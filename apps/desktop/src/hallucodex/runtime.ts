/** Main-process composition for HalluCodex account, authenticated discovery, and scoped relay. */
import { HalluCodexUnauthorizedError, readHalluCodexQuotaDisplay, readHalluCodexWalletQuota, type HalluCodexWalletQuota } from './account-info.ts'
import type { HalluCodexQuotaDisplay } from './quota-display.ts'
import { HalluCodexAuthBroker } from './auth-broker.ts'
import { concreteGroup, HalluCodexAuthError } from './auth-protocol.ts'
import type { HalluCodexAccountSnapshot, HalluCodexAuthBrokerOptions } from './auth-broker.ts'
import { normalizeServerOrigin, type ServerOriginSetting } from './server-origin.ts'
import { HalluCodexCatalogController } from './catalog-controller.ts'
import type { DesktopCatalogView } from './catalog-controller.ts'
import { HalluCodexRelayBroker } from './relay-broker.ts'
import type { DesktopRelayResult } from './relay-broker.ts'
import type { DesktopEndpoint } from './catalog.ts'

/** Safe native account view; no method returning credentials belongs in renderer IPC. */
export interface HalluCodexDesktopSnapshot {
  readonly account: HalluCodexAccountSnapshot
  readonly serverOrigin: string
  readonly catalogStatus: 'unavailable' | 'loading' | 'ready'
  readonly catalog?: DesktopCatalogView
  readonly wallet?: HalluCodexWalletQuota
  readonly walletStatus?: 'unavailable' | 'loading' | 'ready'
  /** How the selected site shows quota; absent until its public status has been read. */
  readonly quotaDisplay?: HalluCodexQuotaDisplay
}

/** Native dependencies, supplied only after Electron readiness and the application single-instance lock. */
export interface HalluCodexDesktopOptions extends Omit<HalluCodexAuthBrokerOptions, 'onChange' | 'origin'> {
  /** Selected server origin; the transport and store passed here must read the same setting. */
  readonly server: ServerOriginSetting
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
  private quotaDisplay: HalluCodexQuotaDisplay | undefined
  private balanceRequest = new AbortController()
  private generation = 0
  private catalogStatus: HalluCodexDesktopSnapshot['catalogStatus'] = 'unavailable'
  private readonly pending = new Set<Promise<void>>()

  constructor(private readonly options: HalluCodexDesktopOptions) {
    const origin = () => options.server.get()
    this.account = new HalluCodexAuthBroker({ ...options, origin, onChange: (snapshot) => { this.accountChanged(snapshot) } })
    const access = () => this.account.getRequestCredentials()
    this.relay = new HalluCodexRelayBroker({ access, origin, fetch: options.fetch, maxRequestBytes: options.maxRequestBytes })
    this.catalog = new HalluCodexCatalogController({ access, origin, fetch: options.fetch, relay: this.relay })
  }

  /** @returns the account/catalog admission revision for the private Host relay. */
  getRelayRevision(): number { return this.generation }

