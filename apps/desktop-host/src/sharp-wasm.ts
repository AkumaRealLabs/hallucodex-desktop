/** Load sharp's WebAssembly build in Electron processes on Linux. */
import { registerHooks, type ModuleHooks } from 'node:module'

const NATIVE_LINUX_SHARP = /^@img\/sharp-(?:libvips-)?linux(?:musl)?-[^/]+(?:\/|$)/u

/**
 * Refuse sharp's native Linux packages so sharp falls back to `@img/sharp-wasm32`. Electron's Linux binary links the system
 * glib, and the native libvips build carries a second glib that crashes the process when sharp processes an image
 * (electron/electron#46323). The refusal raises `MODULE_NOT_FOUND`, the code sharp treats as an absent prebuilt binary.
 * Hooks apply only to this thread; worker threads that load sharp must install their own resolver.
 * @param platform - Operating system of the current process.
 * @param electron - Electron version of the current process, or undefined under plain Node.
 * @returns Installed resolver for the process lifetime, or undefined outside Electron on Linux.
 */
export function installSharpWasmResolution(platform: NodeJS.Platform, electron: string | undefined): ModuleHooks | undefined {
  if (platform !== 'linux' || electron === undefined) return undefined
  return registerHooks({
    resolve(specifier, context, nextResolve) {
      if (!NATIVE_LINUX_SHARP.test(specifier)) return nextResolve(specifier, context)
      const error: NodeJS.ErrnoException = new Error(`Desktop on Linux loads sharp's WebAssembly build instead of ${specifier}`)
      error.code = 'MODULE_NOT_FOUND'
      throw error
    },
  })
}
