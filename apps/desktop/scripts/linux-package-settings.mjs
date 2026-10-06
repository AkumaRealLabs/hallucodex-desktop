/** Public package metadata required to build Linux development artifacts. */

/**
 * Resolve Linux package metadata without inventing a publisher or distribution URL.
 * @param {NodeJS.ProcessEnv} env - File-owned packaging settings.
 * @returns {{ developmentAppImage: boolean, maintainer?: string, homepage?: string }} Explicit development mode or complete deb metadata.
 */
export function resolveLinuxPackageSettings(env) {
  if (env.DSH_DESKTOP_APP_ID === 'com.deepseek.harness') {
    throw new Error('desktop package: Linux requires a separate application identifier from DeepSeek Harness')
  }
  const mode = env.DSH_DESKTOP_LINUX_DEVELOPMENT_APPIMAGE
  if (mode !== undefined && mode !== '0' && mode !== '1') throw new Error('desktop package: DSH_DESKTOP_LINUX_DEVELOPMENT_APPIMAGE must be 0 or 1')
  if (mode === '1') return { developmentAppImage: true }
  const maintainer = env.DSH_DESKTOP_LINUX_MAINTAINER?.trim()
  if (!maintainer || !/^[^<>\r\n]+ <[^<>\s@]+@[^<>\s@]+>$/u.test(maintainer)) {
    throw new Error('desktop package: DSH_DESKTOP_LINUX_MAINTAINER must identify the package maintainer as Name <email>')
  }
  let homepage
  try { homepage = new URL(env.DSH_DESKTOP_LINUX_HOMEPAGE ?? '') }
  catch { throw new Error('desktop package: DSH_DESKTOP_LINUX_HOMEPAGE must be an HTTPS project page') }
  if (homepage.protocol !== 'https:' || homepage.username || homepage.password || homepage.hash) {
    throw new Error('desktop package: DSH_DESKTOP_LINUX_HOMEPAGE must be an HTTPS project page without credentials or fragment')
  }
  return { developmentAppImage: false, maintainer, homepage: homepage.href }
}
