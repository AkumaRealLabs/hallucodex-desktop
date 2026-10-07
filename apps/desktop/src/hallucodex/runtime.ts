/** Main-process composition for HalluCodex account, authenticated discovery, and scoped relay. */
import { HalluCodexUnauthorizedError, readHalluCodexQuotaDisplay, readHalluCodexWalletQuota, type HalluCodexWalletQuota } from './account-info.ts'
import { accountFailure, type AccountFailure } from './account-errors.ts'
import type { HalluCodexQuotaDisplay } from './quota-display.ts'
import { HalluCodexAuthBroker } from './auth-broker.ts'
import { concreteGroup } from './auth-protocol.ts'
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
  readonly catalogError?: AccountFailure
  readonly accountRefreshStatus?: 'loading' | 'ready' | 'failed'
  readonly accountRefreshError?: AccountFailure
  readonly wallet?: HalluCodexWalletQuota
  readonly walletStatus?: 'unavailable' | 'loading' | 'ready' | 'failed'
  readonly walletError?: AccountFailure
  /** Time of the last accepted balance response, not the last attempted request. */
  readonly walletUpdatedAt?: number
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

/** Serializable outcome of an explicit group move, separate from subsequent discovery. */
export type GroupSelectionResult = 'selected' | AccountFailure

/**
 * Account state owns relay admission. The desktop shell exposes only safe account methods to its owned UI.
 * The authenticated Host provider alone receives invoke; credentials remain in the native broker.
 */
export class HalluCodexDesktopRuntime {
  private readonly account: HalluCodexAuthBroker
  private readonly catalog: HalluCodexCatalogController
  private readonly relay: HalluCodexRelayBroker
  private accountKey: string | undefined
  private accountEpoch = 0
  private wallet: HalluCodexWalletQuota | undefined
  private walletStatus: NonNullable<HalluCodexDesktopSnapshot['walletStatus']> = 'unavailable'
  private walletError: AccountFailure | undefined
  private walletUpdatedAt: number | undefined
  private quotaDisplay: HalluCodexQuotaDisplay | undefined
  private balanceRequest = new AbortController()
  private generation = 0
  private catalogStatus: HalluCodexDesktopSnapshot['catalogStatus'] = 'unavailable'
  private catalogError: AccountFailure | undefined
  private accountRefreshStatus: HalluCodexDesktopSnapshot['accountRefreshStatus']
  private accountRefreshError: AccountFailure | undefined
  private catalogTask: { generation: number; promise: Promise<void> } | undefined
  private walletTask: { generation: number; promise: Promise<void> } | undefined
  private refreshTask: { epoch: number; promise: Promise<void> } | undefined
  private mutationTail: Promise<void> = Promise.resolve()
  private disposed = false
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
      ...(this.catalogError === undefined ? {} : { catalogError: this.catalogError }),
      ...(this.accountRefreshStatus === undefined ? {} : { accountRefreshStatus: this.accountRefreshStatus }),
      ...(this.accountRefreshError === undefined ? {} : { accountRefreshError: this.accountRefreshError }),
      ...(this.walletError === undefined ? {} : { walletError: this.walletError }),
      ...(this.walletUpdatedAt === undefined ? {} : { walletUpdatedAt: this.walletUpdatedAt }),
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

  /** @returns account state after secure restoration; network failure does not erase saved credentials. */
  async restore(): Promise<HalluCodexDesktopSnapshot> {
    await this.account.restore()
    return this.getSnapshot()
  }

  /** Refresh capabilities explicitly, then discover data; duplicate calls share the same rotation. */
  refreshAccount(): Promise<void> {
    const epoch = this.accountEpoch
    if (this.refreshTask?.epoch === epoch) return this.refreshTask.promise
    const operation = this.mutationTail.then(async () => {
      if (epoch !== this.accountEpoch || this.disposed || this.account.getSnapshot().status !== 'signed-in') return
      this.invalidateReads()
      this.accountRefreshStatus = 'loading'
      this.accountRefreshError = undefined
      this.publish()
      try {
        await this.account.refreshAccount()
        if (!this.accountCurrent(epoch)) return
        this.accountRefreshStatus = 'ready'
        this.publish()
        await this.loadCatalog()
      } catch (error) {
        if (!this.accountCurrent(epoch)) return
        this.accountRefreshStatus = 'failed'
        this.accountRefreshError = accountFailure(error, 'operation_failed')
        this.publish()
      }
    })
    const promise = operation.finally(() => {
      if (this.refreshTask?.promise === promise) this.refreshTask = undefined
    })
    this.refreshTask = { epoch, promise }
    this.mutationTail = promise.then(() => {}, () => {})
    return this.track(promise)
  }

