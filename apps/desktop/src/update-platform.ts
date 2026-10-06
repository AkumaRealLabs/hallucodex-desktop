/** Publisher-verification availability for Desktop update transports. */

/**
 * Restrict automatic updates to platforms with packaged publisher verification.
 * Linux remains disabled until signed metadata and artifact verification are implemented.
 * @param platform - Native application platform.
 * @returns Whether the platform may consume an automatic update feed.
 */
export function supportsDesktopAutomaticUpdates(platform: NodeJS.Platform): boolean {
  return platform === 'darwin' || platform === 'win32'
}
