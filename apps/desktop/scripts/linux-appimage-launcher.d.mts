/**
 * Return the application-owned AppRun program, without automatic sandbox-disabling arguments.
 * @returns POSIX shell launcher for the fixed HalluCodex executable.
 */
export function desktopLinuxAppRun(): string
/**
 * Place AppRun in the assembled app so the pinned builder's final directory copy replaces its fallback launcher.
 * @param appOutDir - Linux application directory produced by electron-builder.
 * @returns Resolves after writing the executable sandbox-preserving launcher.
 */
export function writeDesktopLinuxAppRun(appOutDir: string): Promise<void>

/**
 * Verify the actual AppImage launcher after assembly without starting Electron or mounting FUSE.
 * @param artifact - Completed local AppImage file.
 * @returns Rejects if the image does not contain the application-owned launcher.
 */
export function verifyDesktopLinuxAppRun(artifact: string): Promise<void>
