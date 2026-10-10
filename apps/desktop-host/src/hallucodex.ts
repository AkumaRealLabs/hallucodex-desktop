/** Private native-to-Host model publication; no upstream account credentials enter the Host. */
import type { Context } from '@deepseek-ai/cordis'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import type { AdapterRegistrationHandle } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import { resolveProfiles } from '@deepseek-ai/dsh-llm-pi-ai/profiles'
import type { PiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import type { AnthropicMessagesCompat, Api, Model, OpenAICompletionsCompat } from '@earendil-works/pi-ai'
import { getBuiltinModels, type BuiltinProvider } from '@earendil-works/pi-ai/providers/all'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { ModelCapacity, ModelCapacityRequest, ModelCapacitySource } from '@deepseek-ai/dsh-api-session-controller/types'

/** Capacity fields of a relayed model. */
export type HalluCodexCapacityField = 'contextWindow' | 'maxOutputTokens'

/** Native authenticated catalog entry with the user's own capacities for it. */
export interface HalluCodexHostModel {
  readonly id: string
  readonly endpoints: readonly string[]
  /** Server-published context window; absent when the server publishes none. */
  readonly contextWindow?: number
  /** Server-published output limit; absent when the server publishes none. */
  readonly maxOutputTokens?: number
  /** Server-published capacities that are server defaults rather than model metadata. */
  readonly capacityDefaults?: readonly HalluCodexCapacityField[]
  /** Context window the user set for this model on this server. */
  readonly userContextWindow?: number
  /** Output limit the user set for this model on this server. */
  readonly userMaxOutputTokens?: number
}

/**
 * Host-to-main request to replace the user's capacities of one model on the signed-in server; null restores the
 * automatic value. The main process answers with the same type and request id, and an error when it refuses or cannot
 * save, after it has sent the configuration that applies the change.
 */
export interface HalluCodexCapacityRequest {
  readonly type: 'hallucodex-set-capacity'
  readonly requestId: number
  readonly model: string
  readonly contextWindow: number | null
  readonly maxOutputTokens: number | null
}

/**
 * Saves the user's capacities of one model through the main process.
 * @param model - model id from the applied configuration.
 * @param contextWindow - positive context window, or null for the automatic value.
 * @param maxOutputTokens - positive output limit, or null for the automatic value.
 * @returns settles after the configuration that applies the change has been delivered; rejects when it is refused.
 */
export type HalluCodexCapacitySaver = (model: string, contextWindow: number | null, maxOutputTokens: number | null) => Promise<void>

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

const isCapacityField = (value: unknown): value is HalluCodexCapacityField => value === 'contextWindow' || value === 'maxOutputTokens'

/**
 * Read one optional token count of an untrusted model entry.
 * @param model - entry object.
 * @param field - property name.
 * @returns the positive safe integer, or undefined when the property is absent.
 */
function capacityField(model: object, field: string): number | undefined {
  const value: unknown = Reflect.get(model, field)
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new Error('hallucodex Host: invalid model capacity')
  return value
}

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
    const contextWindow = capacityField(model, 'contextWindow')
    const maxOutputTokens = capacityField(model, 'maxOutputTokens')
    const userContextWindow = capacityField(model, 'userContextWindow')
    const userMaxOutputTokens = capacityField(model, 'userMaxOutputTokens')
    const defaults: unknown = Reflect.get(model, 'capacityDefaults')
    if ((contextWindow !== undefined && maxOutputTokens !== undefined && maxOutputTokens > contextWindow)
      || (userContextWindow !== undefined && userMaxOutputTokens !== undefined && userMaxOutputTokens > userContextWindow)
      || (defaults !== undefined && (!Array.isArray(defaults) || defaults.length > 2 || new Set(defaults).size !== defaults.length
        || !defaults.every((field: unknown) => field === 'contextWindow' || field === 'maxOutputTokens')))) {
      throw new Error('hallucodex Host: invalid model capacity')
    }
    models.push({
      id: model.id, endpoints: model.endpoints.map((endpoint: string) => endpoint),
      ...contextWindow === undefined ? {} : { contextWindow },
      ...maxOutputTokens === undefined ? {} : { maxOutputTokens },
      ...Array.isArray(defaults) && defaults.length > 0 ? { capacityDefaults: defaults.filter(isCapacityField) } : {},
      ...userContextWindow === undefined ? {} : { userContextWindow },
      ...userMaxOutputTokens === undefined ? {} : { userMaxOutputTokens },
    })
  }
  return { type: 'hallucodex-config', baseURL: url.origin, localCapability: value.localCapability, revision: value.revision, models }
}

