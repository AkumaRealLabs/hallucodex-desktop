import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import { HALLUCODEX_IDENTITY, installHalluCodexIdentity, installHalluCodexProvider, parseHalluCodexHostConfiguration } from '../src/hallucodex.ts'
import { createServer } from 'node:http'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'

const disposers: (() => Promise<void>)[] = []
afterEach(async () => { while (disposers.length) await disposers.pop()?.() })

function configuration(baseURL = 'http://127.0.0.1:43210') {
  return {
    type: 'hallucodex-config' as const, baseURL, localCapability: 't'.repeat(43), revision: 2,
    models: [{ id: 'fixture-model', endpoints: ['/v1/chat/completions'], contextWindow: 8192, maxOutputTokens: 2048 }],
  }
}

describe('native Host configuration', () => {
  it.each(['https://api.hallucodex.com', 'http://localhost:43210', 'http://127.0.0.1:43210/v1', 'http://user@127.0.0.1:43210', 'http://127.0.0.1:43210?x=1'])('rejects a non-exact loopback endpoint %s', (baseURL) => {
    expect(() => parseHalluCodexHostConfiguration(configuration(baseURL))).toThrow()
  })
  it('does not invent model capacities or accept invalid native revisions', () => {
    expect(parseHalluCodexHostConfiguration({ ...configuration(), models: [{ id: 'unknown', endpoints: ['/v1/responses'] }] }).models).toEqual([])
    expect(() => parseHalluCodexHostConfiguration({ ...configuration(), revision: -1 })).toThrow()
    expect(() => parseHalluCodexHostConfiguration({ ...configuration(), localCapability: 'dsk.upstream-credential' })).toThrow()
  })
  it('registers real Harness protocol adapters and disposes their routes', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    disposers.push(() => ctx.fiber.dispose())
    let publications = 0
    ctx.on('llm/adapters-updated', () => { publications++ })
    let update: ((configuration: unknown) => void) | undefined
    const owner = await ctx.plugin((scope) => { update = installHalluCodexProvider(scope, configuration()) })
    expect(await ctx.llm.listModels('hallucodex-chat')).toEqual([
      { provider: 'hallucodex-chat', id: 'fixture-model', name: 'fixture-model', inputModalities: ['text'] },
    ])
    const call = await ctx.llm.prepareCall({ provider: 'hallucodex-chat', model: 'fixture-model' })
    expect(call.retryPolicy).toMatchObject({ mode: 'normal', maxRetries: 0 })
    expect(() => update?.({ ...configuration(), baseURL: 'http://127.0.0.1:43211', revision: 3 })).toThrow('identity cannot change')
    const beforeRefresh = publications
    update?.({ ...configuration(), revision: 3, models: [] })
    expect(publications).toBeGreaterThan(beforeRefresh)
    expect(await ctx.llm.listModels('hallucodex-chat')).toEqual([])
    expect(() => update?.(configuration())).toThrow('stale')
    await owner.dispose()
    await expect(ctx.llm.prepareCall({ provider: 'hallucodex-chat', model: 'fixture-model' })).rejects.toThrow()
  })
  it('uses the actual serializer, private local bearer and prepared revision for one streaming request', async () => {
    const seen: { path?: string; authorization?: string; revision?: string; body?: string }[] = []
    const server = createServer((request, response) => {
      const record = { path: request.url ?? '', authorization: request.headers.authorization ?? '',
        revision: typeof request.headers['x-hallucodex-revision'] === 'string' ? request.headers['x-hallucodex-revision'] : '', body: '' }
      seen.push(record)
      request.setEncoding('utf8')
      request.on('data', (chunk: string) => { record.body += chunk })
      request.on('end', () => {
        response.setHeader('content-type', 'text/event-stream')
        response.end('data: {"id":"fixture","object":"chat.completion.chunk","created":1,"model":"fixture-model","choices":[{"index":0,"delta":{"role":"assistant","content":"hello"},"finish_reason":null}]}\n\ndata: {"id":"fixture","object":"chat.completion.chunk","created":1,"model":"fixture-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
      })
    })
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    disposers.push(() => new Promise<void>((resolve, reject) => { server.close((error) => { if (error) reject(error); else resolve() }) }))
    const port = (server.address() as AddressInfo).port
    const ctx = new Context(); await ctx.plugin(LlmRuntime)
    disposers.push(() => ctx.fiber.dispose())
    const initial = configuration(`http://127.0.0.1:${String(port)}`)
    let update: ((configuration: unknown) => void) | undefined
    await ctx.plugin((scope) => { update = installHalluCodexProvider(scope, initial) })
    const prepared = await ctx.llm.prepareCall({ provider: 'hallucodex-chat', model: 'fixture-model' })
    update?.({ ...initial, revision: 3 })
    const chunks = []
    for await (const chunk of prepared.stream({ ...prepared.config, messages: [createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'model', provider: 'hallucodex-chat', model: 'fixture-model' } })] })) chunks.push(chunk)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ path: '/v1/chat/completions', authorization: `Bearer ${'t'.repeat(43)}`, revision: '2' })
    expect(JSON.parse(seen[0]?.body ?? '{}')).toMatchObject({ model: 'fixture-model', stream: true })
    expect(JSON.stringify(chunks)).toContain('hello')
    expect(JSON.stringify(chunks)).not.toContain('t'.repeat(43))
  })
})

describe('HalluCodex identity', () => {
  it('opens the prompt with HalluCodex in place of the upstream harness line', async () => {
    const { default: SystemPrompt, renderPrompt } = await import('@deepseek-ai/dsh-system-prompt')
    const ctx = new Context()
    try {
      await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false, personaPrefix: 'Deployment persona.' })
      installHalluCodexIdentity(ctx)
      await vi.waitFor(async () => {
        expect(renderPrompt(await ctx.systemPrompt.assemble())).toBe(`${HALLUCODEX_IDENTITY}\n\nDeployment persona.`)
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
