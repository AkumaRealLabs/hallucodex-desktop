/**
 * Suggest the next build version for a product version, so the sequence number
 * is derived rather than remembered.
 *
 * `apps/desktop/README.md` gives the form as `<product version>.<date>.<index>`
 * for a prerelease base and `<product version>-test.<date>.<index>` for a
 * stable one. What makes an index correct is which ones are taken. HalluCodex
 * publishes to no update bucket, so the only record is the target's local
 * output directory; indexes handed out from another machine or a cleaned
 * directory are not visible here.
 */

import { readdir } from 'node:fs/promises'
import { parse } from 'semver'
import { desktopBuildVersionPrefix, validateDesktopBuildVersion } from './desktop-build-version.mjs'

/**
 * Artifact name electron-builder writes for one build; unsigned Windows builds add a suffix.
 * Artifacts named before the HalluCodex rename still occupy their index in the same directory.
 */
const ARTIFACT = new RegExp(
  '^(?:deepseek-harness|hallucodex)-(?<version>.+)-(?:mac|win|linux)-(?:arm64|x64|x86_64|arm_aarch64|amd64)'
  + '(?:-(?:dev-)?unsigned)?\\.(?:exe|dmg|zip|deb|AppImage)$', 'u',
)

/** Inputs that decide which versions are already taken. */
export interface DesktopBuildVersionSuggestionOptions {
  readonly productVersion: string
  /** Date segment to number within; defaults to today where the build runs. */
  readonly date?: string
  /** Directory electron-builder writes installers into for this build. */
  readonly artifactsRoot: string
}

/**
 * Format a date as the convention's segment.
 * @param date - Date to format.
 * @returns The date as `YYYYMMDD` in the build host's own time zone.
 */
export function desktopBuildDateSegment(date: Date = new Date()): string {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  return `${String(date.getFullYear())}${month}${String(date.getDate()).padStart(2, '0')}`
}

/**
 * Read the sequence numbers already used for one product version and date.
 * @param versions - Versions found in an output directory.
 * @param prefix - Everything a numbered build carries before its index.
 * @returns Every index present, unordered.
 */
function sequenceNumbers(versions: Iterable<string>, prefix: string): number[] {
  const numbers: number[] = []
  for (const version of versions) {
    if (!version.startsWith(prefix)) continue
    const index = version.slice(prefix.length)
    if (/^\d+$/u.test(index)) numbers.push(Number(index))
  }
  return numbers
}

/**
 * Read the versions one output directory already holds.
 * @param artifactsRoot - Directory electron-builder wrote installers into.
 * @returns Versions parsed from artifact names.
 */
async function localVersions(artifactsRoot: string): Promise<string[]> {
  const entries = await readdir(artifactsRoot).catch(() => [])
  return entries.map(entry => ARTIFACT.exec(entry)?.groups?.version)
    .filter((version): version is string => version !== undefined && parse(version) !== null)
}

/**
 * Suggest the next build version for today, numbering after what is already taken.
 * @param options - Product version, date, and the output directory to search.
 * @returns A validated build version whose index is free in that directory.
 */
export async function suggestDesktopBuildVersion(options: DesktopBuildVersionSuggestionOptions): Promise<string> {
  const prefix = `${desktopBuildVersionPrefix(options.productVersion)}${options.date ?? desktopBuildDateSegment()}.`
  const used = sequenceNumbers(await localVersions(options.artifactsRoot), prefix)
  const next = used.length === 0 ? 1 : Math.max(...used) + 1
  const suggestion = validateDesktopBuildVersion(`${prefix}${String(next)}`)
  process.stdout.write(`desktop package: numbering ${suggestion} after ${String(used.length)} local artifact${
    used.length === 1 ? '' : 's'} for ${prefix}*\n`)
  return suggestion
}
