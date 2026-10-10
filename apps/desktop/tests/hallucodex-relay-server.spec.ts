import { request } from 'node:http'
import type { IncomingHttpHeaders, OutgoingHttpHeaders } from 'node:http'
import { connect } from 'node:net'
import type { Socket } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startHalluCodexLoopbackRelay } from '../src/hallucodex/loopback-relay.ts'
import type { HalluCodexLoopbackRelay, HalluCodexLoopbackRelayOptions } from '../src/hallucodex/loopback-relay.ts'
import type { DesktopRelayResult } from '../src/hallucodex/relay-broker.ts'

const relays = new Set<HalluCodexLoopbackRelay>()
const sockets = new Set<Socket>()
const payload = { model: 'fixture-model', input: 'hello', stream: true }

function own(socket: Socket): Socket {
  sockets.add(socket)
  socket.once('close', () => { sockets.delete(socket) })
  return socket
}

afterEach(async () => {
  for (const socket of sockets) socket.destroy()
  await Promise.all([...relays].map(relay => relay.close()))
  relays.clear()
})

async function fixture(overrides: Partial<Omit<HalluCodexLoopbackRelayOptions, 'runtime'>> = {}) {
  const invoke = vi.fn<HalluCodexLoopbackRelayOptions['runtime']['invoke']>().mockImplementation(async () => ({
    response: new Response('data: {"delta":"ok"}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } }),
    group: 'fixture-group', model: 'fixture-model',
  }))
  const getRelayRevision = vi.fn().mockReturnValue(1)
  const relay = await startHalluCodexLoopbackRelay({
    runtime: { invoke, getRelayRevision }, maxRequestBytes: 1024, maxConcurrentRequests: 2, requestTimeoutMs: 1000, ...overrides,
  })
  relays.add(relay)
  return { relay, invoke, getRelayRevision }
}

function headers(relay: HalluCodexLoopbackRelay): OutgoingHttpHeaders {
  return { authorization: `Bearer ${relay.localCapability}`, 'content-type': 'application/json', 'x-hallucodex-revision': '1' }
}

function exchange(relay: HalluCodexLoopbackRelay, options: {
  path?: string
  method?: string
  headers?: OutgoingHttpHeaders
  body?: string | Buffer
  chunks?: readonly (string | Buffer)[]
} = {}): Promise<{ status: number | undefined; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const outgoing = Object.fromEntries(
      Object.entries({ ...headers(relay), ...options.headers }).filter(([, value]) => value !== undefined),
    )
    const req = request(relay.baseURL, {
      path: options.path ?? '/v1/responses', method: options.method ?? 'POST',
      headers: outgoing, agent: false,
    }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => { chunks.push(chunk) })
      response.on('error', reject)
      response.on('end', () => { resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }) })
    })
    req.on('socket', own)
    req.on('error', reject)
    if (options.chunks !== undefined) {
      for (const chunk of options.chunks) req.write(chunk)
      req.end()
    } else req.end(options.body ?? JSON.stringify(payload))
  })
}

