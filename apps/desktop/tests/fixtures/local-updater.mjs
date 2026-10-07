/** Actual Electron HTTP/download qualification; installer execution is forbidden. */
import assert from 'node:assert/strict'
import { once } from 'node:events'
import fs from 'node:fs'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { app, protocol } from 'electron'
import updaterModule from 'electron-updater'
import { DesktopUpdateCoordinator } from '../../lib/types/update-coordinator.js'
import { presentDesktopUpdate } from '../../lib/types/update-presentation.js'
import { resolveDesktopLocale } from '../../lib/types/locale.js'
import { createUpdateServer } from './update-server.mjs'
import { DesktopUpdateHttpExecutor } from '../../lib/types/update-http-executor.js'
import { qualifyUpdateDialogs } from './update-dialogs.mjs'

const root = process.env.DSH_LOCAL_UPDATE_TEST_ROOT
assert.ok(root, 'The launcher must allocate a private test root')
app.setPath('userData', join(root, 'electron'))
// Sequential window scenarios share one Electron process; main() owns its final exit.
app.on('window-all-closed', () => {})
protocol.registerSchemesAsPrivileged([{ scheme: 'dsh-app', privileges: { standard: true, secure: true, supportFetchAPI: true } }])
const cases = []
const presentations = []
let dialogScreenshots = []
const { NsisUpdater } = updaterModule
const messages = resolveDesktopLocale('zh-CN').messages

