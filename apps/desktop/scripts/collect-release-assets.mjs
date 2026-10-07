/**
 * Gather one HalluCodex version's installers and update files into a GitHub Release directory.
 *
 * Inputs are electron-builder output directories, or earlier collections, from separate runners.
 * Same-named macOS metadata from the arm64 and x64 runners is merged into one `latest-mac.yml`.
 * Every metadata file is verified against the collected installers before `SHA256SUMS` is written.
 * Usage: `node collect-release-assets.mjs --version <version> --output <directory> <input>...`.
 */

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { mergeDesktopUpdateMetadata, verifyDesktopUpdateMetadata } from './desktop-update-feed.mjs'

/** Checksum listing written beside the collected assets. */
export const DESKTOP_RELEASE_CHECKSUMS = 'SHA256SUMS'

const METADATA = /^latest(?:-mac|-linux(?:-[a-z0-9]+)?)?\.yml$/u
const METADATA_PLATFORM = { 'latest.yml': 'win32', 'latest-mac.yml': 'darwin' }

function escape(text) {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

async function sha256(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

/**
 * Collect, merge, verify, and checksum one version's release assets.
 * @param {{ version: string, inputs: readonly string[], output: string }} request - Version, input directories, and the empty or new output directory.
 * @returns {Promise<string[]>} Collected asset names, sorted, ending with `SHA256SUMS`.
 */
export async function collectDesktopReleaseAssets({ version, inputs, output }) {
  const installer = new RegExp(`^hallucodex-${escape(version)}-(?:win|mac|linux)-[^/\\\\]+\\.(?:exe|dmg|zip|AppImage|deb)(?:\\.blockmap)?$`, 'u')
  await mkdir(output, { recursive: true })
  if ((await readdir(output)).length > 0) throw new Error(`desktop release: output directory ${output} is not empty`)
  const metadata = new Map()
  const copied = new Map()
  for (const input of inputs) {
    for (const entry of await readdir(input, { withFileTypes: true })) {
      if (!entry.isFile()) continue
      const source = join(input, entry.name)
      if (METADATA.test(entry.name)) {
        metadata.set(entry.name, [...metadata.get(entry.name) ?? [], await readFile(source, 'utf8')])
        continue
      }
      if (!installer.test(entry.name)) continue
      const digest = await sha256(source)
      const previous = copied.get(entry.name)
      if (previous !== undefined && previous !== digest) throw new Error(`desktop release: ${entry.name} differs between inputs`)
      if (previous === undefined) await copyFile(source, join(output, entry.name))
      copied.set(entry.name, digest)
    }
  }
  if (metadata.size === 0) throw new Error(`desktop release: no update metadata found for ${version}`)
  for (const [filename, documents] of metadata) {
    const unique = [...new Set(documents)]
    await writeFile(join(output, filename), unique.length === 1 ? unique[0] : mergeDesktopUpdateMetadata(unique))
    await verifyDesktopUpdateMetadata({ directory: output, filename, version, platform: METADATA_PLATFORM[filename] ?? 'linux' })
  }
  const assets = (await readdir(output)).sort()
  for (const name of assets) {
    if (!(await stat(join(output, name))).isFile()) throw new Error(`desktop release: ${name} is not a file`)
  }
  const sums = await Promise.all(assets.map(async name => `${await sha256(join(output, name))}  ${name}\n`))
  await writeFile(join(output, DESKTOP_RELEASE_CHECKSUMS), sums.join(''))
  return [...assets, DESKTOP_RELEASE_CHECKSUMS]
}

async function main(argv) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    version: { type: 'string' }, output: { type: 'string' },
  } })
  if (!values.version || !values.output || positionals.length === 0) {
    throw new Error('desktop release: expected --version <version> --output <directory> <input>...')
  }
  const assets = await collectDesktopReleaseAssets({
    version: values.version, output: resolve(values.output), inputs: positionals.map(input => resolve(input)),
  })
  process.stdout.write(`${assets.join('\n')}\n`)
}

if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) await main(process.argv.slice(2))