  /** @returns a fresh safe projection suitable for owned-window IPC. */
  getSnapshot(): HalluCodexDesktopSnapshot {
    const catalog = this.catalog.getSnapshot()
    return structuredClone({
      account: this.account.getSnapshot(), serverOrigin: this.options.server.get(),
      catalogStatus: this.catalogStatus, walletStatus: this.walletStatus,
      ...(this.wallet === undefined ? {} : { wallet: this.wallet }),
      ...(this.quotaDisplay === undefined ? {} : { quotaDisplay: this.quotaDisplay }),
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

  /**
   * Move this device to another account-allowed group, then reload the catalog and wallet for it.
   * @param group - Concrete group chosen in the account dialog.
   * @returns `group_unavailable` when the server refused the group; the device keeps its current group.
   */
  async selectGroup(group: unknown): Promise<'selected' | 'group_unavailable'> {
    const account = this.account.getSnapshot()
    if (account.status !== 'signed-in') throw new Error('hallucodex: sign in before selecting a group')
    const target = concreteGroup(group)
    if (account.group === target) return 'selected'
    const previousKey = this.accountKey
    // Stop admitting requests for the old group before the server moves the session.
    this.generation++
    this.balanceRequest.abort()
    this.catalogStatus = 'loading'
    this.catalog.clear()
    this.publish()
    try {
      await this.account.selectGroup(target)
      return 'selected'
    } catch (error) {
      if (error instanceof HalluCodexAuthError && error.code === 'group_unavailable') return 'group_unavailable'
      throw error
    } finally {
      // The move did not happen and the login survived: reopen the old group's catalog.
      if (this.accountKey === previousKey && this.account.getSnapshot().status === 'signed-in') {
        const pending = this.refreshCatalog().catch((_refreshError: unknown) => {
          // refreshCatalog publishes its own unavailable state; nothing remains to clean up here.
        })
        this.pending.add(pending)
        void pending.finally(() => { this.pending.delete(pending) })
      }
    }
  }

  /** @returns whether remote revocation succeeded, after local relay admission has already stopped. */
  async signOut(): Promise<{ remoteRevoked: boolean }> {
    this.catalog.clear()
    return this.account.signOut()
  }

  /**
   * Select another New API server while signed out. Saved credentials belong to the previous server,
   * so they are revoked there and removed first.
   * @param value - User-entered server address.
   * @returns The safe projection after the change.
   */
  async setServerOrigin(value: unknown): Promise<HalluCodexDesktopSnapshot> {
    const origin = normalizeServerOrigin(value)
    if (this.account.getSnapshot().status !== 'signed-out') throw new Error('hallucodex: sign out before changing the server')
    if (origin !== this.options.server.get()) {
      await this.signOut()
      this.options.server.set(origin)
      this.quotaDisplay = undefined
      this.generation++
    }
    this.publish()
    return this.getSnapshot()
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
      // A rejected access token is rotated once; a revoked device then fails rotation and signs out.
      await this.catalog.refresh().catch((error: unknown) => {
        if (!(error instanceof HalluCodexUnauthorizedError) || generation !== this.generation) throw error
        this.account.expireAccessToken()
        return this.catalog.refresh()
      })
      if (generation === this.generation) this.catalogStatus = 'ready'
    } catch (_catalogError) {
      if (generation === this.generation) this.catalogStatus = 'unavailable'
    }
    if (generation !== this.generation) return
    this.publish()
    const signal = this.balanceRequest.signal
    const display = this.readQuotaDisplay(generation, signal)
    try {
      const access = await this.account.getRequestCredentials()
      const wallet = await readHalluCodexWalletQuota(this.options.fetch, this.options.server.get(), access, signal)
      if (generation === this.generation && !signal.aborted) { this.wallet = wallet; this.walletStatus = 'ready' }
    } catch (_balanceError) {
      if (generation === this.generation) this.walletStatus = 'unavailable'
    }
    await display
    if (generation === this.generation) this.publish()
  }

  /**
   * Re-read only the wallet and this device's usage, e.g. when the account dialog opens. The shown
   * figures stay until fresh ones arrive; a failed read keeps them instead of signing anything out.
   */
  async refreshWallet(): Promise<void> {
    if (this.account.getSnapshot().status !== 'signed-in' || this.catalogStatus === 'loading' || this.walletStatus === 'loading') return
    const generation = this.generation
    this.balanceRequest.abort()
    this.balanceRequest = new AbortController()
    const signal = this.balanceRequest.signal
    // Retry the site's display settings only if no read has succeeded yet.
    const display = this.quotaDisplay === undefined ? this.readQuotaDisplay(generation, signal) : Promise.resolve()
    try {
      const access = await this.account.getRequestCredentials()
      const wallet = await readHalluCodexWalletQuota(this.options.fetch, this.options.server.get(), access, signal)
      await display
      if (generation !== this.generation || signal.aborted) return
      this.wallet = wallet
      this.walletStatus = 'ready'
      this.publish()
    } catch (_balanceError) {
      // Stale figures remain labelled by their last successful read; the explicit refresh reports failures.
    }
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
    // 401 means the server rejected the device credential. Rotate it through a fresh discovery;
    // 403 business limits (wallet, device cap, model) leave the catalog in place.
    if (generation === this.generation && result.response.status === 401) {
      this.account.expireAccessToken()
      const pending = this.refreshCatalog().catch((_refreshError: unknown) => {
        // refreshCatalog publishes its own unavailable state; nothing remains to clean up here.
      })
      this.pending.add(pending)
      void pending.finally(() => { this.pending.delete(pending) })
    }
    return result
  }

  /** Wait for account cleanup and in-flight catalog operations; retains encrypted login for the next launch. */
  async dispose(): Promise<void> {
    this.generation++
    this.balanceRequest.abort()
    this.wallet = undefined
    this.walletStatus = 'unavailable'
    this.quotaDisplay = undefined
    this.accountKey = undefined
    this.catalogStatus = 'unavailable'
    this.catalog.clear()
    await this.account.dispose()
    await Promise.all([...this.pending])
  }

  /**
   * Re-read how the site shows quota. A failed read keeps the last settings of the same server, and
   * without any the dialog shows raw quota.
   */
  private async readQuotaDisplay(generation: number, signal: AbortSignal): Promise<void> {
    try {
      const display = await readHalluCodexQuotaDisplay(this.options.fetch, this.options.server.get(), signal)
      if (generation === this.generation && !signal.aborted) this.quotaDisplay = display
    } catch (_displayError) {
      // The settings are cosmetic; the counters themselves remain exact.
    }
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
