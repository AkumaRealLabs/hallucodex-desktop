/** Main-process account lifecycle. Renderer projections contain no tokens, PKCE material, or callback URLs. */

import { createHash, randomBytes } from 'node:crypto'
import { authorizationUrl, HalluCodexAuthError, type AccessGrant, type AuthErrorCode, type HalluCodexAuthTransport, type HalluCodexProfile, type RefreshGrant } from './auth-protocol.ts'
import { createLoopbackLogin, type LoopbackLogin } from './loopback-login.ts'
import type { RefreshStore } from './secure-storage.ts'

/** The complete renderer-visible account state. */
export type HalluCodexAccountSnapshot =
  | { status: 'signed-out'; errorCode?: AuthErrorCode }
  | { status: 'signing-in'; expiresAt: number }
  | { status: 'signed-in'; profile: HalluCodexProfile; group: string; allowedGroups: string[] }

/** Trusted main-process composition; do not construct this broker in preload or renderer code. */
export interface HalluCodexAuthBrokerOptions {
  transport: HalluCodexAuthTransport
  store: RefreshStore
  /** Reads the selected server origin; the browser page and its callback must come from it. */
  origin(): string
  /**
   * Open the validated authorization page in the system browser, never a BrowserWindow.
   * @param url - Pinned HalluCodex browser authorization URL.
   */
  openExternal(url: string): Promise<void>
  deviceName: string
  now?: () => number
  /**
   * Receives only renderer-safe state; observer failures cannot disrupt the account lifecycle.
   * @param snapshot - Fresh account projection without credentials or callback parameters.
   */
  onChange?(snapshot: HalluCodexAccountSnapshot): void
}

interface Attempt {
  generation: number
  verifier: string
  expiresAt: number
  requestId?: string
  callback?: LoopbackLogin
}

function safeError(error: unknown): HalluCodexAuthError {
  return error instanceof HalluCodexAuthError ? error : new HalluCodexAuthError('network_error')
}

function refreshOnly(grant: RefreshGrant): RefreshGrant {
  return {
    refreshToken: grant.refreshToken, refreshExpiresAt: grant.refreshExpiresAt,
    deviceSessionId: grant.deviceSessionId, profile: { ...grant.profile }, group: grant.group,
  }
}

/** Single-instance account owner with serialized refresh rotation and generation-checked persistence. */
export class HalluCodexAuthBroker {
  readonly #options: HalluCodexAuthBrokerOptions
  readonly #now: () => number
  #generation = 0
  #controller = new AbortController()
  #attempt: Attempt | undefined
  #grant: AccessGrant | undefined
  #snapshot: HalluCodexAccountSnapshot = { status: 'signed-out' }
  #storageTail: Promise<void> = Promise.resolve()
  #refreshing: { generation: number; promise: Promise<string> } | undefined
  #restoring: Promise<HalluCodexAccountSnapshot> | undefined
  #tasks = new Set<Promise<void>>()
  #disposed = false

  constructor(options: HalluCodexAuthBrokerOptions) {
    this.#options = options
    this.#now = options.now ?? Date.now
  }

