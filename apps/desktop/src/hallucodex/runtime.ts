/** Main-process composition for HalluCodex account, authenticated discovery, and scoped relay. */
import { readHalluCodexWalletQuota, type HalluCodexWalletQuota } from './account-info.ts'
import { HalluCodexAuthBroker } from './auth-broker.ts'
import type { HalluCodexAccountSnapshot, HalluCodexAuthBrokerOptions } from './auth-broker.ts'
import { HalluCodexCatalogController } from './catalog-controller.ts'
import type { DesktopCatalogView } from './catalog-controller.ts'
import { HalluCodexRelayBroker } from './relay-broker.ts'
import type { DesktopRelayResult } from './relay-broker.ts'
import type { DesktopEndpoint } from './catalog.ts'

/** Safe native account view; no method returning credentials belongs in renderer IPC. */
export interface HalluCodexDesktopSnapshot {
  readonly account: HalluCodexAccountSnapshot
  readonly catalogStatus: 'unavailable' | 'loading' | 'ready'
  readonly catalog?: DesktopCatalogView
  readonly wallet?: HalluCodexWalletQuota
  readonly walletStatus?: 'unavailable' | 'loading' | 'ready'
}

/** Native dependencies, supplied only after Electron readiness and the application single-instance lock. */
export interface HalluCodexDesktopOptions extends Omit<HalluCodexAuthBrokerOptions, 'onChange'> {
  readonly fetch: typeof globalThis.fetch
  readonly maxRequestBytes: number
  readonly onChange?: (snapshot: HalluCodexDesktopSnapshot) => void
}

/**
 * Account state owns relay admission. The desktop shell must expose only the safe account methods to its owned UI.
 * The authenticated Host provider alone receives invoke; access and refresh tokens remain in the native broker.
 */
export class HalluCodexDesktopRuntime {
  private readonly account: HalluCodexAuthBroker
  private readonly catalog: HalluCodexCatalogController
  private readonly relay: HalluCodexRelayBroker
  private accountKey: string | undefined
  private wallet: HalluCodexWalletQuota | undefined
  private walletStatus: 'unavailable' | 'loading' | 'ready' = 'unavailable'
  private balanceRequest = new AbortController()
  private generation = 0
  private catalogStatus: HalluCodexDesktopSnapshot['catalogStatus'] = 'unavailable'
  private readonly pending = new Set<Promise<void>>()

  constructor(private readonly options: HalluCodexDesktopOptions) {
    this.account = new HalluCodexAuthBroker({ ...options, onChange: (snapshot) => { this.accountChanged(snapshot) } })
    const access = () => this.account.getRequestCredentials()
    this.relay = new HalluCodexRelayBroker({ access, fetch: options.fetch, maxRequestBytes: options.maxRequestBytes })
    this.catalog = new HalluCodexCatalogController({ access, fetch: options.fetch, relay: this.relay })
  }

  /** @returns the account/catalog admission revision for the private Host relay. */
  getRelayRevision(): number { return this.generation }

  /** @returns a fresh safe projection suitable for owned-window IPC. */
  getSnapshot(): HalluCodexDesktopSnapshot {
    const catalog = this.catalog.getSnapshot()
    return structuredClone({
      account: this.account.getSnapshot(), catalogStatus: this.catalogStatus, walletStatus: this.walletStatus,
      ...(this.wallet === undefined ? {} : { wallet: this.wallet }),
      ...(catalog === undefined ? {} : { catalog }),
    })
  }

  /** @returns account state after opening the system-browser authorization page. */
  async startSignIn(): Promise<HalluCodexDesktopSnapshot> {
    await this.account.startSignIn()
    return this.getSnapshot()
  }

  /** @returns account state after cancelling the current browser attempt. */
  async cancelSignIn(): Promise<HalluCodexDesktopSnapshot> {
    await this.account.cancelSignIn()
    return this.getSnapshot()
  }

