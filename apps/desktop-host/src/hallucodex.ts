/** Private native-to-Host model publication; no upstream account credentials enter the Host. */
import type { Context } from '@deepseek-ai/cordis'
import type { AdapterRegistrationHandle } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import { resolveProfiles } from '@deepseek-ai/dsh-llm-pi-ai/profiles'
import type { PiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import type {} from '@deepseek-ai/dsh-system-prompt'

/** Native authenticated catalog entry; model capacity must come from explicit server metadata. */
export interface HalluCodexHostModel {
  readonly id: string
  readonly endpoints: readonly string[]
  readonly contextWindow?: number
  readonly maxOutputTokens?: number
}

/** Main-to-Host private message. localCapability grants only access to this process's limited loopback relay. */
export interface HalluCodexHostConfiguration {
  readonly type: 'hallucodex-config'
  readonly baseURL: string
  readonly localCapability: string
  readonly revision: number
  readonly models: readonly HalluCodexHostModel[]
}

const routes = [
  { id: 'hallucodex-chat', name: 'HalluCodex Chat', endpoint: '/v1/chat/completions', api: 'openai-completions' },
  { id: 'hallucodex-responses', name: 'HalluCodex Responses', endpoint: '/v1/responses', api: 'openai-responses' },
  { id: 'hallucodex-anthropic', name: 'HalluCodex Messages', endpoint: '/v1/messages', api: 'anthropic-messages' },
] as const

/**
 * Validate a main-process IPC configuration before it can change model routing.
 * @param value - untrusted process message.
 * @returns a detached configuration with bounded local credentials and model data.
 */
export function parseHalluCodexHostConfiguration(value: unknown): HalluCodexHostConfiguration {
  if (typeof value !== 'object' || value === null || !('type' in value) || value.type !== 'hallucodex-config'
    || !('baseURL' in value) || typeof value.baseURL !== 'string'
    || !('localCapability' in value) || typeof value.localCapability !== 'string'
    || !/^[A-Za-z0-9_-]{43,128}$/u.test(value.localCapability)
    || !('revision' in value) || typeof value.revision !== 'number' || !Number.isSafeInteger(value.revision) || value.revision < 0
    || !('models' in value) || !Array.isArray(value.models) || value.models.length > 10_000) {
    throw new Error('hallucodex Host: invalid native configuration')
  }
  const url = new URL(value.baseURL)
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password
    || url.pathname !== '/' || url.search || url.hash || url.origin !== value.baseURL) {
    throw new Error('hallucodex Host: relay must use exact numeric loopback')
  }
  const models: HalluCodexHostModel[] = []
  const seen = new Set<string>()
  for (const raw of value.models) {
    const model: unknown = raw
    if (typeof model !== 'object' || model === null || !('id' in model) || typeof model.id !== 'string'
      || model.id.length < 1 || model.id.length > 512 || /[\u0000-\u001f\u007f]/u.test(model.id)
      || !('endpoints' in model) || !Array.isArray(model.endpoints)
      || !model.endpoints.every((endpoint: unknown) => typeof endpoint === 'string' && routes.some(route => route.endpoint === endpoint))) {
      throw new Error('hallucodex Host: invalid model metadata')
    }
    if (seen.has(model.id)) throw new Error('hallucodex Host: duplicate model')
    seen.add(model.id)
    // Missing capacities remain visible in the account catalog but cannot be advertised as runnable models.
    if (!('contextWindow' in model) || !('maxOutputTokens' in model)) continue
    if (typeof model.contextWindow !== 'number' || !Number.isSafeInteger(model.contextWindow) || model.contextWindow < 1
      || typeof model.maxOutputTokens !== 'number' || !Number.isSafeInteger(model.maxOutputTokens) || model.maxOutputTokens < 1
      || model.maxOutputTokens > model.contextWindow) throw new Error('hallucodex Host: invalid model capacity')
    models.push({
      id: model.id, endpoints: model.endpoints.map((endpoint: string) => endpoint),
      contextWindow: model.contextWindow, maxOutputTokens: model.maxOutputTokens,
    })
  }
  return { type: 'hallucodex-config', baseURL: url.origin, localCapability: value.localCapability, revision: value.revision, models }
}

/**
 * Register three protocol-specific native routes in the actual Harness LLM runtime.
 * @param ctx - owned Host plugin context with the LLM service available.
 * @param initial - authenticated native configuration.
 * @returns a model publication updater; registration disposal belongs to ctx.
 */
export function installHalluCodexProvider(ctx: Context, initial: HalluCodexHostConfiguration): (value: unknown) => void {
  let current = parseHalluCodexHostConfiguration(initial)
  const profiles = (configuration: HalluCodexHostConfiguration) => {
    const providers: Record<string, PiAiProviderProfile> = {}
    for (const route of routes) {
      providers[route.id] = {
        displayName: route.name, api: route.api,
        baseURL: route.api === 'anthropic-messages' ? configuration.baseURL : `${configuration.baseURL}/v1`,
        retryPolicy: { mode: 'normal', maxRetries: 0 },
        headers: { 'x-hallucodex-revision': String(configuration.revision) },
        models: configuration.models.flatMap((model) => {
          if (!model.endpoints.includes(route.endpoint) || model.contextWindow === undefined
            || model.maxOutputTokens === undefined) return []
          return [{ id: model.id, name: model.id, contextWindow: model.contextWindow, maxTokens: model.maxOutputTokens, input: ['text'] }]
        }),
      }
    }
    return resolveProfiles(providers, 'deferred')
  }
  let resolved = profiles(current)
  const adapter = new PiAiAdapter({
    profiles: () => resolved,
    resolveApiKey: () => Promise.resolve(current.localCapability),
    auth: {
      credentials: {
        read: () => Promise.resolve(undefined), list: () => Promise.resolve([]),
        modify: () => Promise.reject(new Error('hallucodex Host: provider credential storage is disabled')),
        delete: () => Promise.resolve(),
      },
      authContext: { env: () => Promise.resolve(undefined), fileExists: () => Promise.resolve(false) },
    },
  })
  const llm = ctx.get('llm')
  if (!llm) throw new Error('hallucodex Host: LLM service unavailable')
  let registration: AdapterRegistrationHandle | undefined
  ctx.effect(() => { registration = llm.registerAdapter(routes.map(route => route.id), adapter); return registration })
  return (value: unknown) => {
    const next = parseHalluCodexHostConfiguration(value)
    if (next.baseURL !== current.baseURL || next.localCapability !== current.localCapability) {
      throw new Error('hallucodex Host: relay identity cannot change during a Host lifetime')
    }
    if (next.revision < current.revision) throw new Error('hallucodex Host: stale native configuration')
    const nextProfiles = profiles(next)
    current = next
    resolved = nextProfiles
    registration?.replace(routes.map(route => route.id))
  }
}

/** Opening line that names the product; the branded profile turns the upstream harness identity off. */
export const HALLUCODEX_IDENTITY = 'You are an AI agent powered by HalluCodex.'

/**
 * Lead every agent's system prompt with the HalluCodex identity, at the placement of the harness opener.
 * Agent-preset personas shadow only the deployment persona sections, so this line reaches every preset.
 * @param ctx - Host root context; the section follows the systemPrompt service across reloads.
 */
export function installHalluCodexIdentity(ctx: Context): void {
  ctx.inject(['systemPrompt'], (promptCtx) => {
    promptCtx.systemPrompt.section({
      name: 'hallucodex:identity',
      order: promptCtx.systemPrompt.getSectionOrder('HARNESS_IDENTITY'),
      text: HALLUCODEX_IDENTITY,
    })
  })
}
