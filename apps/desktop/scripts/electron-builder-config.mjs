import { officePackageDirectories } from '../../../scripts/libreoffice-packages.mjs'
import { X509Certificate } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  resolveDesktopAppId,
  resolveMacOSNotarizationEnvironment,
  resolveMacOSSigningEnvironment,
} from './desktop-release-environment.mjs'
import { notarizeMacOSDiskImageArtifact } from './notarize-macos-disk-images.mjs'
import { verifyMacOSSignatureAfterSign } from './verify-macos-signature.mjs'
import {
  createWindowsTokenSigner,
  installWindowsNsisBootstrapSigner,
  resolveWindowsUpdatePublisher,
  scrubWindowsSigningEnvironment,
} from './windows-sign.mjs'
import { resolveDesktopBuildCommit } from './desktop-build-commit.mjs'
import { resolveDesktopBuildVersion } from './desktop-build-version.mjs'
import { verifyDesktopLinuxAppRun, writeDesktopLinuxAppRun } from './linux-appimage-launcher.mjs'
import { resolveLinuxPackageSettings } from './linux-package-settings.mjs'
import { desktopTargetBuildPaths, resolveDesktopBuildTarget } from './desktop-build-paths.mjs'
import { installWindowsDirectoryInstaller } from './windows-directory-installer.mjs'
import { preserveWindowsRuntimeSignature, signWindowsCode } from './windows-runtime-signature.mjs'
import { prepareWindowsAsarUnpack, verifyWindowsAsarUnpack } from './windows-asar-unpack.mjs'
import { recordPackagingEvent } from './packaging-run.mjs'
import { DESKTOP_APP_UPDATE_CONFIG, DESKTOP_UPDATE_PUBLISH, verifyDesktopAppUpdateConfig, writeDesktopAppUpdateConfig } from './desktop-update-feed.mjs'

const execute = promisify(execFile)

/**
 * Create electron-builder configuration from one release environment.
 * @param {NodeJS.ProcessEnv} env - Packaging environment.
 * @param {NodeJS.Platform} hostPlatform - Build-host platform used when no explicit target is present.
 * @param {string} hostArch - Build-host architecture used when no explicit target is present.
 * @param {string | undefined} preparedRuntime - Prepared dsh tree packaged instead of the target's own; it must declare the product version.
 * @returns {object} electron-builder configuration.
 */
