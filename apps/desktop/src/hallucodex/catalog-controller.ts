/** Native account catalog refresh, committed atomically with the relay selection. */
import { parseDesktopGroups, allowedGroup, concreteGroup } from './group-policy.ts'
import type { DesktopGroup } from './group-policy.ts'
import { parseDesktopModels } from './catalog.ts'
import type { DesktopModel } from './catalog.ts'
import { HalluCodexRelayBroker } from './relay-broker.ts'
import type { RelayAccess } from './relay-broker.ts'
import { accountFailure, HalluCodexReadError, HalluCodexUnauthorizedError, readAccountJson } from './account-errors.ts'
import { HalluCodexAuthError } from './auth-protocol.ts'

const MAX_CATALOG_BYTES = 2 * 1024 * 1024

/** Renderer-safe catalog, with no account credential or management capabilities. */
export interface DesktopCatalogView {
  readonly group: string
  readonly groups: readonly DesktopGroup[]
  readonly models: readonly DesktopModel[]
}

/** Native refresh dependencies; the bearer resolver is never exposed to renderer IPC. */
export interface CatalogControllerOptions {
  readonly access: () => Promise<RelayAccess>
  /** Reads the selected server origin for every request. */
  readonly origin: () => string
  readonly fetch: typeof globalThis.fetch
  readonly relay: HalluCodexRelayBroker
}

/** Owns one generation of account-bound discovery; stale and interrupted reads never reopen relay admission. */
export class HalluCodexCatalogController {
  private generation = 0
  private active: AbortController | undefined
  private view: DesktopCatalogView | undefined

  constructor(private readonly options: CatalogControllerOptions) {}

  /** @returns the last complete renderer-safe catalog, or undefined while unavailable. */
  getSnapshot(): DesktopCatalogView | undefined { return this.view }

  /** Fence pending reads and relay admission before sign-out or an explicit server-side group mutation. */
  clear(): void {
    this.generation++
    this.active?.abort()
    this.active = undefined
    this.view = undefined
    this.options.relay.suspend()
  }

  /**
   * Retrieve groups and models using one device grant, then recheck the current account before publication.
   * @returns the complete renderer-safe catalog committed to the relay broker.
   * @throws {HalluCodexUnauthorizedError} When the server rejects the access token.
   */
  async refresh(): Promise<DesktopCatalogView> {
    this.clear()
    const generation = this.generation
    const controller = new AbortController()
    this.active = controller
    try {
      const access = await this.options.access()
      concreteGroup(access.group)
      controller.signal.throwIfAborted()
      const request: RequestInit = {
        headers: { authorization: `Bearer ${access.accessToken}`, accept: 'application/json' },
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]), redirect: 'error', credentials: 'omit', cache: 'no-store',
      }
      const origin = this.options.origin()
      const reads = [
        readAccountJson(this.options.fetch, `${origin}/api/desktop/v1/groups`, request, MAX_CATALOG_BYTES),
        readAccountJson(this.options.fetch, `${origin}/api/desktop/v1/models`, request, MAX_CATALOG_BYTES),
      ]
      const [groupsJson, modelsJson] = await Promise.all(reads).catch(async (error: unknown) => {
        controller.abort()
        await Promise.allSettled(reads)
        throw error
      })
      const groups = parseDesktopGroups(groupsJson)
      const group = allowedGroup(access.group, groups.map(item => item.name))
      const models = parseDesktopModels(modelsJson, group)
      const current = await this.options.access()
      if (generation !== this.generation || current.deviceSessionId !== access.deviceSessionId || current.group !== group) {
        throw new Error('hallucodex: account changed during discovery')
      }
      controller.signal.throwIfAborted()
      const view = Object.freeze({ group, groups, models })
      this.options.relay.configure({
        deviceSessionId: access.deviceSessionId, group, allowedGroups: groups.map(item => item.name), models,
      })
      this.view = view
      return view
    } catch (refreshError) {
      controller.abort()
      if (refreshError instanceof HalluCodexUnauthorizedError || refreshError instanceof HalluCodexAuthError) throw refreshError
      // The public error excludes bearer-bearing Request and provider diagnostics.
      throw new HalluCodexReadError(accountFailure(refreshError, 'catalog_unavailable'), 'hallucodex: account catalog unavailable')
    } finally {
      if (this.active === controller) this.active = undefined
    }
  }
}