describe('HalluCodex authenticated loopback relay', () => {
  it('binds only IPv4 loopback with an independently random capability per listener', async () => {
    const first = await fixture()
    const second = await fixture()
    expect(first.relay.baseURL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u)
    expect(first.relay.localCapability).toMatch(/^[A-Za-z0-9_-]{43}$/u)
    expect(first.relay.localCapability).not.toBe(second.relay.localCapability)
    expect((await exchange(first.relay, { headers: { authorization: `Bearer ${second.relay.localCapability}` } })).status).toBe(401)
  })

  it.each(['/v1/chat/completions', '/v1/responses', '/v1/messages'] as const)('streams the exact %s protocol and passes no caller headers', async (endpoint) => {
    const { relay, invoke } = await fixture()
    const response = await exchange(relay, { path: endpoint, headers: {
      'x-api-key': 'caller-key', 'x-forwarded-host': 'untrusted.example',
      'x-server-address': 'https://untrusted.example', 'anthropic-version': 'caller-version',
    } })
    expect(response.status).toBe(200)
    expect(response.body).toBe('data: {"delta":"ok"}\n\ndata: [DONE]\n\n')
    expect(response.headers['content-type']).toBe('text/event-stream')
    expect(response.headers['cache-control']).toBe('no-store')
    expect(invoke).toHaveBeenCalledExactlyOnceWith(endpoint, payload, expect.any(AbortSignal), 1)
    expect(invoke.mock.calls[0]?.[2]?.aborted).toBe(false)
  })

  it.each([
    { headers: { origin: '' }, status: 403 },
    { headers: { origin: 'null' }, status: 403 },
    { headers: { origin: 'https://hallucodex.com' }, status: 403 },
    { method: 'OPTIONS', status: 403 },
    { headers: { host: 'localhost' }, status: 403 },
    { headers: { host: '127.0.0.1:1' }, status: 403 },
    { headers: { host: '127.0.0.1.attacker.example' }, status: 403 },
    { headers: { authorization: undefined }, status: 401 },
    { headers: { authorization: 'Bearer wrong' }, status: 401 },
    { headers: { 'x-hallucodex-revision': undefined }, status: 400 },
    { headers: { 'x-hallucodex-revision': '0' }, status: 400 },
    { headers: { 'x-hallucodex-revision': '-1' }, status: 400 },
    { headers: { 'x-hallucodex-revision': '1.5' }, status: 400 },
    { headers: { 'x-hallucodex-revision': '01' }, status: 400 },
    { headers: { 'x-hallucodex-revision': '9007199254740992' }, status: 400 },
    { headers: { 'x-hallucodex-revision': '2' }, status: 409 },
    { headers: { 'x-hallucodex-revision': ['1', '1'] }, status: 400 },
    { method: 'GET', status: 405 },
    { method: 'HEAD', status: 405 },
    { method: 'PUT', status: 405 },
    { path: '/v1', status: 404 },
    { path: '/v1/responses?serverAddress=https://untrusted.example', status: 404 },
    { path: '/v1/responses/', status: 404 },
    { path: '/v1/%72esponses', status: 404 },
    { path: 'https://untrusted.example/v1/responses', status: 404 },
    { headers: { 'content-type': undefined }, status: 415 },
    { headers: { 'content-type': 'text/plain' }, status: 415 },
    { headers: { 'content-type': 'application/jsonp' }, status: 415 },
    { headers: { 'content-type': 'application/json; charset=utf-16' }, status: 415 },
    { headers: { 'content-encoding': 'gzip' }, status: 415 },
  ])('denies an untrusted request before invoking: %j', async ({ status, ...options }) => {
    const { relay, invoke } = await fixture()
    const response = await exchange(relay, options)
    expect(response.status).toBe(status)
    expect(response.headers['access-control-allow-origin']).toBeUndefined()
    expect(response.headers['access-control-allow-credentials']).toBeUndefined()
    expect(response.body).not.toContain(relay.localCapability)
    expect(invoke).not.toHaveBeenCalled()
  })

  it('rejects duplicate authorization and content-type headers', async () => {
    const { relay, invoke } = await fixture()
    for (const [name, value, status] of [
      ['authorization', `Bearer ${relay.localCapability}`, 401], ['content-type', 'application/json', 415],
    ] as const) {
      const duplicate: Record<string, string[]> = { [name]: [value, value] }
      expect((await exchange(relay, { headers: duplicate })).status).toBe(status)
    }
    expect(invoke).not.toHaveBeenCalled()
  })

  it('accepts JSON with a UTF-8 charset and rejects malformed JSON or UTF-8', async () => {
    const { relay, invoke } = await fixture()
    expect((await exchange(relay, { headers: { 'content-type': 'Application/JSON; charset="UTF-8"' } })).status).toBe(200)
    for (const body of ['', '{', 'null trailing', Buffer.from([0x22, 0xff, 0x22])]) {
      expect((await exchange(relay, { body })).status).toBe(400)
    }
    expect(invoke).toHaveBeenCalledOnce()
  })

  it('enforces byte limits on declared and chunked bodies, including multibyte text', async () => {
    const exact = JSON.stringify({ model: 'fixture-model', input: '汉' })
    const { relay, invoke } = await fixture({ maxRequestBytes: Buffer.byteLength(exact) })
    expect((await exchange(relay, { body: exact })).status).toBe(200)
    expect((await exchange(relay, { body: `${exact} ` })).status).toBe(413)
    expect((await exchange(relay, { chunks: [exact.slice(0, -1), '} '] })).status).toBe(413)
    expect(invoke).toHaveBeenCalledOnce()
  })

  it('forwards only allowed response headers and preserves upstream status without retrying', async () => {
    const { relay, invoke } = await fixture()
    invoke.mockImplementation(async () => ({ group: 'fixture-group', model: 'fixture-model', response: new Response('{"error":"limited"}', {
      status: 429, headers: {
        'content-type': 'application/json', 'retry-after': '7', 'set-cookie': 'upstream-secret',
        authorization: 'Bearer upstream-secret', 'x-api-key': 'upstream-secret', location: 'https://untrusted.example',
        'access-control-allow-origin': '*', 'content-encoding': 'gzip', 'content-length': '1000',
      },
    }) }))
    const response = await exchange(relay)
    expect(response.status).toBe(429)
    expect(response.body).toBe('{"error":"limited"}')
    expect(response.headers['retry-after']).toBe('7')
    expect(JSON.stringify(response.headers)).not.toContain('upstream-secret')
    for (const name of ['set-cookie', 'authorization', 'x-api-key', 'location', 'access-control-allow-origin', 'content-encoding', 'content-length']) {
      expect(response.headers[name]).toBeUndefined()
    }
    expect(invoke).toHaveBeenCalledOnce()
  })

  it('redacts failures before headers and does not retry ambiguous requests', async () => {
    const { relay, invoke } = await fixture()
    invoke.mockRejectedValue(new Error('Bearer upstream-secret; refresh=private-refresh'))
    const response = await exchange(relay)
    expect(response.status).toBe(502)
    expect(JSON.parse(response.body)).toEqual({ error: { code: 'relay_unavailable', message: 'relay_unavailable' } })
    expect(invoke).toHaveBeenCalledOnce()
  })

  it.each([204, 401, 402, 403, 500, 503])('preserves status %i without a retry or a group change', async (status) => {
    const { relay, invoke } = await fixture()
    invoke.mockResolvedValue({ response: new Response(status === 204 ? null : 'upstream response', { status }), group: 'fixture-group', model: 'fixture-model' })
    expect((await exchange(relay)).status).toBe(status)
    expect(invoke).toHaveBeenCalledOnce()
  })

  it('holds an admission slot until its upstream response ends', async () => {
    const { relay, invoke } = await fixture({ maxConcurrentRequests: 1 })
    const result = Promise.withResolvers<DesktopRelayResult>()
    invoke.mockReturnValueOnce(result.promise)
    const first = exchange(relay)
    try {
      await vi.waitFor(() => { expect(invoke).toHaveBeenCalledOnce() })
      expect((await exchange(relay)).status).toBe(429)
      expect(invoke).toHaveBeenCalledOnce()
    } finally { result.resolve({ response: new Response('complete'), group: 'fixture-group', model: 'fixture-model' }) }
    expect((await first).body).toBe('complete')
    expect((await exchange(relay)).status).toBe(200)
  })

  it('rejects an old prepared request after account revision changes during its upload', async () => {
    const { relay, invoke, getRelayRevision } = await fixture()
    const result = Promise.withResolvers<number | undefined>()
    const req = request(relay.baseURL, { method: 'POST', path: '/v1/responses', headers: headers(relay), agent: false }, (response) => {
      response.resume()
      response.on('end', () => { result.resolve(response.statusCode) })
    })
    req.on('socket', own)
    req.on('error', result.reject)
    req.write('{')
    await vi.waitFor(() => { expect(getRelayRevision).toHaveBeenCalledOnce() })
    getRelayRevision.mockReturnValue(2)
    req.end(JSON.stringify(payload).slice(1))
    expect(await result.promise).toBe(409)
    expect(invoke).not.toHaveBeenCalled()
    expect((await exchange(relay, { headers: { 'x-hallucodex-revision': '2' } })).status).toBe(200)
    expect(invoke).toHaveBeenCalledExactlyOnceWith('/v1/responses', payload, expect.any(AbortSignal), 2)
  })

  it('closes an oversized unfinished upload before accepting the next call', async () => {
    const { relay, invoke } = await fixture({ maxRequestBytes: 100, maxConcurrentRequests: 1 })
    const response = Promise.withResolvers<number | undefined>()
    const closed = Promise.withResolvers<undefined>()
    const req = request(relay.baseURL, { method: 'POST', path: '/v1/responses', headers: headers(relay), agent: false }, (incoming) => {
      incoming.resume()
      incoming.on('end', () => { response.resolve(incoming.statusCode) })
    })
    req.on('socket', own)
    req.on('error', () => { /* The server rejects this unfinished body and closes its connection. */ })
    req.once('close', () => { closed.resolve(undefined) })
    req.write(' '.repeat(101))
    expect(await response.promise).toBe(413)
    await closed.promise
    expect(invoke).not.toHaveBeenCalled()
    expect((await exchange(relay)).status).toBe(200)
  })

  it('rejects excessive HTTP headers without invoking the runtime', async () => {
    const { relay, invoke } = await fixture()
    expect((await exchange(relay, { headers: { 'x-excessive-header': 'x'.repeat(8192) } })).status).toBe(431)
    expect(invoke).not.toHaveBeenCalled()
  })

  it('counts unfinished body uploads toward concurrency and times them out', async () => {
    const { relay, invoke } = await fixture({ maxConcurrentRequests: 1, requestTimeoutMs: 150 })
    const started = Promise.withResolvers<undefined>()
    const timedOut = new Promise<number | undefined>((resolve, reject) => {
      const req = request(relay.baseURL, { method: 'POST', path: '/v1/responses', headers: headers(relay), agent: false }, (response) => {
        response.resume()
        response.on('end', () => { resolve(response.statusCode) })
      })
      req.on('socket', own)
      req.on('error', reject)
      req.write('{', () => { started.resolve(undefined) })
    })
    await started.promise
    await vi.waitFor(async () => { expect((await exchange(relay)).status).toBe(429) })
    expect(await timedOut).toBe(408)
    expect(invoke).not.toHaveBeenCalled()
    expect((await exchange(relay)).status).toBe(200)
  })

  it('aborts an upstream call when its local client disconnects', async () => {
    const { relay, invoke } = await fixture()
    const aborted = Promise.withResolvers<undefined>()
    invoke.mockImplementation((_endpoint, _payload, signal) => new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => { aborted.resolve(undefined); reject(new Error('upstream-private-abort')) }, { once: true })
    }))
    const req = request(relay.baseURL, { method: 'POST', path: '/v1/responses', headers: headers(relay), agent: false })
    req.on('socket', own)
    req.on('error', () => { /* This test deliberately disconnects the client. */ })
    req.end(JSON.stringify(payload))
    await vi.waitFor(() => { expect(invoke).toHaveBeenCalledOnce() })
    req.destroy()
    await aborted.promise
    await relay.close()
    expect(invoke.mock.calls[0]?.[2]?.aborted).toBe(true)
  })

  it('streams without buffering and cancels the reader on client disconnect', async () => {
    const { relay, invoke } = await fixture()
    const cancelled = Promise.withResolvers<undefined>()
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('data: first\n\n')) },
      cancel() { cancelled.resolve(undefined) },
    })
    invoke.mockResolvedValue({ response: new Response(body, { headers: { 'content-type': 'text/event-stream' } }), group: 'fixture-group', model: 'fixture-model' })
    const firstChunk = Promise.withResolvers<string>()
    const req = request(relay.baseURL, { method: 'POST', path: '/v1/responses', headers: headers(relay), agent: false }, (response) => {
      response.once('data', (chunk: Buffer) => { firstChunk.resolve(chunk.toString('utf8')); response.destroy() })
      response.on('error', () => { /* Client cancellation intentionally interrupts the stream. */ })
    })
    req.on('socket', own)
    req.on('error', () => { /* Client cancellation intentionally interrupts the request. */ })
    req.end(JSON.stringify(payload))
    expect(await firstChunk.promise).toBe('data: first\n\n')
    await cancelled.promise
    await relay.close()
    expect(invoke).toHaveBeenCalledOnce()
  })

  it('stops pulling upstream while the local receiver applies backpressure', async () => {
    const { relay, invoke } = await fixture()
    let pulls = 0
    const cancelled = Promise.withResolvers<undefined>()
    invoke.mockResolvedValue({ group: 'fixture-group', model: 'fixture-model', response: new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++
        controller.enqueue(new Uint8Array(256 * 1024))
        if (pulls === 256) controller.close()
      },
      cancel() { cancelled.resolve(undefined) },
    })) })
    const started = Promise.withResolvers<undefined>()
    const req = request(relay.baseURL, { method: 'POST', path: '/v1/responses', headers: headers(relay), agent: false }, (response) => {
      response.pause()
      response.on('error', () => { /* This test cancels a paused receiver. */ })
      started.resolve(undefined)
    })
    req.on('socket', own)
    req.on('error', () => { /* This test cancels a paused request. */ })
    req.end(JSON.stringify(payload))
    await started.promise
    // Leave enough time for a faulty unbounded producer to drain all 64 MiB.
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(pulls).toBeGreaterThan(0)
    expect(pulls).toBeLessThan(256)
    req.destroy()
    await cancelled.promise
    await relay.close()
  })

  it('terminates an already-started stream without appending private error diagnostics', async () => {
    const { relay, invoke } = await fixture()
    const fail = Promise.withResolvers<undefined>()
    invoke.mockResolvedValueOnce({ group: 'fixture-group', model: 'fixture-model', response: new Response(new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(new TextEncoder().encode('data: safe\n\n'))
        await fail.promise
        controller.error(new Error('Bearer private-stream-secret'))
      },
    })) })
    const received = new Promise<string>((resolve, reject) => {
      const req = request(relay.baseURL, { method: 'POST', path: '/v1/responses', headers: headers(relay), agent: false }, (response) => {
        let text = ''
        response.on('data', (chunk: Buffer) => { text += chunk.toString('utf8'); fail.resolve(undefined) })
        response.once('aborted', () => { resolve(text) })
        response.on('error', () => { /* The upstream failure intentionally truncates this response. */ })
      })
      req.on('socket', own)
      req.on('error', reject)
      req.end(JSON.stringify(payload))
    })
    expect(await received).toBe('data: safe\n\n')
    expect(invoke).toHaveBeenCalledOnce()
    expect((await exchange(relay)).status).toBe(200)
  })

  it('waits for asynchronous stream cancellation and closes idle sockets during shutdown', async () => {
    const { relay, invoke } = await fixture()
    const cancelStarted = Promise.withResolvers<undefined>()
    const cancelDone = Promise.withResolvers<undefined>()
    invoke.mockResolvedValue({ group: 'fixture-group', model: 'fixture-model', response: new Response(new ReadableStream<Uint8Array>({
      cancel() { cancelStarted.resolve(undefined); return cancelDone.promise },
    })) })
    const responseStarted = Promise.withResolvers<undefined>()
    const req = request(relay.baseURL, { method: 'POST', path: '/v1/responses', headers: headers(relay), agent: false }, (response) => {
      response.on('error', () => { /* Shutdown intentionally interrupts the stream. */ })
      response.resume()
      responseStarted.resolve(undefined)
    })
    req.on('socket', own)
    req.on('error', () => { /* Shutdown intentionally interrupts the request. */ })
    req.end(JSON.stringify(payload))
    await responseStarted.promise
    const idle = own(connect({ host: '127.0.0.1', port: Number(new URL(relay.baseURL).port) }))
    // Shutdown destroys idle connections; depending on the platform the client sees a clean close or a reset.
    const idleErrors: string[] = []
    idle.on('error', (error: NodeJS.ErrnoException) => { idleErrors.push(error.code ?? error.message) })
    await new Promise<void>((resolve) => { idle.once('connect', resolve) })
    let closed = false
    const closing = relay.close().then(() => { closed = true })
    expect(relay.close()).toBe(relay.close())
    try {
      await cancelStarted.promise
      expect(closed).toBe(false)
      await vi.waitFor(() => { expect(idle.destroyed).toBe(true) })
    } finally { cancelDone.resolve(undefined) }
    await closing
    expect(idleErrors.every(code => code === 'ECONNRESET')).toBe(true)
    expect(invoke.mock.calls[0]?.[2]?.aborted).toBe(true)
    await expect(exchange(relay)).rejects.toThrow()
  })

  it.each([
    { maxRequestBytes: 0 }, { maxRequestBytes: 1.5 }, { maxConcurrentRequests: 0 },
    { maxConcurrentRequests: Number.NaN }, { requestTimeoutMs: 0 }, { requestTimeoutMs: 2_147_483_648 },
  ])('rejects invalid explicit limits before listening: %j', async (overrides) => {
    await expect(fixture(overrides)).rejects.toThrow('invalid local relay')
  })
})

