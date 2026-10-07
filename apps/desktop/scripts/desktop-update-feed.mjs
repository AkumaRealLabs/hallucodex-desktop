/** Name the GitHub Releases update feed and verify the update files electron-builder writes for it. */

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { dump, load } from 'js-yaml'

/**
 * electron-builder publish entry for this repository's GitHub Releases.
 * Packaging always passes `--publish never`; the release workflow uploads the files.
 */
export const DESKTOP_UPDATE_PUBLISH = Object.freeze({
  provider: 'github',
  owner: 'AkumaRealLabs',
  repo: 'hallucodex-desktop',
  releaseType: 'release',
})

/** Updater configuration filename inside the packaged resources directory. */
export const DESKTOP_APP_UPDATE_CONFIG = 'app-update.yml'

/**
 * Return the `latest` channel metadata filename electron-builder writes for one target.
 * @param {NodeJS.Platform} platform - Target platform.
 * @param {string} arch - Target architecture.
 * @returns {string} Metadata filename beside the installers.
 */
export function desktopUpdateMetadataFilename(platform, arch) {
  if (platform === 'win32') return 'latest.yml'
  if (platform === 'darwin') return 'latest-mac.yml'
  if (platform === 'linux') return arch === 'x64' ? 'latest-linux.yml' : `latest-linux-${arch}.yml`
  throw new Error(`desktop update feed: unsupported platform ${platform}`)
}

/**
 * Return the installer extensions whose differential-download blockmap must sit beside them.
 * AppImage embeds its blockmap, so Linux requires no separate file.
 * @param {NodeJS.Platform} platform - Target platform.
 * @returns {readonly string[]} Extensions, including the leading dot.
 */
export function desktopBlockmapExtensions(platform) {
  return platform === 'win32' ? ['.exe'] : platform === 'darwin' ? ['.zip'] : []
}

function record(value, label) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`desktop update feed: ${label} must be a mapping`)
  }
  return value
}

function text(value, label) {
  if (typeof value !== 'string' || value === '') throw new Error(`desktop update feed: ${label} must be a non-empty string`)
  return value
}

/**
 * Write the updater configuration electron-builder writes for installer targets.
 * macOS directory builds need it before signing because electron-builder writes it only for DMG and ZIP targets.
 * @param {string} resourcesDir - Packaged resources directory.
 * @param {string} updaterCacheDirName - electron-builder updater cache directory name.
 * @returns {Promise<void>} Resolves after the file is written.
 */
export async function writeDesktopAppUpdateConfig(resourcesDir, updaterCacheDirName) {
  const config = { ...DESKTOP_UPDATE_PUBLISH, updaterCacheDirName: text(updaterCacheDirName, 'updater cache directory') }
  await writeFile(join(resourcesDir, DESKTOP_APP_UPDATE_CONFIG), dump(config, { lineWidth: -1, noRefs: true }))
}

/**
 * Verify that a packaged application reads this repository's GitHub Releases.
 * @param {string} resourcesDir - Packaged resources directory.
 * @returns {Promise<Record<string, unknown>>} The parsed configuration.
 */
