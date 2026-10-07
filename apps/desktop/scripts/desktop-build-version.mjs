/**
 * Resolve the version one build carries, which is not always the version the
 * repository declares.
 *
 * HalluCodex releases follow their own version line: the release workflow
 * passes the version from a `hallucodex-v<version>` tag, and local test builds
 * may number themselves after the product version as
 * `<product version>.<date>.<sequence>` (or `-test.<date>.<sequence>` on a
 * stable product version). Passing that version here keeps it out of the
 * manifests, so the tracked version stays the product's while the build
 * version reaches electron-builder, the update metadata, and the installed
 * `app.getVersion()` as one input.
 *
 * `electron-updater` compares release versions with `semver.gt` against the
 * installed version, so validation uses the same library and rejects build
 * metadata, which does not take part in that comparison.
 */

import { parse } from 'semver'

/** Environment variable that carries the build version through one packaging run. */
export const DESKTOP_BUILD_VERSION_ENV = 'DSH_DESKTOP_BUILD_VERSION'

/** Prerelease field that opens a test build's suffix on a stable product version. */
const STABLE_TEST_FIELD = 'test'

/**
 * Parse a version the updater would accept.
 * @param {string} version - Version to read.
 * @param {string} label - Description used in failures.
 * @returns {import('semver').SemVer} The parsed version.
 */
function parseVersion(version, label) {
  const parsed = parse(version, { loose: false })
  if (parsed === null) throw new Error(`desktop build version: ${label} ${version} is not a version`)
  if (parsed.build.length > 0) {
    // Build metadata does not participate in precedence, so two builds would compare equal to the updater.
    throw new Error(`desktop build version: ${label} ${version} cannot carry build metadata`)
  }
  return parsed
}

/**
 * The prerelease fields every build version for one product version starts with.
 * @param {import('semver').SemVer} product - Parsed product version.
 * @returns {readonly (string | number)[]} Fields a build version must repeat before its date.
 */
function requiredFields(product) {
  return product.prerelease.length === 0 ? [STABLE_TEST_FIELD] : product.prerelease
}

/**
 * Validate a build version as a strict SemVer version without build metadata.
 * @param {string} buildVersion - Version this build carries.
 * @returns {string} The version as semver normalizes it, which is what the artifacts will carry.
 */
export function validateDesktopBuildVersion(buildVersion) {
  return parseVersion(buildVersion, 'build version').version
}

/**
 * Resolve the version a build carries.
 * @param {NodeJS.ProcessEnv} env - Packaging environment.
 * @param {string} productVersion - Version the manifests declare.
 * @returns {string} The build version when one is present, otherwise the product version.
 */
export function resolveDesktopBuildVersion(env, productVersion) {
  const buildVersion = env[DESKTOP_BUILD_VERSION_ENV]?.trim()
  if (buildVersion === undefined || buildVersion === '') return productVersion
  return validateDesktopBuildVersion(buildVersion)
}

/**
 * Everything a locally numbered test build version carries before its date, including the trailing separator.
 * @param {string} productVersion - Version the manifests declare.
 * @returns {string} The prefix shared by every build version of that product version.
 */
export function desktopBuildVersionPrefix(productVersion) {
  const product = parseVersion(productVersion, 'product version')
  const [release] = product.version.split('-')
  return `${release}-${requiredFields(product).join('.')}.`
}
