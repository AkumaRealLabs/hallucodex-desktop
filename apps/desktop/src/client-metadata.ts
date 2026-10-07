/** Client build version the Desktop build inlines. */

/**
 * Read the client build version inlined by the Desktop build.
 * @returns the version embedded in this application build.
 * @throws Error when the build carries no client version, instead of reporting a guessed one.
 */
export function desktopClientVersion(): string {
  const version = process.env.DSH_CLIENT_VERSION
  if (version === undefined || version === '') {
    throw new Error('desktop account: this application build carries no DSH_CLIENT_VERSION')
  }
  return version
}