it('accepts the Anthropic SDK local credential and exact beta query without forwarding either', async () => {
  const { relay, invoke } = await fixture()
  const response = await exchange(relay, { path: '/v1/messages?beta=true', headers: {
    authorization: undefined, 'x-api-key': relay.localCapability,
  } })
  expect(response.status).toBe(200)
  expect(invoke).toHaveBeenCalledExactlyOnceWith('/v1/messages', payload, expect.any(AbortSignal), 1)
  expect((await exchange(relay, { path: '/v1/messages?beta=true&group=auto', headers: {
    authorization: undefined, 'x-api-key': relay.localCapability,
  } })).status).toBe(404)
  expect((await exchange(relay, { path: '/v1/responses', headers: {
    authorization: undefined, 'x-api-key': relay.localCapability,
  } })).status).toBe(401)
})

it.each([
  ['hallucodex-chat', '/v1/chat/completions'],
  ['hallucodex-responses', '/v1/responses'],
  ['hallucodex-anthropic', '/v1/messages'],
] as const)('dispatches the actual %s serializer through the authenticated native relay', async (provider, endpoint) => {
  const { Context } = await import('@deepseek-ai/cordis')
  const { default: LlmRuntime, createUserMessage } = await import('@deepseek-ai/dsh-llm')
  const { installHalluCodexProvider } = await import('../../desktop-host/src/hallucodex.ts')
  const { relay, invoke } = await fixture()
  invoke.mockResolvedValue({
    response: Response.json({ error: { type: 'invalid_request_error', message: 'fixture-terminal' } }, { status: 400 }),
    group: 'fixture-group', model: 'fixture-model',
  })
  const ctx = new Context()
  try {
    await ctx.plugin(LlmRuntime)
    await ctx.plugin((scope) => { installHalluCodexProvider(scope, {
      type: 'hallucodex-config', baseURL: relay.baseURL, localCapability: relay.localCapability, revision: 1,
      models: [{ id: 'fixture-model', endpoints: [endpoint], contextWindow: 8192, maxOutputTokens: 2048 }],
    }, () => Promise.reject(new Error('fixture: saving is not expected'))) })
    const prepared = await ctx.llm.prepareCall({ provider, model: 'fixture-model' })
    const chunks = []
    for await (const chunk of prepared.stream({ ...prepared.config, messages: [createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'model', provider, model: 'fixture-model' } })] })) chunks.push(chunk)
    expect(invoke).toHaveBeenCalledOnce()
    expect(invoke.mock.calls[0]?.[0]).toBe(endpoint)
    expect(invoke.mock.calls[0]?.[1]).toMatchObject({ model: 'fixture-model', stream: true })
    expect(invoke.mock.calls[0]?.[3]).toBe(1)
    expect(JSON.stringify(chunks)).not.toContain(relay.localCapability)
    expect(prepared.retryPolicy).toMatchObject({ mode: 'normal', maxRetries: 0 })
  } finally { await ctx.fiber.dispose() }
})
