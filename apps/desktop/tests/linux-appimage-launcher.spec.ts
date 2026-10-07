/** The AppImage launcher preserves sandboxing when namespace probing is unavailable. */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { desktopLinuxAppRun, verifyDesktopLinuxAppRun, writeDesktopLinuxAppRun } from '../scripts/linux-appimage-launcher.mjs'

it.skipIf(process.platform === 'win32')('forwards literal arguments without falling back to an unsandboxed launch', async () => {
  const root = mkdtempSync(join(tmpdir(), 'linux-AppRun-'))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  const helpers = join(root, 'helpers')
  mkdirSync(helpers)
  writeFileSync(join(helpers, 'id'), '#!/bin/sh\nprintf 1000\n', { mode: 0o755 })
  const marker = join(root, 'namespace-probe')
  writeFileSync(join(helpers, 'unshare'), `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, { mode: 0o755 })
  writeFileSync(join(root, 'hallucodex'), '#!/bin/sh\nprintf "<%s>\\n" "$@"\nexit 23\n', { mode: 0o755 })
  await writeDesktopLinuxAppRun(root)
  const args = ['quoted "value"', '$HOME', '中文', '']
  const result = spawnSync(join(root, 'AppRun'), args, {
    encoding: 'utf8', env: { PATH: `${helpers}:/usr/bin:/bin`, APPDIR: root },
  })
  expect(result.status, result.stderr).toBe(23)
  expect(result.stdout).toBe(args.map(arg => `<${arg}>\n`).join(''))
  expect(existsSync(marker)).toBe(false)
  expect(readFileSync(join(root, 'AppRun'), 'utf8')).toBe(desktopLinuxAppRun())
  expect(desktopLinuxAppRun()).not.toContain('--no-sandbox')
})

it.skipIf(process.platform === 'win32')('refuses an ordinary application launch as root', async () => {
  const root = mkdtempSync(join(tmpdir(), 'linux-AppRun-root-'))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  writeFileSync(join(root, 'id'), '#!/bin/sh\nprintf 0\n', { mode: 0o755 })
  await writeDesktopLinuxAppRun(root)
  const result = spawnSync(join(root, 'AppRun'), [], { encoding: 'utf8', env: { PATH: `${root}:/usr/bin:/bin`, APPDIR: root } })
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('ordinary user')
})

it.skipIf(process.platform === 'win32')('verifies extracted launcher bytes and rejects an upstream sandbox fallback', async () => {
  const root = mkdtempSync(join(tmpdir(), 'linux-AppRun-artifact-'))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  const artifact = join(root, 'fixture.AppImage')
  for (const accepted of [true, false]) {
    const launcher = accepted ? desktopLinuxAppRun() : '#!/bin/sh\nexec hallucodex --no-sandbox\n'
    writeFileSync(artifact, `#!/bin/sh\nset -eu\nmkdir squashfs-root\ncat > squashfs-root/AppRun <<'LAUNCHER'\n${launcher}LAUNCHER\n`, { mode: 0o755 })
    if (accepted) await expect(verifyDesktopLinuxAppRun(artifact)).resolves.toBeUndefined()
    else await expect(verifyDesktopLinuxAppRun(artifact)).rejects.toThrow(/sandbox-preserving AppRun/u)
  }
})
