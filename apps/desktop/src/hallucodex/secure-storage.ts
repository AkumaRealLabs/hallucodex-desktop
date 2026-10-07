/** Refresh-only persistence in an owner-private file encrypted by Electron's OS-backed safeStorage. */

import { randomBytes } from 'node:crypto'
import { constants, closeSync, fchmodSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, chmodSync, fstatSync, type Stats } from 'node:fs'
import { join, resolve } from 'node:path'
import { HalluCodexAuthError, parseRefreshRecord, type RefreshGrant } from './auth-protocol.ts'

/** Inject Electron safeStorage only after app readiness; do not enable plaintext encryption. */
export interface SafeStorageEncryption {
  /** @returns Whether the OS key store is available. */
  isEncryptionAvailable(): boolean
  /** @returns Linux backend name; unknown/basic_text cannot protect refresh credentials. */
  getSelectedStorageBackend?(): string
  /**
   * Encrypt without logging or retaining plaintext.
   * @param plainText - Refresh-only JSON record.
   * @returns OS-key-protected ciphertext.
   */
  encryptString(plainText: string): Buffer
  /**
   * Decrypt only inside the main process.
   * @param encrypted - Persisted ciphertext.
   * @returns Decrypted refresh-only JSON, never sent to the renderer.
   */
  decryptString(encrypted: Buffer): string
}

/** Single-owner main-process refresh persistence, serialized by the account broker. */
export interface RefreshStore {
  /** Fail closed when OS-backed encryption is unavailable. */
  assertAvailable(): void
  /** @returns The encrypted refresh grant, or null when no account is saved. */
  load(): Promise<RefreshGrant | null>
  /**
   * Atomically replace the encrypted refresh grant; never persist access tokens.
   * @param grant - Refresh credential and immutable account/session/group binding.
   */
  save(grant: RefreshGrant): Promise<void>
  /** Delete local credentials even if the OS key store is unavailable. */
  clear(): Promise<void>
}

const linuxBackends = new Set(['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'])

/**
 * Owner-private encrypted storage. The directory must be dedicated to this account store under trusted app userData.
 * The desktop must hold its single-instance lock before creating a broker that uses this store.
 */
export class SafeStorageRefreshStore implements RefreshStore {
  readonly #directory: string
  readonly #file: string
  readonly #encryption: SafeStorageEncryption
  readonly #origin: () => string
  readonly #platform: NodeJS.Platform

  /**
   * @param directory - Dedicated account directory under trusted app userData.
   * @param encryption - OS-backed Electron safeStorage.
   * @param origin - Selected server origin; a saved record issued by another origin does not load.
   * @param platform - Native platform deciding the accepted Linux key-store backends.
   */
  constructor(directory: string, encryption: SafeStorageEncryption, origin: () => string, platform: NodeJS.Platform = process.platform) {
    this.#directory = resolve(directory)
    this.#file = join(this.#directory, 'refresh.enc')
    this.#encryption = encryption
    this.#origin = origin
    this.#platform = platform
  }

