/** Main-process relay admission; no caller chooses an origin or receives an account credential. */
import { allowedGroup } from './group-policy.ts'
import type { DesktopEndpoint, DesktopModel } from './catalog.ts'

const ORIGIN = 'https://api.hallucodex.com'

/** Authentication material obtained only inside the native process. */
export interface RelayAccess {
  readonly accessToken: string
  readonly deviceSessionId: string
  readonly group: string
}

/** Immutable account and catalog binding committed after authenticated server reads. */
export interface RelaySelection {
  readonly deviceSessionId: string
  readonly group: string
  readonly allowedGroups: readonly string[]
  readonly models: readonly DesktopModel[]
}

/** Native dependencies; production consumers supply the account broker's private access resolver. */
export interface RelayBrokerOptions {
  readonly access: () => Promise<RelayAccess>
  readonly fetch: typeof globalThis.fetch
  readonly maxRequestBytes: number
}

/** One relay result and the exact group snapshot admitted before the request began. */
export interface DesktopRelayResult {
  readonly response: Response
  readonly group: string
  readonly model: string
}

/**
 * Refuse automatic routing, redirects, stale selection, and unauthorized protocol/model pairs.
 * This module never retries requests; streams already admitted retain their original server grant.
 */
export class HalluCodexRelayBroker {
  private selection: RelaySelection | undefined
  private generation = 0

  constructor(private readonly options: RelayBrokerOptions) {
    if (!Number.isSafeInteger(options.maxRequestBytes) || options.maxRequestBytes < 1) {
      throw new Error('hallucodex: invalid request size limit')
    }
  }

  /**
   * Commit an authenticated group/catalog snapshot after login, refresh, or explicit group selection.
   * @param selection - complete server-authorized device selection.
   */
  configure(selection: RelaySelection): void {
    allowedGroup(selection.group, selection.allowedGroups)
    this.selection = Object.freeze({
      deviceSessionId: selection.deviceSessionId,
      group: selection.group,
      allowedGroups: Object.freeze([...selection.allowedGroups]),
      models: Object.freeze(selection.models.map(model => Object.freeze({
        ...model, endpoints: Object.freeze([...model.endpoints]),
      }))),
    })
    this.generation++
  }

  /** Suspend new admission before changing group, signing out, or handling a server revocation. */
  suspend(): void {
    this.selection = undefined
    this.generation++
  }

  /**
   * Send one JSON model request using a private, fresh desktop access token.
   * @param endpoint - a supported exact protocol path.
   * @param payload - serialized request fields from the local protocol adapter.
   * @param signal - cancellation owned by the requesting turn.
   * @returns the response stream and the group/model captured at admission.
   */
  async invoke(endpoint: DesktopEndpoint, payload: unknown, signal?: AbortSignal): Promise<DesktopRelayResult> {
    const selection = this.selection
    const generation = this.generation
    if (selection === undefined) throw new Error('hallucodex: select an allowed group before inference')
    let encoded: unknown
    try { encoded = JSON.stringify(payload) }
    catch (_serializationError) { throw new Error('hallucodex: invalid model request') }
    if (typeof encoded !== 'string' || Buffer.byteLength(encoded, 'utf8') > this.options.maxRequestBytes) {
      throw new Error('hallucodex: model request is too large')
    }
    const body = encoded
    const request: unknown = JSON.parse(body)
    payload = request
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)
      || !('model' in payload) || typeof payload.model !== 'string') {
      throw new Error('hallucodex: invalid model request')
    }
    if (Object.keys(payload).some(key => key.toLowerCase() === 'model' && key !== 'model')) {
      throw new Error('hallucodex: ambiguous model field')
    }
    // Group is bound to the server-side grant, never accepted as a client request override.
    if (Object.keys(payload).some(key => ['group', 'auto_groups', 'cross_group_retry'].includes(key.toLowerCase()))) {
      throw new Error('hallucodex: request routing overrides are forbidden')
    }
    const model = selection.models.find(candidate => candidate.id === payload.model)
    if (model === undefined || !model.endpoints.includes(endpoint)) {
      throw new Error('hallucodex: model endpoint is not allowed')
    }
    const access = await this.options.access()
    if (generation !== this.generation || this.selection !== selection) {
      throw new Error('hallucodex: account selection changed')
    }
    allowedGroup(access.group, selection.allowedGroups)
    if (access.deviceSessionId !== selection.deviceSessionId || access.group !== selection.group
      || access.accessToken.length === 0 || (/[\u0000-\u001f\u007f]/u.test(access.accessToken) || /\s/u.test(access.accessToken))) {
      throw new Error('hallucodex: access grant does not match selection')
    }
    signal?.throwIfAborted()
    const headers: Record<string, string> = {
      authorization: `Bearer ${access.accessToken}`, 'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    }
    if (endpoint === '/v1/messages') headers['anthropic-version'] = '2023-06-01'
    let response: Response
    try {
      response = await this.options.fetch(`${ORIGIN}${endpoint}`, {
        method: 'POST', headers, body, signal: signal ?? null, redirect: 'error', credentials: 'omit', cache: 'no-store',
      })
    } catch (_networkError) {
      if (signal?.aborted) throw signal.reason
      // Fetch errors may contain request headers or adapter diagnostics; do not forward them to UI/logs.
      throw new Error('hallucodex: relay network failure')
    }
    if (response.status === 401 || response.status === 403) {
      if (generation === this.generation) this.suspend()
    }
    return { response, group: selection.group, model: model.id }
  }
}
