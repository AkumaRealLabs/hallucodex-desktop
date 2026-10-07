/** Environment variable that carries the build version through one packaging run. */
export const DESKTOP_BUILD_VERSION_ENV: 'DSH_DESKTOP_BUILD_VERSION'

/**
 * Validate a build version as a strict SemVer version without build metadata.
 * @param buildVersion - Version this build carries.
 * @returns The version as semver normalizes it, which is what the artifacts will carry.
 */
export function validateDesktopBuildVersion(buildVersion: string): string

/**
 * Resolve the version a build carries.
 * @param env - Packaging environment.
 * @param productVersion - Version the manifests declare.
 * @returns The build version when one is present, otherwise the product version.
 */
export function resolveDesktopBuildVersion(env: NodeJS.ProcessEnv, productVersion: string): string

/**
 * Everything a locally numbered test build version carries before its date, including the trailing separator.
 * @param productVersion - Version the manifests declare.
 * @returns The prefix shared by every build version of that product version.
 */
export function desktopBuildVersionPrefix(productVersion: string): string