export async function verifyDesktopAppUpdateConfig(resourcesDir) {
  const path = join(resourcesDir, DESKTOP_APP_UPDATE_CONFIG)
  let parsed
  try {
    parsed = load(await readFile(path, 'utf8'))
  }
  catch (error) {
    throw new Error(`desktop update feed: cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
  const config = record(parsed, path)
  for (const [name, value] of Object.entries(DESKTOP_UPDATE_PUBLISH)) {
    if (config[name] !== value) throw new Error(`desktop update feed: ${path} must set ${name} to ${value}`)
  }
  text(config.updaterCacheDirName, `${path} updaterCacheDirName`)
  return config
}

/**
 * Parse one electron-builder update metadata document.
 * @param {string} contents - YAML text.
 * @param {string} label - Source named in failures.
 * @returns {{ version: string, files: { url: string, sha512: string, size: number }[], path?: string, sha512?: string, releaseDate?: string }} Validated fields; other fields are preserved.
 */
export function parseDesktopUpdateMetadata(contents, label) {
  const document = record(load(contents), label)
  text(document.version, `${label} version`)
  if (!Array.isArray(document.files) || document.files.length === 0) throw new Error(`desktop update feed: ${label} lists no files`)
  for (const [index, entry] of document.files.entries()) {
    const file = record(entry, `${label} files[${index}]`)
    const url = text(file.url, `${label} files[${index}].url`)
    if (url.includes('/') || url.includes('\\')) throw new Error(`desktop update feed: ${label} file ${url} must be a sibling filename`)
    text(file.sha512, `${label} files[${index}].sha512`)
    if (!Number.isSafeInteger(file.size) || file.size <= 0) throw new Error(`desktop update feed: ${label} file ${url} has no size`)
  }
  if (document.path !== undefined && !document.files.some(file => file.url === document.path)) {
    throw new Error(`desktop update feed: ${label} path ${String(document.path)} is not among its files`)
  }
  return document
}

async function sha512(path) {
  const hash = createHash('sha512')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('base64')
}

async function requireFile(directory, name, label) {
  const path = join(directory, name)
  let details
  try { details = await stat(path) }
  catch { throw new Error(`desktop update feed: ${label} references missing file ${name}`) }
  if (!details.isFile() || details.size === 0) throw new Error(`desktop update feed: ${label} references empty or non-file ${name}`)
  return details
}

/**
 * Verify one metadata file against the installers beside it.
 * @param {{ directory: string, filename: string, version: string, platform: NodeJS.Platform }} request - Directory holding the metadata and installers, expected build version, and target platform.
 * @returns {Promise<string[]>} The metadata filename followed by every installer and blockmap it requires.
 */
export async function verifyDesktopUpdateMetadata({ directory, filename, version, platform }) {
  let contents
  try { contents = await readFile(join(directory, filename), 'utf8') }
  catch { throw new Error(`desktop update feed: missing ${filename} in ${directory}`) }
  const document = parseDesktopUpdateMetadata(contents, filename)
  if (document.version !== version) throw new Error(`desktop update feed: ${filename} declares ${document.version}, expected ${version}`)
  const required = [filename]
  for (const file of document.files) {
    const details = await requireFile(directory, file.url, filename)
    if (details.size !== file.size) throw new Error(`desktop update feed: ${filename} records ${file.size} bytes for ${file.url}, found ${details.size}`)
    if (await sha512(join(directory, file.url)) !== file.sha512) throw new Error(`desktop update feed: ${filename} records another SHA-512 for ${file.url}`)
    required.push(file.url)
    if (desktopBlockmapExtensions(platform).some(extension => file.url.endsWith(extension))) {
      await requireFile(directory, `${file.url}.blockmap`, filename)
      required.push(`${file.url}.blockmap`)
    }
  }
  return [...new Set(required)]
}

/**
 * Combine per-architecture metadata for one platform into the single file the release serves.
 * The first document keeps its legacy `path` and `sha512`; electron-updater selects by architecture from `files`.
 * @param {readonly string[]} contents - YAML documents built for the same version on separate runners.
 * @returns {string} Combined YAML document.
 */
export function mergeDesktopUpdateMetadata(contents) {
  const documents = contents.map((content, index) => parseDesktopUpdateMetadata(content, `metadata ${index + 1}`))
  if (documents.length === 0) throw new Error('desktop update feed: no metadata to merge')
  const [first] = documents
  const files = new Map()
  for (const document of documents) {
    if (document.version !== first.version) {
      throw new Error(`desktop update feed: cannot merge versions ${first.version} and ${document.version}`)
    }
    for (const file of document.files) {
      const existing = files.get(file.url)
      if (existing !== undefined && (existing.sha512 !== file.sha512 || existing.size !== file.size)) {
        throw new Error(`desktop update feed: ${file.url} differs between merged metadata`)
      }
      files.set(file.url, file)
    }
  }
  const releaseDates = documents.map(document => document.releaseDate).filter(date => typeof date === 'string').sort()
  return dump({
    ...first,
    files: [...files.values()],
    ...releaseDates.length === 0 ? {} : { releaseDate: releaseDates.at(-1) },
  }, { lineWidth: -1, noRefs: true })
}
