/** Group-scoped model discovery, limited to protocols exercised by the desktop relay. */
import { concreteGroup } from './group-policy.ts'

/** Protocol paths supported by this desktop request broker. */
export type DesktopEndpoint = '/v1/chat/completions' | '/v1/responses' | '/v1/messages'

/** Model advertised for the exact authenticated device group. */
export interface DesktopModel {
  readonly id: string
  readonly endpoints: readonly DesktopEndpoint[]
  readonly contextWindow?: number
  readonly maxOutputTokens?: number
}

/**
 * Normalize New API endpoint labels without inferring a protocol from model names.
 * @param value - an advertised endpoint label or exact path.
 * @returns supported path, or undefined for a protocol not implemented by this broker.
 */
export function desktopEndpoint(value: string): DesktopEndpoint | undefined {
  switch (value) {
    case 'openai':
    case 'openai-chat':
    case 'openai-completions':
    case '/v1/chat/completions': return '/v1/chat/completions'
    case 'openai-response':
    case 'openai-responses':
    case '/v1/responses': return '/v1/responses'
    case 'anthropic':
    case '/v1/messages': return '/v1/messages'
    default: return undefined
  }
}

/**
 * Read only a catalog bound to the selected concrete group; unknown protocols stay unavailable.
 * @param value - GET /api/desktop/v1/models JSON.
 * @param group - authenticated selected group.
 * @returns immutable models with at least one supported endpoint.
 */
export function parseDesktopModels(value: unknown, group: string): readonly DesktopModel[] {
  concreteGroup(group)
  if (typeof value !== 'object' || value === null || !('group' in value) || value.group !== group
    || !('data' in value) || !Array.isArray(value.data) || value.data.length > 10_000) {
    throw new Error('hallucodex: model catalog group mismatch')
  }
  const models: DesktopModel[] = []
  const seen = new Set<string>()
  for (const candidate of value.data) {
    const entry: unknown = candidate
    if (typeof entry !== 'object' || entry === null || !('id' in entry) || typeof entry.id !== 'string'
      || entry.id.length === 0 || entry.id.length > 512 || entry.id !== entry.id.trim()
      || /[\u0000-\u001f\u007f]/u.test(entry.id) || !('endpoints' in entry) || !Array.isArray(entry.endpoints)
      || entry.endpoints.length > 32 || !entry.endpoints.every((item: unknown) => typeof item === 'string')) {
      throw new Error('hallucodex: invalid model catalog')
    }
    if (seen.has(entry.id)) throw new Error('hallucodex: duplicate model')
    seen.add(entry.id)
    const supported = new Set<DesktopEndpoint>()
    for (const item of entry.endpoints) {
      const endpoint = desktopEndpoint(item)
      if (endpoint !== undefined) supported.add(endpoint)
    }
    const endpoints = [...supported]
    const contextWindow = 'context_window' in entry ? entry.context_window : undefined
    const maxOutputTokens = 'max_output_tokens' in entry ? entry.max_output_tokens : undefined
    if ((contextWindow !== undefined && (typeof contextWindow !== 'number' || !Number.isSafeInteger(contextWindow) || contextWindow < 1))
      || (maxOutputTokens !== undefined && (typeof maxOutputTokens !== 'number' || !Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1))
      || (typeof contextWindow === 'number' && typeof maxOutputTokens === 'number' && maxOutputTokens > contextWindow)) {
      throw new Error('hallucodex: invalid model capacity')
    }
    if (endpoints.length > 0) models.push(Object.freeze({
      id: entry.id, endpoints: Object.freeze(endpoints),
      ...(typeof contextWindow === 'number' ? { contextWindow } : {}),
      ...(typeof maxOutputTokens === 'number' ? { maxOutputTokens } : {}),
    }))
  }
  return Object.freeze(models)
}
