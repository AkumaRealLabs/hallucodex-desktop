import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { ReasoningEffortId, createUserMessage } from '@deepseek-ai/dsh-llm'
import {
  HALLUCODEX_IDENTITY, halluCodexDefaultSelection, installHalluCodexIdentity, installHalluCodexProvider,
  parseHalluCodexHostConfiguration, type HalluCodexCapacitySaver,
} from '../src/hallucodex.ts'
import { createServer } from 'node:http'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'

const disposers: (() => Promise<void>)[] = []
afterEach(async () => { while (disposers.length) await disposers.pop()?.() })

const refuseSave: HalluCodexCapacitySaver = () => Promise.reject(new Error('fixture: saving is not expected'))

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
    const unknown = parseHalluCodexHostConfiguration({ ...configuration(), models: [{ id: 'unknown', endpoints: ['/v1/responses'] }] })
    expect(unknown.models).toEqual([{ id: 'unknown', endpoints: ['/v1/responses'] }])
    const model = { id: 'fixture-model', endpoints: ['/v1/chat/completions'] }
    for (const invalid of [
      { contextWindow: 0 }, { maxOutputTokens: 1.5 }, { contextWindow: 1024, maxOutputTokens: 2048 },
      { userContextWindow: 1024, userMaxOutputTokens: 2048 }, { capacityDefaults: ['contextWindow', 'contextWindow'] },
      { capacityDefaults: ['context_window'] }, { capacityDefaults: 'contextWindow' },
    ]) expect(() => parseHalluCodexHostConfiguration({ ...configuration(), models: [{ ...model, ...invalid }] })).toThrow('invalid model capacity')
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
    const owner = await ctx.plugin((scope) => { update = installHalluCodexProvider(scope, configuration(), refuseSave) })
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
    await ctx.plugin((scope) => { update = installHalluCodexProvider(scope, initial, refuseSave) })
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