  assertAvailable(): void {
    try {
      if (!this.#encryption.isEncryptionAvailable()
        || (this.#platform === 'linux' && !linuxBackends.has(this.#encryption.getSelectedStorageBackend?.() ?? 'unknown'))) {
        throw new HalluCodexAuthError('secure_storage_unavailable')
      }
    } catch (_error) {
      throw new HalluCodexAuthError('secure_storage_unavailable')
    }
  }

  load(): Promise<RefreshGrant | null> {
    return Promise.resolve().then(() => this.loadRecord())
  }

  private loadRecord(): RefreshGrant | null {
    this.assertAvailable()
    try {
      this.prepareDirectory()
      if (!this.checkFile()) return null
      const fd = openSync(this.#file, constants.O_RDONLY | constants.O_NOFOLLOW)
      let encrypted: Buffer
      try {
        this.checkPrivateFile(fstatSync(fd))
        encrypted = readFileSync(fd)
      } finally { closeSync(fd) }
      return parseRefreshRecord(JSON.parse(this.#encryption.decryptString(encrypted)), this.#origin())
    } catch (_error) {
      throw new HalluCodexAuthError('storage_error')
    }
  }

  save(grant: RefreshGrant): Promise<void> {
    return Promise.resolve().then(() => { this.saveRecord(grant) })
  }

  private saveRecord(grant: RefreshGrant): void {
    this.assertAvailable()
    let temporary: string | undefined
    try {
      this.prepareDirectory()
      this.checkFile()
      // Project explicitly so an AccessGrant passed structurally cannot put its accessToken on disk.
      const origin = this.#origin()
      const record = parseRefreshRecord({
        version: 1, origin,
        refreshToken: grant.refreshToken, refreshExpiresAt: grant.refreshExpiresAt,
        deviceSessionId: grant.deviceSessionId, group: grant.group,
        profile: { id: grant.profile.id, displayName: grant.profile.displayName },
      }, origin)
      const encrypted = this.#encryption.encryptString(JSON.stringify({ version: 1, origin, ...record }))
      if (encrypted.byteLength === 0 || encrypted.byteLength > 65_536) throw new HalluCodexAuthError('storage_error')
      temporary = join(this.#directory, `.refresh-${randomBytes(16).toString('hex')}.tmp`)
      const fd = openSync(temporary, 'wx', 0o600)
      try {
        if (this.#platform !== 'win32') fchmodSync(fd, 0o600)
        writeFileSync(fd, encrypted)
        fsyncSync(fd)
      } finally { closeSync(fd) }
      this.checkFile()
      renameSync(temporary, this.#file)
      temporary = undefined
      this.syncDirectory()
    } catch (_error) {
      throw new HalluCodexAuthError('storage_error')
    } finally {
      if (temporary !== undefined) {
        try { unlinkSync(temporary) }
        catch (_error) { /* A failed write may never have created its exclusive temporary file. */ }
      }
    }
  }

  clear(): Promise<void> {
    return Promise.resolve().then(() => { this.clearRecord() })
  }

  private clearRecord(): void {
    try {
      this.prepareDirectory()
      const file = lstatSync(this.#file, { throwIfNoEntry: false })
      if (!file) return
      // Unlink removes a replaced symlink itself without following its target.
      if (!file.isFile() && !file.isSymbolicLink()) throw new HalluCodexAuthError('storage_error')
      unlinkSync(this.#file)
      this.syncDirectory()
    } catch (_error) {
      throw new HalluCodexAuthError('storage_error')
    }
  }

  private prepareDirectory(): void {
    mkdirSync(this.#directory, { recursive: true, mode: 0o700 })
    const directory = lstatSync(this.#directory)
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw new HalluCodexAuthError('storage_error')
    if (this.#platform !== 'win32') {
      if (process.getuid && directory.uid !== process.getuid()) throw new HalluCodexAuthError('storage_error')
      chmodSync(this.#directory, 0o700)
    }
  }

  private checkPrivateFile(file: Stats): void {
    if (!file.isFile() || file.nlink !== 1 || file.size > 65_536) throw new HalluCodexAuthError('storage_error')
    if (this.#platform !== 'win32' && ((file.mode & 0o777) !== 0o600 || (process.getuid && file.uid !== process.getuid()))) {
      throw new HalluCodexAuthError('storage_error')
    }
  }

  private checkFile(): boolean {
    const file = lstatSync(this.#file, { throwIfNoEntry: false })
    if (!file) return false
    this.checkPrivateFile(file)
    return true
  }

  private syncDirectory(): void {
    if (this.#platform === 'win32') return
    const fd = openSync(this.#directory, constants.O_RDONLY | constants.O_DIRECTORY)
    try { fsyncSync(fd) }
    finally { closeSync(fd) }
  }
}
