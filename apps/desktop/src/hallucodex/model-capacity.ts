/** Model capacities the user sets in the composer's model selector, kept on this device for each server. */
import { readFileSync } from 'node:fs'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { normalizeServerOrigin } from './server-origin.ts'

/** The user's capacities for one model; an absent field follows the automatic value. */
export interface ModelCapacityOverride {
  readonly contextWindow?: number
  readonly maxOutputTokens?: number
}

/** Largest token count accepted, far above any published model, so a mistyped digit cannot take effect. */
export const MAX_MODEL_CAPACITY = 100_000_000

function tokenCount(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > MAX_MODEL_CAPACITY) {
    throw new Error('hallucodex: invalid model capacity')
  }
  return value
}

/**
 * Validate capacities from a Host request or the settings file.
 * @param value - Untrusted object whose fields are token counts, or null or absent to follow the automatic value.
 * @returns The capacities that are set.
 * @throws {Error} When a count is not a positive integer up to {@link MAX_MODEL_CAPACITY}, or the output limit exceeds
 * the context window.
 */
export function parseModelCapacityOverride(value: unknown): ModelCapacityOverride {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('hallucodex: invalid model capacity')
  const contextWindow = tokenCount(Reflect.get(value, 'contextWindow'))
  const maxOutputTokens = tokenCount(Reflect.get(value, 'maxOutputTokens'))
  if (contextWindow !== undefined && maxOutputTokens !== undefined && maxOutputTokens > contextWindow) {
    throw new Error('hallucodex: invalid model capacity')
  }
  return {
    ...contextWindow === undefined ? {} : { contextWindow },
    ...maxOutputTokens === undefined ? {} : { maxOutputTokens },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read the saved capacities; a missing or damaged file, server, or model entry contributes nothing.
 * @param file - Settings file inside the application's userData directory.
 * @returns Capacities by server origin, then model id.
 */
export function readModelCapacities(file: string): Map<string, Map<string, ModelCapacityOverride>> {
  const servers = new Map<string, Map<string, ModelCapacityOverride>>()
  let saved: unknown
  try { saved = JSON.parse(readFileSync(file, 'utf8')) }
  catch (_readError) { return servers /* No file yet, or a damaged one: every model follows its automatic values. */ }
  const entries = isRecord(saved) ? saved.servers : undefined
  if (!isRecord(entries)) return servers
  for (const [origin, models] of Object.entries(entries)) {
    if (!isRecord(models)) continue
    let normalized: string
    try { normalized = normalizeServerOrigin(origin) }
    catch (_originError) { continue /* An entry for an address the dialog would refuse is ignored. */ }
    const values = new Map<string, ModelCapacityOverride>()
    for (const [model, capacity] of Object.entries(models)) {
      let parsed: ModelCapacityOverride
      try { parsed = parseModelCapacityOverride(capacity) }
      catch (_capacityError) { continue /* An invalid entry follows the automatic values. */ }
      if (Object.keys(parsed).length > 0) values.set(model, parsed)
    }
    if (values.size > 0) servers.set(normalized, values)
  }
  return servers
}

/** The user's model capacities for every server, persisted on each change. */
export class ModelCapacitySettings {
  #servers: Map<string, Map<string, ModelCapacityOverride>>
  #changes: Promise<void> = Promise.resolve()

  /**
   * @param file - Settings file inside userData; undefined keeps the capacities in memory only.
   * @param initial - Capacities by server origin, then model id.
   */
  constructor(private readonly file: string | undefined, initial: Map<string, Map<string, ModelCapacityOverride>> = new Map()) {
    this.#servers = initial
  }

  /**
   * Load the saved capacities.
   * @param file - Settings file inside the application's userData directory.
   * @returns The settings bound to that file.
   */
  static load(file: string): ModelCapacitySettings {
    return new ModelCapacitySettings(file, readModelCapacities(file))
  }

  /**
   * @param origin - Normalized server origin.
   * @returns The capacities set for that server's models, by model id.
   */
  get(origin: string): ReadonlyMap<string, ModelCapacityOverride> {
    return this.#servers.get(origin) ?? new Map()
  }

  /**
   * Replace one model's capacities; empty capacities restore the automatic values. Changes apply in call order, each
   * only after the file holds it.
   * @param origin - Normalized server origin.
   * @param model - Model id from that server's catalog.
   * @param capacity - Validated capacities.
   * @returns Settles once the change is saved and applied; rejects, applying nothing, when saving fails.
   */
  set(origin: string, model: string, capacity: ModelCapacityOverride): Promise<void> {
    const change = this.#changes.then(async () => {
      const next = new Map([...this.#servers].map(([server, models]) => [server, new Map(models)]))
      const models = next.get(origin) ?? new Map<string, ModelCapacityOverride>()
      if (Object.keys(capacity).length > 0) models.set(model, capacity)
      else models.delete(model)
      if (models.size > 0) next.set(origin, models)
      else next.delete(origin)
      if (this.file !== undefined) {
        const servers = Object.fromEntries([...next].map(([server, values]) => [server, Object.fromEntries(values)]))
        await writeFileAtomic(this.file, `${JSON.stringify({ version: 1, servers })}\n`, { mode: 0o600, dirMode: 0o700 })
      }
      this.#servers = next
    })
    this.#changes = change.catch((_saveError: unknown) => { /* The caller receives the failure; later changes still run. */ })
    return change
  }
}