  /**
   * Move this device to another allowed group, serializing with explicit capability refreshes.
   * @param group - Concrete group chosen in the account dialog.
   * @returns The safe move outcome, independent of subsequent catalog and balance reads.
   */
  async selectGroup(group: unknown): Promise<GroupSelectionResult> {
    const target = concreteGroup(group)
    const epoch = this.accountEpoch
    const operation = this.mutationTail.then(async (): Promise<GroupSelectionResult> => {
      if (epoch !== this.accountEpoch || this.disposed) return 'cancelled'
      const account = this.account.getSnapshot()
      if (account.status !== 'signed-in') return 'session_expired'
      if (account.group === target) return 'selected'
      const previousKey = this.accountKey
      this.invalidateReads()
      this.catalogStatus = 'loading'
      this.publish()
      try {
        await this.account.selectGroup(target)
        return this.account.getSnapshot().status === 'signed-in' ? 'selected' : 'cancelled'
      } catch (error) {
        return accountFailure(error, 'operation_failed')
      } finally {
        // A successful move starts discovery via accountChanged; a rejected move reopens the old group.
        if (this.accountKey === previousKey && this.account.getSnapshot().status === 'signed-in') {
          void this.loadCatalog()
        }
      }
    })
    this.mutationTail = operation.then(() => {}, () => {})
    return this.track(operation)
  }

  /** @returns whether remote revocation succeeded, after local relay admission has already stopped. */
  async signOut(): Promise<{ remoteRevoked: boolean }> {
    this.catalog.clear()
    return this.account.signOut()
  }

  /**
   * Select another server while signed out, revoking the old server's saved credentials first.
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

  /** Retry discovery without unnecessarily rotating a valid credential. */
  refreshCatalog(): Promise<void> {
    const epoch = this.accountEpoch
    return this.track(this.mutationTail.then(() => {
      if (epoch !== this.accountEpoch || this.disposed) return
      return this.loadCatalog()
    }))
  }

  private loadCatalog(): Promise<void> {
    if (this.disposed || this.account.getSnapshot().status !== 'signed-in') return Promise.resolve()
    if (this.catalogTask?.generation === this.generation) return this.catalogTask.promise
    this.invalidateReads()
    const generation = this.generation
    this.catalogStatus = 'loading'
    this.publish()
    const promise = this.readCatalog(generation).finally(() => {
      if (this.catalogTask?.promise === promise) this.catalogTask = undefined
    })
    this.catalogTask = { generation, promise }
    return this.track(promise)
  }

  private async readCatalog(generation: number): Promise<void> {
    const signal = this.balanceRequest.signal
    const display = this.readQuotaDisplay(generation, signal)
    const wallet = this.loadWallet()
    try {
      await this.catalog.refresh().catch((error: unknown) => {
        if (!(error instanceof HalluCodexUnauthorizedError) || generation !== this.generation) throw error
        this.account.expireAccessToken()
        return this.catalog.refresh()
      })
      if (generation === this.generation) this.catalogStatus = 'ready'
    } catch (error) {
      if (generation === this.generation) {
        this.catalogStatus = 'unavailable'
        this.catalogError = accountFailure(error, 'catalog_unavailable')
      }
    }
    if (generation === this.generation) this.publish()
    await Promise.all([display, wallet])
    if (generation === this.generation) this.publish()
  }

  /** Re-read only balance and device usage, preserving the last successful data and time on failure. */
  refreshWallet(): Promise<void> {
    if (this.walletTask?.generation === this.generation) return this.walletTask.promise
    const epoch = this.accountEpoch
    return this.track(this.mutationTail.then(() => {
      if (epoch !== this.accountEpoch || this.disposed) return
      return this.loadWallet()
    }))
  }

  private loadWallet(): Promise<void> {
    if (this.disposed || this.account.getSnapshot().status !== 'signed-in') return Promise.resolve()
    if (this.walletTask?.generation === this.generation) return this.walletTask.promise
    const generation = this.generation
    const signal = this.balanceRequest.signal
    this.walletStatus = 'loading'
    this.walletError = undefined
    this.publish()
    const promise = this.readWallet(generation, signal).finally(() => {
      if (this.walletTask?.promise === promise) this.walletTask = undefined
    })
    this.walletTask = { generation, promise }
    return this.track(promise)
  }