/**
 * pi-ai catalog providers run by the vendor that makes their models, in lookup order, each limited to its own models
 * when it also hosts other vendors'. Gateway catalogs are excluded: their reasoning wire values target the gateway's
 * own API rather than the vendor behind the relay.
 */
const REASONING_CATALOGS: readonly { readonly provider: BuiltinProvider; readonly ownModels?: RegExp }[] = [
  { provider: 'anthropic' }, { provider: 'openai' }, { provider: 'xai' }, { provider: 'meta' }, { provider: 'deepseek' },
  { provider: 'moonshotai' }, { provider: 'kimi-coding' }, { provider: 'zai' }, { provider: 'minimax' }, { provider: 'xiaomi' },
  { provider: 'ant-ling' },
  // Alibaba's token plan also serves DeepSeek, GLM, Kimi and MiniMax models with Alibaba's thinking parameters.
  { provider: 'qwen-token-plan', ownModels: /^qwen/u },
]

/** Anthropic Messages switches that decide how thinking is requested and replayed. */
const ANTHROPIC_REASONING_COMPAT = ['forceAdaptiveThinking', 'allowEmptySignature'] as const satisfies readonly (keyof AnthropicMessagesCompat)[]

/** Chat Completions switches that decide how thinking is requested and replayed, and which instruction role a reasoning model gets. */
const COMPLETIONS_REASONING_COMPAT = [
  'thinkingFormat', 'supportsReasoningEffort', 'supportsDeveloperRole', 'requiresReasoningContentOnAssistantMessages',
  'requiresThinkingAsText', 'chatTemplateKwargs', 'chatTemplateArgs', 'supportsThinkingTokenBudget', 'thinkingTokenBudgetField',
] as const satisfies readonly (keyof OpenAICompletionsCompat)[]

/** Lookup tables over {@link REASONING_CATALOGS}, built on first use. */
interface VendorCatalogIndex {
  /** First vendor entry for each protocol and model id. */
  readonly models: ReadonlyMap<string, Model<Api>>
  /** Protocols of the vendor entries in each model name family. */
  readonly families: ReadonlyMap<string, ReadonlySet<string>>
}

let vendorCatalog: VendorCatalogIndex | undefined

const catalogKey = (api: string, id: string) => `${api}\n${id}`

/** Leading letters of a model id, lowercased, such as `claude` or `gpt`: one vendor names a family with them. */
const modelFamily = (id: string) => /^[a-z]+/u.exec(id.toLowerCase())?.[0]

function vendorCatalogIndex(): VendorCatalogIndex {
  if (vendorCatalog === undefined) {
    const models = new Map<string, Model<Api>>()
    const families = new Map<string, Set<string>>()
    for (const { provider, ownModels } of REASONING_CATALOGS) {
      for (const model of getBuiltinModels(provider)) {
        if (ownModels !== undefined && !ownModels.test(model.id)) continue
        const key = catalogKey(model.api, model.id)
        if (!models.has(key)) models.set(key, model)
        const family = modelFamily(model.id)
        if (family !== undefined) families.set(family, (families.get(family) ?? new Set()).add(model.api))
      }
    }
    vendorCatalog = { models, families }
  }
  return vendorCatalog
}

/** First vendor catalog entry for each protocol and model id. */
function vendorCatalogModel(api: string, id: string): Model<Api> | undefined {
  return vendorCatalogIndex().models.get(catalogKey(api, id))
}

function speaks<T extends Api>(model: Model<Api>, api: T): model is Model<T> {
  return model.api === api
}

function definedFields<T extends object, K extends keyof T>(source: T | undefined, fields: readonly K[]): Partial<Pick<T, K>> {
  const picked: Partial<Pick<T, K>> = {}
  for (const field of fields) {
    if (source?.[field] !== undefined) picked[field] = source[field]
  }
  return picked
}

/**
 * Give a relayed model the reasoning of the vendor catalog entry with the same id and protocol. The entry's effort
 * levels and its thinking-related compat switches carry over; capacity, modalities, cost and every other vendor
 * switch stay as given, and a model without a reasoning vendor entry is returned unchanged.
 * @param model - materialized relay model.
 * @returns the model, reasoning like its vendor entry when one exists.
 */
