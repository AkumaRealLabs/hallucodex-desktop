/** Native account catalog refresh, committed atomically with the relay selection. */
import { parseDesktopGroups, allowedGroup, concreteGroup } from './group-policy.ts'
import type { DesktopGroup } from './group-policy.ts'
import { parseDesktopModels } from './catalog.ts'
import type { DesktopModel } from './catalog.ts'
import { HalluCodexRelayBroker } from './relay-broker.ts'
import type { RelayAccess } from './relay-broker.ts'
import { HalluCodexUnauthorizedError } from './account-info.ts'

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

/**
 * Read a bounded server JSON response without forwarding transport error diagnostics.
 * @param response - authenticated same-origin response.
 * @returns decoded JSON for endpoint-specific validation.
 */
async function readCatalogJson(response: Response): Promise<unknown> {
  if (response.status === 401) {
    await response.body?.cancel()
    throw new HalluCodexUnauthorizedError()
  }
  if (!response.ok || response.body === null) throw new Error('hallucodex: catalog unavailable')
  if (!response.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    await response.body.cancel()
    throw new Error('hallucodex: invalid catalog content type')
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > MAX_CATALOG_BYTES) throw new Error('hallucodex: catalog is too large')
      chunks.push(chunk.value)
    }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return value
  } catch (_readError) {
    await reader.cancel().catch((_cancelError: unknown) => { /* A broken response is already rejected. */ })
    throw new Error('hallucodex: invalid catalog response')
  } finally {
    reader.releaseLock()
  }
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
        signal: controller.signal, redirect: 'error', credentials: 'omit', cache: 'no-store',
      }
      const origin = this.options.origin()
      const [groupsJson, modelsJson] = await Promise.all([
        this.options.fetch(`${origin}/api/desktop/v1/groups`, request).then(readCatalogJson),
        this.options.fetch(`${origin}/api/desktop/v1/models`, request).then(readCatalogJson),
      ])
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
      if (refreshError instanceof HalluCodexUnauthorizedError) throw refreshError
      // The public error excludes bearer-bearing Request and provider diagnostics.
      throw new Error('hallucodex: account catalog unavailable')
    } finally {
      if (this.active === controller) this.active = undefined
    }
  }
}
