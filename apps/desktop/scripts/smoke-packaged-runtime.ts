/** Validate the assembled application, including native Office conversion outside ASAR. */
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { resolveDesktopBuildTarget, resolveDesktopTargetBuildPaths } from './desktop-build-paths.mjs'
import { readDesktopRuntime, verifyDesktopRuntime } from '../src/runtime-tree.ts'
import { verifyWindowsCode } from './windows-runtime-signature.mjs'
import { smokePreparedRuntime } from './smoke-prepared-runtime.ts'
import { desktopPackagedApplication, resolveDesktopPackageTarget } from './package-target.ts'

const paths = resolveDesktopTargetBuildPaths()
const { values } = parseArgs({ options: { unsigned: { type: 'boolean', default: false } }, allowPositionals: false })
const target = resolveDesktopPackageTarget(resolveDesktopBuildTarget())
if (values.unsigned && target.platform === 'linux') throw new Error('desktop smoke: unsigned artifacts require Windows or macOS')
const developmentAppImage = target.platform === 'linux' && process.env.DSH_DESKTOP_LINUX_DEVELOPMENT_APPIMAGE === '1'
const artifacts = values.unsigned || developmentAppImage ? paths.unsignedArtifacts : paths.artifacts
const { application, resources, executable } = desktopPackagedApplication(target, artifacts)
const descriptor = await verifyDesktopRuntime(paths.dsh, readDesktopRuntime(paths.dsh).release.version, target)
if (target.platform === 'win32' && !values.unsigned) await verifyWindowsCode(application)
await smokePreparedRuntime(join(resources, 'app.asar', 'dsh'), executable, join(resources, 'runtime'), descriptor)