function withVendorReasoning(model: Model<Api>): Model<Api> {
  const vendor = vendorCatalogModel(model.api, model.id)
  if (vendor?.reasoning !== true) return model
  const reasoning = {
    reasoning: true,
    ...vendor.thinkingLevelMap === undefined ? {} : { thinkingLevelMap: { ...vendor.thinkingLevelMap } },
  }
  if (speaks(model, 'anthropic-messages') && speaks(vendor, 'anthropic-messages')) {
    return { ...model, ...reasoning, compat: { ...model.compat, ...definedFields(vendor.compat, ANTHROPIC_REASONING_COMPAT) } }
  }
  if (speaks(model, 'openai-completions') && speaks(vendor, 'openai-completions')) {
    return { ...model, ...reasoning, compat: { ...model.compat, ...definedFields(vendor.compat, COMPLETIONS_REASONING_COMPAT) } }
  }
  return { ...model, ...reasoning }
}

/**
 * Pick the one route that lists a model, among its advertised endpoints: the protocol of its vendor catalog entry,
 * otherwise a protocol of the vendor entries in its name family, which places a model newer than the installed catalog
 * beside its siblings, otherwise the first advertised route. Ties follow Chat Completions, Responses, Messages order;
 * New API exposes Chat Completions for most channel types and lists endpoints in that fixed order, so the order says
 * nothing about a channel. A family match only places the model and grants no reasoning levels.
 * @param model - authenticated catalog entry.
 * @returns the route, or undefined when the model advertises no relay endpoint.
 */
function modelRoute(model: HalluCodexHostModel): (typeof routes)[number] | undefined {
  const advertised = routes.filter(route => model.endpoints.includes(route.endpoint))
  const family = modelFamily(model.id)
  const familyProtocols = family === undefined ? undefined : vendorCatalogIndex().families.get(family)
  return advertised.find(route => vendorCatalogModel(route.api, model.id) !== undefined)
    ?? advertised.find(route => familyProtocols?.has(route.api) === true)
    ?? advertised[0]
}

/** One effective capacity and where it comes from. */
interface CapacityValue {
  readonly value: number
  readonly source: ModelCapacitySource
}

/** Effective capacities of a runnable model. */
interface ResolvedCapacity {
  readonly context: CapacityValue
  readonly output: CapacityValue
}

/** Vendor catalog entry with the model's id and the protocol of its route. */
function vendorEntry(model: HalluCodexHostModel): Model<Api> | undefined {
  const route = modelRoute(model)
  return route === undefined ? undefined : vendorCatalogModel(route.api, model.id)
}

const CAPACITY_PRECEDENCE: Readonly<Record<ModelCapacitySource, number>> = { user: 3, provider: 2, catalog: 1, default: 0 }

function capacityValue(
  model: HalluCodexHostModel, field: HalluCodexCapacityField, vendor: Model<Api> | undefined, withUser: boolean,
): CapacityValue | undefined {
  const user = field === 'contextWindow' ? model.userContextWindow : model.userMaxOutputTokens
  if (withUser && user !== undefined) return { value: user, source: 'user' }
  const server = model[field]
  if (server !== undefined && model.capacityDefaults?.includes(field) !== true) return { value: server, source: 'provider' }
  if (vendor !== undefined) return { value: field === 'contextWindow' ? vendor.contextWindow : vendor.maxTokens, source: 'catalog' }
  return server === undefined ? undefined : { value: server, source: 'default' }
}

/**
 * Resolve each capacity from the first source that supplies it: the user's value, server metadata, the vendor catalog
 * entry with the same id and protocol, then the server default. An output limit above the context window is fitted
 * like the server fits a defaulted side: the value from the lower-precedence source moves to the other one.
 * @param model - parsed catalog entry.
 * @param withUser - whether the user's own values take part.
 * @returns both capacities, or undefined when a source is missing for either.
 */
function resolveCapacity(model: HalluCodexHostModel, withUser: boolean): ResolvedCapacity | undefined {
  const vendor = vendorEntry(model)
  const context = capacityValue(model, 'contextWindow', vendor, withUser)
  const output = capacityValue(model, 'maxOutputTokens', vendor, withUser)
  if (context === undefined || output === undefined) return undefined
  if (output.value <= context.value) return { context, output }
  return CAPACITY_PRECEDENCE[output.source] > CAPACITY_PRECEDENCE[context.source]
    ? { context: { ...context, value: output.value }, output }
    : { context, output: { ...output, value: context.value } }
}

/**
 * Describe one model's capacities: server metadata counts as the provider's, a server default as the default.
 * @param model - parsed catalog entry.
 * @returns the effective values when sources supply both, and the automatic values that apply without the user's own.
 */
