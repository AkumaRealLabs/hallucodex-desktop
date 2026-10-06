/** Linux AppImage launcher that preserves Chromium's sandbox instead of probing and disabling it. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { join, resolve } from 'node:path'

/**
 * Return the application-owned AppRun program, without automatic sandbox-disabling arguments.
 * @returns {string} POSIX shell launcher for the fixed HalluCodex executable.
 */
export function desktopLinuxAppRun() {
  return `#!/bin/sh
set -eu
if [ "$(id -u)" = 0 ]; then
  printf '%s\\n' 'HalluCodex must run as an ordinary user.' >&2
  exit 1
fi
if [ -z "\${APPDIR:-}" ]; then
  APPDIR=$(dirname -- "$(readlink -f -- "$0")")
fi
export APPDIR
export PATH="$APPDIR:$APPDIR/usr/sbin\${PATH:+:$PATH}"
export XDG_DATA_DIRS="$APPDIR/usr/share:\${XDG_DATA_DIRS:-/usr/local/share:/usr/share}"
export LD_LIBRARY_PATH="$APPDIR/usr/lib\${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export GSETTINGS_SCHEMA_DIR="$APPDIR/usr/share/glib-2.0/schemas"
exec "$APPDIR/hallucodex" "$@"
`
}

/**
 * Place AppRun in the assembled app so the pinned builder's final directory copy replaces its fallback launcher.
 * @param {string} appOutDir - Linux application directory produced by electron-builder.
 * @returns {Promise<void>} Resolves after writing the executable sandbox-preserving launcher.
 */
export async function writeDesktopLinuxAppRun(appOutDir) {
  await writeFile(join(appOutDir, 'AppRun'), desktopLinuxAppRun(), { mode: 0o755 })
}

/**
 * Verify the actual AppImage launcher after assembly without starting Electron or mounting FUSE.
 * @param {string} artifact - Completed local AppImage file.
 * @returns {Promise<void>} Rejects if the image does not contain the application-owned launcher.
 */
export async function verifyDesktopLinuxAppRun(artifact) {
  const directory = await mkdtemp(join(tmpdir(), 'hallucodex-AppRun-check-'))
  try {
    await promisify(execFile)(resolve(artifact), ['--appimage-extract', 'AppRun'], {
      cwd: directory, timeout: 30_000, env: { PATH: '/usr/bin:/bin', HOME: directory, TMPDIR: directory },
    })
    if (await readFile(join(directory, 'squashfs-root', 'AppRun'), 'utf8') !== desktopLinuxAppRun()) {
      throw new Error('desktop package: AppImage does not contain the sandbox-preserving AppRun launcher')
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