  /** @returns A fresh renderer-safe projection; mutating it cannot change the account. */
  getSnapshot(): HalluCodexAccountSnapshot {
    return structuredClone(this.#snapshot)
  }

  /**
   * Start a new PKCE attempt, invalidating every older callback, request, and stored result.
   * Resolves once the system browser has opened; completion is delivered through onChange/getSnapshot.
   * @returns The current renderer-safe state.
   */
  startSignIn(): Promise<HalluCodexAccountSnapshot> {
    const operation = this.startSignInAttempt()
    this.track(operation.then(() => {}, () => {}))
    return operation
  }

  private async startSignInAttempt(): Promise<HalluCodexAccountSnapshot> {
    if (this.#disposed) throw new HalluCodexAuthError('cancelled')
    const previous = this.#grant
    const generation = this.invalidate()
    this.#grant = undefined
    if (previous) this.bestEffort(() => this.#options.transport.revoke(previous.refreshToken))
    const attempt: Attempt = { generation, verifier: randomBytes(32).toString('base64url'), expiresAt: this.#now() + 300_000 }
    const state = randomBytes(32).toString('base64url')
    const signal = this.#controller.signal
    this.#attempt = attempt
    this.publish({ status: 'signing-in', expiresAt: attempt.expiresAt })
    try {
      await this.storage(() => this.#options.store.clear())
      this.assertCurrent(generation, attempt.expiresAt)
      this.#options.store.assertAvailable()
      const origin = this.#options.origin()
      attempt.callback = await createLoopbackLogin(state, { signal, expiresAt: attempt.expiresAt, now: this.#now, origin })
      this.assertCurrent(generation, attempt.expiresAt)
      const authorization = await this.#options.transport.authorize({
        state, codeChallenge: createHash('sha256').update(attempt.verifier).digest('base64url'),
        redirectUri: attempt.callback.redirectUri, deviceName: this.#options.deviceName,
      }, signal)
      attempt.requestId = authorization.requestId
      this.assertCurrent(generation, attempt.expiresAt)
      await this.#options.openExternal(authorizationUrl(authorization.authorizationUrl, origin))
      this.assertCurrent(generation, attempt.expiresAt)
      this.track(this.finishSignIn(attempt, signal))
    } catch (error) {
      await this.closeAttempt(attempt)
      if (generation === this.#generation) {
        this.#attempt = undefined
        this.publish({ status: 'signed-out', errorCode: safeError(error).code })
      }
    }
    return this.getSnapshot()
  }

  /**
   * Cancel the active browser attempt and prevent any late storage result from restoring it.
   * @returns The current renderer-safe state after local cleanup.
   */
  async cancelSignIn(): Promise<HalluCodexAccountSnapshot> {
    if (!this.#attempt) return this.getSnapshot()
    this.invalidate()
    this.#grant = undefined
    this.publish({ status: 'signed-out' })
    await this.storage(() => this.#options.store.clear())
    return this.getSnapshot()
  }

  /**
   * Restore by rotating the encrypted refresh credential; stored access tokens are never read.
   * @returns The safe account state, preserving saved credentials on transient failures.
   */
  async restore(): Promise<HalluCodexAccountSnapshot> {
    if (this.#disposed) throw new HalluCodexAuthError('cancelled')
    if (this.#grant || this.#attempt) return this.getSnapshot()
    if (this.#restoring) return this.#restoring
    const operation = this.restoreSaved()
    this.#restoring = operation
    this.track(operation.then(() => {}, () => {}))
    try { return await operation }
    finally { if (this.#restoring === operation) this.#restoring = undefined }
  }

  /**
   * Obtain a short-lived bearer for the trusted request broker only; never expose this method over IPC.
   * Concurrent callers share one refresh and cannot silently change the selected concrete group.
   * @returns A main-process-only bearer token.
   */
  async getAccessToken(): Promise<string> {
    const grant = this.#grant
    if (!grant || this.#disposed) throw new HalluCodexAuthError('signed_out')
    if (grant.accessExpiresAt > this.#now() + 30_000) return grant.accessToken
    if (this.#refreshing?.generation === this.#generation) return this.#refreshing.promise
    const generation = this.#generation
    const promise = this.rotate(grant, generation, this.#controller.signal)
    this.#refreshing = { generation, promise }
    this.track(promise.then(() => {}, () => {}))
    try { return await promise }
    finally {
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- A newer generation may finish and clear this field during await.
      if (this.#refreshing?.promise === promise) this.#refreshing = undefined
    }
  }

  /**
   * Treat the current access token as expired after the server rejected it; the next caller rotates it.
   * A revoked device then fails rotation with `invalid_grant` and signs out.
   */
  expireAccessToken(): void {
    if (this.#grant) this.#grant = { ...this.#grant, accessExpiresAt: 0 }
  }

  /**
   * Resolve coherent credentials for the trusted relay, never renderer IPC.
   * @returns The current bearer, device session, and concrete group from one account generation.
   */
  async getRequestCredentials(): Promise<{ accessToken: string; deviceSessionId: string; group: string }> {
    const generation = this.#generation
    const accessToken = await this.getAccessToken()
    this.assertCurrent(generation)
    if (!this.#grant || this.#grant.accessToken !== accessToken) throw new HalluCodexAuthError('cancelled')
    return { accessToken, deviceSessionId: this.#grant.deviceSessionId, group: this.#grant.group }
  }

  /**
   * Immediately block new requests, clear local credentials, then try remote family revocation.
   * @returns Whether remote revocation succeeded; false means the user can revoke from their device page.
   */
  signOut(): Promise<{ remoteRevoked: boolean }> {
    const operation = this.signOutAccount()
    this.track(operation.then(() => {}, () => {}))
    return operation
  }

  private async signOutAccount(): Promise<{ remoteRevoked: boolean }> {
    let grant: RefreshGrant | undefined = this.#grant
    const generation = this.invalidate()
    this.#grant = undefined
    this.publish({ status: 'signed-out' })
    let unavailable = false
    let localFailure = false
    try {
      await this.storage(async () => {
        if (!grant) {
          try { grant = (await this.#options.store.load()) ?? undefined }
          catch (_error) { unavailable = true }
        }
        await this.#options.store.clear()
      })
    } catch (_error) {
      localFailure = true
      if (generation === this.#generation) this.publish({ status: 'signed-out', errorCode: 'storage_error' })
    }
    let remoteRevoked = !unavailable
    if (grant) {
      try { await this.#options.transport.revoke(grant.refreshToken) }
      catch (_error) { remoteRevoked = false }
    }
    if (localFailure) throw new HalluCodexAuthError('storage_error')
    return { remoteRevoked }
  }

  /**
   * Stop the broker and wait for background account work and local writes to finish, retaining a saved login.
   * @returns Completion after callback listeners and tracked cleanup are quiescent.
   */
  async dispose(): Promise<void> {
    this.#disposed = true
    this.invalidate()
    this.#grant = undefined
    this.publish({ status: 'signed-out' })
    while (this.#tasks.size) await Promise.all([...this.#tasks])
    await this.#storageTail
  }

  private async finishSignIn(attempt: Attempt, signal: AbortSignal): Promise<void> {
    let received: AccessGrant | undefined
    try {
      const callback = attempt.callback
      if (!callback) throw new HalluCodexAuthError('cancelled')
      const code = await callback.code
      this.assertCurrent(attempt.generation, attempt.expiresAt)
      received = await this.#options.transport.exchange({ code, codeVerifier: attempt.verifier, redirectUri: callback.redirectUri }, signal)
      await this.install(received, attempt.generation, attempt.expiresAt)
      // Consumed-request cancellation revokes its issued session; successful login only closes the local listener.
      delete attempt.requestId
      if (this.#attempt === attempt) this.#attempt = undefined
    } catch (error) {
      const rejected = received
      if (rejected) this.bestEffort(() => this.#options.transport.revoke(rejected.refreshToken))
      if (attempt.generation === this.#generation) {
        this.#attempt = undefined
        this.publish({ status: 'signed-out', errorCode: safeError(error).code })
        if (received) {
          try { await this.storage(() => this.#options.store.clear()) }
          catch (_error) {
            if (attempt.generation === this.#generation) this.publish({ status: 'signed-out', errorCode: 'storage_error' })
          }
        }
      }
    } finally { await this.closeAttempt(attempt) }
  }

  private async restoreSaved(): Promise<HalluCodexAccountSnapshot> {
    const generation = this.#generation
    const signal = this.#controller.signal
    try {
      const saved = await this.storage(() => this.#options.store.load())
      this.assertCurrent(generation)
      if (saved) await this.rotate(saved, generation, signal)
    } catch (error) {
      if (generation === this.#generation) this.publish({ status: 'signed-out', errorCode: safeError(error).code })
    }
    return this.getSnapshot()
  }

  private async rotate(previous: RefreshGrant, generation: number, signal: AbortSignal): Promise<string> {
    let received: AccessGrant | undefined
    try {
      this.assertCurrent(generation)
      if (previous.refreshExpiresAt <= this.#now()) throw new HalluCodexAuthError('expired')
      try { received = await this.#options.transport.refresh(refreshOnly(previous), signal) }
      catch (firstError) {
        // A lost response may hide a committed rotation. The server repeats the same successor
        // for the previous token only briefly, so retry once immediately instead of on the next use.
        if (safeError(firstError).code !== 'network_error' || signal.aborted) throw firstError
        received = await this.#options.transport.refresh(refreshOnly(previous), signal)
      }
      if (received.group !== previous.group || received.deviceSessionId !== previous.deviceSessionId
        || received.profile.id !== previous.profile.id || received.refreshExpiresAt > previous.refreshExpiresAt
        || received.refreshToken === previous.refreshToken) throw new HalluCodexAuthError('invalid_response')
      await this.install(received, generation)
      return received.accessToken
    } catch (error) {
      const failure = safeError(error)
      const rejected = received
      if (rejected) this.bestEffort(() => this.#options.transport.revoke(rejected.refreshToken))
      if (generation === this.#generation && (received !== undefined
        || ['invalid_grant', 'expired', 'invalid_response', 'group_invalid'].includes(failure.code))) {
        this.invalidate()
        this.#grant = undefined
        this.publish({ status: 'signed-out', errorCode: failure.code })
        await this.storage(() => this.#options.store.clear())
      }
      throw failure
    }
  }

  private async install(grant: AccessGrant, generation: number, expiresAt?: number): Promise<void> {
    this.assertCurrent(generation, expiresAt)
    await this.storage(async () => {
      this.assertCurrent(generation, expiresAt)
      try { await this.#options.store.save(refreshOnly(grant)) }
      catch (error) {
        // A rename can succeed before fsync fails, including after disposal invalidates this generation.
        await this.#options.store.clear()
        throw error
      }
      if (generation !== this.#generation || this.#disposed || (expiresAt !== undefined && this.#now() >= expiresAt)) {
        await this.#options.store.clear()
        this.assertCurrent(generation, expiresAt)
      }
    })
    this.assertCurrent(generation, expiresAt)
    this.#grant = grant
    this.publish({ status: 'signed-in', profile: { ...grant.profile }, group: grant.group, allowedGroups: [...grant.allowedGroups] })
  }

  private assertCurrent(generation: number, expiresAt?: number): void {
    if (generation !== this.#generation || this.#disposed || this.#controller.signal.aborted) throw new HalluCodexAuthError('cancelled')
    if (expiresAt !== undefined && this.#now() >= expiresAt) throw new HalluCodexAuthError('expired')
  }

  private invalidate(): number {
    this.#generation += 1
    this.#controller.abort()
    this.#controller = new AbortController()
    const attempt = this.#attempt
    this.#attempt = undefined
    if (attempt) this.track(this.closeAttempt(attempt))
    return this.#generation
  }

  private async closeAttempt(attempt: Attempt): Promise<void> {
    if (attempt.callback) await attempt.callback.close()
    if (attempt.requestId) {
      const id = attempt.requestId
      delete attempt.requestId
      this.bestEffort(() => this.#options.transport.cancel(id, attempt.verifier))
    }
  }

  private storage<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#storageTail.then(operation)
    this.#storageTail = result.then(() => {}, () => {})
    return result
  }

  private track(task: Promise<void>): void {
    this.#tasks.add(task)
    void task.finally(() => { this.#tasks.delete(task) })
  }

  private bestEffort(operation: () => Promise<void>): void {
    this.track(Promise.resolve().then(operation).catch(() => { /* Local invalidation has already taken effect. */ }))
  }

  private publish(snapshot: HalluCodexAccountSnapshot): void {
    this.#snapshot = snapshot
    try { this.#options.onChange?.(this.getSnapshot()) }
    catch (_error) { /* A renderer observer cannot interrupt credential cleanup or grant installation. */ }
  }
}