describe('vendor reasoning', () => {
  const capacity = { contextWindow: 200_000, maxOutputTokens: 32_000 }

  it('offers the vendor catalog effort levels only for a matching id and protocol', async () => {
    const ctx = new Context(); await ctx.plugin(LlmRuntime)
    disposers.push(() => ctx.fiber.dispose())
    await ctx.plugin((scope) => {
      installHalluCodexProvider(scope, { ...configuration(), models: [
        { id: 'claude-opus-4-7', endpoints: ['/v1/messages'], ...capacity },
        { id: 'gpt-5.1', endpoints: ['/v1/responses'], ...capacity },
        { id: 'gpt-5.2', endpoints: ['/v1/chat/completions'], ...capacity },
        { id: 'fixture-model', endpoints: ['/v1/chat/completions'], ...capacity },
        { id: 'qwen3.8-max', endpoints: ['/v1/chat/completions'], ...capacity },
        { id: 'deepseek-v4-pro', endpoints: ['/v1/chat/completions'], ...capacity },
        { id: 'deepseek-v4-flash', endpoints: ['/v1/chat/completions'], ...capacity },
      ] }, refuseSave)
    })
    const efforts = async (provider: string, model: string) =>
      (await ctx.llm.resolveModelInfo(provider, model)).reasoning?.efforts.map(effort => String(effort.id))
    expect(await efforts('hallucodex-anthropic', 'claude-opus-4-7')).toEqual(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
    expect(await efforts('hallucodex-responses', 'gpt-5.1')).toEqual(['off', 'low', 'medium', 'high'])
    expect(await efforts('hallucodex-chat', 'gpt-5.2')).toBeUndefined()
    expect(await efforts('hallucodex-chat', 'fixture-model')).toBeUndefined()
    expect(await efforts('hallucodex-chat', 'qwen3.8-max')).toEqual(['low', 'medium', 'xhigh'])
    // DeepSeek's own entry wins over Alibaba's hosted copy, and a DeepSeek id only Alibaba hosts stays without levels.
    expect(await efforts('hallucodex-chat', 'deepseek-v4-pro')).toEqual(['off', 'high', 'max'])
    expect(await efforts('hallucodex-chat', 'deepseek-v4-flash')).toBeUndefined()
  })

  it('requests thinking with the vendor wire controls through the relay', async () => {
    const bodies = new Map<string, string>()
    const server = createServer((request, response) => {
      let body = ''
      request.setEncoding('utf8')
      request.on('data', (chunk: string) => { body += chunk })
      request.on('end', () => {
        bodies.set(`${(request.url ?? '').split('?')[0] ?? ''} ${String((JSON.parse(body) as { model?: unknown }).model)}`, body)
        response.statusCode = 400
        response.setHeader('content-type', 'application/json')
        response.end('{"error":{"type":"invalid_request_error","message":"fixture"}}')
      })
    })
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    disposers.push(() => new Promise<void>((resolve, reject) => { server.close((error) => { if (error) reject(error); else resolve() }) }))
    const port = (server.address() as AddressInfo).port
    const ctx = new Context(); await ctx.plugin(LlmRuntime)
    disposers.push(() => ctx.fiber.dispose())
    await ctx.plugin((scope) => {
      installHalluCodexProvider(scope, { ...configuration(`http://127.0.0.1:${String(port)}`), models: [
        { id: 'claude-opus-4-7', endpoints: ['/v1/messages'], ...capacity },
        { id: 'deepseek-v4-pro', endpoints: ['/v1/chat/completions'], ...capacity },
        { id: 'qwen3.8-max', endpoints: ['/v1/chat/completions'], ...capacity },
      ] }, refuseSave)
    })
    const requests = [
      ['hallucodex-anthropic', 'claude-opus-4-7', 'high'], ['hallucodex-chat', 'deepseek-v4-pro', 'high'], ['hallucodex-chat', 'qwen3.8-max', 'medium'],
    ] as const
    for (const [provider, model, effort] of requests) {
      const prepared = await ctx.llm.prepareCall({ provider, model, reasoningEffort: ReasoningEffortId(effort) })
      const message = createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'model', provider, model } })
      try {
        for await (const _chunk of prepared.stream({ ...prepared.config, system: 'Fixture instructions.', messages: [message] })) { /* drain */ }
      } catch (_fixtureRejection) { /* the fixture server refuses every request after recording its body */ }
    }
    expect(JSON.parse(bodies.get('/v1/messages claude-opus-4-7') ?? '{}')).toMatchObject({
      thinking: { type: 'adaptive' }, output_config: { effort: 'high' },
    })
    expect(JSON.parse(bodies.get('/v1/chat/completions deepseek-v4-pro') ?? '{}')).toMatchObject({
      thinking: { type: 'enabled' }, reasoning_effort: 'high', messages: [{ role: 'system' }, { role: 'user' }],
    })
    expect(JSON.parse(bodies.get('/v1/chat/completions qwen3.8-max') ?? '{}')).toMatchObject({
      enable_thinking: true, reasoning_effort: 'medium', messages: [{ role: 'system' }, { role: 'user' }],
    })
  })
})

