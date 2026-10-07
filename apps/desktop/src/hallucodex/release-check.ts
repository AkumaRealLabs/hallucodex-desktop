/** Read the latest public HalluCodex desktop release; the app only points users at it and never installs anything. */

import { readFileSync, writeFileSync } from 'node:fs'

/** Public release page users download installers from. */
export const HALLUCODEX_RELEASES_URL = 'https://github.com/AkumaRealLabs/hallucodex-desktop/releases'

/** GitHub API endpoint for the latest stable (non-prerelease, non-draft) release. */
export const HALLUCODEX_LATEST_RELEASE_API = 'https://api.github.com/repos/AkumaRealLabs/hallucodex-desktop/releases/latest'

/** Release-body marker before the installation instructions the release workflow appends for the download page. */
export const RELEASE_INSTALL_NOTES_MARKER = '<!-- hallucodex:install-notes -->'

/** Longest changelog excerpt shown in a native dialog; the release page carries the rest. */
const MAX_NOTES_CHARS = 4000

const TAG_PREFIX = 'hallucodex-v'
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/u

/** Outcome of comparing the running version with the latest public release. */
export type HalluCodexReleaseCheck =
  | { readonly status: 'newer'; readonly version: string; readonly url: string; readonly notes: string }
  | { readonly status: 'current'; readonly version: string }

interface ParsedVersion {
  readonly core: readonly [number, number, number]
  readonly prerelease: readonly string[]
}

function parseVersion(version: string): ParsedVersion | undefined {
  const match = SEMVER.exec(version)
  if (match === null) return undefined
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] === undefined ? [] : match[4].split('.'),
  }
}

function compareIdentifier(left: string, right: string): number {
  const leftNumeric = /^\d+$/u.test(left)
  const rightNumeric = /^\d+$/u.test(right)
  if (leftNumeric && rightNumeric) return Math.sign(Number(left) - Number(right))
  if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1
  return left < right ? -1 : left > right ? 1 : 0
}

/**
 * Order two semantic versions by SemVer 2.0 precedence; build metadata is ignored.
 * @param left - First version.
 * @param right - Second version.
 * @returns Negative, zero or positive like a sort comparator.
 * @throws when either value is not a semantic version.
 */
export function compareVersions(left: string, right: string): number {
  const a = parseVersion(left)
  const b = parseVersion(right)
  if (a === undefined || b === undefined) throw new Error(`hallucodex release: invalid version ${JSON.stringify(a === undefined ? left : right)}`)
  const core = Math.sign(a.core[0] - b.core[0] || a.core[1] - b.core[1] || a.core[2] - b.core[2])
  if (core !== 0) return core
  if (a.prerelease.length === 0 || b.prerelease.length === 0) return Math.sign(b.prerelease.length - a.prerelease.length)
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index++) {
    const left = a.prerelease[index]
    const right = b.prerelease[index]
    if (left === undefined) return -1
    if (right === undefined) return 1
    const order = compareIdentifier(left, right)
    if (order !== 0) return order
  }
  return 0
}

/**
 * Turn a GitHub release body (Markdown) into plain text for a native dialog; nothing is rendered as markup.
 * Installation instructions after {@link RELEASE_INSTALL_NOTES_MARKER} belong to the download page and are dropped.
 * @param body - Release body as GitHub returns it.
 * @returns Readable notes, possibly empty, capped at a dialog-sized excerpt.
 */