async function main() {
  await app.whenReady()
  const server = await createUpdateServer()
  let serial = 0
  const fixtures = []
  async function fixture(mode = 'healthy', timeoutMs = 60_000) {
    server.select(mode)
    const directory = join(root, String(++serial))
    await mkdir(directory, { recursive: true })
    const config = join(directory, 'app-update.yml')
    // Unsigned inert bytes are confined to this fixture; production configuration is never loaded or changed.
    await writeFile(config, `updaterCacheDirName: cache\n`)
    const forbidden = () => { throw new Error('Unexpected application quit or relaunch') }
    const updater = new NsisUpdater(undefined, {
      version: '1.0.0', name: 'local-update-qualification', isPackaged: true,
      appUpdateConfigPath: config, userDataPath: directory, baseCachePath: directory,
      whenReady: async () => {}, quit: forbidden, relaunch: forbidden, onQuit: forbidden,
    })
    updater.logger = null
    updater.httpExecutor = new DesktopUpdateHttpExecutor(timeoutMs)
    updater.disableDifferentialDownload = true
    updater.disableWebInstaller = true
    updater.setFeedURL({ provider: 'generic', url: server.url, channel: 'nightly' })
    const installations = []
    const states = []
    let restart = async () => true
    updater.quitAndInstall = (...args) => { installations.push(args) }
    const coordinator = new DesktopUpdateCoordinator(state => { states.push(state); return state },
      () => restart(), updater, () => true, () => '1.0.0')
    const result = { updater, coordinator, installations, states, directory, restart: handler => { restart = handler } }
    fixtures.push(result)
    return result
  }
  async function scenario(name, run) { await run(); cases.push(name); console.log(`local updater: ${name}`) }
  try {
    await scenario('same-version-no-update', async () => {
      const f = await fixture()
      server.select('healthy', '1.0.0')
      assert.deepEqual(await f.coordinator.check(true), { phase: 'idle' })
    })
    await scenario('older-version-no-downgrade', async () => {
      const f = await fixture()
      server.select('healthy', '0.9.0')
      assert.equal((await f.coordinator.check(true)).phase, 'idle')
    })
    for (const mode of ['feed-404', 'feed-408', 'invalid-yaml']) {
      await scenario(`${mode}-silent-auto-visible-manual-recovery`, async () => {
        const f = await fixture(mode)
        assert.equal((await f.coordinator.check()).failedOperation, 'check')
        assert.equal(f.states.length, 0)
        assert.equal((await f.coordinator.check(true)).failedOperation, 'check')
        assert.equal(f.coordinator.state.phase, 'error')
        server.select('healthy')
        assert.equal((await f.coordinator.check(true)).phase, 'available')
      })
    }
    await scenario('stalled-feed-request-times-out-and-recovers', async () => {
      const f = await fixture('feed-stall', 1000)
      const failure = await f.coordinator.check(true)
      assert.equal(failure.failedOperation, 'check')
      assert.match(failure.message, /timed out/)
      server.select('healthy')
      assert.equal((await f.coordinator.check(true)).phase, 'available')
    })
    await scenario('concurrent-checks-use-one-request', async () => {
      const f = await fixture('hold-check')
      const before = server.requests.length
      const checks = [f.coordinator.check(), f.coordinator.check(true)]
      await server.arrived()
      try { assert.equal(server.requests.length - before, 1) }
      finally { server.release() }
      assert.ok((await Promise.all(checks)).every(state => state.phase === 'available'))
    })
    await scenario('same-feed-url-observes-new-release', async () => {
      const f = await fixture()
      assert.equal((await f.coordinator.check()).version, '1.0.1-nightly.1')
      server.select('healthy', '1.0.1-nightly.2')
      assert.equal((await f.coordinator.check()).version, '1.0.1-nightly.2')
      await assert.rejects(f.coordinator.download('1.0.1-nightly.1'), /stale/)
    })
    await scenario('user-download-progress-hash-and-separate-install', async () => {
      const f = await fixture('hold-download')
      const before = server.requests.length
      const available = await f.coordinator.check()
      assert.equal(available.phase, 'available')
      assert.equal(server.requests.length - before, 1)
      await assert.rejects(f.coordinator.install(available.version), /not ready/)
      await assert.rejects(f.coordinator.download('1.0.9-nightly.1'), /stale/)
      const downloads = [f.coordinator.download(available.version), f.coordinator.download(available.version)]
      await server.arrived()
      try {
        assert.equal(f.coordinator.state.phase, 'downloading')
        assert.equal((await f.coordinator.check(true)).phase, 'downloading')
        assert.equal(server.requests.length - before, 2)
        assert.equal(f.installations.length, 0)
      } finally { server.release() }
      assert.ok((await Promise.all(downloads)).every(state => state.phase === 'ready'))
      assert.deepEqual(await readFile(f.updater.installerPath), server.payload)
      assert.equal(f.installations.length, 0)
      assert.ok(f.states.some(state => state.phase === 'verifying'))
      const readyRequests = server.requests.length
      server.select('healthy', '1.0.1-nightly.2')
      await f.coordinator.check(true)
      await f.coordinator.download(available.version)
      assert.equal(server.requests.length, readyRequests)
      assert.equal(f.coordinator.state.version, '1.0.1-nightly.1')
      f.restart(async () => false)
      assert.equal((await f.coordinator.install(available.version)).phase, 'ready')
      assert.equal(f.installations.length, 0)
      f.restart(async () => { throw new Error('Host clean stop failed') })
      assert.equal((await f.coordinator.install(available.version)).failedOperation, 'install')
      assert.equal(f.installations.length, 0)
      f.restart(async () => true)
      assert.equal((await f.coordinator.install(available.version)).phase, 'installing')
      assert.deepEqual(f.installations, [[true, true]])
      presentations.push(...f.states.map(state => ({ phase: state.phase, ...presentDesktopUpdate(state) })))
    })
    for (const mode of ['download-404', 'corrupt', 'disconnect', 'download-stall']) {
      await scenario(`${mode}-explicit-retry`, async () => {
        const f = await fixture(mode, mode === 'download-stall' ? 1000 : 60_000)
        const available = await f.coordinator.check()
        const failure = await f.coordinator.download(available.version)
        assert.equal(failure.phase, 'error')
        assert.equal(failure.failedOperation, 'download')
        if (mode === 'corrupt') assert.match(failure.message, /checksum mismatch/i)
        if (mode === 'download-stall') assert.match(failure.message, /timed out/)
        assert.equal(f.updater.installerPath, null)
        const presentation = presentDesktopUpdate(failure)
        assert.equal(presentation.phase, 'error')
        assert.equal(presentation.failure, 'download')
        assert.equal(f.installations.length, 0)
        const before = server.requests.length
        await f.coordinator.check()
        assert.equal(server.requests.length, before)
        server.select('healthy')
        assert.equal((await f.coordinator.download(available.version)).phase, 'ready')
      })
    }
    await scenario('download-write-enospc-clears-partial-file-and-retries', async () => {
      const f = await fixture()
      const available = await f.coordinator.check()
      const original = fs.createWriteStream
      let written = 0
      const closed = []
      // Only this fixture's executable stream injects ENOSPC, after a real partial write.
      fs.createWriteStream = (file, options) => {
        if (typeof file !== 'string' || !file.startsWith(f.directory + sep) || !file.endsWith('.exe')) return original(file, options)
        const stream = original(file, { ...options, fs: {
          open: fs.open, close: fs.close,
          write(fd, buffer, offset, length, position, callback) {
            fs.write(fd, buffer, offset, Math.min(length, 1024), position, (error, bytes) => {
              written += bytes ?? 0
              callback(error ?? Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' }), bytes)
            })
          },
        } })
        closed.push(new Promise(resolve => stream.once('close', resolve)))
        return stream
      }
      try {
        const failure = await f.coordinator.download(available.version)
        assert.equal(failure.phase, 'error')
        assert.equal(failure.failedOperation, 'download')
        assert.match(failure.message, /ENOSPC/)
        assert.ok(written > 0 && written < server.payload.length, 'The fault must follow a partial file write')
        assert.equal(f.updater.installerPath, null)
        assert.ok(!f.states.some(state => state.phase === 'ready'))
        await assert.rejects(f.coordinator.install(available.version), /not ready/)
        const count = server.requests.length
        await f.coordinator.check()
        assert.equal(server.requests.length, count, 'Automatic checks must not retry a failed write')
      } finally { fs.createWriteStream = original; await Promise.all(closed) }
      assert.equal(fs.createWriteStream, original)
      const cache = await readdir(join(f.directory, 'cache'), { recursive: true })
      assert.ok(!cache.some(file => file.endsWith('.exe') || file.endsWith('update-info.json')), 'Partial bytes must not remain installable')
      const presentation = presentDesktopUpdate(f.coordinator.state)
      assert.equal(presentation.phase, 'error')
      assert.equal(presentation.failure, 'download')
      assert.equal((await f.coordinator.download(available.version)).phase, 'ready')
      assert.deepEqual(await readFile(f.updater.installerPath), server.payload)
      assert.equal(f.installations.length, 0)
    })
    await scenario('disposed-check-does-not-publish', async () => {
      const f = await fixture('hold-check')
      const check = f.coordinator.check()
      await server.arrived()
      f.coordinator.dispose()
      server.release()
      await check
      assert.equal(f.states.length, 0)
    })
    await scenario('ordinary-real-dialog-cancel-and-explicit-install', async () => {
      dialogScreenshots = await qualifyUpdateDialogs(root, fixture)
    })
    assert.deepEqual(server.failures, [])
    console.log(`LOCAL_UPDATER_RESULT=${JSON.stringify({ cases, presentations, actualElectron: process.versions.electron,
      actualTransport: 'DesktopUpdateHttpExecutor (ElectronHttpExecutor)', installerExecuted: false, requests: server.requests.length })}`)
    await writeFile(join(root, 'result.json'), `${JSON.stringify({ cases, presentations, installerExecuted: false, dialogScreenshots }, null, 2)}\n`)
  } finally {
    for (const f of fixtures) f.coordinator.dispose()
    await server.close()
  }
}

main().then(() => app.exit(0), error => { console.error(error); app.exit(1) })
