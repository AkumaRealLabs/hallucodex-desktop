/** Load platform-local release settings without changing the caller's process environment. */

/** Parent variable that selects where release settings come from: `file` (default) or `environment`. */
export const DESKTOP_PACKAGE_SETTINGS_ENV: 'DSH_DESKTOP_PACKAGE_SETTINGS'

/**
 * Read release settings from the target's UTF-8 dotenv file, or from the parent environment when
 * `DSH_DESKTOP_PACKAGE_SETTINGS=environment` selects it for CI; the other source contributes none.
 * @param platform Target platform.
 * @param environment Parent environment, retained for unrelated build tools.
 * @param appRoot Desktop application directory; relative credential paths resolve here.
 * @returns Isolated environment with the selected release settings.
 */
export function loadDesktopPackageEnvironment(
  platform: 'win32' | 'darwin' | 'linux',
  environment?: NodeJS.ProcessEnv,
  appRoot?: string,
): NodeJS.ProcessEnv

/**
 * Validate release configuration before preparation without invoking a token or Apple's services.
 * @param environment File-owned release settings.
 * @param target Selected release target.
 * @param options Explicit packaging mode.
 * @returns Nothing.
 */
export function validateDesktopPackageEnvironment(
  environment: NodeJS.ProcessEnv,
  target: { platform: 'win32' | 'darwin' | 'linux', arch: string },
  options?: { unsigned?: boolean, prepareOnly?: boolean },
): void