  private async readWallet(generation: number, signal: AbortSignal): Promise<void> {
    const display = this.quotaDisplay === undefined && this.catalogStatus !== 'loading'
      ? this.readQuotaDisplay(generation, signal) : Promise.resolve()
    try {
      let access = await this.account.getRequestCredentials()
      let wallet: HalluCodexWalletQuota
      try { wallet = await readHalluCodexWalletQuota(this.options.fetch, this.options.server.get(), access, signal) }
      catch (error) {
        if (!(error instanceof HalluCodexUnauthorizedError) || generation !== this.generation || signal.aborted) throw error
        this.account.expireAccessToken()
        access = await this.account.getRequestCredentials()
        wallet = await readHalluCodexWalletQuota(this.options.fetch, this.options.server.get(), access, signal)
      }
      if (generation === this.generation && !signal.aborted) {
        this.wallet = wallet
        this.walletUpdatedAt = (this.options.now ?? Date.now)()
        this.walletStatus = 'ready'
        this.publish()
      }
    } catch (error) {
      if (generation === this.generation && !signal.aborted) {
        this.walletStatus = 'failed'
        this.walletError = accountFailure(error, 'wallet_unavailable')
        this.publish()
      }
    }
    await display
    if (generation === this.generation && !signal.aborted) this.publish()
  }

  /**
   * Invoke from the trusted Host model provider, never renderer IPC.
   * @param endpoint - Exact catalog-authorized protocol.
   * @param payload - Adapter JSON request.
   * @param signal - Turn cancellation.
   * @param expectedRevision - Revision captured by the Host adapter; stale requests are refused.
   * @returns An unbuffered response with its original group.
   */
  async invoke(endpoint: DesktopEndpoint, payload: unknown, signal?: AbortSignal, expectedRevision?: number): Promise<DesktopRelayResult> {
    if (expectedRevision !== undefined && expectedRevision !== this.generation) throw new Error('hallucodex: stale model selection')
    const generation = this.generation
    const result = await this.relay.invoke(endpoint, payload, signal)
    if (generation === this.generation && result.response.status === 401) {
      this.account.expireAccessToken()
      this.invalidateReads()
      void this.refreshCatalog()
    }
    return result
  }

  /** Wait for native account and data operations to stop, retaining encrypted login for next launch. */
  async dispose(): Promise<void> {
    this.disposed = true
    this.invalidateReads()
    this.quotaDisplay = undefined
    await this.account.dispose()
    while (this.pending.size) await Promise.all([...this.pending])
  }

  private async readQuotaDisplay(generation: number, signal: AbortSignal): Promise<void> {
    try {
      const display = await readHalluCodexQuotaDisplay(this.options.fetch, this.options.server.get(), signal)
      if (generation === this.generation && !signal.aborted) this.quotaDisplay = display
    } catch (_displayError) { /* Cosmetic settings do not change quota or account authorization. */ }
  }

  private invalidateReads(): void {
    this.generation++
    this.balanceRequest.abort()
    this.balanceRequest = new AbortController()
    this.catalog.clear()
    this.catalogStatus = 'unavailable'
    this.catalogError = undefined
    this.walletStatus = this.walletError !== undefined ? 'failed' : this.wallet === undefined ? 'unavailable' : 'ready'
  }

  private accountChanged(snapshot: HalluCodexAccountSnapshot): void {
    const key = snapshot.status === 'signed-in' ? JSON.stringify([snapshot.profile.id, snapshot.group]) : undefined
    if (key === undefined || key !== this.accountKey) {
      this.accountEpoch++
      this.invalidateReads()
      this.wallet = undefined
      this.walletUpdatedAt = undefined
      this.walletError = undefined
      this.walletStatus = 'unavailable'
      this.accountRefreshStatus = undefined
      this.accountRefreshError = undefined
      this.accountKey = key
      if (key !== undefined && !this.disposed) void this.loadCatalog()
    }
    this.publish()
  }

  private accountCurrent(epoch: number): boolean { return epoch === this.accountEpoch && !this.disposed }

  private track<T>(operation: Promise<T>): Promise<T> {
    const settled = operation.then(() => {}, () => {})
    this.pending.add(settled)
    void settled.then(() => { this.pending.delete(settled) })
    return operation
  }

  private publish(): void {
    if (this.disposed) return
    try { this.options.onChange?.(this.getSnapshot()) }
    catch (_observerError) { /* UI observer failures cannot interrupt native account state. */ }
  }
}
