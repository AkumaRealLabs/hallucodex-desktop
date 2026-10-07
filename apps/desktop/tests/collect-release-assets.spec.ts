import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dump, load } from 'js-yaml'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { collectDesktopReleaseAssets } from '../scripts/collect-release-assets.mjs'

let root: string

beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'desktop-release-assets-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

function entry(name: string, contents: string): { url: string; sha512: string; size: number } {
  return { url: name, sha512: createHash('sha512').update(contents).digest('base64'), size: Buffer.byteLength(contents) }
}

/** Write one runner's electron-builder output: installers, blockmaps, metadata, and an unpacked directory. */
async function runner(name: string, files: Record<string, string>, metadata: Record<string, object>): Promise<string> {
  const directory = join(root, name)
  await mkdir(join(directory, `${name}-unpacked`), { recursive: true })
  for (const [file, contents] of Object.entries(files)) await writeFile(join(directory, file), contents)
  for (const [file, document] of Object.entries(metadata)) await writeFile(join(directory, file), dump(document))
  await writeFile(join(directory, 'builder-debug.yml'), 'ignored')
  return directory
}

async function releaseInputs(version = '0.1.0') {
  const exe = `hallucodex-${version}-win-x64-unsigned.exe`
  const armZip = `hallucodex-${version}-mac-arm64-unsigned.zip`
  const intelZip = `hallucodex-${version}-mac-x64-unsigned.zip`
  const appImage = `hallucodex-${version}-linux-x86_64.AppImage`
  return [
    await runner('win', { [exe]: 'exe', [`${exe}.blockmap`]: 'map' },
      { 'latest.yml': { version, files: [entry(exe, 'exe')], path: exe } }),
    await runner('mac-arm64', { [armZip]: 'arm zip', [`${armZip}.blockmap`]: 'map', [`hallucodex-${version}-mac-arm64-unsigned.dmg`]: 'arm dmg' },
      { 'latest-mac.yml': { version, files: [entry(armZip, 'arm zip')], path: armZip, releaseDate: '2026-10-07T01:00:00.000Z' } }),
    await runner('mac-x64', { [intelZip]: 'intel zip', [`${intelZip}.blockmap`]: 'map', [`hallucodex-${version}-mac-x64-unsigned.dmg`]: 'intel dmg' },
      { 'latest-mac.yml': { version, files: [entry(intelZip, 'intel zip')], path: intelZip, releaseDate: '2026-10-07T02:00:00.000Z' } }),
    await runner('linux', { [appImage]: 'appimage', [`hallucodex-${version}-linux-amd64.deb`]: 'deb' },
      { 'latest-linux.yml': { version, files: [entry(appImage, 'appimage')], path: appImage } }),
  ]
}

describe('release asset collection', () => {
  it('collects installers and update files, merges macOS metadata, and writes checksums', async () => {
    const output = join(root, 'release')
    const assets = await collectDesktopReleaseAssets({ version: '0.1.0', inputs: await releaseInputs(), output })
    expect(assets).toEqual([
      'hallucodex-0.1.0-linux-amd64.deb',
      'hallucodex-0.1.0-linux-x86_64.AppImage',
      'hallucodex-0.1.0-mac-arm64-unsigned.dmg',
      'hallucodex-0.1.0-mac-arm64-unsigned.zip',
      'hallucodex-0.1.0-mac-arm64-unsigned.zip.blockmap',
      'hallucodex-0.1.0-mac-x64-unsigned.dmg',
      'hallucodex-0.1.0-mac-x64-unsigned.zip',
      'hallucodex-0.1.0-mac-x64-unsigned.zip.blockmap',
      'hallucodex-0.1.0-win-x64-unsigned.exe',
      'hallucodex-0.1.0-win-x64-unsigned.exe.blockmap',
      'latest-linux.yml',
      'latest-mac.yml',
      'latest.yml',
      'SHA256SUMS',
    ])
    expect((await readdir(output)).sort()).toEqual([...assets].sort())
    const mac = load(await readFile(join(output, 'latest-mac.yml'), 'utf8')) as { files: { url: string }[]; releaseDate: string }
    expect(mac.files.map(file => file.url)).toEqual(['hallucodex-0.1.0-mac-arm64-unsigned.zip', 'hallucodex-0.1.0-mac-x64-unsigned.zip'])
    expect(mac.releaseDate).toBe('2026-10-07T02:00:00.000Z')
    const sums = (await readFile(join(output, 'SHA256SUMS'), 'utf8')).trim().split('\n')
    expect(sums).toHaveLength(assets.length - 1)
    expect(sums).toContain(`${createHash('sha256').update('exe').digest('hex')}  hallucodex-0.1.0-win-x64-unsigned.exe`)
  })

  it('accepts its own earlier collection as input, as the release job receives per-runner collections', async () => {
    const inputs = await releaseInputs()
    const perRunner = await Promise.all(inputs.map(async (input, index) => {
      const output = join(root, `collected-${index}`)
      await collectDesktopReleaseAssets({ version: '0.1.0', inputs: [input], output })
      return output
    }))
    const assets = await collectDesktopReleaseAssets({ version: '0.1.0', inputs: perRunner, output: join(root, 'release') })
    expect(assets).toContain('latest-mac.yml')
    expect(assets.filter(name => name === 'SHA256SUMS')).toHaveLength(1)
  })

  it('refuses metadata of another version, a missing installer, and a non-empty output', async () => {
    const inputs = await releaseInputs()
    await expect(collectDesktopReleaseAssets({ version: '0.1.1', inputs, output: join(root, 'other') }))
      .rejects.toThrow(/declares 0\.1\.0, expected 0\.1\.1|missing file/u)
    await rm(join(inputs[0]!, 'hallucodex-0.1.0-win-x64-unsigned.exe'))
    await expect(collectDesktopReleaseAssets({ version: '0.1.0', inputs, output: join(root, 'missing') }))
      .rejects.toThrow(/missing file hallucodex-0\.1\.0-win-x64-unsigned\.exe/u)
    await mkdir(join(root, 'busy'))
    await writeFile(join(root, 'busy', 'stale.exe'), 'stale')
    await expect(collectDesktopReleaseAssets({ version: '0.1.0', inputs, output: join(root, 'busy') })).rejects.toThrow(/not empty/u)
    await expect(collectDesktopReleaseAssets({ version: '0.1.0', inputs: [join(root, 'busy')], output: join(root, 'none') }))
      .rejects.toThrow(/no update metadata/u)
  })

  it('refuses one installer name with different bytes on two runners', async () => {
    const first = await runner('a', { 'hallucodex-0.1.0-linux-amd64.deb': 'one' }, {})
    const second = await runner('b', { 'hallucodex-0.1.0-linux-amd64.deb': 'two' }, {})
    await expect(collectDesktopReleaseAssets({ version: '0.1.0', inputs: [first, second], output: join(root, 'release') }))
      .rejects.toThrow(/differs between inputs/u)
  })
})
