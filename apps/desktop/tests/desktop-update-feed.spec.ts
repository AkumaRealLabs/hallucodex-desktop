import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dump, load } from 'js-yaml'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DESKTOP_UPDATE_PUBLISH,
  desktopBlockmapExtensions,
  desktopUpdateMetadataFilename,
  mergeDesktopUpdateMetadata,
  parseDesktopUpdateMetadata,
  verifyDesktopAppUpdateConfig,
  verifyDesktopUpdateMetadata,
  writeDesktopAppUpdateConfig,
} from '../scripts/desktop-update-feed.mjs'

let directory: string

beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'desktop-update-feed-')) })
afterEach(async () => { await rm(directory, { recursive: true, force: true }) })

/** Write one installer and return the metadata entry electron-builder would record for it. */
async function installer(name: string, contents: string): Promise<{ url: string; sha512: string; size: number }> {
  await writeFile(join(directory, name), contents)
  return { url: name, sha512: createHash('sha512').update(contents).digest('base64'), size: Buffer.byteLength(contents) }
}

async function metadata(filename: string, document: object): Promise<void> {
  await writeFile(join(directory, filename), dump(document))
}

describe('desktop update feed', () => {
  it('names the latest channel files electron-builder writes for each target', () => {
    expect(desktopUpdateMetadataFilename('win32', 'x64')).toBe('latest.yml')
    expect(desktopUpdateMetadataFilename('darwin', 'arm64')).toBe('latest-mac.yml')
    expect(desktopUpdateMetadataFilename('darwin', 'x64')).toBe('latest-mac.yml')
    expect(desktopUpdateMetadataFilename('linux', 'x64')).toBe('latest-linux.yml')
    expect(desktopUpdateMetadataFilename('linux', 'arm64')).toBe('latest-linux-arm64.yml')
    expect(() => desktopUpdateMetadataFilename('freebsd', 'x64')).toThrow(/unsupported platform/u)
    expect(desktopBlockmapExtensions('win32')).toEqual(['.exe'])
    expect(desktopBlockmapExtensions('darwin')).toEqual(['.zip'])
    expect(desktopBlockmapExtensions('linux')).toEqual([])
  })

  it('writes and verifies the packaged updater configuration for this repository', async () => {
    await writeDesktopAppUpdateConfig(directory, 'hallucodex-updater')
    expect(load(await readFile(join(directory, 'app-update.yml'), 'utf8'))).toEqual({ ...DESKTOP_UPDATE_PUBLISH, updaterCacheDirName: 'hallucodex-updater' })
    await expect(verifyDesktopAppUpdateConfig(directory)).resolves.toMatchObject({ provider: 'github', owner: 'AkumaRealLabs' })
    await writeFile(join(directory, 'app-update.yml'), dump({ ...DESKTOP_UPDATE_PUBLISH, repo: 'other', updaterCacheDirName: 'x' }))
    await expect(verifyDesktopAppUpdateConfig(directory)).rejects.toThrow(/must set repo to hallucodex-desktop/u)
    await writeFile(join(directory, 'app-update.yml'), dump({ ...DESKTOP_UPDATE_PUBLISH }))
    await expect(verifyDesktopAppUpdateConfig(directory)).rejects.toThrow(/updaterCacheDirName/u)
    await rm(join(directory, 'app-update.yml'))
    await expect(verifyDesktopAppUpdateConfig(directory)).rejects.toThrow(/cannot read/u)
  })

  it('returns the metadata, installers, and required blockmaps when every reference matches', async () => {
    const exe = await installer('hallucodex-0.1.0-win-x64-unsigned.exe', 'installer bytes')
    await writeFile(join(directory, `${exe.url}.blockmap`), 'blockmap')
    await metadata('latest.yml', { version: '0.1.0', files: [exe], path: exe.url, sha512: exe.sha512, releaseDate: '2026-10-07T00:00:00.000Z' })
    await expect(verifyDesktopUpdateMetadata({ directory, filename: 'latest.yml', version: '0.1.0', platform: 'win32' }))
      .resolves.toEqual(['latest.yml', exe.url, `${exe.url}.blockmap`])
    const appImage = await installer('hallucodex-0.1.0-linux-x86_64.AppImage', 'appimage bytes')
    await metadata('latest-linux.yml', { version: '0.1.0', files: [appImage], path: appImage.url })
    // AppImage embeds its blockmap, so Linux needs no sibling file.
    await expect(verifyDesktopUpdateMetadata({ directory, filename: 'latest-linux.yml', version: '0.1.0', platform: 'linux' }))
      .resolves.toEqual(['latest-linux.yml', appImage.url])
  })

  it.each([
    ['another version', async (zip: { url: string }) => ({ version: '0.1.1', files: [zip] }), /declares 0\.1\.1, expected 0\.1\.0/u],
    ['a missing installer', async () => ({ version: '0.1.0', files: [{ url: 'absent.zip', sha512: 'x', size: 1 }] }), /missing file absent\.zip/u],
    ['another size', async (zip: { url: string; sha512: string }) => ({ version: '0.1.0', files: [{ ...zip, size: 1 }] }), /records 1 bytes/u],
    ['another digest', async (zip: { url: string; size: number }) => ({ version: '0.1.0', files: [{ ...zip, sha512: 'AAAA' }] }), /another SHA-512/u],
    ['a path outside the release', async (zip: object) => ({ version: '0.1.0', files: [{ ...zip, url: '../escape.zip' }] }), /sibling filename/u],
    ['a path missing from files', async (zip: object) => ({ version: '0.1.0', files: [zip], path: 'other.zip' }), /is not among its files/u],
    ['no files', async () => ({ version: '0.1.0', files: [] }), /lists no files/u],
  ] as const)('rejects metadata with %s', async (_label, document, error) => {
    const zip = await installer('hallucodex-0.1.0-mac-arm64-unsigned.zip', 'zip bytes')
    await writeFile(join(directory, `${zip.url}.blockmap`), 'blockmap')
    await metadata('latest-mac.yml', await document(zip))
    await expect(verifyDesktopUpdateMetadata({ directory, filename: 'latest-mac.yml', version: '0.1.0', platform: 'darwin' })).rejects.toThrow(error)
  })

  it('requires the differential blockmap beside Windows and macOS update installers', async () => {
    const zip = await installer('hallucodex-0.1.0-mac-x64-unsigned.zip', 'zip bytes')
    await metadata('latest-mac.yml', { version: '0.1.0', files: [zip] })
    await expect(verifyDesktopUpdateMetadata({ directory, filename: 'latest-mac.yml', version: '0.1.0', platform: 'darwin' }))
      .rejects.toThrow(/missing file hallucodex-0\.1\.0-mac-x64-unsigned\.zip\.blockmap/u)
    await expect(verifyDesktopUpdateMetadata({ directory, filename: 'latest.yml', version: '0.1.0', platform: 'win32' }))
      .rejects.toThrow(/missing latest\.yml/u)
  })

  it('merges per-architecture macOS metadata so each architecture finds its own ZIP', () => {
    const arm = { url: 'hallucodex-0.1.0-mac-arm64-unsigned.zip', sha512: 'arm', size: 10 }
    const intel = { url: 'hallucodex-0.1.0-mac-x64-unsigned.zip', sha512: 'intel', size: 11 }
    const merged = load(mergeDesktopUpdateMetadata([
      dump({ version: '0.1.0', files: [arm], path: arm.url, sha512: arm.sha512, releaseDate: '2026-10-07T01:00:00.000Z' }),
      dump({ version: '0.1.0', files: [intel], path: intel.url, sha512: intel.sha512, releaseDate: '2026-10-07T02:00:00.000Z' }),
    ]))
    expect(merged).toEqual({ version: '0.1.0', files: [arm, intel], path: arm.url, sha512: arm.sha512, releaseDate: '2026-10-07T02:00:00.000Z' })
    expect(parseDesktopUpdateMetadata(mergeDesktopUpdateMetadata([dump({ version: '0.1.0', files: [arm] })]), 'single').files).toEqual([arm])
    expect(() => mergeDesktopUpdateMetadata([dump({ version: '0.1.0', files: [arm] }), dump({ version: '0.1.1', files: [intel] })]))
      .toThrow(/cannot merge versions/u)
    expect(() => mergeDesktopUpdateMetadata([dump({ version: '0.1.0', files: [arm] }), dump({ version: '0.1.0', files: [{ ...arm, size: 9 }] })]))
      .toThrow(/differs between merged metadata/u)
    expect(() => mergeDesktopUpdateMetadata([])).toThrow(/no metadata/u)
  })
})