export function createElectronBuilderConfig(
  env = process.env,
  hostPlatform = process.platform,
  hostArch = process.arch,
  preparedRuntime = undefined,
) {
  const appId = resolveDesktopAppId(env)
  const targetPlatform = env.DSH_DESKTOP_TARGET_PLATFORM
  const resolvedPlatform = targetPlatform ?? hostPlatform
  const packagesLinux = resolvedPlatform === 'linux'
  const linuxSettings = packagesLinux ? resolveLinuxPackageSettings(env) : undefined
  const developmentAppImage = linuxSettings?.developmentAppImage === true
  const resolvedArch = env.DSH_DESKTOP_TARGET_ARCH ?? hostArch
  if (env.DSH_DESKTOP_UNSIGNED !== undefined && !['0', '1'].includes(env.DSH_DESKTOP_UNSIGNED)) {
    throw new Error('desktop package: DSH_DESKTOP_UNSIGNED must be 0 or 1')
  }
  const unsigned = env.DSH_DESKTOP_UNSIGNED === '1'
  if (unsigned && packagesLinux) throw new Error('desktop package: unsigned builds require Windows or macOS')
  const packagesMacOS = targetPlatform === 'darwin' || (targetPlatform === undefined && hostPlatform === 'darwin')
  const packagesWindows = resolvedPlatform === 'win32'
  if (resolvedPlatform === 'win32') installWindowsDirectoryInstaller()
  const signsMacOS = packagesMacOS && !unsigned
  const macOSSigning = signsMacOS ? resolveMacOSSigningEnvironment(env) : undefined
  if (signsMacOS) resolveMacOSNotarizationEnvironment(env)
  const buildPaths = desktopTargetBuildPaths(resolveDesktopBuildTarget(env, hostPlatform, hostArch))
  let primaryRuntimeDestination
  let dshDestination
  let windowsCode = []
  const unpack = ['**/*.{node,dylib,dll,so,exe}', '**/*.so.*', '**/spawn-helper', '**/@vscode/ripgrep-*/bin/rg',
    `**/node_modules/@deepseek-ai/libreoffice-kit-${resolvedPlatform}-${resolvedArch}/**/*`]
  const windowsSigner = packagesWindows && !unsigned
    ? createWindowsTokenSigner({
        certificateFile: env.DSH_DESKTOP_WINDOWS_CER_FILE,
        signTool: env.DSH_DESKTOP_WINDOWS_SIGNTOOL,
        tokenPin: env.DSH_DESKTOP_WINDOWS_TOKEN_PIN,
        keyContainer: env.DSH_DESKTOP_WINDOWS_KEY_CONTAINER,
        preserveSignature: async path => {
          for (const [sourceRoot, destinationRoot] of [[join(buildPaths.runtime, 'primary-runtime'), primaryRuntimeDestination], [buildPaths.dsh, dshDestination]]) {
            if (destinationRoot !== undefined && await preserveWindowsRuntimeSignature(path, {
              sourceRoot, destinationRoot, runDirectory: env.DSH_DESKTOP_PACKAGING_RUN_DIR,
            })) return true
          }
          return false
        },
      })
    : undefined
  if (windowsSigner !== undefined) {
    installWindowsNsisBootstrapSigner({ sign: windowsSigner })
  }
  if (preparedRuntime !== undefined) buildPaths.dsh = preparedRuntime
  // electron-builder merges extraMetadata into the packaged manifest, so a build version here reaches
  // the artifact names, the update metadata, and the installed app.getVersion() the updater compares against.
  const productVersion = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')).version
  const buildVersion = resolveDesktopBuildVersion(env, productVersion)
  const packaged = resolveDesktopBuildCommit(env)
  return {
    appId,
    // HalluCodex registers no URL scheme; dsh:// belongs to DeepSeek Harness.
    protocols: [],
    extraMetadata: {
      dshDesktopAppId: appId,
      // The package name selects Electron's userData directory, separate from DeepSeek Harness.
      name: 'hallucodex',
      ...(packagesLinux ? { desktopName: 'hallucodex.desktop',
        ...(developmentAppImage ? { dshDevelopmentArtifact: true } : { homepage: linuxSettings.homepage }) } : {}),
      ...buildVersion === productVersion ? {} : { version: buildVersion },
      ...packaged === undefined ? {} : { dshBuildCommit: packaged.commit, dshBuildDirty: packaged.dirty },
      // Only a Developer ID signed and notarized macOS application can install an update in place;
      // without this field the application shows the release notes and opens the release page.
      ...signsMacOS ? { hallucodexUpdateMode: 'install' } : {},
    },
    productName: 'HalluCodex',
    // Unsigned builds carry their own suffix so a shared file can never pass for a release artifact.
    artifactName: `hallucodex-\${version}-\${os}-\${arch}${developmentAppImage ? '-dev-unsigned' : unsigned ? '-unsigned' : ''}.\${ext}`,
    directories: { output: unsigned || developmentAppImage ? buildPaths.unsignedArtifacts : buildPaths.artifacts },
    asar: true,
    electronDist: buildPaths.electron,
    electronFuses: { runAsNode: true },
    beforeBuild: async () => {
      if (resolvedPlatform !== 'win32') return true
      await execute('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
        fileURLToPath(new URL('./prepare-windows-installer.ps1', import.meta.url)),
        '-OutputDirectory', join(buildPaths.root, 'installer-ui')], {
        env: scrubWindowsSigningEnvironment(env), windowsHide: true,
      })
      if (windowsSigner !== undefined) {
        await windowsSigner({ path: join(buildPaths.root, 'installer-ui', 'window-frame.dll'), hash: 'sha256', isNest: false })
      }
      // A falsy result tells electron-builder to omit its production node_modules collection.
      return true
    },
    files: [
      'lib/main.js',
      'lib/preload-app.cjs',
      'lib/preload-mandatory.cjs',
      'lib/preload-update-dialog.cjs',
      'renderer/**/*',
      'package.json',
      { from: buildPaths.dsh, to: 'dsh', filter: ['**/*'] },
      // electron-builder excludes a source directory's root node_modules.
      { from: join(buildPaths.dsh, 'node_modules'), to: 'dsh/node_modules', filter: ['**/*'] },
    ],
    asarUnpack: unpack,
    extraResources: [
      { from: buildPaths.runtime, to: 'runtime' },
      { from: fileURLToPath(new URL('../resources/icon-windows.png', import.meta.url)), to: 'icon.png' },
      // Windows tray bitmaps; macOS keeps the Dock and ships no menu bar icon.
      ...(packagesWindows ? [{ from: fileURLToPath(new URL('../resources/tray-windows.ico', import.meta.url)), to: 'tray.ico' }] : []),
    ],
    mac: {
      icon: fileURLToPath(new URL('../resources/icon-macos.png', import.meta.url)),
      category: 'public.app-category.developer-tools',
      // An unsigned build skips electron-builder signing; afterPack applies an ad-hoc signature instead.
      identity: unsigned ? null : macOSSigning?.signingIdentity,
      forceCodeSigning: !unsigned,
      hardenedRuntime: !unsigned,
      extendInfo: {
        // macOS matches the application locale against this bundle, not Electron Framework resources.
        CFBundleLocalizations: ['en', 'zh_CN'],
        NSMicrophoneUsageDescription: 'HalluCodex uses your microphone to transcribe speech into message drafts.',
      },
      entitlements: fileURLToPath(new URL('./macos-entitlements.plist', import.meta.url)),
      entitlementsInherit: fileURLToPath(new URL('./macos-entitlements.plist', import.meta.url)),
      // ASAR-unpacked native runtime files are pre-signed; PAK resources are sealed by their enclosing bundle.
      signIgnore: ['/Contents/Resources/app\\.asar\\.unpacked/dsh(?:/|$)', '/Contents/Resources/runtime/primary-runtime(?:/|$)', '\\.pak$'],
      notarize: !unsigned,
      // The ZIP is the archive the macOS updater downloads; the DMG is the manual installer.
      target: ['dmg', 'zip'],
    },
    dmg: {
      sign: !unsigned,
      writeUpdateInfo: false,
    },
    beforePack: async context => {
      const office = await officePackageDirectories(buildPaths.dsh, { platform: resolvedPlatform, arch: resolvedArch })
      const patterns = office.map(directory => `**/${relative(buildPaths.dsh, directory).split(sep).join('/')}/**/*`)
      const existing = context.packager.config.asarUnpack ?? []
      context.packager.config.asarUnpack = [...(typeof existing === 'string' ? [existing] : existing), ...patterns]
      if (packagesWindows) windowsCode = await prepareWindowsAsarUnpack(context, buildPaths.dsh)
      if (windowsSigner !== undefined) {
        primaryRuntimeDestination = join(context.appOutDir, 'resources', 'runtime', 'primary-runtime')
        dshDestination = join(context.appOutDir, 'resources', 'app.asar.unpacked', 'dsh')
      }
    },
    afterPack: async context => {
      if (packagesLinux) await writeDesktopLinuxAppRun(context.appOutDir)
      const { verifyDesktopRuntime } = await import('../lib/types/runtime-tree.js')
      const resourcesDir = context.packager.getResourcesDir(context.appOutDir)
      // The bundled runtime declares the product version; a build version only renames the application.
      await verifyDesktopRuntime(buildPaths.dsh, productVersion, { platform: resolvedPlatform, arch: resolvedArch })
      // Unsigned Windows builds skip electron-builder's afterSign hook.
      if (packagesWindows && unsigned) await verifyWindowsAsarUnpack(buildPaths.dsh, resourcesDir, windowsCode)
      if (context.electronPlatformName !== 'darwin') return
      // User hooks run after electron-builder's own, which writes the updater configuration only for DMG
      // and ZIP targets; the signed directory build that later becomes both needs it before signing.
      if (!existsSync(join(resourcesDir, DESKTOP_APP_UPDATE_CONFIG))) {
        await writeDesktopAppUpdateConfig(resourcesDir, context.packager.appInfo.updaterCacheDirName)
      }
      await verifyDesktopAppUpdateConfig(resourcesDir)
      if (!unsigned) return
      // Apple Silicon refuses to launch code whose signature no longer matches the modified bundle.
      const appPath = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
      await execute('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', appPath])
      await execute('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath])
    },
    afterSign: async context => {
      if (windowsSigner !== undefined) {
        await signWindowsCode(context.appOutDir, {
          thumbprint: new X509Certificate(await readFile(env.DSH_DESKTOP_WINDOWS_CER_FILE)).fingerprint.replaceAll(':', ''),
          sign: windowsSigner,
          record: event => recordPackagingEvent(env.DSH_DESKTOP_PACKAGING_RUN_DIR, event),
        })
        await verifyWindowsAsarUnpack(buildPaths.dsh, context.packager.getResourcesDir(context.appOutDir), windowsCode)
      }
      if (context.electronPlatformName !== 'darwin' || unsigned) return
      verifyMacOSSignatureAfterSign(context, macOSSigning ?? resolveMacOSSigningEnvironment(env))
    },
    artifactBuildCompleted: artifact => {
      if (packagesLinux && artifact.file.endsWith('.AppImage')) return verifyDesktopLinuxAppRun(artifact.file)
      if (!artifact.file.endsWith('.dmg') || unsigned) return
      return notarizeMacOSDiskImageArtifact(
        artifact,
        env,
        macOSSigning ?? resolveMacOSSigningEnvironment(env),
      )
    },
    win: {
      icon: fileURLToPath(new URL('../resources/icon-windows.png', import.meta.url)),
      forceCodeSigning: !unsigned,
      signtoolOptions: {
        sign: windowsSigner,
        publisherName: windowsSigner === undefined ? undefined : resolveWindowsUpdatePublisher(env.DSH_DESKTOP_WINDOWS_CER_FILE),
        signingHashAlgorithms: ['sha256'],
      },
      target: ['nsis'],
    },
    linux: {
      executableName: 'hallucodex',
      syncDesktopName: true,
      icon: fileURLToPath(new URL('../resources/icon.png', import.meta.url)),
      category: 'Development',
      maintainer: linuxSettings?.maintainer,
      target: developmentAppImage ? ['AppImage'] : ['AppImage', 'deb'],
      executableArgs: [],
      desktop: { entry: { Name: 'HalluCodex', StartupWMClass: 'hallucodex' } },
    },
    // The pinned builder otherwise inserts a sandbox-disabling AppImage argument.
    appImage: { executableArgs: [] },
    deb: { packageName: 'hallucodex', executableArgs: [] },
    nsis: {
      installerSidebar: join(buildPaths.root, 'installer-ui', 'uninstaller-sidebar.bmp'),
      uninstallerSidebar: join(buildPaths.root, 'installer-ui', 'uninstaller-sidebar.bmp'),
      include: fileURLToPath(new URL('./installer.nsh', import.meta.url)),
      oneClick: false,
      perMachine: false,
      allowElevation: false,
      allowToChangeInstallationDirectory: false,
      installerLanguages: ['en_US', 'zh_CN'],
      differentialPackage: true,
    },
    // Every version, including prereleases, writes the `latest` channel files.
    detectUpdateChannel: false,
    // Development AppImages stay out of the update feed; packaging always passes `--publish never`.
    publish: developmentAppImage ? null : [{ ...DESKTOP_UPDATE_PUBLISH }],
  }
}