  /** @returns account state after attempting secure refresh restoration; network failure does not erase saved credentials. */
  async restore(): Promise<HalluCodexDesktopSnapshot> {
    await this.account.restore()
    return this.getSnapshot()
  }

  /** @returns whether remote revocation succeeded, after local relay admission has already stopped. */
  async signOut(): Promise<{ remoteRevoked: boolean }> {
    this.catalog.clear()
    return this.account.signOut()
  }

  /** Retry account discovery explicitly after a transient failure; does not infer a replacement group. */
  async refreshCatalog(): Promise<void> {
    if (this.account.getSnapshot().status !== 'signed-in') throw new Error('hallucodex: sign in before discovery')
    const generation = ++this.generation
    this.catalogStatus = 'loading'
    this.balanceRequest.abort()
    this.balanceRequest = new AbortController()
    this.wallet = undefined
    this.walletStatus = 'loading'
    this.publish()
    try {
      await this.catalog.refresh()
      if (generation === this.generation) this.catalogStatus = 'ready'
    } catch (_catalogError) {
      if (generation === this.generation) this.catalogStatus = 'unavailable'
    }
    if (generation !== this.generation) return
    this.publish()
    const signal = this.balanceRequest.signal
    try {
      const access = await this.account.getRequestCredentials()
      const wallet = await readHalluCodexWalletQuota(this.options.fetch, access, signal)
      if (generation === this.generation && !signal.aborted) { this.wallet = wallet; this.walletStatus = 'ready' }
    } catch (_balanceError) {
      if (generation === this.generation) this.walletStatus = 'unavailable'
    }
    if (generation === this.generation) this.publish()
  }

  /**
   * Invoke from the trusted Host model provider; this method must not be installed as renderer IPC.
   * @param endpoint - exact catalog-authorized model protocol.
   * @param payload - adapter JSON request.
   * @param signal - turn cancellation.
   * @param expectedRevision - revision captured by the trusted Host adapter; stale requests are refused.
   * @returns an unbuffered relay response with its original concrete group.
   */
  async invoke(endpoint: DesktopEndpoint, payload: unknown, signal?: AbortSignal, expectedRevision?: number): Promise<DesktopRelayResult> {
    if (expectedRevision !== undefined && expectedRevision !== this.generation) throw new Error('hallucodex: stale model selection')
    const generation = this.generation
    const result = await this.relay.invoke(endpoint, payload, signal)
    if (generation === this.generation && (result.response.status === 401 || result.response.status === 403)) {
      this.generation++
      this.balanceRequest.abort()
      this.wallet = undefined
      this.walletStatus = 'unavailable'
      this.catalog.clear()
      this.catalogStatus = 'unavailable'
      this.publish()
    }
    return result
  }

  /** Wait for account cleanup and in-flight catalog operations; retains encrypted login for the next launch. */
  async dispose(): Promise<void> {
    this.generation++
    this.balanceRequest.abort()
    this.wallet = undefined
    this.walletStatus = 'unavailable'
    this.accountKey = undefined
    this.catalogStatus = 'unavailable'
    this.catalog.clear()
    await this.account.dispose()
    await Promise.all([...this.pending])
  }

  private accountChanged(snapshot: HalluCodexAccountSnapshot): void {
    const key = snapshot.status === 'signed-in' ? JSON.stringify([snapshot.profile.id, snapshot.group]) : undefined
    if (key === undefined || key !== this.accountKey) {
      this.generation++
      this.balanceRequest.abort()
      this.wallet = undefined
      this.walletStatus = 'unavailable'
      this.accountKey = key
      this.catalogStatus = 'unavailable'
      this.catalog.clear()
      if (key !== undefined) {
        const pending = this.refreshCatalog()
        this.pending.add(pending)
        void pending.finally(() => { this.pending.delete(pending) })
      }
    }
    this.publish()
  }

  private publish(): void {
    try { this.options.onChange?.(this.getSnapshot()) }
    catch (_observerError) { /* UI observer failures cannot interrupt native account state. */ }
  }
}