describe('one route per model', () => {
  const capacity = { contextWindow: 200_000, maxOutputTokens: 32_000 }
  const all = ['/v1/chat/completions', '/v1/responses', '/v1/messages']
  const models = [
    { id: 'claude-opus-4-7', endpoints: all, ...capacity },
    { id: 'gpt-5.1', endpoints: all, ...capacity },
    { id: 'deepseek-v4-pro', endpoints: all, ...capacity },
    { id: 'fixture-model', endpoints: all, ...capacity },
    { id: 'fixture-responses', endpoints: ['/v1/messages', '/v1/responses'], ...capacity },
    { id: 'fixture-messages', endpoints: ['/v1/messages'], ...capacity },
    // Newer than the installed catalog: placed by name family.
    { id: 'claude-sonnet-9-9', endpoints: all, ...capacity },
    { id: 'gpt-9', endpoints: all, ...capacity },
    { id: 'deepseek-flash', endpoints: ['/v1/responses', '/v1/chat/completions'], ...capacity },
  ]

  it('lists a model under its vendor or name-family protocol, otherwise under the first advertised endpoint', async () => {
    const ctx = new Context(); await ctx.plugin(LlmRuntime)
    disposers.push(() => ctx.fiber.dispose())
    await ctx.plugin((scope) => { installHalluCodexProvider(scope, { ...configuration(), models }, refuseSave) })
    const listed = async (provider: string) => (await ctx.llm.listModels(provider)).map(model => model.id)
    expect(await listed('hallucodex-chat')).toEqual(['deepseek-v4-pro', 'fixture-model', 'deepseek-flash'])
    expect(await listed('hallucodex-responses')).toEqual(['gpt-5.1', 'fixture-responses', 'gpt-9'])
    expect(await listed('hallucodex-anthropic')).toEqual(['claude-opus-4-7', 'fixture-messages', 'claude-sonnet-9-9'])
    expect((await ctx.llm.resolveModelInfo('hallucodex-anthropic', 'claude-sonnet-9-9')).reasoning).toBeUndefined()
  })

  it('moves a saved default selection to the route that lists its model', () => {
    const applied = parseHalluCodexHostConfiguration({ ...configuration(), models })
    expect(halluCodexDefaultSelection(applied, { provider: 'deepseek-official', model: 'deepseek-v4-pro' }))
      .toEqual({ provider: 'hallucodex-responses', model: 'select-a-model' })
    expect(halluCodexDefaultSelection(applied, { provider: 'hallucodex-responses', model: 'deepseek-v4-pro', reasoningEffort: ReasoningEffortId('high') }))
      .toEqual({ provider: 'hallucodex-chat', model: 'deepseek-v4-pro' })
    expect(halluCodexDefaultSelection(applied, { provider: 'hallucodex-chat', model: 'deepseek-v4-pro' })).toBeUndefined()
    expect(halluCodexDefaultSelection(applied, { provider: 'hallucodex-chat', model: 'withdrawn-model' })).toBeUndefined()
    expect(halluCodexDefaultSelection(applied, { provider: 'hallucodex-responses', model: 'select-a-model' })).toBeUndefined()
  })
})

