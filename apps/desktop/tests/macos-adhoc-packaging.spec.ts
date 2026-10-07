/** macOS afterPack seals the GitHub Releases updater configuration and ad-hoc signs unsigned builds. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { execute, verifyDesktopRuntime } = vi.hoisted(() => ({
  execute: vi.fn(async (_command: string, _args: readonly string[]) => ({ stdout: '', stderr: '' })),
  verifyDesktopRuntime: vi.fn(async () => undefined),
}))
vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>()
  const { promisify } = await import('node:util')
  return { ...original, execFile: Object.assign(vi.fn(), { [promisify.custom]: execute }) }
})
// The hook imports the built tree, which a clean checkout has not produced; this is the path it resolves.
vi.mock('/apps/desktop/lib/types/runtime-tree.js', () => ({ verifyDesktopRuntime }))

const UNSIGNED = { DSH_DESKTOP_APP_ID: 'com.example.desktop', DSH_DESKTOP_TARGET_PLATFORM: 'darwin', DSH_DESKTOP_TARGET_ARCH: 'arm64', DSH_DESKTOP_UNSIGNED: '1' }
const SIGNED = {
  ...UNSIGNED, DSH_DESKTOP_UNSIGNED: '0',
  DSH_DESKTOP_MACOS_SIGNING_IDENTITY: 'Example Company (TEAMID1234)', DSH_DESKTOP_MACOS_TEAM_ID: 'TEAMID1234', APPLE_KEYCHAIN_PROFILE: 'fixture',
}

let root: string
let resources: string
const appPath = (): string => join(root, 'HalluCodex.app')

function context() {
  return {
    electronPlatformName: 'darwin', appOutDir: root,
    packager: { getResourcesDir: () => resources, appInfo: { productFilename: 'HalluCodex', updaterCacheDirName: 'hallucodex-updater' } },
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'desktop-macos-afterpack-'))
  resources = join(appPath(), 'Contents', 'Resources')
  await mkdir(resources, { recursive: true })
  execute.mockClear()
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe('macOS afterPack', () => {
  it('writes the updater configuration before ad-hoc signing an unsigned App, then verifies the seal', async () => {
    const { createElectronBuilderConfig } = await import('../scripts/electron-builder-config.mjs')
    const config = createElectronBuilderConfig(UNSIGNED, 'darwin', 'arm64')
    execute.mockImplementationOnce(async () => {
      // Signing seals Contents/Resources, so the configuration must already exist.
      expect(await readFile(join(resources, 'app-update.yml'), 'utf8')).toContain('owner: AkumaRealLabs')
      return { stdout: '', stderr: '' }
    })
    await config.afterPack(context() as never)
    expect(execute.mock.calls.map(([command, args]) => [command, ...args])).toEqual([
      ['/usr/bin/codesign', '--force', '--deep', '--sign', '-', appPath()],
      ['/usr/bin/codesign', '--verify', '--deep', '--strict', appPath()],
    ])
  })

  it('keeps the configuration electron-builder already wrote for DMG and ZIP targets', async () => {
    const written = 'owner: AkumaRealLabs\nrepo: hallucodex-desktop\nprovider: github\nreleaseType: release\nupdaterCacheDirName: hallucodex-updater\n'
    await writeFile(join(resources, 'app-update.yml'), written)
    const { createElectronBuilderConfig } = await import('../scripts/electron-builder-config.mjs')
    await createElectronBuilderConfig(UNSIGNED, 'darwin', 'arm64').afterPack(context() as never)
    expect(await readFile(join(resources, 'app-update.yml'), 'utf8')).toBe(written)
    expect(execute).toHaveBeenCalledTimes(2)
  })

  it('writes the configuration into a signed directory build without applying an ad-hoc signature', async () => {
    const { createElectronBuilderConfig } = await import('../scripts/electron-builder-config.mjs')
    await createElectronBuilderConfig(SIGNED, 'darwin', 'arm64').afterPack(context() as never)
    expect(await readFile(join(resources, 'app-update.yml'), 'utf8')).toContain('provider: github')
    expect(execute).not.toHaveBeenCalled()
  })

  it('refuses to sign an App whose updater configuration names another feed', async () => {
    await writeFile(join(resources, 'app-update.yml'), 'provider: generic\nurl: https://updates.example.com\nupdaterCacheDirName: x\n')
    const { createElectronBuilderConfig } = await import('../scripts/electron-builder-config.mjs')
    await expect(createElectronBuilderConfig(UNSIGNED, 'darwin', 'arm64').afterPack(context() as never)).rejects.toThrow(/provider to github/u)
    expect(execute).not.toHaveBeenCalled()
  })
})
