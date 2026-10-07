import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { mkdir } from 'node:fs/promises'
import { loadDesktopPackageEnvironment, validateDesktopPackageEnvironment } from '../scripts/desktop-package-environment.mjs'
import { resolveWindowsPackageSettings } from '../scripts/windows-package-settings.mjs'

const WINDOWS = { platform: 'win32', arch: 'x64' } as const
const MACOS = { platform: 'darwin', arch: 'arm64' } as const
const RELEASE = { DSH_DESKTOP_APP_ID: 'com.example.desktop' }
const MAC_IDENTITY = { DSH_DESKTOP_MACOS_SIGNING_IDENTITY: 'Example Company (TEAMID1234)', DSH_DESKTOP_MACOS_TEAM_ID: 'TEAMID1234' }

async function withDirectory(action: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'desktop-env-'))
  try {
    await action(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

describe('Desktop local packaging configuration', () => {
  it('takes cache concurrency from the Windows file and defaults to four without ambient overrides', async () => {
    await withDirectory(async (directory) => {
      const parent = { DSH_DESKTOP_WINDOWS_SIGNATURE_CACHE_CONCURRENCY: '8' }
      await writeFile(join(directory, '.env.windows'), '')
      expect(resolveWindowsPackageSettings(loadDesktopPackageEnvironment('win32', parent, directory)).signatureCacheConcurrency).toBe(4)
      await writeFile(join(directory, '.env.windows'), 'DSH_DESKTOP_WINDOWS_SIGNATURE_CACHE_CONCURRENCY=2\n')
      expect(resolveWindowsPackageSettings(loadDesktopPackageEnvironment('win32', parent, directory)).signatureCacheConcurrency).toBe(2)
    })
  })

  it.each(['1', '2', '4', '8'])('accepts cache concurrency %s', (value) => {
    const settings = resolveWindowsPackageSettings({ DSH_DESKTOP_WINDOWS_SIGNATURE_CACHE_CONCURRENCY: value })
    expect(settings.signatureCacheConcurrency).toBe(Number(value))
  })

  it.each(['', '0', '-1', '9', '1.5', 'Infinity', '01'])('rejects invalid cache concurrency %s', (value) => {
    expect(() => resolveWindowsPackageSettings({ DSH_DESKTOP_WINDOWS_SIGNATURE_CACHE_CONCURRENCY: value })).toThrow('integer from 1 to 8')
    for (const options of [{ unsigned: true }, { prepareOnly: true }]) {
      expect(() => {
        validateDesktopPackageEnvironment({ ...RELEASE, DSH_DESKTOP_WINDOWS_SIGNATURE_CACHE_CONCURRENCY: value }, WINDOWS, options)
      }).toThrow('integer from 1 to 8')
    }
  })

  it('selects the platform file, preserves literal secrets, and excludes stale ambient release settings', async () => {
    await withDirectory(async (directory) => {
      await writeFile(join(directory, '.env.windows'), '\uFEFFDSH_DESKTOP_APP_ID=com.example.windows\r\nDSH_DESKTOP_WINDOWS_TOKEN_PIN=" #!$%&literal "\r\nDSH_DESKTOP_WINDOWS_CER_FILE="keys/public certificate.cer"\r\n')
      await writeFile(join(directory, '.env.macos'), 'DSH_DESKTOP_APP_ID=com.example.mac\nAPPLE_KEYCHAIN_PROFILE=release\nCSC_LINK=keys/signing.p12\nCSC_KEY_PASSWORD=" # literal "\n')
      const parent = {
        PATH: 'build-tools', DSH_DESKTOP_APP_ID: 'com.stale.desktop', dsh_desktop_npm_registry: 'https://stale.example.com',
        DSH_DESKTOP_WINDOWS_TOKEN_PIN: 'stale-pin', APPLE_ID: 'stale-apple-id', CSC_LINK: 'stale-certificate',
        dsh_desktop_windows_key_container: 'case-insensitive-stale-container', DSH_DESKTOP_LINUX_MAINTAINER: 'stale',
      }
      expect(loadDesktopPackageEnvironment('win32', parent, directory)).toEqual({
        PATH: 'build-tools', DSH_DESKTOP_APP_ID: 'com.example.windows',
        DSH_DESKTOP_WINDOWS_TOKEN_PIN: ' #!$%&literal ',
        DSH_DESKTOP_WINDOWS_CER_FILE: join(directory, 'keys', 'public certificate.cer'),
      })
      expect(loadDesktopPackageEnvironment('darwin', parent, directory)).toEqual({
        PATH: 'build-tools', DSH_DESKTOP_APP_ID: 'com.example.mac', APPLE_KEYCHAIN_PROFILE: 'release',
        CSC_LINK: join(directory, 'keys/signing.p12'), CSC_KEY_PASSWORD: ' # literal ',
      })
      expect(parent.DSH_DESKTOP_WINDOWS_TOKEN_PIN).toBe('stale-pin')
    })
  })

  it.each([
    ['win32', '.env.windows'], ['darwin', '.env.macos'], ['linux', '.env.linux'],
  ] as const)('rejects retired update-publication settings in %s files', async (platform, filename) => {
    await withDirectory(async (directory) => {
      for (const setting of ['DSH_DESKTOP_AUTO_UPDATE_ENV=test', 'DOWNLOAD_TEST_ORIGIN=https://updates.example.com',
        'DOWNLOAD_PROD_COS_SECRET_KEY=secret-sentinel', 'DSH_DESKTOP_MANDATORY_UPDATE_CONFIG={}']) {
        await writeFile(join(directory, filename), `DSH_DESKTOP_APP_ID=com.example.desktop\n${setting}\n`)
        expect(() => loadDesktopPackageEnvironment(platform, {}, directory)).toThrow(/unsupported setting/u)
        expect(() => loadDesktopPackageEnvironment(platform, {}, directory)).not.toThrow(/secret-sentinel/u)
      }
    })
  })

  it.each([
    ['linux', { DSH_DESKTOP_LINUX_MAINTAINER: 'Example <maintainer@example.com>', DSH_DESKTOP_LINUX_HOMEPAGE: 'https://example.com/app' }],
    ['win32', { DSH_DESKTOP_WINDOWS_SIGNATURE_CACHE_CONCURRENCY: '2' }],
    ['darwin', { DSH_DESKTOP_MACOS_PACK_CONCURRENCY: '3', CSC_LINK: 'keys/signing.p12' }],
  ] as const)('reads %s settings from the parent environment only when it is selected explicitly', async (platform, platformSettings) => {
    await withDirectory(async (directory) => {
      const parent = {
        PATH: 'build-tools', DSH_DESKTOP_PACKAGE_SETTINGS: 'environment', DSH_DESKTOP_APP_ID: 'com.hallucodex.desktop',
        DSH_DESKTOP_NPM_REGISTRY: 'https://registry.example.com', ...platformSettings,
        ...(platform === 'linux' ? { DSH_DESKTOP_WINDOWS_TOKEN_PIN: 'other-platform' } : { DSH_DESKTOP_LINUX_MAINTAINER: 'other-platform' }),
      }
      const loaded = loadDesktopPackageEnvironment(platform, parent, directory)
      expect(loaded).toEqual({
        PATH: 'build-tools', DSH_DESKTOP_APP_ID: 'com.hallucodex.desktop', DSH_DESKTOP_NPM_REGISTRY: 'https://registry.example.com',
        ...platformSettings,
        ...('CSC_LINK' in platformSettings ? { CSC_LINK: join(directory, 'keys/signing.p12') } : {}),
      })
      expect(parent.DSH_DESKTOP_PACKAGE_SETTINGS).toBe('environment')
      expect(() => loadDesktopPackageEnvironment(platform, { ...parent, DSH_DESKTOP_PACKAGE_SETTINGS: 'file' }, directory))
        .toThrow(/cannot read/u)
    })
  })

  it('refuses two release-setting sources and unknown source names', async () => {
    await withDirectory(async (directory) => {
      await mkdir(directory, { recursive: true })
      await writeFile(join(directory, '.env.linux'), 'DSH_DESKTOP_APP_ID=com.example.file\n')
      expect(() => loadDesktopPackageEnvironment('linux', { DSH_DESKTOP_PACKAGE_SETTINGS: 'environment' }, directory))
        .toThrow(/conflicts with .*\.env\.linux/u)
      expect(() => loadDesktopPackageEnvironment('linux', { DSH_DESKTOP_PACKAGE_SETTINGS: 'ambient' }, directory))
        .toThrow(/must be file or environment/u)
      expect(loadDesktopPackageEnvironment('linux', { DSH_DESKTOP_PACKAGE_SETTINGS: 'file', DSH_DESKTOP_APP_ID: 'ambient' }, directory))
        .toEqual({ DSH_DESKTOP_APP_ID: 'com.example.file' })
    })
  })

  it('requires the local file even when ambient configuration exists and rejects other-platform fields', async () => {
    await withDirectory(async (directory) => {
      expect(() => loadDesktopPackageEnvironment('win32', RELEASE, directory)).toThrow(/copy .*\.env.windows.example/u)
      await writeFile(join(directory, '.env.windows'), 'APPLE_APP_SPECIFIC_PASSWORD=secret-sentinel\n')
      expect(() => loadDesktopPackageEnvironment('win32', {}, directory)).toThrow(/unsupported setting APPLE_APP_SPECIFIC_PASSWORD/u)
      expect(() => loadDesktopPackageEnvironment('win32', {}, directory)).not.toThrow(/secret-sentinel/u)
    })
  })

  it('checks application and update configuration before Windows credentials while preserving unsigned and preparation modes', () => {
    expect(() => {
      validateDesktopPackageEnvironment({}, WINDOWS, { unsigned: true })
    }).toThrow(/DSH_DESKTOP_APP_ID/u)
    expect(() => {
      validateDesktopPackageEnvironment({ DSH_DESKTOP_APP_ID: 'invalid' }, WINDOWS)
    }).toThrow(/reverse-DNS/u)
    expect(() => {
      validateDesktopPackageEnvironment(RELEASE, WINDOWS)
    }).toThrow(/DSH_DESKTOP_WINDOWS_CER_FILE/u)
    expect(() => {
      validateDesktopPackageEnvironment(RELEASE, WINDOWS, { unsigned: true })
    }).not.toThrow()
    expect(() => {
      validateDesktopPackageEnvironment(RELEASE, WINDOWS, { prepareOnly: true })
    }).not.toThrow()
  })

  it('accepts unsigned macOS packaging without an identity, certificate, or notarization credentials', () => {
    expect(() => { validateDesktopPackageEnvironment(RELEASE, MACOS, { unsigned: true }) }).not.toThrow()
    expect(() => { validateDesktopPackageEnvironment({}, MACOS, { unsigned: true }) }).toThrow(/DSH_DESKTOP_APP_ID/u)
    expect(() => { validateDesktopPackageEnvironment({ ...RELEASE, DSH_DESKTOP_MACOS_PACK_CONCURRENCY: '0' }, MACOS, { unsigned: true }) })
      .toThrow('PACK_CONCURRENCY')
  })

  it('accepts one local npm registry mirror and rejects other registry forms', () => {
    const release = RELEASE
    expect(() => {
      validateDesktopPackageEnvironment({ ...release, DSH_DESKTOP_NPM_REGISTRY: 'https://registry.npmmirror.com/' }, WINDOWS, { unsigned: true })
    }).not.toThrow()
    for (const value of ['http://registry.example.com/', 'https://registry.example.com/path', 'https://user:secret@registry.example.com/', 'not-a-url']) {
      expect(() => {
        validateDesktopPackageEnvironment({ ...release, DSH_DESKTOP_NPM_REGISTRY: value }, WINDOWS, { unsigned: true })
      }).toThrow(/DSH_DESKTOP_NPM_REGISTRY/u)
    }
  })

  it('rejects incomplete macOS identity and credentials and checks referenced files without contacting Apple', async () => {
    expect(() => {
      validateDesktopPackageEnvironment(RELEASE, MACOS)
    }).toThrow(/DSH_DESKTOP_MACOS_SIGNING_IDENTITY/u)
    expect(() => {
      validateDesktopPackageEnvironment({ ...RELEASE, ...MAC_IDENTITY }, MACOS)
    }).toThrow(/macOS packaging requires/u)
    expect(() => {
      validateDesktopPackageEnvironment({ ...RELEASE, ...MAC_IDENTITY, APPLE_API_KEY: 'missing.p8' }, MACOS)
    }).toThrow(/APPLE_API_KEY_ID/u)
    expect(() => {
      validateDesktopPackageEnvironment({ ...RELEASE, ...MAC_IDENTITY, APPLE_KEYCHAIN_PROFILE: 'release' }, MACOS)
    }).toThrow(/CSC_LINK/u)
    expect(() => {
      validateDesktopPackageEnvironment({ ...RELEASE, ...MAC_IDENTITY, APPLE_KEYCHAIN_PROFILE: 'release', APPLE_API_KEY: '' }, MACOS)
    }).toThrow(/exactly one macOS notarization strategy/u)
    expect(() => {
      validateDesktopPackageEnvironment({ ...RELEASE, ...MAC_IDENTITY, APPLE_ID: 'user@example.com', APPLE_APP_SPECIFIC_PASSWORD: 'fixture', APPLE_TEAM_ID: 'TEAMID1234' }, MACOS)
    }).toThrow(/CSC_LINK/u)
    await withDirectory(async (directory) => {
      const appleApiKey = join(directory, 'AuthKey.p8')
      const environment = { ...RELEASE, ...MAC_IDENTITY, CSC_LINK: appleApiKey, CSC_KEY_PASSWORD: '', APPLE_API_KEY: appleApiKey, APPLE_API_KEY_ID: 'TEST123456', APPLE_API_ISSUER: '11111111-2222-3333-4444-555555555555' }
      expect(() => {
        validateDesktopPackageEnvironment(environment, MACOS)
      }).toThrow(/APPLE_API_KEY must identify a readable local file/u)
      await writeFile(appleApiKey, 'local-file-fixture')
      expect(() => {
        validateDesktopPackageEnvironment(environment, MACOS)
      }).not.toThrow()
      expect(() => {
        validateDesktopPackageEnvironment({ ...environment, CSC_KEY_PASSWORD: undefined }, MACOS)
      }).toThrow(/CSC_KEY_PASSWORD/u)
      expect(() => { validateDesktopPackageEnvironment({ ...environment, CSC_LINK: directory }, MACOS) }).toThrow(/CSC_LINK/u)
      expect(() => { validateDesktopPackageEnvironment({ ...environment, CSC_LINK: 'missing.p12' }, MACOS, { prepareOnly: true }) }).toThrow(/CSC_LINK/u)
      expect(() => {
        validateDesktopPackageEnvironment({ ...RELEASE, ...MAC_IDENTITY, APPLE_KEYCHAIN_PROFILE: 'release', APPLE_KEYCHAIN: directory }, MACOS)
      }).toThrow(/APPLE_KEYCHAIN/u)
    })
  })
})

it('owns macOS tuning in the local file and validates it before signing credentials', async () => {
  await withDirectory(async (directory) => {
    await writeFile(join(directory, '.env.macos'), 'DSH_DESKTOP_MACOS_PACK_CONCURRENCY=2\nDSH_DESKTOP_MACOS_DOWNLOAD_PROXY=http://proxy.example:8080\nDSH_DESKTOP_MACOS_NOTARIZATION_PROXY=\n')
    const env = loadDesktopPackageEnvironment('darwin', { DSH_DESKTOP_MACOS_PACK_CONCURRENCY: '99' }, directory)
    expect(env.DSH_DESKTOP_MACOS_PACK_CONCURRENCY).toBe('2')
    expect(env.DSH_DESKTOP_MACOS_NOTARIZATION_PROXY).toBe('')
    expect(() =>{  validateDesktopPackageEnvironment({ ...RELEASE, DSH_DESKTOP_MACOS_PACK_CONCURRENCY: '' }, MACOS) }).toThrow('PACK_CONCURRENCY')
    expect(() =>{  validateDesktopPackageEnvironment({ ...RELEASE, DSH_DESKTOP_MACOS_NOTARIZATION_PROXY: 'socks5://localhost:8080' }, MACOS) }).toThrow('NOTARIZATION_PROXY')
  })
})
