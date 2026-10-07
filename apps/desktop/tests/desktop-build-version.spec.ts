import { describe, expect, it } from 'vitest'
import {
  DESKTOP_BUILD_VERSION_ENV,
  desktopBuildVersionPrefix,
  resolveDesktopBuildVersion,
  validateDesktopBuildVersion,
} from '../scripts/desktop-build-version.mjs'

const PRERELEASE = '0.1.6-alpha.2'
const STABLE = '0.1.6'

describe('desktop build version', () => {
  it('publishes the product version when no build version is present', () => {
    expect(resolveDesktopBuildVersion({}, PRERELEASE)).toBe(PRERELEASE)
    expect(resolveDesktopBuildVersion({ [DESKTOP_BUILD_VERSION_ENV]: '   ' }, PRERELEASE)).toBe(PRERELEASE)
  })

  it.each(['0.1.6-alpha.2.20260921.1', '0.1.6-test.20260921.1', '0.1.0', '0.1.0-beta.1', '2.0.0'])(
    'accepts %s regardless of the product version, as a release tag supplies it', (buildVersion) => {
      expect(resolveDesktopBuildVersion({ [DESKTOP_BUILD_VERSION_ENV]: buildVersion }, PRERELEASE)).toBe(buildVersion)
      expect(validateDesktopBuildVersion(buildVersion)).toBe(buildVersion)
    })

  it('validates a build version passed through the environment', () => {
    expect(() => resolveDesktopBuildVersion({ [DESKTOP_BUILD_VERSION_ENV]: 'hallucodex-v0.1.0' }, STABLE)).toThrow(/is not a version/u)
  })

  it.each(['', 'nightly', '0.1.6-alpha.2.', '0.1', '01.2.3', 'hallucodex-v0.1.0'])(
    'rejects %j as a version', (buildVersion) => {
      expect(() => validateDesktopBuildVersion(buildVersion)).toThrow(/is not a version/u)
    })

  it('normalizes what the artifacts carry, so validation and the installed version agree', () => {
    expect(validateDesktopBuildVersion('v0.1.6-alpha.2.1')).toBe('0.1.6-alpha.2.1')
  })

  it('rejects build metadata, which does not affect updater precedence', () => {
    expect(() => validateDesktopBuildVersion('0.1.6-alpha.2.1+build')).toThrow(/build metadata/u)
  })

  it.each([[PRERELEASE, '0.1.6-alpha.2.'], [STABLE, '0.1.6-test.']])(
    'opens %s build versions with %s', (productVersion, prefix) => {
      expect(desktopBuildVersionPrefix(productVersion)).toBe(prefix)
    })
})
