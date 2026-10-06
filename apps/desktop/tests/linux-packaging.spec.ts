/** Linux development packages have native paths and no unauthenticated updater. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { Packager } from 'app-builder-lib'
import { LinuxPackager } from 'app-builder-lib/out/linuxPackager.js'
import { LinuxTargetHelper } from 'app-builder-lib/out/targets/LinuxTargetHelper.js'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createElectronBuilderConfig } from '../scripts/electron-builder-config.mjs'
import { loadDesktopPackageEnvironment, validateDesktopPackageEnvironment } from '../scripts/desktop-package-environment.mjs'
import { resolveLinuxPackageSettings } from '../scripts/linux-package-settings.mjs'
import { supportsDesktopAutomaticUpdates } from '../src/update-platform.ts'
import { createDesktopUploadPlan } from '../scripts/desktop-upload-plan.ts'

const ENVIRONMENT = {
  DSH_DESKTOP_APP_ID: 'com.example.hallucodex',
  DSH_DESKTOP_LINUX_MAINTAINER: 'Example Developer <developer@example.com>',
  DSH_DESKTOP_LINUX_HOMEPAGE: 'https://example.com/hallucodex',
}

describe('Linux development package configuration', () => {
  it.each(['x64', 'arm64'])('keeps Linux %s artifacts separate and disables inherited feeds', (arch) => {
    const config = createElectronBuilderConfig(ENVIRONMENT, 'linux', arch)
    expect(config.productName).toBe('HalluCodex')
    expect(config.artifactName).toBe('hallucodex-${version}-${os}-${arch}.${ext}')
    expect(config.directories.output).toContain(join('targets', `linux-${arch}`, 'artifacts'))
    expect(config.linux).toMatchObject({ executableName: 'hallucodex', target: ['AppImage', 'deb'], executableArgs: [] })
    expect(config.appImage.executableArgs).toEqual([])
    expect(config.deb).toEqual({ packageName: 'hallucodex', executableArgs: [] })
    expect(config.publish).toBeNull()
    expect(config.protocols).toEqual([])
    expect(config.extraMetadata).toMatchObject({ name: 'hallucodex', homepage: ENVIRONMENT.DSH_DESKTOP_LINUX_HOMEPAGE })
    expect(config.extraMetadata.dshMandatoryUpdatePolicy).toBeUndefined()
    expect(supportsDesktopAutomaticUpdates('linux')).toBe(false)
    expect(supportsDesktopAutomaticUpdates('darwin')).toBe(true)
    expect(supportsDesktopAutomaticUpdates('win32')).toBe(true)
    expect(supportsDesktopAutomaticUpdates('freebsd')).toBe(false)
    expect(() => validateDesktopPackageEnvironment(ENVIRONMENT, { platform: 'linux', arch })).not.toThrow()
    expect(() => validateDesktopPackageEnvironment({ ...ENVIRONMENT, DSH_DESKTOP_APP_ID: 'com.deepseek.harness' },
      { platform: 'linux', arch })).toThrow(/separate application identifier/u)
  })

  it('uses an isolated Linux dotenv file and rejects legacy updater and signing settings', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'desktop-linux-settings-'))
    try {
      const path = join(directory, '.env.linux')
      const entries = Object.entries(ENVIRONMENT).map(([name, value]) => `${name}=${value}`).join('\n')
      await writeFile(path, `${entries}\n`)
      expect(loadDesktopPackageEnvironment('linux', { PATH: '/toolchain', DSH_DESKTOP_LINUX_MAINTAINER: 'ambient',
        DSH_DESKTOP_AUTO_UPDATE_ENV: 'production', DSH_DESKTOP_MACOS_TEAM_ID: 'ignored' }, directory))
        .toEqual({ PATH: '/toolchain', ...ENVIRONMENT })
      for (const setting of ['DOWNLOAD_TEST_ORIGIN=https://example.com', 'DSH_DESKTOP_WINDOWS_TOKEN_PIN=ignored']) {
        await writeFile(path, `${entries}\n${setting}\n`)
        expect(() => loadDesktopPackageEnvironment('linux', {}, directory)).toThrow(/unsupported setting/u)
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('prepares a Linux runtime without inventing package publication metadata', () => {
    const env = { DSH_DESKTOP_APP_ID: ENVIRONMENT.DSH_DESKTOP_APP_ID }
    expect(() => validateDesktopPackageEnvironment(env, { platform: 'linux', arch: 'x64' }, { prepareOnly: true })).not.toThrow()
    expect(() => validateDesktopPackageEnvironment(env, { platform: 'linux', arch: 'x64' })).toThrow(/MAINTAINER/u)
  })

  it('requires actual public maintainer metadata and an HTTPS project page', () => {
    expect(resolveLinuxPackageSettings(ENVIRONMENT)).toEqual({
      developmentAppImage: false, maintainer: ENVIRONMENT.DSH_DESKTOP_LINUX_MAINTAINER, homepage: ENVIRONMENT.DSH_DESKTOP_LINUX_HOMEPAGE,
    })
    for (const maintainer of [undefined, '', 'Developer', 'Developer\nInjected <test@example.com>']) {
      expect(() => resolveLinuxPackageSettings({ ...ENVIRONMENT, DSH_DESKTOP_LINUX_MAINTAINER: maintainer })).toThrow(/MAINTAINER/u)
    }
    for (const homepage of [undefined, '', 'http://example.com', 'https://user:secret@example.com', 'https://example.com/#fragment']) {
      expect(() => resolveLinuxPackageSettings({ ...ENVIRONMENT, DSH_DESKTOP_LINUX_HOMEPAGE: homepage })).toThrow(/HOMEPAGE/u)
    }
  })

  it.each(['linux-x64', 'linux-arm64'] as const)('rejects %s publication before reading any artifact metadata', async (target) => {
    await expect(createDesktopUploadPlan(target, { environment: ENVIRONMENT, artifactsRoot: '/missing-linux-artifacts' }))
      .rejects.toThrow(/publisher-authenticated/u)
  })
})

it('passes the pinned builder schema and retains sandboxing in the emitted Linux desktop entries', async () => {
  const require = createRequire(import.meta.url)
  const { validateConfiguration } = require('app-builder-lib/out/util/config/config.js') as {
    validateConfiguration: (config: object, logger: { isEnabled: false }) => Promise<void>
  }
  const { default: AppImageTarget } = require('app-builder-lib/out/targets/appimage/AppImageTarget.js') as {
    default: typeof import('app-builder-lib/out/targets/appimage/AppImageTarget.js').default
  }
  const config = createElectronBuilderConfig(ENVIRONMENT, 'linux', 'x64')
  await validateConfiguration(config, { isEnabled: false })
  const packager = new Packager({ projectDir: tmpdir() })
  Object.defineProperties(packager, {
    config: { value: config },
    metadata: { value: { name: 'hallucodex', desktopName: 'hallucodex.desktop', version: '1.2.3', description: 'HalluCodex desktop' } },
  })
  const linux = new LinuxPackager(packager)
  const helper = new LinuxTargetHelper(linux)
  const target = new AppImageTarget('AppImage', linux, helper, tmpdir())
  // The dependency's lazy desktop entry is the value embedded in AppRun's package.
  const entry = Reflect.get(target, 'desktopEntry') as { value: Promise<string> }
  expect(await entry.value).toBe(await readFile(new URL('./expected/linux-appimage.desktop', import.meta.url), 'utf8'))
  const debEntry = await helper.computeDesktopEntry(linux.platformSpecificBuildOptions)
  expect(debEntry).toContain('Exec=/opt/HalluCodex/hallucodex  %U')
  expect(debEntry).not.toContain('--no-sandbox')
})

it('builds only explicitly marked development AppImages without inventing deb publisher metadata', () => {
  const env = { DSH_DESKTOP_APP_ID: ENVIRONMENT.DSH_DESKTOP_APP_ID, DSH_DESKTOP_LINUX_DEVELOPMENT_APPIMAGE: '1' }
  const config = createElectronBuilderConfig(env, 'linux', 'x64')
  expect(config.linux.target).toEqual(['AppImage'])
  expect(config.artifactName).toBe('hallucodex-${version}-${os}-${arch}-dev-unsigned.${ext}')
  expect(config.directories.output).toContain('unsigned-artifacts')
  expect(config.extraMetadata).toMatchObject({ name: 'hallucodex', dshDevelopmentArtifact: true })
  expect(config.extraMetadata.homepage).toBeUndefined()
  expect(config.linux.maintainer).toBeUndefined()
  expect(config.publish).toBeNull()
  expect(() => validateDesktopPackageEnvironment(env, { platform: 'linux', arch: 'x64' })).not.toThrow()
  expect(() => createElectronBuilderConfig({ ...env, DSH_DESKTOP_LINUX_DEVELOPMENT_APPIMAGE: 'yes' }, 'linux', 'x64')).toThrow(/must be 0 or 1/u)
  expect(() => createElectronBuilderConfig({ ...env, DSH_DESKTOP_LINUX_DEVELOPMENT_APPIMAGE: '0' }, 'linux', 'x64')).toThrow(/MAINTAINER/u)
})
