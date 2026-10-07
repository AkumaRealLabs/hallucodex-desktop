/** electron-builder publish entry for this repository's GitHub Releases. */
export const DESKTOP_UPDATE_PUBLISH: {
  readonly provider: 'github'
  readonly owner: 'AkumaRealLabs'
  readonly repo: 'hallucodex-desktop'
  readonly releaseType: 'release'
}

/** Updater configuration filename inside the packaged resources directory. */
export const DESKTOP_APP_UPDATE_CONFIG: 'app-update.yml'

/** One installer entry of an electron-builder update metadata file. */
export interface DesktopUpdateFile {
  readonly url: string
  readonly sha512: string
  readonly size: number
}

/** Validated fields of an electron-builder update metadata file. */
export interface DesktopUpdateMetadata {
  readonly version: string
  readonly files: readonly DesktopUpdateFile[]
  readonly path?: string
  readonly sha512?: string
  readonly releaseDate?: string
}

/**
 * Return the `latest` channel metadata filename electron-builder writes for one target.
 * @param platform - Target platform.
 * @param arch - Target architecture.
 * @returns Metadata filename beside the installers.
 */
export function desktopUpdateMetadataFilename(platform: NodeJS.Platform, arch: string): string

/**
 * Return the installer extensions whose differential-download blockmap must sit beside them.
 * @param platform - Target platform.
 * @returns Extensions, including the leading dot.
 */
export function desktopBlockmapExtensions(platform: NodeJS.Platform): readonly string[]

/**
 * Write the updater configuration electron-builder writes for installer targets.
 * @param resourcesDir - Packaged resources directory.
 * @param updaterCacheDirName - electron-builder updater cache directory name.
 * @returns Resolves after the file is written.
 */
export function writeDesktopAppUpdateConfig(resourcesDir: string, updaterCacheDirName: string): Promise<void>

/**
 * Verify that a packaged application reads this repository's GitHub Releases.
 * @param resourcesDir - Packaged resources directory.
 * @returns The parsed configuration.
 */
export function verifyDesktopAppUpdateConfig(resourcesDir: string): Promise<Record<string, unknown>>

/**
 * Parse one electron-builder update metadata document.
 * @param contents - YAML text.
 * @param label - Source named in failures.
 * @returns Validated fields.
 */
export function parseDesktopUpdateMetadata(contents: string, label: string): DesktopUpdateMetadata

/**
 * Verify one metadata file against the installers beside it.
 * @param request - Directory holding the metadata and installers, expected build version, and target platform.
 * @returns The metadata filename followed by every installer and blockmap it requires.
 */
export function verifyDesktopUpdateMetadata(request: {
  readonly directory: string
  readonly filename: string
  readonly version: string
  readonly platform: NodeJS.Platform
}): Promise<string[]>

/**
 * Combine per-architecture metadata for one platform into the single file the release serves.
 * @param contents - YAML documents built for the same version on separate runners.
 * @returns Combined YAML document.
 */
export function mergeDesktopUpdateMetadata(contents: readonly string[]): string
