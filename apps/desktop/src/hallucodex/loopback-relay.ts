/** Private HTTP transport from the trusted Host subprocess to the native account relay. */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import { finished } from 'node:stream/promises'
import type { DesktopEndpoint } from './catalog.ts'
import type { HalluCodexDesktopRuntime } from './runtime.ts'

/** Explicit native limits; the runtime is never exposed through renderer IPC. */
export interface HalluCodexLoopbackRelayOptions {
  readonly runtime: Pick<HalluCodexDesktopRuntime, 'invoke' | 'getRelayRevision'>
  readonly maxRequestBytes: number
  readonly maxConcurrentRequests: number
  /** Bounds receipt of local headers/body, without timing out upstream inference streams. */
  readonly requestTimeoutMs: number
}

/** Transfer only through trusted subprocess IPC; neither field belongs in renderer state or logs. */
export interface HalluCodexLoopbackRelay {
  readonly baseURL: string
  readonly localCapability: string
  /** Stop admission, abort streams, and wait for all owned work and sockets to stop. */
  close(): Promise<void>
}

class LocalRequestError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code) }
}

function headerCount(request: IncomingMessage, name: string): number {
  let count = 0
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === name) count++
  }
  return count
}

function endpointFor(path: string | undefined): DesktopEndpoint {
  switch (path) {
    case '/v1/chat/completions':
    case '/v1/responses':
    case '/v1/messages': return path
    case '/v1/messages?beta=true': return '/v1/messages'
    default: throw new LocalRequestError(404, 'unknown_endpoint')
  }
}

function authorize(request: IncomingMessage, host: string, authorization: Buffer): DesktopEndpoint {
  if (headerCount(request, 'origin') !== 0 || request.method === 'OPTIONS') {
    throw new LocalRequestError(403, 'browser_requests_forbidden')
  }
  if (headerCount(request, 'host') !== 1 || request.headers.host !== host) {
    throw new LocalRequestError(403, 'invalid_host')
  }
  const endpoint = endpointFor(request.url)
  const apiKeyAuth = endpoint === '/v1/messages' && headerCount(request, 'authorization') === 0
    && headerCount(request, 'x-api-key') === 1 && typeof request.headers['x-api-key'] === 'string'
  const supplied = Buffer.from(apiKeyAuth ? `Bearer ${String(request.headers['x-api-key'])}` : request.headers.authorization ?? '', 'utf8')
  if ((!apiKeyAuth && headerCount(request, 'authorization') !== 1) || supplied.length !== authorization.length
    || !timingSafeEqual(supplied, authorization)) {
    throw new LocalRequestError(401, 'unauthorized')
  }
  if (request.method !== 'POST') throw new LocalRequestError(405, 'method_not_allowed')
  if (headerCount(request, 'content-type') !== 1
    || !/^application\/json(?:\s*;\s*charset=(?:utf-8|"utf-8"))?$/iu.test(request.headers['content-type'] ?? '')
    || headerCount(request, 'content-encoding') !== 0) {
    throw new LocalRequestError(415, 'json_required')
  }
  return endpoint
}

function revisionFor(request: IncomingMessage): number {
  const value = request.headers['x-hallucodex-revision']
  if (headerCount(request, 'x-hallucodex-revision') !== 1 || typeof value !== 'string'
    || !/^[1-9]\d*$/u.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new LocalRequestError(400, 'invalid_relay_revision')
  }
  return Number(value)
}

async function readJSON(request: IncomingMessage, maxBytes: number, timeoutMs: number, signal: AbortSignal): Promise<unknown> {
  const length = request.headers['content-length']
  if (length !== undefined && Number(length) > maxBytes) throw new LocalRequestError(413, 'request_too_large')
  const body = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []
    let bytes = 0
    const cleanup = () => {
      clearTimeout(timer)
      request.off('data', onData)
      request.off('end', onEnd)
      signal.removeEventListener('abort', onAbort)
    }
    const fail = (error: Error) => { cleanup(); request.pause(); reject(error) }
    const onAbort = () => { fail(new LocalRequestError(400, 'request_cancelled')) }
    const onData = (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > maxBytes) { fail(new LocalRequestError(413, 'request_too_large')); return }
      chunks.push(chunk)
    }
    const onEnd = () => { cleanup(); resolve(Buffer.concat(chunks, bytes)) }
    const timer = setTimeout(() => { fail(new LocalRequestError(408, 'request_timeout')) }, timeoutMs)
    timer.unref()
    request.on('data', onData)
    request.once('end', onEnd)
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
  })
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)) }
  catch (_parseError) { throw new LocalRequestError(400, 'invalid_json') }
}

function failure(response: ServerResponse, error: unknown): void {
  if (response.destroyed) return
  if (response.headersSent) { response.destroy(); return }
  const status = error instanceof LocalRequestError ? error.status : 502
  const code = error instanceof LocalRequestError ? error.code : 'relay_unavailable'
  response.writeHead(status, {
    'content-type': 'application/json', 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff', connection: 'close',
  })
  response.end(JSON.stringify({ error: { code, message: code } }))
}