function describeCapacity(model: HalluCodexHostModel): ModelCapacity {
  const effective = resolveCapacity(model, true)
  const vendor = vendorEntry(model)
  const automatic = resolveCapacity(model, false)
  const automaticContext = automatic?.context.value ?? capacityValue(model, 'contextWindow', vendor, false)?.value
  const automaticOutput = automatic?.output.value ?? capacityValue(model, 'maxOutputTokens', vendor, false)?.value
  return {
    ...effective === undefined ? {} : {
      contextWindow: effective.context.value, contextSource: effective.context.source,
      maxOutputTokens: effective.output.value, outputSource: effective.output.source,
    },
    ...automaticContext === undefined ? {} : { automaticContextWindow: automaticContext },
    ...automaticOutput === undefined ? {} : { automaticMaxOutputTokens: automaticOutput },
  }
}

/**
 * Correct a saved default model selection for a configuration. A selection outside HalluCodex becomes the unselected
 * placeholder, and a selection of a model the configuration lists on another route moves to that route without its
 * reasoning effort, whose levels belong to the route.
 * @param configuration - applied native configuration.
 * @param saved - current default selection.
 * @returns the selection to save, or undefined when the saved one stands.
 */
export function halluCodexDefaultSelection(configuration: HalluCodexHostConfiguration, saved: ModelSelection): ModelSelection | undefined {
  if (!routes.some(route => route.id === saved.provider)) return { provider: 'hallucodex-responses', model: 'select-a-model' }
  const model = configuration.models.find(entry => entry.id === saved.model)
  const route = model === undefined || resolveCapacity(model, true) === undefined ? undefined : modelRoute(model)
  return route === undefined || route.id === saved.provider ? undefined : { provider: route.id, model: saved.model }
}

/**
 * Register three protocol-specific native routes in the actual Harness LLM runtime. Each model is listed on one route
 * only, chosen by {@link modelRoute}, and only while {@link resolveCapacity} finds both of its capacities. The
 * `modelCapacity` service describes the capacities of each model on its route and saves the user's changes.
 * @param ctx - owned Host plugin context with the LLM service available.
 * @param initial - authenticated native configuration.
 * @param saveCapacity - saves a capacity change through the main process.
 * @returns a model publication updater; registration and service disposal belong to ctx.
 */
export function installHalluCodexProvider(
  ctx: Context, initial: HalluCodexHostConfiguration, saveCapacity: HalluCodexCapacitySaver,
): (value: unknown) => void {
  let current = parseHalluCodexHostConfiguration(initial)
  const routed = (provider: string, id: string) => {
    const model = current.models.find(entry => entry.id === id)
    return model !== undefined && modelRoute(model)?.id === provider ? model : undefined
  }
  const profiles = (configuration: HalluCodexHostConfiguration) => {
    const capacities = new Map(configuration.models.map(model => [model.id, resolveCapacity(model, true)]))
    const providers: Record<string, PiAiProviderProfile> = {}
    for (const route of routes) {
      providers[route.id] = {
        displayName: route.name, api: route.api,
        baseURL: route.api === 'anthropic-messages' ? configuration.baseURL : `${configuration.baseURL}/v1`,
        retryPolicy: { mode: 'normal', maxRetries: 0 },
        headers: { 'x-hallucodex-revision': String(configuration.revision) },
        models: configuration.models.flatMap((model) => {
          const capacity = capacities.get(model.id)
          if (modelRoute(model) !== route || capacity === undefined) return []
          // A chosen output limit caps every request; a catalog figure only sizes the model, as for other pi-ai routes.
          return [{
            id: model.id, name: model.id, contextWindow: capacity.context.value, input: ['text'],
            ...capacity.output.source === 'catalog' ? {} : { maxTokens: capacity.output.value },
          }]
        }),
      }
    }
    const resolvedProfiles = resolveProfiles(providers, 'deferred')
    for (const [route, profile] of resolvedProfiles) {
      const piProvider = profile.piProvider
      if (piProvider === undefined) continue
      const models = piProvider.getModels().map((model) => {
        const output = capacities.get(model.id)?.output
        return withVendorReasoning(output?.source === 'catalog' ? { ...model, maxTokens: output.value } : model)
      })
      resolvedProfiles.set(route, { ...profile, piProvider: { ...piProvider, getModels: () => models } })
    }
    return resolvedProfiles
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
  ctx.provide('modelCapacity', {
    describe: (provider: string, id: string) => {
      const model = routed(provider, id)
      return model === undefined ? undefined : describeCapacity(model)
    },
    set: async ({ provider, model, contextWindow, maxOutputTokens }: ModelCapacityRequest) => {
      if (routed(provider, model) === undefined) throw new Error(`hallucodex Host: model "${model}" is not listed on "${provider}"`)
      await saveCapacity(model, contextWindow, maxOutputTokens)
    },
  })
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
