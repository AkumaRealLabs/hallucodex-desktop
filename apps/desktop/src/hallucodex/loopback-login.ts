/** One-shot IPv4 loopback callback for system-browser PKCE authorization. */

import { timingSafeEqual } from 'node:crypto'
import { createServer, type ServerResponse } from 'node:http'
import { HALLUCODEX_ORIGIN, HalluCodexAuthError } from './auth-protocol.ts'

/** Callback lifetime, bounded by the broker's login generation and expiry. */
export interface LoopbackLoginOptions {
  signal: AbortSignal
  expiresAt: number
  now?: () => number
}

/** Main-process callback handle; never expose its code promise or URI through renderer IPC. */
export interface LoopbackLogin {
  redirectUri: string
  code: Promise<string>
  /** Stop accepting callbacks and wait for all callback sockets to close. */
  close(): Promise<void>
}

/**
 * Listen exclusively on 127.0.0.1 at an OS-selected port with a fixed, exact callback path.
 * Invalid requests never consume the attempt; one valid code consumes it before exchange begins.
 * @param state - Main-process random state value for this attempt.
 * @param options - Cancellation signal and absolute authorization deadline.
 * @returns A one-shot callback whose close operation reaches listener quiescence.
 */
export async function createLoopbackLogin(state: string, options: LoopbackLoginOptions): Promise<LoopbackLogin> {
  const now = options.now ?? Date.now
  if (options.signal.aborted) throw new HalluCodexAuthError('cancelled')
  if (options.expiresAt <= now()) throw new HalluCodexAuthError('expired')
  const result = Promise.withResolvers<string>()
  // A callback may fail while registration or browser opening is still awaiting another operation.
  void result.promise.catch(() => {})
  let consumed = false
  let host = ''
  let closing: Promise<void> | undefined
  const lifetime: { timer?: ReturnType<typeof setTimeout> } = {}
  const answer = (response: ServerResponse, status: number): void => {
    response.writeHead(status, {
      'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'", 'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff', Connection: 'close',
    })
    response.end(status === 200 ? 'You can return to HalluCodex.' : 'Authorization callback rejected.')
  }
  const server = createServer({ maxHeaderSize: 8192 }, (request, response) => {
    if (consumed || now() >= options.expiresAt || options.signal.aborted) {
      answer(response, 410)
      fail(options.signal.aborted ? 'cancelled' : 'expired')
      return
    }
    if (request.method !== 'GET' || request.headers.host !== host
      || (request.headers.origin !== undefined && request.headers.origin !== HALLUCODEX_ORIGIN)
      || !request.url || request.url.length > 4096 || request.url.split('?')[0] !== '/oauth/callback' || request.url.includes('#')) {
      answer(response, 400)
      return
    }
    const url = new URL(request.url, `http://${host}`)
    const receivedState = url.searchParams.get('state') ?? ''
    const expected = Buffer.from(state)
    const received = Buffer.from(receivedState)
    const code = url.searchParams.get('code')
    const error = url.searchParams.get('error')
    if (url.searchParams.getAll('state').length !== 1 || received.length !== expected.length || !timingSafeEqual(received, expected)
      || [...url.searchParams.keys()].some(key => key !== 'code' && key !== 'state' && key !== 'error')
      || (code !== null && error !== null) || (code === null && error === null)
      || url.searchParams.getAll('code').length > 1 || url.searchParams.getAll('error').length > 1
      || (code !== null && !/^dsc\.[A-Za-z0-9._~-]{1,2044}$/u.test(code)) || (error !== null && error !== 'access_denied')) {
      answer(response, 400)
      return
    }
    consumed = true
    answer(response, 200)
    if (code !== null) result.resolve(code)
    else result.reject(new HalluCodexAuthError('cancelled'))
    void close()
  })
  server.headersTimeout = 5000
  server.requestTimeout = 5000
  server.maxHeadersCount = 20
  server.on('clientError', (_error, socket) => { socket.destroy() })

  function close(): Promise<void> {
    if (closing) return closing
    if (lifetime.timer) clearTimeout(lifetime.timer)
    options.signal.removeEventListener('abort', abort)
    if (!consumed) {
      consumed = true
      result.reject(new HalluCodexAuthError('cancelled'))
    }
    closing = new Promise<void>((resolve) => {
      server.close(() => { resolve() })
      server.closeAllConnections()
    })
    return closing
  }

  function fail(code: 'expired' | 'cancelled' | 'network_error'): void {
    if (!consumed) {
      consumed = true
      result.reject(new HalluCodexAuthError(code))
    }
    void close()
  }

  function abort(): void { fail('cancelled') }

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve() })
    })
  } catch (_error) {
    await close()
    throw new HalluCodexAuthError('network_error')
  }
  server.on('error', () => { fail('network_error') })
  const address = server.address()
  if (address === null || typeof address === 'string') {
    await close()
    throw new HalluCodexAuthError('network_error')
  }
  host = `127.0.0.1:${address.port}`
  options.signal.addEventListener('abort', abort, { once: true })
  lifetime.timer = setTimeout(() => { fail('expired') }, Math.max(1, options.expiresAt - now()))
  lifetime.timer.unref()
  // oxlint-disable-next-line typescript/no-unnecessary-condition -- Abort can occur while the listener's asynchronous bind is pending.
  if (options.signal.aborted) abort()
  return { redirectUri: `http://${host}/oauth/callback`, code: result.promise, close }
}