export function releaseNotesText(body: string): string {
  const markerAt = body.indexOf(RELEASE_INSTALL_NOTES_MARKER)
  const text = (markerAt === -1 ? body : body.slice(0, markerAt))
    .replace(/\r\n?/gu, '\n')
    .replace(/<!--[\s\S]*?-->/gu, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
    .replace(/^#{1,6}\s+/gmu, '')
    .replace(/^(\s*)[-*+]\s+/gmu, '$1• ')
    .replace(/(\*\*|__)(.+?)\1/gu, '$2')
    .replace(/`([^`]+)`/gu, '$1')
    .replace(/\n{3,}/gu, '\n\n')
    .trim()
  return text.length > MAX_NOTES_CHARS ? `${text.slice(0, MAX_NOTES_CHARS).trimEnd()}…` : text
}

/**
 * Validate one GitHub release payload; only this repository's `hallucodex-v<semver>` tags count.
 * @param value - Parsed JSON body.
 * @returns The release version, its page, and its notes as plain text.
 * @throws for any other shape, tag, or page origin.
 */
export function parseRelease(value: unknown): { version: string; url: string; notes: string } {
  if (typeof value !== 'object' || value === null) throw new Error('hallucodex release: invalid response')
  const tag: unknown = Reflect.get(value, 'tag_name')
  const page: unknown = Reflect.get(value, 'html_url')
  const body: unknown = Reflect.get(value, 'body')
  if (typeof tag !== 'string' || !tag.startsWith(TAG_PREFIX) || parseVersion(tag.slice(TAG_PREFIX.length)) === undefined) {
    throw new Error('hallucodex release: unexpected release tag')
  }
  if (typeof page !== 'string' || !page.startsWith(`${HALLUCODEX_RELEASES_URL}/`)) throw new Error('hallucodex release: unexpected release page')
  return { version: tag.slice(TAG_PREFIX.length), url: page, notes: typeof body === 'string' ? releaseNotesText(body) : '' }
}

const GITHUB_HEADERS = { accept: 'application/vnd.github+json', 'user-agent': 'HalluCodex-Desktop', 'x-github-api-version': '2022-11-28' }

/**
 * Ask GitHub for the latest stable release and compare it with the running version.
 * @param currentVersion - The running application's semantic version.
 * @param fetcher - Network fetch; the main process passes Electron's `net.fetch` so system proxies apply.
 * @param signal - Cancellation and timeout.
 * @returns Whether a newer public release exists, with its notes.
 */
export async function checkHalluCodexRelease(
  currentVersion: string,
  fetcher: (url: string, init: RequestInit) => Promise<Response>,
  signal: AbortSignal,
): Promise<HalluCodexReleaseCheck> {
  const response = await fetcher(HALLUCODEX_LATEST_RELEASE_API, { headers: GITHUB_HEADERS, redirect: 'error', signal })
  // No published stable release yet: the running build is the newest one available.
  if (response.status === 404) return { status: 'current', version: currentVersion }
  if (!response.ok) throw new Error(`hallucodex release: GitHub answered ${String(response.status)}`)
  const latest = parseRelease(await response.json())
  return compareVersions(latest.version, currentVersion) > 0
    ? { status: 'newer', ...latest }
    : { status: 'current', version: currentVersion }
}

/**
 * Read the notes of one published release, for the in-app update confirmation.
 * @param version - Release version without the tag prefix.
 * @param fetcher - Network fetch.
 * @param signal - Cancellation and timeout.
 * @returns Plain-text notes; empty when the release has none.
 * @throws when the release cannot be read or does not belong to this repository.
 */
export async function fetchHalluCodexReleaseNotes(
  version: string,
  fetcher: (url: string, init: RequestInit) => Promise<Response>,
  signal: AbortSignal,
): Promise<string> {
  if (parseVersion(version) === undefined) throw new Error(`hallucodex release: invalid version ${JSON.stringify(version)}`)
  const url = `https://api.github.com/repos/AkumaRealLabs/hallucodex-desktop/releases/tags/${TAG_PREFIX}${version}`
  const response = await fetcher(url, { headers: GITHUB_HEADERS, redirect: 'error', signal })
  if (!response.ok) throw new Error(`hallucodex release: GitHub answered ${String(response.status)}`)
  const release = parseRelease(await response.json())
  if (release.version !== version) throw new Error('hallucodex release: notes belong to another release')
  return release.notes
}

/** Remembers the release a user postponed from an automatic prompt; manual checks always report. */
export class ReleaseNoticeState {
  private dismissedVersion: string | undefined

  private constructor(private readonly file: string, dismissed: string | undefined) {
    this.dismissedVersion = dismissed
  }

  /**
   * Load the postponed version; a missing or unreadable file means nothing was postponed.
   * @param file - Private JSON file under the application's user-data directory.
   * @returns The state bound to that file.
   */
  static load(file: string): ReleaseNoticeState {
    try {
      const value: unknown = JSON.parse(readFileSync(file, 'utf8'))
      const dismissed: unknown = typeof value === 'object' && value !== null ? Reflect.get(value, 'dismissedVersion') : undefined
      return new ReleaseNoticeState(file, typeof dismissed === 'string' ? dismissed : undefined)
    } catch (_readError) {
      return new ReleaseNoticeState(file, undefined)
    }
  }

  /** The release the user last postponed, if any. */
  get dismissed(): string | undefined { return this.dismissedVersion }

  /**
   * Stop prompting automatically for one release; a later release prompts again.
   * @param version - The postponed release version.
   */
  dismiss(version: string): void {
    this.dismissedVersion = version
    try { writeFileSync(this.file, `${JSON.stringify({ dismissedVersion: version })}\n`, { mode: 0o600 }) }
    catch (_writeError) { /* Losing the preference only means one more prompt next launch. */ }
  }
}