async function streamResponse(upstream: Response, response: ServerResponse, signal: AbortSignal): Promise<void> {
  const reader = upstream.body?.getReader()
  let cancellation: Promise<void> | undefined
  const cancel = () => {
    if (reader === undefined || cancellation !== undefined) return
    cancellation = reader.cancel().catch((_cancelError: unknown) => {
      // A failed upstream stream may reject cancellation; its reader still needs releasing.
    })
  }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    if (signal.aborted) cancel()
    signal.throwIfAborted()
    const headers: Record<string, string> = {
      'cache-control': 'no-store', 'x-content-type-options': 'nosniff', connection: 'close',
    }
    const contentType = upstream.headers.get('content-type')
    if (contentType !== null) headers['content-type'] = contentType
    const retryAfter = upstream.headers.get('retry-after')
    if (retryAfter !== null && /^\d+$/u.test(retryAfter)) headers['retry-after'] = retryAfter
    response.writeHead(upstream.status, headers)
    response.flushHeaders()
    if (reader !== undefined) {
      while (true) {
        const chunk = await reader.read()
        signal.throwIfAborted()
        if (chunk.done) break
        if (!response.write(chunk.value)) await once(response, 'drain', { signal })
      }
    }
    response.end()
    await finished(response, { cleanup: true })
  } finally {
    signal.removeEventListener('abort', cancel)
    cancel()
    await cancellation
    reader?.releaseLock()
  }
}

/**
 * Bind a fresh IPv4 loopback listener and mint a 256-bit capability used only by the trusted Host.
 * Each request requires local capability authentication (Bearer, or Anthropic x-api-key) and its prepared positive x-hallucodex-revision.
 * No destination, account credential, or caller header is forwarded to the upstream runtime.
 * @param options - private invocation dependency and explicit resource limits.
 * @returns listener coordinates and idempotent asynchronous shutdown; baseURL has no protocol-path suffix.
 */
export async function startHalluCodexLoopbackRelay(options: HalluCodexLoopbackRelayOptions): Promise<HalluCodexLoopbackRelay> {
  for (const limit of [options.maxRequestBytes, options.maxConcurrentRequests, options.requestTimeoutMs]) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('hallucodex: invalid local relay limit')
  }
  if (options.requestTimeoutMs > 2_147_483_647) throw new Error('hallucodex: invalid local relay timeout')
  const localCapability = randomBytes(32).toString('base64url')
  const authorization = Buffer.from(`Bearer ${localCapability}`, 'utf8')
  const active = new Set<AbortController>()
  const pending = new Set<Promise<void>>()
  const sockets = new Set<Socket>()
  let closing = false
  let host = ''
  let closePromise: Promise<void> | undefined
  const server = createServer({
    maxHeaderSize: 8 * 1024,
    headersTimeout: options.requestTimeoutMs,
    requestTimeout: options.requestTimeoutMs,
    connectionsCheckingInterval: options.requestTimeoutMs,
  }, (request, response) => {
    const task = serve(request, response)
    pending.add(task)
    void task.then(() => { pending.delete(task) })
  })

  async function serve(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const controller = new AbortController()
    const abort = () => { controller.abort() }
    const close = () => { if (!response.writableFinished) abort() }
    request.on('error', abort)
    request.once('aborted', abort)
    response.on('error', abort)
    response.once('close', close)
    let admitted = false
    try {
      if (closing) throw new LocalRequestError(503, 'relay_closed')
      const endpoint = authorize(request, host, authorization)
      const revision = revisionFor(request)
      if (revision !== options.runtime.getRelayRevision()) throw new LocalRequestError(409, 'stale_relay_revision')
      if (active.size >= options.maxConcurrentRequests) throw new LocalRequestError(429, 'relay_busy')
      active.add(controller)
      admitted = true
      const payload = await readJSON(request, options.maxRequestBytes, options.requestTimeoutMs, controller.signal)
      controller.signal.throwIfAborted()
      if (revision !== options.runtime.getRelayRevision()) throw new LocalRequestError(409, 'stale_relay_revision')
      const result = await options.runtime.invoke(endpoint, payload, controller.signal, revision)
      await streamResponse(result.response, response, controller.signal)
    } catch (error) {
      failure(response, error)
      await finished(response, { cleanup: true }).catch((_responseError: unknown) => {
        // Local disconnection is already reflected in cancellation; never emit transport diagnostics.
      })
    } finally {
      if (!request.complete) {
        request.destroy()
        await finished(request, { cleanup: true }).catch((_requestError: unknown) => {
          // Incomplete uploads must stop before their final error listener is removed.
        })
      }
      if (admitted) active.delete(controller)
      request.off('error', abort)
      request.off('aborted', abort)
      response.off('error', abort)
      response.off('close', close)
    }
  }

  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.once('close', () => { sockets.delete(socket) })
    if (closing) socket.destroy()
  })
  // Neither protocol upgrade nor Expect negotiation bypasses the ordinary admission checks.
  server.on('upgrade', (_request, socket) => { socket.destroy() })
  server.on('connect', (_request, socket) => { socket.destroy() })
  server.on('checkContinue', (request, response) => { failure(response, new LocalRequestError(417, 'expectation_failed')); request.resume() })
  server.on('checkExpectation', (request, response) => { failure(response, new LocalRequestError(417, 'expectation_failed')); request.resume() })
  await new Promise<void>((resolve, reject) => {
    const onError = () => { reject(new Error('hallucodex: local relay unavailable')) }
    server.once('error', onError)
    server.listen(0, '127.0.0.1', () => { server.off('error', onError); resolve() })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') {
    server.close()
    throw new Error('hallucodex: local relay unavailable')
  }
  host = `127.0.0.1:${address.port}`
  function close(): Promise<void> {
    closePromise ??= (async () => {
      closing = true
      const stopped = new Promise<void>((resolve) => { server.close(() => { resolve() }) })
      for (const controller of active) controller.abort()
      for (const socket of sockets) socket.destroy()
      await stopped
      await Promise.all([...pending])
    })()
    return closePromise
  }
  server.on('error', () => { void close() })
  return {
    baseURL: `http://${host}`,
    localCapability,
    close,
  }
}
