/** Account server address selection; every account, relay and browser request uses one origin. */

import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { DEFAULT_HALLUCODEX_ORIGIN } from './server-default.ts'

export { DEFAULT_HALLUCODEX_ORIGIN }

/**
 * Reduce a user-entered server address to the exact origin browsers send in `Origin`.
 * @param value - Untrusted address from the account dialog or the settings file.
 * @returns Lower-case `scheme://host[:port]` for an HTTP(S) site root.
 * @throws {Error} When the address has credentials, a path, query, fragment or another scheme.
 */
export function normalizeServerOrigin(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error('hallucodex: invalid server address')
  }
  let url: URL
  try { url = new URL(value.trim()) }
  catch (_parseError) { throw new Error('hallucodex: invalid server address') }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password
    || url.search || url.hash || value.includes('#') || (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error('hallucodex: invalid server address')
  }
  return url.origin
}

/**
 * Read the saved server origin; a missing or unreadable file selects the production service.
 * @param file - Settings file inside the application's userData directory.
 * @returns Normalized origin.
 */
export function readServerOrigin(file: string): string {
  try {
    const value: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (typeof value === 'object' && value !== null && 'origin' in value) return normalizeServerOrigin(value.origin)
  } catch (_readError) {
    // A missing or damaged settings file selects the production service; credentials are bound per origin.
  }
  return DEFAULT_HALLUCODEX_ORIGIN
}

/**
 * Atomically save the selected server origin.
 * @param file - Settings file inside the application's userData directory.
 * @param origin - Normalized origin.
 */
export function writeServerOrigin(file: string, origin: string): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const temporary = join(dirname(file), `.server-${randomBytes(8).toString('hex')}.tmp`)
  const fd = openSync(temporary, 'wx', 0o600)
  try {
    writeFileSync(fd, `${JSON.stringify({ version: 1, origin: normalizeServerOrigin(origin) })}\n`)
    fsyncSync(fd)
  } finally { closeSync(fd) }
  renameSync(temporary, file)
}

/** The selected server origin, shared by every account, catalog and relay request in the main process. */
export class ServerOriginSetting {
  #origin: string

  /**
   * @param file - Settings file inside userData; undefined keeps the selection in memory only.
   * @param initial - Normalized origin to start from.
   */
  constructor(private readonly file: string | undefined, initial: string) {
    this.#origin = normalizeServerOrigin(initial)
  }

  /**
   * Load the saved selection, defaulting to the production service.
   * @param file - Settings file inside the application's userData directory.
   * @returns The setting bound to that file.
   */
  static load(file: string): ServerOriginSetting {
    return new ServerOriginSetting(file, readServerOrigin(file))
  }

  /** @returns The selected origin. */
  get(): string { return this.#origin }

  /**
   * Select and persist another origin.
   * @param origin - Normalized origin.
   */
  set(origin: string): void {
    const normalized = normalizeServerOrigin(origin)
    if (this.file !== undefined) writeServerOrigin(this.file, normalized)
    this.#origin = normalized
  }
}
