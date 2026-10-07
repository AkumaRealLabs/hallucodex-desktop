/** Native settings reads using the shared Web authentication and RPC APIs. */

import { randomUUID } from 'node:crypto'

/** Metadata read without credential values. */
export interface WelcomeState {
  readonly hasApiKey: boolean
  readonly localePreference: string | null
}

/** Read-only operations available to the Electron shell. */
export interface DesktopWelcomeBackend {
  /** @returns Configured-key presence across configurable providers and the shared language preference, without credential values. */
  read(): Promise<WelcomeState>
  /** @returns The saved UI language without account or provider requests. */
  readLocalePreference(): Promise<string | null>
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Authenticate the native HTTP client through the Web application's launch URL.
 * @param authenticatedUrl - URL supplied by the running Desktop Host.
 * @param send - Electron session fetch, retaining the Web authentication cookie.
 * @returns metadata reads over standard RPC.
 */
export async function connectDesktopWelcome(
  authenticatedUrl: string,
  send: (input: string, init?: RequestInit) => Promise<Response>,
): Promise<DesktopWelcomeBackend> {
  const origin = new URL(authenticatedUrl).origin
  const authenticated = await send(authenticatedUrl, { credentials: 'include' })
  await authenticated.body?.cancel()
  if (!authenticated.ok) throw new Error('desktop welcome: Web authentication failed')
  const invoke = async (request: { namespace: string; method: string; args: Record<string, unknown> }): Promise<unknown> => {
    const rpcId = randomUUID()
    const method = `${request.namespace}/${request.method}`
    const response = await send(new URL(`/api/${method}`, origin).href, {
      method: 'POST', credentials: 'include', redirect: 'error',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args: request.args } }),
    })
    if (!response.ok) throw new Error('desktop welcome: Web request failed')
    const envelope: unknown = await response.json()
    if (!record(envelope) || envelope.type !== 'server-response' || envelope.rpcId !== rpcId
      || !record(envelope.result) || envelope.result.ok !== true) {
      throw new Error('desktop welcome: Web RPC failed')
    }
    return envelope.result.value
  }
  const settingsNamespaces = async (): Promise<unknown[]> => {
    const settings = await invoke({ namespace: 'settings', method: 'describe', args: {} })
    if (!record(settings) || !Array.isArray(settings.namespaces)) throw new Error('desktop welcome: missing settings namespaces')
    const namespaces: unknown[] = settings.namespaces
    return namespaces
  }
  const localePreference = (namespaces: unknown[]): string | null => {
    const locale: unknown = namespaces.find((item: unknown) => record(item) && item.ns === 'locale')
    if (!record(locale) || !record(locale.value)
      || (locale.value.preference !== undefined && typeof locale.value.preference !== 'string')) {
      throw new Error('desktop welcome: invalid locale preference')
    }
    return locale.value.preference ?? null
  }
  return {
    async read() {
      const namespaces = await settingsNamespaces()
      const providers = await invoke({ namespace: 'llm', method: 'listConfigurableProviders', args: {} })
      if (!Array.isArray(providers)) throw new Error('desktop welcome: invalid provider directory')
      const refs = providers.flatMap((provider: unknown) => {
        if (!record(provider) || typeof provider.settingsNs !== 'string' || !Array.isArray(provider.settingsPath)) {
          throw new Error('desktop welcome: invalid provider settings address')
        }
        const namespace: unknown = namespaces.find((item: unknown) => record(item) && item.ns === provider.settingsNs)
        let value: unknown = record(namespace) ? namespace.value : undefined
        for (const key of provider.settingsPath as unknown[]) {
          if (typeof key !== 'string') throw new Error('desktop welcome: invalid provider settings path')
          value = record(value) ? value[key] : undefined
        }
        return record(value) && typeof value.apiKeyEnv === 'string' ? [value.apiKeyEnv] : []
      })
      const unique = [...new Set(refs)]
      const states: Record<string, unknown> = {}
      // credentials.describe accepts at most 64 references per request.
      for (let offset = 0; offset < unique.length; offset += 64) {
        const batch = await invoke({ namespace: 'credentials', method: 'describe', args: { refs: unique.slice(offset, offset + 64) } })
        if (!record(batch)) throw new Error('desktop welcome: invalid credential metadata')
        Object.assign(states, batch)
      }
      return {
        hasApiKey: Object.values(states).some(value => record(value) && value.configured === true),
        localePreference: localePreference(namespaces),
      }
    },
    async readLocalePreference() {
      return localePreference(await settingsNamespaces())
    },
  }
}