describe('model capacities', () => {
  const defaults = ['contextWindow', 'maxOutputTokens'] as const
  const server = { contextWindow: 128_000, maxOutputTokens: 8192 }
  const chat = ['/v1/chat/completions']
  const models = [
    // Server defaults give way to the vendor catalog entry, which only sizes the model.
    { id: 'deepseek-v4-pro', endpoints: chat, ...server, capacityDefaults: defaults },
    // Server metadata is the deployment's choice and caps every request.
    { id: 'claude-opus-4-7', endpoints: ['/v1/messages'], contextWindow: 200_000, maxOutputTokens: 32_000 },
    // Without a vendor entry the server defaults stay.
    { id: 'fixture-model', endpoints: chat, ...server, capacityDefaults: defaults },
    // The user's value wins; the side the user left alone follows the catalog.
    { id: 'gpt-5.1', endpoints: ['/v1/responses'], ...server, capacityDefaults: defaults, userContextWindow: 300_000 },
    // A configured output above the catalog window moves the defaulted window up, as the server does.
    { id: 'glm-5.3', endpoints: chat, contextWindow: 1_200_000, maxOutputTokens: 1_200_000, capacityDefaults: ['contextWindow' as const] },
    // A catalog output above the user's window is fitted to it.
    { id: 'kimi-k2.7-code', endpoints: chat, ...server, capacityDefaults: defaults, userContextWindow: 100_000 },
    // No server figure and no vendor entry: runnable only with the user's own values.
    { id: 'bare-model', endpoints: chat },
    { id: 'user-model', endpoints: chat, userContextWindow: 64_000, userMaxOutputTokens: 4096 },
  ]

  const routed = [
    ['hallucodex-chat', 'deepseek-v4-pro'], ['hallucodex-anthropic', 'claude-opus-4-7'], ['hallucodex-chat', 'fixture-model'],
    ['hallucodex-responses', 'gpt-5.1'], ['hallucodex-chat', 'glm-5.3'], ['hallucodex-chat', 'kimi-k2.7-code'],
    ['hallucodex-chat', 'bare-model'], ['hallucodex-chat', 'user-model'],
  ] as const

  it('takes each capacity from the user, server metadata, the vendor catalog, then the server default', async () => {
    const ctx = new Context(); await ctx.plugin(LlmRuntime)
    disposers.push(() => ctx.fiber.dispose())
    const owner = await ctx.plugin((scope) => { installHalluCodexProvider(scope, { ...configuration(), models }, refuseSave) })
    const capacities = ctx.get('modelCapacity')
    expect(routed.map(([provider, model]) => capacities?.describe(provider, model))).toEqual([
      { contextWindow: 1_000_000, contextSource: 'catalog', maxOutputTokens: 384_000, outputSource: 'catalog',
        automaticContextWindow: 1_000_000, automaticMaxOutputTokens: 384_000 },
      { contextWindow: 200_000, contextSource: 'provider', maxOutputTokens: 32_000, outputSource: 'provider',
        automaticContextWindow: 200_000, automaticMaxOutputTokens: 32_000 },
      { contextWindow: 128_000, contextSource: 'default', maxOutputTokens: 8192, outputSource: 'default',
        automaticContextWindow: 128_000, automaticMaxOutputTokens: 8192 },
      { contextWindow: 300_000, contextSource: 'user', maxOutputTokens: 128_000, outputSource: 'catalog',
        automaticContextWindow: 400_000, automaticMaxOutputTokens: 128_000 },
      { contextWindow: 1_200_000, contextSource: 'catalog', maxOutputTokens: 1_200_000, outputSource: 'provider',
        automaticContextWindow: 1_200_000, automaticMaxOutputTokens: 1_200_000 },
      { contextWindow: 100_000, contextSource: 'user', maxOutputTokens: 100_000, outputSource: 'catalog',
        automaticContextWindow: 262_144, automaticMaxOutputTokens: 262_144 },
      {},
      { contextWindow: 64_000, contextSource: 'user', maxOutputTokens: 4096, outputSource: 'user' },
    ])
    expect(capacities?.describe('hallucodex-responses', 'deepseek-v4-pro')).toBeUndefined()
    expect(capacities?.describe('hallucodex-chat', 'missing-model')).toBeUndefined()
    await owner.dispose()
    expect(ctx.get('modelCapacity')).toBeUndefined()
  })

  it('saves a change of a model on its route through the main process', async () => {
    const ctx = new Context(); await ctx.plugin(LlmRuntime)
    disposers.push(() => ctx.fiber.dispose())
    let update: ((configuration: unknown) => void) | undefined
    const save = vi.fn<HalluCodexCapacitySaver>(async (model, contextWindow) => {
      await Promise.resolve()
      update?.({ ...configuration(), revision: 3, models: models.map(entry => entry.id === model && contextWindow !== null
        ? { ...entry, userContextWindow: contextWindow } : entry) })
    })
    await ctx.plugin((scope) => { update = installHalluCodexProvider(scope, { ...configuration(), models }, save) })
    const capacities = ctx.get('modelCapacity')
    await capacities?.set({ provider: 'hallucodex-chat', model: 'fixture-model', contextWindow: 64_000, maxOutputTokens: null })
    expect(save).toHaveBeenCalledExactlyOnceWith('fixture-model', 64_000, null)
    expect(capacities?.describe('hallucodex-chat', 'fixture-model')).toMatchObject({ contextWindow: 64_000, contextSource: 'user' })
    expect((await ctx.llm.resolveModelInfo('hallucodex-chat', 'fixture-model')).context?.contextWindow).toBe(64_000)
    await expect(capacities?.set({ provider: 'hallucodex-responses', model: 'fixture-model', contextWindow: null, maxOutputTokens: null }))
      .rejects.toThrow('is not listed on "hallucodex-responses"')
    expect(save).toHaveBeenCalledOnce()
  })

  it('caps requests only with a chosen output limit and lists a model only with both capacities', async () => {
    const ctx = new Context(); await ctx.plugin(LlmRuntime)
    disposers.push(() => ctx.fiber.dispose())
    await ctx.plugin((scope) => { installHalluCodexProvider(scope, { ...configuration(), models }, refuseSave) })
    const info = async (provider: string, model: string) => {
      const resolved = await ctx.llm.resolveModelInfo(provider, model)
      return { contextWindow: resolved.context?.contextWindow, defaultMaxTokens: resolved.defaultMaxTokens }
    }
    expect(await info('hallucodex-chat', 'deepseek-v4-pro')).toEqual({ contextWindow: 1_000_000, defaultMaxTokens: undefined })
    expect(await info('hallucodex-anthropic', 'claude-opus-4-7')).toEqual({ contextWindow: 200_000, defaultMaxTokens: 32_000 })
    expect(await info('hallucodex-chat', 'fixture-model')).toEqual({ contextWindow: 128_000, defaultMaxTokens: 8192 })
    expect(await info('hallucodex-responses', 'gpt-5.1')).toEqual({ contextWindow: 300_000, defaultMaxTokens: undefined })
    expect(await info('hallucodex-chat', 'user-model')).toEqual({ contextWindow: 64_000, defaultMaxTokens: 4096 })
    expect((await ctx.llm.listModels('hallucodex-chat')).map(model => model.id)).not.toContain('bare-model')
    const applied = parseHalluCodexHostConfiguration({ ...configuration(), models })
    expect(halluCodexDefaultSelection(applied, { provider: 'hallucodex-responses', model: 'bare-model' })).toBeUndefined()
  })

  it('sends the catalog output limit as the model size of a request', async () => {
    const bodies = new Map<string, Record<string, unknown>>()
    const server = createServer((request, response) => {
      let body = ''
      request.setEncoding('utf8')
      request.on('data', (chunk: string) => { body += chunk })
      request.on('end', () => {
        const parsed = JSON.parse(body) as Record<string, unknown>
        bodies.set(String(parsed.model), parsed)
        response.statusCode = 400
        response.setHeader('content-type', 'application/json')
        response.end('{"error":{"type":"invalid_request_error","message":"fixture"}}')
      })
    })
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    disposers.push(() => new Promise<void>((resolve, reject) => { server.close((error) => { if (error) reject(error); else resolve() }) }))
    const ctx = new Context(); await ctx.plugin(LlmRuntime)
    disposers.push(() => ctx.fiber.dispose())
    await ctx.plugin((scope) => {
      installHalluCodexProvider(scope, { ...configuration(`http://127.0.0.1:${String((server.address() as AddressInfo).port)}`), models },
        refuseSave)
    })
    for (const model of ['deepseek-v4-pro', 'fixture-model']) {
      const prepared = await ctx.llm.prepareCall({ provider: 'hallucodex-chat', model })
      const message = createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'model', provider: 'hallucodex-chat', model } })
      try {
        for await (const _chunk of prepared.stream({ ...prepared.config, messages: [message] })) { /* drain */ }
      } catch (_fixtureRejection) { /* the fixture server refuses every request after recording its body */ }
    }
    const limit = (model: string) => bodies.get(model)?.max_tokens ?? bodies.get(model)?.max_completion_tokens
    expect(limit('deepseek-v4-pro')).toBe(384_000)
    expect(limit('fixture-model')).toBe(8192)
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
