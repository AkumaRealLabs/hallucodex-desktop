/** How a packaged HalluCodex build may deliver an update the user has confirmed. */

/**
 * `install` downloads and installs inside the app after separate confirmations; `download-page` only shows the
 * release notes and opens the public release page, because the platform cannot replace this build in place.
 */
export type DesktopUpdateDelivery = 'install' | 'download-page'

/**
 * Restrict the in-app download-and-install path to builds the platform updater can replace.
 * Windows NSIS replaces unsigned builds; Linux replaces only an AppImage, never a deb installation; macOS
 * Squirrel validates a Developer ID signature, so it needs the packaged `hallucodexUpdateMode: 'install'`
 * marker that only a signed build carries.
 * @param platform - Native application platform.
 * @param environment - Process environment; an AppImage launch sets `APPIMAGE`.
 * @param packagedMode - The packaged manifest's `hallucodexUpdateMode` value, if any.
 * @returns The delivery this build supports.
 */
export function desktopUpdateDelivery(
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv = process.env,
  packagedMode?: unknown,
): DesktopUpdateDelivery {
  if (platform === 'win32') return 'install'
  if (platform === 'linux') return environment.APPIMAGE === undefined || environment.APPIMAGE === '' ? 'download-page' : 'install'
  return platform === 'darwin' && packagedMode === 'install' ? 'install' : 'download-page'
}
