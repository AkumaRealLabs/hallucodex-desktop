import { WINDOWS_TITLEBAR_HEIGHT } from '../src/windows-layout.ts'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import { join } from 'node:path'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type { MenuItemConstructorOptions, MessageBoxOptions } from 'electron'
import { DESKTOP_IPC, type DesktopUpdateState } from '../src/ipc.ts'
import { DesktopHostFatalError, DesktopHostUncleanExitError } from '../src/host-process.ts'
import { en, zh } from '../src/locale.ts'
import { DesktopUpdatePreparationError } from '../src/update-error.ts'
import { writeCrashReport } from '../src/crash-report.ts'

type InvokeEvent = { sender?: unknown; senderFrame: { url: string } }
type InvokeHandler = (event: InvokeEvent, ...args: unknown[]) => unknown

const hallucodexTest = vi.hoisted(() => ({
  snapshot: { account: { status: 'signed-out' as const }, catalogStatus: 'unavailable' as const },
  restore: vi.fn(async () => {}), dispose: vi.fn(async () => {}), closeRelay: vi.fn(async () => {}),
  refreshAccount: vi.fn(async () => {}), refreshCatalog: vi.fn(async () => {}), refreshWallet: vi.fn(async () => {}),
}))
vi.mock('../src/hallucodex/runtime.ts', () => ({ HalluCodexDesktopRuntime: class {
  getSnapshot() { return hallucodexTest.snapshot }
  getRelayRevision() { return 1 }
  readonly restore = hallucodexTest.restore
  readonly dispose = hallucodexTest.dispose
  readonly refreshAccount = hallucodexTest.refreshAccount
  readonly refreshCatalog = hallucodexTest.refreshCatalog
  readonly refreshWallet = hallucodexTest.refreshWallet
} }))
vi.mock('../src/hallucodex/secure-storage.ts', () => ({ SafeStorageRefreshStore: vi.fn() }))
vi.mock('../src/hallucodex/loopback-relay.ts', () => ({ startHalluCodexLoopbackRelay: async () => ({
  baseURL: 'http://127.0.0.1:43210', localCapability: 't'.repeat(43), close: hallucodexTest.closeRelay,
}) }))

vi.mock('../src/web-document.ts', () => ({ authenticateWebHost: async () => 'test-cookie', serveWebDocument: vi.fn(), forwardWebRequest: vi.fn() }))
// Report persistence has its own unit tests; here it resolves within microtasks so the fatal
// dialog never outlives the test that triggered it.
vi.mock('../src/crash-report.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/crash-report.ts')>(),
  writeCrashReport: vi.fn(async () => 'desktop-test-logs/crash-test.log'),
  pruneCrashReports: vi.fn(async () => {}),
}))

const harness = await vi.hoisted(async () => {
  const { EventEmitter } = await import('node:events')
  function deferred() {
    let resolve!: () => void
    let reject!: (error: Error) => void
    const promise = new Promise<void>((accept, decline) => { resolve = accept; reject = decline })
    return { promise, resolve, reject }
  }
  const windows: FakeWindow[] = []
  let windowFailure: Error | undefined
  const powerMonitor = new EventEmitter()
  const hosts: FakeHost[] = []
  const handlers = new Map<string, InvokeHandler>()
  let pluginsEnabled = false
  let prepareUpdate: (() => Promise<boolean>) | undefined
  let publishUpdate: ((state: DesktopUpdateState) => DesktopUpdateState) | undefined
  let preparing = deferred()
  let prepared = deferred()
  let hostStarted = deferred()
  let navigated = deferred()
  let dialogShown = deferred()
  let quitCompleted = deferred()
  let closeWindowsOnQuit = false
  let updateState: DesktopUpdateState = { phase: 'idle' }
  const readLoginShell = async (base: NodeJS.ProcessEnv) => ({
    environment: { ...base, DSH_TEST_LOGIN_SHELL: 'login' }, failures: [{ shell: '/account/shell', reason: 'timeout' }],
  })
  const loginShell = vi.fn((base: NodeJS.ProcessEnv, _config: unknown, _options: { signal?: AbortSignal }) => readLoginShell(base))
  const updateCheck = vi.fn(async (_manual?: boolean): Promise<DesktopUpdateState> => updateState)
  const updateDownload = vi.fn(async (_version: string): Promise<DesktopUpdateState> => updateState)
  const updateInstall = vi.fn(async (_version: string): Promise<DesktopUpdateState> => updateState)
  const popup = vi.fn<(options: { window: FakeWindow; x?: number; y?: number; callback?: () => void }) => void>()
  const menuBuilder = vi.fn<(template: MenuItemConstructorOptions[]) => { popup: typeof popup }>(() => ({ popup }))
  const menu = Object.assign(menuBuilder, { buildFromTemplate: menuBuilder, setApplicationMenu: vi.fn() })
  class FakeWindow extends EventEmitter {
    destroyed = false
    readonly urls: string[] = []
    readonly webContents = Object.assign(new EventEmitter(), {
      id: 42,
      setWindowOpenHandler: vi.fn(),
      insertCSS: vi.fn(async () => 'blur'),
      removeInsertedCSS: vi.fn(async () => {}),
      openDevTools: vi.fn(),
      getURL: () => this.urls.at(-1) ?? '',
      mainFrame: { url: '' },
      getZoomFactor: () => 1,
      isDestroyed: () => this.destroyed,
      setIgnoreMenuShortcuts: vi.fn(),
      focus: vi.fn(),
      sendInputEvent: vi.fn(),
      send: vi.fn(),
    })
    readonly shown = deferred()
    readonly show = vi.fn(() => { this.shown.resolve() })
    readonly hide = vi.fn()
    readonly minimize = vi.fn()
    readonly focus = vi.fn()
    readonly moveTop = vi.fn()
    readonly setAlwaysOnTop = vi.fn()
    readonly restore = vi.fn()
    readonly setSize = vi.fn()
    readonly getBounds = vi.fn(() => ({ x: 0, y: 0, width: 800, height: 700 }))
    readonly setMinimumSize = vi.fn()
    readonly setTitleBarOverlay = vi.fn()
    readonly contentView = { addChildView: vi.fn(), removeChildView: vi.fn() }
    readonly setVibrancy = vi.fn()
    readonly setBackgroundColor = vi.fn()
    constructor(readonly options: { show: boolean; modal?: boolean }) {
      super(); if (windowFailure !== undefined) throw windowFailure; windows.push(this)
    }
    isDestroyed() { return this.destroyed }
    fullscreen = false
    isFullScreen() { return this.fullscreen }
    readonly setFullScreen = vi.fn((flag: boolean) => { this.fullscreen = flag; this.emit(flag ? 'enter-full-screen' : 'leave-full-screen') })
    minimized = false
    isMinimized() { return this.minimized }
    visible = true
    isVisible() { return this.visible }
    focused = true
    isFocused() { return this.focused }
    async loadURL(url: string) {
      this.urls.push(url)
      this.webContents.mainFrame.url = url
      if (url === 'dsh-app://app/') navigated.resolve()
    }
    static getAllWindows() { return windows.filter(window => !window.destroyed) }
    setMenu() {}
    getContentBounds() { return { x: 0, y: 0, width: 900, height: 650 } }
    setBounds() {}
    setTitle = vi.fn()
    destroy() { this.destroyed = true; this.emit('closed') }
    close() {
      const event = { preventDefault: vi.fn() }
      this.emit('close', event)
      if (event.preventDefault.mock.calls.length === 0) this.destroy()
    }
  }
  class FakeHost {
    readonly updateTasks = vi.fn(async (_action: 'inspect' | 'lock' | 'unlock') => false)
    readonly inspectQuit = vi.fn(async () => ({ activeTasks: false, scheduledTasks: false }))
    url = 'http://127.0.0.1:3080/?token=test'
    readonly ready = deferred()
    readonly exited = deferred()
    readonly stopping = deferred()
    readonly start = vi.fn(() => { hostStarted.resolve(); return this.ready.promise.then(() => ({ url: this.url, injections: [] })) })
    readonly stop = vi.fn(() => {
      this.stopping.resolve()
      this.ready.reject(new Error('child stopped'))
      return this.exited.promise
    })
    constructor(
      readonly node: string, readonly runtime: string, readonly profile: string,
      readonly inspectPort?: number, readonly environment?: NodeJS.ProcessEnv, readonly onFailure?: (error: Error) => void,
      readonly primaryRuntime?: string,
      readonly packageManager?: { pnpm: string; nodeBin: string },
    ) { hosts.push(this) }
  }
  const app = Object.assign(new EventEmitter(), {
    isPackaged: true,
    name: 'Desktop test',
    whenReady: () => Promise.resolve(),
    getLocale: (): string => 'en-US',
    getPreferredSystemLanguages: () => ['en-US'],
    getVersion: () => '1.0.0',
    getAppPath: (): string => 'desktop-test-app',
    setAppLogsPath: vi.fn(),
    getPath: vi.fn<(name: string) => string>(),
    setAboutPanelOptions: vi.fn<(options: Electron.AboutPanelOptionsOptions) => void>(),
    requestSingleInstanceLock: () => true,
    setAsDefaultProtocolClient: vi.fn(),
    exit: vi.fn(),
    relaunch: vi.fn(),
    focus: vi.fn(),
    quit: vi.fn(() => {
      const event = { preventDefault: vi.fn() }
      app.emit('before-quit', event)
      if (event.preventDefault.mock.calls.length === 0) {
        if (closeWindowsOnQuit) for (const window of [...windows]) if (!window.isDestroyed()) window.close()
        if (!closeWindowsOnQuit || windows.every(window => window.isDestroyed())) quitCompleted.resolve()
      }
    }),
  })
  const nativeTheme = { themeSource: 'system', shouldUseDarkColors: false }
  const trays: FakeTray[] = []
  class FakeTray extends EventEmitter {
    readonly setToolTip = vi.fn()
    readonly setContextMenu = vi.fn()
    readonly destroy = vi.fn()
    constructor(readonly image: unknown) { super(); trays.push(this) }
  }
  const backgroundNotice = { close: vi.fn((hide: () => void) => { hide() }), dispose: vi.fn(),
    markerPath: undefined as string | undefined, destination: undefined as string | undefined }
  const shellDialog = { isOpen: false, focus: vi.fn() }
  // Linux update overlays are views embedded in the main window.
  class FakeView {
    readonly webContents = Object.assign(new EventEmitter(), {
      focus: vi.fn(), setWindowOpenHandler: vi.fn(), isDestroyed: () => false, close: vi.fn(), loadURL: vi.fn(async () => {}),
    })
    readonly setBackgroundColor = vi.fn()
    readonly setBounds = vi.fn()
  }
  const overlays: { current?: { create(parent: object, preload: string, title: string, nativeModal?: boolean): { destroy(): void } } } = {}
  return {
    failWindow(error: Error) { windowFailure = error },
    windows, hosts, handlers, app, FakeWindow, FakeHost, powerMonitor, nativeTheme,
    trays, FakeTray, backgroundNotice, shellDialog, FakeView, overlays,
    menu, popup, socketHeaders: vi.fn(), loginShell, readLoginShell, updateCheck, updateDownload, updateInstall,
    ipcOn: vi.fn<(channel: string, listener: (event: { sender: unknown; senderFrame: unknown }, ...args: unknown[]) => void) => void>(),
    get updateState() { return updateState },
    set updateState(value: DesktopUpdateState) { updateState = value },
    get prepareUpdate() { return prepareUpdate! },
    set prepareUpdate(value: () => Promise<boolean>) { prepareUpdate = value },
    get publishUpdate() { return publishUpdate! },
    set publishUpdate(value: (state: DesktopUpdateState) => DesktopUpdateState) { publishUpdate = value },
    dialog: { showOpenDialog: vi.fn(), showErrorBox: vi.fn(), showMessageBox: vi.fn() },
    openExternal: vi.fn(async () => {}),
    netFetch: vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(),
    protocolHandle: vi.fn<(scheme: string, handler: (request: Request) => Response | Promise<Response>) => void>(),
    applyRelease: vi.fn(() => { preparing.resolve(); return prepared.promise }),
    disableAllPlugins: vi.fn(async () => {
      pluginsEnabled = false
      return 'desktop-test-profile/cordis.patch.yml.bak-1789555200000'
    }),
    get preparing() { return preparing }, get prepared() { return prepared },
    get hostStarted() { return hostStarted }, get navigated() { return navigated },
    get dialogShown() { return dialogShown }, get quitCompleted() { return quitCompleted },
    nextNavigation() { navigated = deferred(); return navigated.promise },
    nextHostStart() { hostStarted = deferred(); return hostStarted.promise },
    get pluginsEnabled() { return pluginsEnabled },
    set pluginsEnabled(value: boolean) { pluginsEnabled = value },
    set closeWindowsOnQuit(value: boolean) { closeWindowsOnQuit = value },
    reset() {
      windows.length = 0; hosts.length = 0; handlers.clear(); app.removeAllListeners()
      trays.length = 0
      backgroundNotice.markerPath = undefined
      backgroundNotice.destination = undefined
      shellDialog.isOpen = false
      powerMonitor.removeAllListeners()
      app.isPackaged = true
      windowFailure = undefined
      pluginsEnabled = false
      closeWindowsOnQuit = false
      prepareUpdate = undefined
      publishUpdate = undefined
      updateState = { phase: 'idle' }
      updateCheck.mockReset().mockImplementation(async () => updateState)
      loginShell.mockReset().mockImplementation(base => readLoginShell(base))
      updateDownload.mockReset().mockImplementation(async () => updateState)
      updateInstall.mockReset().mockImplementation(async () => updateState)
      nativeTheme.themeSource = 'system'; nativeTheme.shouldUseDarkColors = false
      preparing = deferred(); prepared = deferred(); hostStarted = deferred()
      navigated = deferred(); dialogShown = deferred(); quitCompleted = deferred()
    },
  }
})

vi.mock('electron', () => ({
  app: harness.app,
  BrowserWindow: harness.FakeWindow,
  WebContentsView: harness.FakeView,
  dialog: harness.dialog,
  shell: { openExternal: harness.openExternal },
  nativeTheme: harness.nativeTheme,
  net: { fetch: harness.netFetch },
  ipcMain: {
    on: harness.ipcOn,
    handle: (channel: string, handler: InvokeHandler) => {
      if (harness.handlers.has(channel)) throw new Error(`duplicate IPC handler ${channel}`)
      harness.handlers.set(channel, handler)
    },
    removeHandler: (channel: string) => { harness.handlers.delete(channel) },
  },
  Menu: { setApplicationMenu: harness.menu.setApplicationMenu, buildFromTemplate: harness.menu },
  session: { defaultSession: {
    setPermissionCheckHandler: vi.fn(), setPermissionRequestHandler: vi.fn(), webRequest: { onBeforeSendHeaders: harness.socketHeaders },
  } },
  protocol: { registerSchemesAsPrivileged: vi.fn(), handle: harness.protocolHandle },
  powerMonitor: harness.powerMonitor,
  Tray: harness.FakeTray,
  safeStorage: {},
  nativeImage: { createFromPath: (path: string) => ({ path }) },
}))
vi.mock('../src/background-notice.ts', () => ({ DesktopBackgroundNotice: class {
  constructor(options: { markerPath: string; destination: string }) {
    harness.backgroundNotice.markerPath = options.markerPath
    harness.backgroundNotice.destination = options.destination
  }
  readonly close = harness.backgroundNotice.close
  readonly dispose = harness.backgroundNotice.dispose
} }))
vi.mock('../src/login-shell-environment.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/login-shell-environment.ts')>(),
  readDesktopLoginShellEnvironment: harness.loginShell,
}))
vi.mock('../src/paths.ts', () => ({ resolveDesktopPaths: () => ({ profile: 'desktop-test-profile' }) }))
vi.mock('../src/project-manager.ts', () => ({
  DesktopProjectManager: class {
    readonly applyRelease = harness.applyRelease
    disableAllPlugins = harness.disableAllPlugins

  },
}))
vi.mock('../src/host-process.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/host-process.ts')>(), DesktopHostProcess: harness.FakeHost,
}))
vi.mock('../src/update-dialog.ts', () => ({ DesktopUpdateDialog: class {
  constructor(_preload: string, _locale: unknown, overlays: NonNullable<typeof harness.overlays.current>) {
    harness.overlays.current = overlays
  }
  get isOpen() { return harness.shellDialog.isOpen }
  show(owner: { options: { modal?: boolean } }, options: unknown) {
    return (owner.options.modal ? harness.dialog.showMessageBox(owner, options)
      : harness.dialog.showMessageBox(options)) as Promise<Electron.MessageBoxReturnValue>
  }
  cancel() {}
  readonly focus = harness.shellDialog.focus
  dispose() {}
} }))
vi.mock('../src/update-coordinator.ts', () => ({ DesktopUpdateCoordinator: class {
  constructor(publish: (state: DesktopUpdateState) => DesktopUpdateState, beforeRestart: () => Promise<boolean>) {
    harness.prepareUpdate = beforeRestart
    harness.publishUpdate = publish
  }
  get state() { return harness.updateState }
  readonly check = harness.updateCheck
  readonly download = harness.updateDownload
  readonly install = harness.updateInstall
  readonly dispose = vi.fn()
} }))
vi.mock('../src/welcome-backend.ts', () => ({
  connectDesktopWelcome: async () => ({
    readLocalePreference: async () => null,
    read: async () => ({ hasApiKey: false, localePreference: null }),
  }),
}))

function invoke(channel: string, origin = channel === DESKTOP_IPC.boot ? 'app' : 'shell', ...args: unknown[]): unknown {
  const handler = harness.handlers.get(channel)
  if (handler === undefined) throw new Error(`missing handler ${channel}`)
  if (origin === 'app') {
    const sender = harness.windows[0]!.webContents
    return handler({ sender, senderFrame: sender.mainFrame }, ...args)
  }
  return handler({ senderFrame: { url: `dsh-app://${origin}/index.html` } }, ...args)
}

function applicationMenuItems(): MenuItemConstructorOptions[] {
  const native = harness.menu.mock.calls[0]?.[0][0]?.submenu
  if (Array.isArray(native)) return native
  const sender = harness.windows[0]!.webContents
  void harness.handlers.get(DESKTOP_IPC.windowsMenu)!({ sender, senderFrame: sender.mainFrame }, 'application', 0, 0)
  return harness.menu.mock.lastCall![0]
}

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  harness.dialog.showMessageBox.mockReset()
  harness.dialog.showMessageBox.mockResolvedValue({ response: 1 })
  vi.useFakeTimers()
  harness.reset()
  const userData = mkdtempSync(join(tmpdir(), 'dsh-main-user-data-'))
  onTestFinished(() => { rmSync(userData, { recursive: true, force: true }) })
  harness.app.getPath.mockImplementation(name => name === 'userData' ? userData : `desktop-test-${name}`)
  harness.dialog.showMessageBox.mockImplementation((options: { title?: string }) => {
    if (options.title !== en.startupFailed) return Promise.resolve({ response: 1 })
    harness.dialogShown.resolve()
    return new Promise(() => {})
  })
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.stubEnv('DSH_DESKTOP_PNPM_ENTRY', 'test-pnpm')
  vi.stubEnv('DSH_DESKTOP_DSH_DIR', 'test-runtime')
  vi.stubEnv('DSH_DESKTOP_PRIMARY_RUNTIME_DIR', 'test-primary-runtime')
  vi.stubGlobal('process', { ...process, platform: 'win32', arch: 'x64', resourcesPath: 'desktop-test-resources' })
  vi.stubEnv('DSH_DESKTOP_HOST_INSPECT_PORT', undefined)
  vi.stubEnv('DSH_DESKTOP_DEV_PROJECT_DIR', undefined)
  vi.stubEnv('DSH_DESKTOP_UPDATE_JOURNAL_DIR', undefined)
  vi.stubEnv('DSH_CLIENT_VERSION', '1.2.3')
})

afterEach(async () => {
  harness.prepared.resolve()
  for (const host of harness.hosts) { host.ready.resolve(); host.exited.resolve() }
  harness.app.quit()
  // The quit decides asynchronously; a Host that starts meanwhile must still be released.
  await vi.advanceTimersByTimeAsync(0)
  for (const host of harness.hosts) { host.ready.resolve(); host.exited.resolve() }
  await harness.quitCompleted.promise
  vi.restoreAllMocks()
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('desktop main startup', () => {
  it('routes shell update documents and assets through the registered main protocol handler', async () => {
    const root = join(import.meta.dirname, '..')
    vi.spyOn(harness.app, 'getAppPath').mockReturnValue(root)
    const web = await import('../src/web-document.ts')
    const actual = await vi.importActual<typeof import('../src/web-document.ts')>('../src/web-document.ts')
    vi.mocked(web.serveWebDocument).mockImplementation(actual.serveWebDocument)
    try {
      await readyForUpdate()
      const { protocol } = await import('electron')
      const handler = vi.mocked(protocol).handle.mock.calls.at(-1)?.[1]
      if (handler === undefined) throw new Error('main did not register its protocol handler')
      for (const [name, mime] of [
        ['update-dialog.html', 'text/html'], ['update-dialog.css', 'text/css'], ['update-dialog.js', 'text/javascript'],
        ['update-close.svg', 'image/svg+xml'],
      ] as const) {
        const response = await handler(new Request(`dsh-app://shell/${name}`))
        expect(response.status).toBe(200)
        expect(response.headers.get('content-type')).toContain(mime)
        expect(await response.text()).toBe(readFileSync(join(root, 'renderer', name), 'utf8'))
      }
      const head = await handler(new Request('dsh-app://shell/update-dialog.html', { method: 'HEAD' }))
      expect(head.status).toBe(200)
      expect(await head.text()).toBe('')
      expect((await handler(new Request('dsh-app://shell/update-dialog.html', { method: 'POST' }))).status).toBe(405)
      expect((await handler(new Request('dsh-app://shell/%'))).status).toBe(400)
      expect((await handler(new Request('dsh-app://shell/%2e%2e%2fpackage.json'))).status).toBe(403)
      expect((await handler(new Request('dsh-app://shell/missing.html'))).status).toBe(404)
      expect((await handler(new Request('dsh-app://other/update-dialog.html'))).status).toBe(404)
    } finally {
      vi.mocked(web.serveWebDocument).mockReset()
    }
  })

  it('serves shell dialogs and their assets without forwarding them to the Host', async () => {
    await readyForUpdate()
    const { serveWebDocument, forwardWebRequest } = await import('../src/web-document.ts')
    const handler = harness.protocolHandle.mock.calls[0]![1]
    for (const file of ['update-dialog.html', 'update-dialog.js', 'update-dialog.css', 'update-close.svg']) {
      const request = new Request(`dsh-app://shell/${file}`)
      await handler(request)
      expect(serveWebDocument).toHaveBeenLastCalledWith(request, join('desktop-test-app', 'renderer'))
    }
    expect(forwardWebRequest).not.toHaveBeenCalled()
    expect((await handler(new Request('dsh-app://unknown/update-dialog.html'))).status).toBe(404)
  })

  it('installs hidden native DevTools shortcuts in the macOS application menu', async () => {
    vi.stubGlobal('process', { ...process, platform: 'darwin' })
    await readyForUpdate()
    expect(applicationMenuItems().slice(-2)).toEqual([
      { role: 'toggleDevTools', visible: false },
      { role: 'toggleDevTools', visible: false, accelerator: 'F12' },
    ])
    expect(harness.windows[0]!.options).toMatchObject({ webPreferences: { devTools: true } })
  })

  it.each([
    ['darwin', true, 'en-US'],
    ['darwin', false, 'zh-CN'],
    ['win32', true, 'zh-CN'],
    ['win32', false, 'en-US'],
  ] as const)('offers the About command before other commands on %s (packaged=%s, locale=%s)', async (platform, packaged, locale) => {
    vi.stubGlobal('process', { ...process, platform })
    harness.app.isPackaged = packaged
    vi.spyOn(harness.app, 'getLocale').mockReturnValue(locale)
    vi.spyOn(harness.app, 'getPreferredSystemLanguages').mockReturnValue([locale])
    vi.spyOn(harness.app, 'getPreferredSystemLanguages').mockReturnValue([locale])
    await readyForUpdate()
    const submenu = applicationMenuItems()
    const options = harness.app.setAboutPanelOptions.mock.calls[0]![0]
    const expected = JSON.parse(readFileSync(new URL('./expected/about-panel.json', import.meta.url), 'utf8')) as Record<string, unknown>
    const [about, separator] = submenu
    expect({ menu: [{ label: about!.label, role: about!.role }, separator], options: { ...options, iconPath: '<app icon>' } })
      .toEqual(expected[`${platform}:${locale}`])
    expect(options.iconPath).toBe(packaged ? join('desktop-test-resources', 'icon.png')
      : join('desktop-test-app', 'resources', 'icon-windows.png'))
    if (platform !== 'win32') { expect(about!.click).toBeUndefined(); return }
    // Windows reuses the dimmed update dialog because Electron's fallback is a bare message box.
    harness.dialog.showMessageBox.mockResolvedValueOnce({ response: 0 })
    ;(about!.click as () => void)()
    await vi.advanceTimersByTimeAsync(0)
    const zh = locale === 'zh-CN'
    expect(harness.dialog.showMessageBox).toHaveBeenLastCalledWith(expect.objectContaining({
      type: 'info', title: zh ? '关于 HalluCodex' : 'About HalluCodex', message: 'HalluCodex',
      detail: zh ? '版本 V1.0.0' : 'Version V1.0.0', buttons: [zh ? '确定' : 'OK'], cancelId: 0,
    }))
    // A dialog that cannot open is logged, not surfaced as an unhandled rejection.
    harness.dialog.showMessageBox.mockRejectedValueOnce(new Error('overlay unavailable'))
    ;(about!.click as () => void)()
    await vi.advanceTimersByTimeAsync(0)
    expect(console.error).toHaveBeenLastCalledWith(expect.objectContaining({ message: 'overlay unavailable' }))
  })

  it('persists opt-in update evidence from the real main entry without private diagnostics', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-main-update-journal-'))
    try {
      vi.stubEnv('DSH_DESKTOP_UPDATE_JOURNAL_DIR', directory)
      await readyForUpdate()
      harness.publishUpdate({ phase: 'error', failedOperation: 'download', version: '1.2.3', message: 'ENOSPC secret-url' })
      await vi.advanceTimersByTimeAsync(0)
      for (const host of harness.hosts) host.exited.resolve()
      harness.app.quit()
      await harness.quitCompleted.promise
      const files = readdirSync(directory)
      expect(files).toHaveLength(1)
      const contents = readFileSync(join(directory, files[0]!), 'utf8')
      const records = contents.trim().split('\n').map(line => JSON.parse(line) as { event: string })
      expect(records.map(row => row.event)).toEqual(expect.arrayContaining(['started', 'workspace-ready', 'state', 'quit-requested']))
      expect(contents).toContain('ENOSPC')
      expect(contents).not.toContain('secret-url')
    } finally {
      // The existing teardown calls quit again; retain its journal until listeners are removed.
      harness.app.removeAllListeners('before-quit')
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('accepts product IPC only from the current application top frame in the owned main window', async () => {
    await readyForUpdate()
    const sender = harness.windows[0]!.webContents
    for (const channel of [DESKTOP_IPC.updatesStatus, DESKTOP_IPC.deviceInfo]) {
      const handler = harness.handlers.get(channel)!
      expect(() => handler({ sender, senderFrame: sender.mainFrame })).not.toThrow()
      for (const event of [
        { sender: {}, senderFrame: sender.mainFrame },
        { sender, senderFrame: { url: sender.mainFrame.url } },
        { sender, senderFrame: { url: 'http://127.0.0.1:40000/' } },
      ]) expect(() => handler(event)).toThrow('unowned renderer')
      const original = sender.mainFrame.url
      sender.mainFrame.url = 'http://127.0.0.1:40000/'
      expect(() => handler({ sender, senderFrame: sender.mainFrame })).toThrow('unowned renderer')
      sender.mainFrame.url = original
    }
  })

  it.each(['darwin', 'win32', 'linux'] as const)('replaces the native caption and menu bar on %s', async (platform) => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
    await import('../src/main.ts')
    await harness.preparing.promise
    const window = harness.windows[0]!
    expect(window.urls).toEqual(['dsh-app://app/'])
    if (platform === 'darwin') {
      expect(window.options).toMatchObject({ titleBarStyle: 'hiddenInset', vibrancy: 'sidebar', backgroundColor: '#00000000' })
      expect(window.options).not.toHaveProperty('icon')
    } else {
      // Windows and Linux draw the Application and Edit menus in the page caption; no native menu bar remains.
      expect(window.options).toMatchObject({ titleBarStyle: 'hidden', titleBarOverlay: { height: WINDOWS_TITLEBAR_HEIGHT } })
      expect(window.options).not.toHaveProperty('vibrancy')
      expect(harness.menu.mock.calls[0]![0]).toEqual([
        { role: 'toggleDevTools', visible: false },
        { role: 'toggleDevTools', visible: false, accelerator: 'F12' },
      ])
    }
    if (platform === 'linux') {
      expect(window.options).toMatchObject({ icon: join('desktop-test-resources', 'icon.png') })
    } else {
      expect(window.options).not.toHaveProperty('icon')
    }
    expect(harness.hosts).toHaveLength(0)
  })

  it('serves packaged shell documents instead of rejecting the shell origin', async () => {
    const { serveWebDocument } = await import('../src/web-document.ts')
    vi.mocked(serveWebDocument).mockResolvedValue(new Response('shell document'))
    await import('../src/main.ts')
    await harness.preparing.promise
    const handler = harness.protocolHandle.mock.calls[0]![1]
    const request = new Request('dsh-app://shell/update-dialog.html')
    expect(await (await handler(request)).text()).toBe('shell document')
    expect(serveWebDocument).toHaveBeenCalledWith(request, join('desktop-test-app', 'renderer'))
    expect((await handler(new Request('dsh-app://foreign/index.html'))).status).toBe(404)
  })

  it.each(['darwin', 'win32', 'linux'] as const)('relays the %s fullscreen state on transitions and after each load', async (platform) => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
    await import('../src/main.ts')
    await harness.preparing.promise
    const window = harness.windows[0]!
    const sent = () => window.webContents.send.mock.calls.filter(([channel]) => channel === DESKTOP_IPC.windowFullscreen)
    expect(sent()).toHaveLength(0)
    window.fullscreen = true
    window.emit('enter-full-screen')
    expect(sent().at(-1)).toEqual([DESKTOP_IPC.windowFullscreen, true])
    // A reload re-registers the preload listener; the finished load resends
    // the current state so fullscreen CSS survives the reload.
    window.webContents.emit('did-finish-load')
    expect(sent().at(-1)).toEqual([DESKTOP_IPC.windowFullscreen, true])
    window.fullscreen = false
    window.emit('leave-full-screen')
    expect(sent().at(-1)).toEqual([DESKTOP_IPC.windowFullscreen, false])
    const relayed = sent().length
    window.destroyed = true
    window.emit('enter-full-screen')
    expect(sent()).toHaveLength(relayed)
  })

  it('covers the macOS vibrancy reattach gap with an opaque base while minimized or hidden', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    await import('../src/main.ts')
    await harness.preparing.promise
    const window = harness.windows[0]!
    // Minimizing drops the vibrancy material and paints the theme's opaque fill.
    window.minimized = true
    window.emit('minimize')
    expect(window.setVibrancy).toHaveBeenLastCalledWith(null)
    expect(window.setBackgroundColor).toHaveBeenLastCalledWith('#f9fafb')
    // Restoring re-requests the material and returns to the transparent base.
    window.minimized = false
    window.emit('restore')
    expect(window.setVibrancy).toHaveBeenLastCalledWith('sidebar')
    expect(window.setBackgroundColor).toHaveBeenLastCalledWith('#00000000')
    // Hiding under the dark palette picks the dark opaque fill.
    harness.nativeTheme.shouldUseDarkColors = true
    window.visible = false
    window.emit('hide')
    expect(window.setVibrancy).toHaveBeenLastCalledWith(null)
    expect(window.setBackgroundColor).toHaveBeenLastCalledWith('#1b1b1c')
    window.visible = true
    window.emit('show')
    expect(window.setBackgroundColor).toHaveBeenLastCalledWith('#00000000')
    // A destroyed window ends the backdrop updates.
    const applied = window.setVibrancy.mock.calls.length
    window.destroyed = true
    window.emit('minimize')
    expect(window.setVibrancy.mock.calls).toHaveLength(applied)
  })

  it.each(['win32', 'linux'] as const)('registers no backdrop swap on %s', async (platform) => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
    await import('../src/main.ts')
    await harness.preparing.promise
    const window = harness.windows[0]!
    window.minimized = true
    window.emit('minimize')
    expect(window.setVibrancy).not.toHaveBeenCalled()
    expect(window.setBackgroundColor).not.toHaveBeenCalled()
  })

  it.each(['win32', 'linux'] as const)('follows the %s primary document language and palette without trusting other frames', async (platform) => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
    await import('../src/main.ts')
    await harness.preparing.promise
    const window = harness.windows[0]!
    const listener = harness.ipcOn.mock.calls.find(([channel]) => channel === DESKTOP_IPC.windowsAppearance)![1]
    const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame }
    listener({ ...event, senderFrame: { url: 'dsh-app://app/' } }, 'zh-CN', '#ffffff', '#000000')
    expect(window.setTitleBarOverlay).not.toHaveBeenCalled()
    listener(event, 'zh-CN', 'rgb(249, 250, 251)', '#0f1115')
    expect(window.setTitleBarOverlay).toHaveBeenCalledWith({ color: 'rgb(249, 250, 251)', symbolColor: '#0f1115' })
    window.webContents.emit('context-menu', {}, { isEditable: false, selectionText: 'text', editFlags: { canCopy: true } })
    expect(harness.menu.buildFromTemplate).toHaveBeenLastCalledWith([{ role: 'copy', enabled: true, label: '复制', accelerator: '' }])
    listener(event, 'en', '#1b1b1c', '#f9fafb')
    window.webContents.emit('context-menu', {}, { isEditable: false, selectionText: 'text', editFlags: { canCopy: true } })
    expect(harness.menu.buildFromTemplate).toHaveBeenLastCalledWith([{ role: 'copy', enabled: true, label: 'Copy', accelerator: '' }])
    window.setTitleBarOverlay.mockClear()
    listener(event, 'en', 'url(file:///bad)', '#fff')
    expect(window.setTitleBarOverlay).not.toHaveBeenCalled()
    listener(event, {}, '#fff', '#000')
    expect(window.setTitleBarOverlay).toHaveBeenLastCalledWith({ color: '#fff', symbolColor: '#000' })
    window.setTitleBarOverlay.mockClear()
    window.webContents.mainFrame.url = 'dsh-app://unowned/index.html'
    listener(event, 'zh-CN', '#fff', '#000')
    expect(window.setTitleBarOverlay).not.toHaveBeenCalled()
    expect(harness.menu.setApplicationMenu).toHaveBeenCalledOnce()
  })

  it('shades the Linux caption buttons with the backdrop of an embedded update overlay', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    await import('../src/main.ts')
    await harness.preparing.promise
    const window = harness.windows[0]!
    const appearance = harness.ipcOn.mock.calls.find(([channel]) => channel === DESKTOP_IPC.windowsAppearance)![1]
    const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame }
    appearance(event, 'en', 'rgba(255, 255, 255, 1)', 'rgba(15, 17, 21, 1)')
    expect(window.setTitleBarOverlay).toHaveBeenLastCalledWith({ color: 'rgba(255, 255, 255, 1)', symbolColor: 'rgba(15, 17, 21, 1)' })
    const overlay = harness.overlays.current!.create(window, 'preload', 'Update available', false)
    expect(window.contentView.addChildView).toHaveBeenCalledOnce()
    expect(window.setTitleBarOverlay).toHaveBeenLastCalledWith({ color: 'rgba(194, 194, 194, 1)', symbolColor: 'rgba(11, 13, 16, 1)' })
    // A palette change while the overlay is open keeps the shade.
    appearance(event, 'en', 'rgba(27, 27, 28, 1)', 'rgba(249, 250, 251, 1)')
    expect(window.setTitleBarOverlay).toHaveBeenLastCalledWith({ color: 'rgba(21, 21, 21, 1)', symbolColor: 'rgba(189, 190, 191, 1)' })
    overlay.destroy()
    expect(window.setTitleBarOverlay).toHaveBeenLastCalledWith({ color: 'rgba(27, 27, 28, 1)', symbolColor: 'rgba(249, 250, 251, 1)' })
  })

  it.each(['win32', 'linux'] as const)('maps %s caption menus to localized native commands and rejects foreign popup requests', async (platform) => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
    await import('../src/main.ts')
    await harness.preparing.promise
    const window = harness.windows[0]!
    const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame }
    const appearance = harness.ipcOn.mock.calls.find(([channel]) => channel === DESKTOP_IPC.windowsAppearance)![1]
    appearance(event, 'zh-CN', '#fff', '#000')
    const handler = harness.handlers.get(DESKTOP_IPC.windowsMenu)!
    const foreignEvent = { ...event, sender: {} }
    expect(() => handler(foreignEvent, 'application', 48, 34)).toThrow('rejected sender')
    expect(() => handler(event, 'arbitrary-command', 48, 34)).toThrow('invalid popup request')
    expect(() => handler(event, 'application', NaN, 34)).toThrow('invalid popup request')
    const application = handler(event, 'application', 48, 34)
    // Linux installs no dsh command, so it offers no command management.
    expect(harness.menu.buildFromTemplate.mock.lastCall![0].map(item => item.label ?? item.type)).toEqual([
      '关于 HalluCodex', 'separator', 'HalluCodex 账号', '检查更新…', ...platform === 'win32' ? ['管理 dsh 命令…'] : [], 'separator', '退出',
    ])
    expect(harness.popup.mock.lastCall![0]).toMatchObject({ window, x: 48, y: 34 })
    expect(harness.popup.mock.lastCall![0].callback).toBeTypeOf('function')
    harness.popup.mock.lastCall![0].callback!()
    await application
    const edit = handler(event, 'edit', 104, 34)
    expect(harness.menu.buildFromTemplate.mock.lastCall![0].map(item => item.label ?? item.type)).toEqual([
      '撤销', '重做', 'separator', '剪切', '复制', '粘贴', '删除', 'separator', '全选',
    ])
    const commands = harness.menu.buildFromTemplate.mock.lastCall![0].filter(item => item.type !== 'separator')
    for (const [index, keyCode] of ['Z', 'Y', 'X', 'C', 'V', 'Delete', 'A'].entries()) {
      const click = commands[index]!.click as () => void
      click()
      const modifiers = keyCode === 'Delete' ? [] : ['control']
      expect(window.webContents.sendInputEvent).toHaveBeenNthCalledWith(index * 2 + 1, { type: 'keyDown', keyCode, modifiers })
      expect(window.webContents.sendInputEvent).toHaveBeenNthCalledWith(index * 2 + 2, { type: 'keyUp', keyCode, modifiers })
    }
    harness.popup.mock.lastCall![0].callback!()
    await edit
  })

  it('adds the product File menu and standard window commands on macOS', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    await import('../src/main.ts')
    await harness.preparing.promise
    const describeItem = (item: MenuItemConstructorOptions): string | undefined =>
      item.role ?? (item.type === 'separator' ? 'separator' : item.label)
    const template = harness.menu.buildFromTemplate.mock.calls
      .map(call => call[0])
      .find(items => items.some(item => item.role === 'editMenu'))
    if (template === undefined) throw new Error('application menu missing')
    expect(template.map(describeItem)).toEqual(['Desktop test', en.fileMenu, 'editMenu', 'windowMenu'])
    const application = template[0]!.submenu as MenuItemConstructorOptions[]
    expect(application.filter(item => item.visible !== false).map(describeItem)).toEqual(
      ['about', 'separator', 'HalluCodex account', en.checkUpdatesMenu, en.cliCommandMenu, 'separator', 'hide', 'hideOthers', 'unhide', 'separator', 'quit'])
    expect(harness.menu.setApplicationMenu).toHaveBeenCalledOnce()
  })

  it.each(['en-US', 'zh-CN'])('localizes macOS application commands without changing the application name (%s)', async (locale) => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    vi.spyOn(harness.app, 'getLocale').mockReturnValue(locale)
    vi.spyOn(harness.app, 'getPreferredSystemLanguages').mockReturnValue([locale])
    const originalName = harness.app.name
    harness.app.name = '@deepseek-ai/dsh-desktop'
    try {
      await import('../src/main.ts')
      await harness.preparing.promise
      const commands = applicationMenuItems().filter(item =>
        item.role === 'hide' || item.role === 'hideOthers' || item.role === 'unhide' || item.role === 'quit'
        || item.label === en.checkUpdatesMenu || item.label === zh.checkUpdatesMenu
        || item.label === en.cliCommandMenu || item.label === zh.cliCommandMenu)
      await expect(JSON.stringify(commands, null, 2) + '\n')
        .toMatchFileSnapshot(`./expected/application-menu-${locale}.json`)
      expect(harness.app.name).toBe('@deepseek-ai/dsh-desktop')
    } finally { harness.app.name = originalName }
  })

  it('attaches Host socket credentials only to the owned application origin and window', async () => {
    await import('../src/main.ts')
    await harness.preparing.promise
    harness.prepared.resolve()
    await harness.hostStarted.promise
    harness.hosts[0]!.ready.resolve()
    await Promise.resolve(invoke(DESKTOP_IPC.boot))
    const handler = harness.socketHeaders.mock.calls[0]![1] as (
      details: { url: string; webContentsId: number; requestHeaders: Record<string, string> },
      callback: (result: unknown) => void,
    ) => void
    const callback = vi.fn()
    const details = { url: 'ws://127.0.0.1:3080/api/remote.mux', webContentsId: 42, requestHeaders: { Origin: 'dsh-app://app' } }
    handler(details, callback)
    expect(callback).toHaveBeenLastCalledWith({ requestHeaders: {
      origin: 'http://127.0.0.1:3080', cookie: 'test-cookie', 'sec-fetch-site': 'same-origin',
    } })
    handler({ ...details, requestHeaders: { Origin: 'https://other.example' } }, callback)
    expect(callback).toHaveBeenLastCalledWith({ cancel: true })
    handler({ ...details, webContentsId: 43 }, callback)
    expect(callback).toHaveBeenLastCalledWith({})
    handler({ ...details, url: 'ws://127.0.0.1:9999/api/remote.mux' }, callback)
    expect(callback).toHaveBeenLastCalledWith({})
  })

  it('enlarges only an active onboarding window and keeps its size after completion', async () => {
    await import('../src/main.ts')
    await harness.preparing.promise
    const window = harness.windows[0]!
    const listener = harness.ipcOn.mock.calls.find(([channel]) => channel === DESKTOP_IPC.onboardingActive)![1]
    const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame }
    expect(window.setMinimumSize).not.toHaveBeenCalled()
    listener({ ...event, sender: {} }, true)
    listener(event, 'true')
    expect(window.setMinimumSize).not.toHaveBeenCalled()
    listener(event, true)
    expect(window.setMinimumSize).toHaveBeenLastCalledWith(960, 600)
    expect(window.setSize).toHaveBeenLastCalledWith(960, 700)
    window.setSize.mockClear()
    window.getBounds.mockReturnValue({ x: 0, y: 0, width: 1200, height: 800 })
    listener(event, true)
    expect(window.setSize).not.toHaveBeenCalled()
    listener(event, false)
    expect(window.setMinimumSize).toHaveBeenLastCalledWith(520, 600)
    expect(window.setSize).not.toHaveBeenCalled()
  })

  it('registers the window-owned directory picker during startup and rejects foreign callers', async () => {
    await import('../src/main.ts')
    await harness.preparing.promise
    const window = harness.windows[0]!
    const handler = harness.handlers.get(DESKTOP_IPC.directoryPick) as (event: IpcMainInvokeEvent) => Promise<string | null>
    expect(handler).toBeTypeOf('function')
    const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame } as unknown as IpcMainInvokeEvent
    harness.dialog.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['/workspace'] })
    await expect(handler(event)).resolves.toBe('/workspace')
    expect(harness.dialog.showOpenDialog).toHaveBeenCalledExactlyOnceWith(window, { properties: ['openDirectory', 'createDirectory'] })
    window.webContents.mainFrame.url = 'https://other.example/'
    await expect(handler(event)).rejects.toThrow('unowned renderer')
  })

  it('holds boot injections until the Host is ready and rejects foreign boot callers', async () => {
    await import('../src/main.ts')
    await harness.preparing.promise
    const handler = harness.handlers.get(DESKTOP_IPC.boot)!
    await expect(handler({ senderFrame: { url: 'https://other.example/' } })).rejects.toThrow('unowned renderer')
    let settled = false
    const boot = Promise.resolve(handler({ senderFrame: { url: 'dsh-app://app/' } })).then((value) => { settled = true; return value })
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(harness.windows[0]!.urls).toEqual(['dsh-app://app/'])
    harness.prepared.resolve()
    await harness.hostStarted.promise
    expect(settled).toBe(false)
    harness.hosts[0]!.ready.resolve()
    await expect(boot).resolves.toEqual({ injections: [], streamBaseUrl: 'http://127.0.0.1:3080' })
    expect(harness.windows[0]!.urls).toEqual(['dsh-app://app/'])
  })

  it('retains macOS native editing actions on right-click and only copy for selected read-only text', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    await import('../src/main.ts')
    await harness.preparing.promise
    const window = harness.windows[0]!
    const editFlags = { canUndo: true, canRedo: false, canCut: true, canCopy: true, canPaste: true, canSelectAll: true }
    harness.menu.mockClear()

    window.webContents.emit('context-menu', {}, { isEditable: true, selectionText: 'text', editFlags })
    expect(harness.menu).toHaveBeenLastCalledWith([
      { role: 'undo', enabled: true, accelerator: '' }, { role: 'redo', enabled: false, accelerator: '' },
      { type: 'separator', accelerator: '' },
      { role: 'cut', enabled: true, accelerator: '' }, { role: 'copy', enabled: true, accelerator: '' },
      { role: 'paste', enabled: true, accelerator: '' }, { type: 'separator', accelerator: '' },
      { role: 'selectAll', enabled: true, accelerator: '' },
    ])
    expect(harness.popup).toHaveBeenCalledWith({ window })

    window.webContents.emit('context-menu', {}, { isEditable: false, selectionText: 'text', editFlags })
    expect(harness.menu).toHaveBeenLastCalledWith([{ role: 'copy', enabled: true, accelerator: '' }])

    harness.menu.mockClear()
    window.webContents.emit('context-menu', {}, { isEditable: false, selectionText: '', editFlags })
    expect(harness.menu).not.toHaveBeenCalled()
  })

  it('opens message links externally while retaining same-origin application navigation', async () => {
    await readyForUpdate()
    const window = harness.windows[0]!
    const openWindow = window.webContents.setWindowOpenHandler.mock.calls[0]![0] as
      (details: { url: string }) => { action: string }
    const source = 'https://example.com/source?q=reference'
    expect(openWindow({ url: source })).toEqual({ action: 'deny' })
    expect(harness.openExternal).toHaveBeenCalledWith(source)
    harness.openExternal.mockClear()
    const external = { preventDefault: vi.fn() }
    window.webContents.emit('will-navigate', external, 'https://example.com/document')
    expect(external.preventDefault).toHaveBeenCalledOnce()
    expect(harness.openExternal).toHaveBeenCalledWith('https://example.com/document')
    harness.openExternal.mockClear()
    const internal = { preventDefault: vi.fn() }
    window.webContents.emit('will-navigate', internal, 'dsh-app://app/session/task-1')
    expect(internal.preventDefault).not.toHaveBeenCalled()
    expect(harness.openExternal).not.toHaveBeenCalled()
  })

  /** Give the packaged build an in-app update source, as a Windows or AppImage release carries. */
  function withInAppUpdateSource(): void {
    const resources = mkdtempSync(join(tmpdir(), 'hallucodex-update-source-'))
    writeFileSync(join(resources, 'app-update.yml'), 'provider: github\nowner: AkumaRealLabs\nrepo: hallucodex-desktop\n')
    onTestFinished(() => { rmSync(resources, { recursive: true, force: true }) })
    vi.stubGlobal('process', { ...process, resourcesPath: resources })
  }

  async function readyForUpdate() {
    await import('../src/main.ts')
    await harness.preparing.promise
    harness.prepared.resolve()
    await harness.hostStarted.promise
    harness.hosts[0]!.ready.resolve()
    await harness.navigated.promise
    return harness.hosts[0]!
  }

  it('opens the startup account dialog in the language the client reports', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    await import('../src/main.ts')
    await harness.preparing.promise
    const window = harness.windows[0]!
    const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame }
    harness.ipcOn.mock.calls.find(([channel]) => channel === DESKTOP_IPC.localeChanged)![1](event, 'zh')
    // The document declares lang="en" until the client applies its language, and the caption reports it.
    window.webContents.mainFrame.url = 'dsh-app://app/'
    harness.ipcOn.mock.calls.find(([channel]) => channel === DESKTOP_IPC.windowsAppearance)![1](event, 'en', '#fff', '#000')
    harness.prepared.resolve()
    await harness.hostStarted.promise
    harness.hosts[0]!.ready.resolve()
    await harness.navigated.promise
    await Promise.resolve(invoke(DESKTOP_IPC.boot))
    await vi.waitFor(() => { expect(window.webContents.send).toHaveBeenCalledWith('hallucodex:open', 'zh-CN') })
  })

  it('keeps Linux data separate and starts the HalluCodex runtime', async () => {
    vi.stubEnv('DSH_HOME', undefined)
    vi.stubGlobal('process', { ...process, platform: 'linux' })
    const request = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', request)
    await readyForUpdate()
    expect(process.env.DSH_HOME).toBe(join(harness.app.getPath('home'), '.hallucodex'))
    expect(request).not.toHaveBeenCalled()
    expect(harness.app.setAsDefaultProtocolClient).not.toHaveBeenCalled()
    expect(hallucodexTest.restore).toHaveBeenCalledOnce()
    const locale = await Promise.resolve(invoke(DESKTOP_IPC.localeBootstrap, 'app'))
    expect(locale).toMatchObject({ languages: ['en-US'] })
    expect(await Promise.resolve(invoke('hallucodex:state', 'app'))).toEqual(hallucodexTest.snapshot)
    const window = harness.windows[0]!
    expect(() => harness.handlers.get('hallucodex:state')!({ sender: {}, senderFrame: window.webContents.mainFrame })).toThrow()
    for (const channel of ['hallucodex:refresh', 'hallucodex:refresh-catalog', 'hallucodex:refresh-wallet', 'hallucodex:restore']) {
      expect(() => harness.handlers.get(channel)!({ sender: {}, senderFrame: window.webContents.mainFrame })).toThrow()
      await Promise.resolve(invoke(channel, 'app'))
    }
    expect(hallucodexTest.refreshAccount).toHaveBeenCalledOnce()
    expect(hallucodexTest.refreshCatalog).toHaveBeenCalledOnce()
    expect(hallucodexTest.refreshWallet).toHaveBeenCalledOnce()
    expect(hallucodexTest.restore).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['win32', ['--updated'], true],
    ['win32', [], false],
    ['darwin', ['--updated'], false],
    ['linux', ['--updated'], false],
  ] as const)('raises the first workspace only for a Windows installer restart (%s, %j)', async (platform, args, raises) => {
    vi.stubGlobal('process', { ...process, platform, argv: ['desktop', ...args] })
    await import('../src/main.ts')
    await harness.preparing.promise
    const window = harness.windows[0]!
    expect(window.moveTop).not.toHaveBeenCalled()
    harness.prepared.resolve()
    await harness.hostStarted.promise
    harness.hosts[0]!.ready.resolve()
    await window.shown.promise
    expect(window.show).toHaveBeenCalledOnce()
    expect(window.moveTop).toHaveBeenCalledTimes(raises ? 1 : 0)
    expect(window.focus).toHaveBeenCalledTimes(raises ? 1 : 0)
    expect(window.setAlwaysOnTop).not.toHaveBeenCalled()
    if (raises) {
      expect(window.show.mock.invocationCallOrder[0]).toBeLessThan(window.moveTop.mock.invocationCallOrder[0]!)
    }
    window.destroy()
    harness.app.emit('second-instance')
    const replacement = harness.windows[1]!
    await replacement.shown.promise
    expect(replacement.show).toHaveBeenCalledOnce()
    expect(replacement.moveTop).not.toHaveBeenCalled()
    expect(replacement.setAlwaysOnTop).not.toHaveBeenCalled()
  })

  it.each([
    ['win32', 'zh-CN'], ['win32', 'en-US'], ['darwin', 'zh-CN'], ['darwin', 'en-US'],
  ] as const)('records the restart confirmation on %s in %s', async (platform, language) => {
    vi.stubGlobal('process', { ...process, platform })
    vi.spyOn(harness.app, 'getPreferredSystemLanguages').mockReturnValue([language])
    await readyForUpdate()
    harness.updateState = { phase: 'ready', version: '0.1.7-alpha.2' }
    harness.dialog.showMessageBox.mockResolvedValueOnce({ response: 1 })
    await expect(harness.prepareUpdate()).resolves.toBe(false)
    const { message, detail, buttons } = harness.dialog.showMessageBox.mock.lastCall![0] as MessageBoxOptions
    await expect(JSON.stringify({ message, detail, buttons }, null, 2) + '\n')
      .toMatchFileSnapshot(`./expected/update-restart-${platform}-${language}.json`)
  })

  /** Like readyForUpdate, but past backend readiness and the workspace reveal, so the Host answers quit inspections. */
  async function readyWorkspace() {
    const host = await readyForUpdate()
    await Promise.resolve(invoke(DESKTOP_IPC.boot))
    return host
  }

  it('hides the workspace before intentional Host shutdown can look like reconnection', async () => {
    const host = await readyWorkspace()
    const window = harness.windows[0]!
    window.show.mockClear()
    window.focus.mockClear()
    harness.app.quit()
    // The quit inspects the Host before hiding; nothing to interrupt means no dialog.
    await vi.advanceTimersByTimeAsync(0)
    expect(host.inspectQuit).toHaveBeenCalledOnce()
    expect(harness.dialog.showMessageBox).not.toHaveBeenCalled()
    expect(window.hide).toHaveBeenCalledOnce()
    await host.stopping.promise
    harness.app.emit('second-instance')
    expect(window.show).not.toHaveBeenCalled()
    expect(window.focus).not.toHaveBeenCalled()
    host.exited.resolve()
    await harness.quitCompleted.promise
    expect(harness.trays[0]!.destroy).toHaveBeenCalledOnce()
  })

  it.each([['win32', 'tray.ico', 'tray'], ['linux', 'tray.png', 'taskbar']] as const)('routes closing on %s through the background confirmation and keeps the Host running', async (platform, icon, destination) => {
    vi.stubGlobal('process', { ...process, platform })
    const host = await readyWorkspace()
    const window = harness.windows[0]!
    expect(harness.trays).toHaveLength(1)
    expect(harness.trays[0]!.image).toEqual({ path: join('desktop-test-resources', icon) })
    expect(harness.backgroundNotice.markerPath).toBe(join(harness.app.getPath('userData'), 'background-close-confirmed'))
    expect(harness.backgroundNotice.destination).toBe(destination)
    window.show.mockClear()
    window.close()
    expect(window.isDestroyed()).toBe(false)
    // Linux minimizes instead: Electron 44.0.0 cannot show its tray icon there.
    expect(platform === 'linux' ? window.minimize : window.hide).toHaveBeenCalledOnce()
    expect(platform === 'linux' ? window.hide : window.minimize).not.toHaveBeenCalled()
    window.minimized = platform === 'linux'
    // Wayland never reports the minimized state, so Linux goes by focus.
    window.focused = false
    expect(host.stop).not.toHaveBeenCalled()
    expect(harness.app.quit).not.toHaveBeenCalled()
    expect(harness.backgroundNotice.close).toHaveBeenCalledOnce()
    window.hide.mockClear()
    harness.trays[0]!.emit('click')
    // Wayland cannot unminimize or raise a window, so Linux remaps it instead of restoring it.
    expect(window.restore).not.toHaveBeenCalled()
    expect(window.hide).toHaveBeenCalledTimes(platform === 'linux' ? 1 : 0)
    if (platform === 'linux') expect(window.hide.mock.invocationCallOrder[0]).toBeLessThan(window.show.mock.invocationCallOrder[0]!)
    expect(window.show).toHaveBeenCalledOnce()
    expect(window.focus).toHaveBeenCalled()
    // A window already in front is shown again without being remapped.
    window.focused = true
    window.hide.mockClear()
    harness.app.emit('second-instance')
    expect(window.show).toHaveBeenCalledTimes(2)
    expect(window.hide).not.toHaveBeenCalled()
    // Locale changes relabel the tray together with the application menu.
    const relabels = harness.trays[0]!.setContextMenu.mock.calls.length
    harness.ipcOn.mock.calls.find(call => call[0] === DESKTOP_IPC.localeChanged)![1]({ sender: window.webContents, senderFrame: window.webContents.mainFrame }, 'zh')
    expect(harness.trays[0]!.setContextMenu.mock.calls.length).toBe(relabels + 1)
  })

  it('keeps the workspace visible while acknowledgement is pending and ignores a destroyed window', async () => {
    await readyWorkspace()
    const window = harness.windows[0]!
    const approval = Promise.withResolvers<() => void>()
    harness.backgroundNotice.close.mockImplementationOnce((hide) => { approval.resolve(hide) })
    window.close()
    const hide = await approval.promise
    expect(window.hide).not.toHaveBeenCalled()
    window.destroy()
    hide()
    expect(window.hide).not.toHaveBeenCalled()
  })

  it('focuses an existing shell dialog instead of replacing it with a close confirmation', async () => {
    await readyWorkspace()
    const window = harness.windows[0]!
    harness.shellDialog.isOpen = true
    window.close()
    expect(harness.shellDialog.focus).toHaveBeenCalledOnce()
    expect(harness.backgroundNotice.close).not.toHaveBeenCalled()
    expect(window.hide).not.toHaveBeenCalled()
  })

  it('leaves macOS fullscreen before hiding on close and reopens the hidden window on activate', async () => {
    vi.stubGlobal('process', { ...process, platform: 'darwin', arch: 'arm64', resourcesPath: 'desktop-test-resources' })
    await readyWorkspace()
    const window = harness.windows[0]!
    expect(harness.trays).toHaveLength(0)
    window.fullscreen = true
    window.close()
    expect(window.setFullScreen).toHaveBeenCalledWith(false)
    expect(window.hide).toHaveBeenCalledOnce()
    expect(harness.backgroundNotice.close).not.toHaveBeenCalled()
    window.show.mockClear()
    harness.app.emit('activate', {}, false)
    expect(window.show).toHaveBeenCalledOnce()
    harness.app.emit('activate', {}, true)
    expect(window.show).toHaveBeenCalledOnce()
  })

  it('skips the confirmation during a macOS shutdown but asks again once a cancelled shutdown returns focus', async () => {
    vi.stubGlobal('process', { ...process, platform: 'darwin', arch: 'arm64', resourcesPath: 'desktop-test-resources' })
    const host = await readyWorkspace()
    const window = harness.windows[0]!
    host.inspectQuit.mockResolvedValue({ activeTasks: true, scheduledTasks: false })
    harness.dialog.showMessageBox.mockResolvedValue({ response: 1, checkboxChecked: false })
    harness.powerMonitor.emit('shutdown')
    // Another application vetoed the shutdown; the user comes back to the window.
    window.emit('focus')
    window.close()
    expect(window.isDestroyed()).toBe(false)
    harness.app.quit()
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.dialog.showMessageBox).toHaveBeenCalledOnce()
    expect(host.stop).not.toHaveBeenCalled()
    harness.powerMonitor.emit('shutdown')
    harness.app.quit()
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.dialog.showMessageBox).toHaveBeenCalledOnce()
    await host.stopping.promise
    host.exited.resolve()
    await harness.quitCompleted.promise
  })

  it('drops a pending confirmation when a bypassing quit starts first', async () => {
    harness.app.isPackaged = false
    const host = await readyWorkspace()
    const inspected = Promise.withResolvers<{ activeTasks: boolean; scheduledTasks: boolean }>()
    host.inspectQuit.mockReturnValue(inspected.promise)
    harness.app.quit()
    await vi.advanceTimersByTimeAsync(0)
    const restart = applicationMenuItems().find(item => item.label === en.restartAppHostMenu)!
    ;(restart as { click: () => void }).click()
    await vi.advanceTimersByTimeAsync(0)
    inspected.resolve({ activeTasks: true, scheduledTasks: true })
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.dialog.showMessageBox).not.toHaveBeenCalled()
    await host.stopping.promise
    host.exited.resolve()
    await harness.quitCompleted.promise
  })

  it('asks before quitting when the Host reports interruptible work and cancels without stopping anything', async () => {
    const host = await readyWorkspace()
    const window = harness.windows[0]!
    host.inspectQuit.mockResolvedValue({ activeTasks: true, scheduledTasks: true })
    harness.dialog.showMessageBox.mockResolvedValue({ response: 1, checkboxChecked: false })
    harness.app.quit()
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.dialog.showMessageBox).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      message: en.quitTitle, detail: en.quitActiveAndScheduledTasks, buttons: [en.quit, en.cancel], defaultId: 0, cancelId: 1,
    }))
    expect(window.hide).not.toHaveBeenCalled()
    expect(host.stop).not.toHaveBeenCalled()
    expect(harness.trays[0]!.destroy).not.toHaveBeenCalled()
    // A second request while the box is open joins it instead of stacking another.
    const pending = Promise.withResolvers<Electron.MessageBoxReturnValue>()
    harness.dialog.showMessageBox.mockReturnValue(pending.promise)
    harness.app.quit()
    await vi.advanceTimersByTimeAsync(0)
    harness.app.quit()
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.dialog.showMessageBox).toHaveBeenCalledTimes(2)
    expect(host.inspectQuit).toHaveBeenCalledTimes(2)
    pending.resolve({ response: 0, checkboxChecked: false })
    await vi.advanceTimersByTimeAsync(0)
    expect(window.hide).toHaveBeenCalledOnce()
    await host.stopping.promise
    host.exited.resolve()
    await harness.quitCompleted.promise
  })

  it('resumes startup when a quit requested before the workspace opens is cancelled', async () => {
    await import('../src/main.ts')
    await harness.preparing.promise
    // The startup window closes and its replacement closes while loading, so startup ends without a workspace.
    harness.windows[0]!.destroy()
    vi.spyOn(harness.FakeWindow.prototype, 'loadURL').mockImplementationOnce(async function (this: InstanceType<typeof harness.FakeWindow>) {
      this.destroy()
    })
    harness.prepared.resolve()
    await harness.hostStarted.promise
    const host = harness.hosts[0]!
    host.ready.resolve()
    await vi.waitFor(() => { expect(harness.windows[1]?.isDestroyed()).toBe(true) })
    await vi.advanceTimersByTimeAsync(0)
    host.inspectQuit.mockResolvedValue({ activeTasks: false, scheduledTasks: true })
    harness.dialog.showMessageBox.mockResolvedValue({ response: 1, checkboxChecked: false })
    harness.app.quit()
    await vi.waitFor(() => { expect(harness.windows[2]?.show).toHaveBeenCalledOnce() })
    expect(harness.dialog.showMessageBox).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ detail: en.quitScheduledTasks }))
    expect(harness.windows[2]!.urls).toEqual(['dsh-app://app/'])
    expect(harness.windows[2]!.webContents.send).toHaveBeenCalledWith('hallucodex:open', 'en')
    expect(host.stop).not.toHaveBeenCalled()
    host.inspectQuit.mockResolvedValue({ activeTasks: false, scheduledTasks: false })
  })

  it('warns about running tasks when the inspection fails and quits directly on session end or a development restart', async () => {
    harness.app.isPackaged = false
    const host = await readyWorkspace()
    host.inspectQuit.mockRejectedValue(new Error('desktop quit: inspection timed out'))
    harness.dialog.showMessageBox.mockResolvedValue({ response: 1, checkboxChecked: false })
    harness.app.quit()
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.dialog.showMessageBox).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ detail: en.quitActiveTasks }))
    expect(host.stop).not.toHaveBeenCalled()
    const restart = applicationMenuItems().find(item => item.label === en.restartAppHostMenu)!
    harness.dialog.showMessageBox.mockClear()
    ;(restart as { click: () => void }).click()
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.app.relaunch).toHaveBeenCalledOnce()
    expect(harness.dialog.showMessageBox).not.toHaveBeenCalled()
    await host.stopping.promise
    host.exited.resolve()
    await harness.quitCompleted.promise
  })

  it('does not block a Windows session end on the quit confirmation', async () => {
    const host = await readyWorkspace()
    const window = harness.windows[0]!
    host.inspectQuit.mockResolvedValue({ activeTasks: true, scheduledTasks: false })
    // The session-end question alone proves nothing: another application can veto it silently.
    window.emit('query-session-end', { reasons: ['shutdown'] })
    window.close()
    expect(window.isDestroyed()).toBe(false)
    expect(window.hide).toHaveBeenCalledOnce()
    window.emit('session-end', { reasons: ['shutdown'] })
    window.close()
    expect(window.isDestroyed()).toBe(true)
    // Electron follows the last closed window with window-all-closed, which quits on Windows.
    harness.app.quit()
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.dialog.showMessageBox).not.toHaveBeenCalled()
    expect(host.inspectQuit).not.toHaveBeenCalled()
    await host.stopping.promise
    host.exited.resolve()
    await harness.quitCompleted.promise
  })

  it('defers the downloaded-update confirmation until the hidden window is shown again', async () => {
    harness.dialog.showMessageBox.mockResolvedValue({ response: 0 })
    await readyWorkspace()
    const window = harness.windows[0]!
    harness.updateState = { phase: 'available', version: '1.0.1' }
    harness.updateDownload.mockImplementation(async () => { harness.updateState = { phase: 'ready', version: '1.0.1' }; return harness.updateState })
    window.close()
    window.visible = false
    const opened = invoke(DESKTOP_IPC.updatesOpen, 'app') as Promise<void>
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.updateDownload).toHaveBeenCalledWith('1.0.1')
    expect(harness.updateInstall).not.toHaveBeenCalled()
    window.visible = true
    window.emit('show')
    await opened
    expect(harness.updateInstall).toHaveBeenCalledWith('1.0.1')
  })

  it('finishes quitting when the native window is destroyed before its closed listener clears ownership', async () => {
    const host = await readyForUpdate()
    const window = harness.windows[0]!
    window.destroyed = true
    window.hide.mockImplementation(() => { throw new TypeError('Object has been destroyed') })
    expect(() => { harness.app.quit() }).not.toThrow()
    expect(window.hide).not.toHaveBeenCalled()
    await host.stopping.promise
    window.emit('closed')
    host.exited.resolve()
    await harness.quitCompleted.promise
  })

  it('shares the failed-check deadline across focus and resume, while explicit checks reset polling', async () => {
    vi.stubEnv('DSH_DESKTOP_UPDATE_CHECK_INTERVAL_MS', '1000')
    vi.stubEnv('DSH_DESKTOP_UPDATE_CHECK_MAX_BACKOFF_MS', '4000')
    vi.stubEnv('DSH_DESKTOP_UPDATE_CHECK_JITTER', '0')
    harness.updateCheck.mockResolvedValue({ phase: 'error', failedOperation: 'check', message: 'offline' })
    const host = await readyForUpdate()
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.updateCheck).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1999)
    harness.windows[0]!.emit('focus')
    harness.powerMonitor.emit('resume')
    expect(harness.updateCheck).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    expect(harness.updateCheck).toHaveBeenCalledTimes(2)
    harness.updateCheck.mockResolvedValue({ phase: 'idle' })
    await invoke(DESKTOP_IPC.updatesOpen, 'app')
    expect(harness.updateCheck).toHaveBeenLastCalledWith(true)
    await vi.advanceTimersByTimeAsync(1000)
    expect(harness.updateCheck).toHaveBeenCalledTimes(4)
    harness.app.quit()
    try {
      await host.stopping.promise
      await vi.advanceTimersByTimeAsync(10_000)
      harness.powerMonitor.emit('resume')
      expect(harness.updateCheck).toHaveBeenCalledTimes(4)
      expect(vi.getTimerCount()).toBe(0)
    } finally { host.exited.resolve(); await harness.quitCompleted.promise }
  })

  it('keeps one checking dialog open until the manual check settles, then reports the current version', async () => {
    withInAppUpdateSource()
    await readyForUpdate()
    const checked = Promise.withResolvers<DesktopUpdateState>()
    const checking = Promise.withResolvers<AbortSignal>()
    const requested = Promise.withResolvers<undefined>()
    harness.updateCheck.mockImplementationOnce(() => { requested.resolve(undefined); return checked.promise })
    harness.dialog.showMessageBox.mockImplementationOnce(({ signal }: { signal: AbortSignal }) => {
      checking.resolve(signal)
      return new Promise((resolve) => { signal.addEventListener('abort', () => { resolve({ response: 0 }) }, { once: true }) })
    }).mockImplementationOnce(() => {
      expect((harness.dialog.showMessageBox.mock.calls[0]![0] as { signal: AbortSignal }).signal.aborted).toBe(false)
      return Promise.resolve({ response: 0 })
    })
    const submenu = applicationMenuItems()
    const action = submenu.find(item => item.label === 'Check for Updates…')
    expect(action?.click).toBeTypeOf('function')
    // Electron supplies menu arguments that this callback does not consume.
    Reflect.apply(action!.click!, undefined, [])
    const prompt = Promise.resolve(invoke(DESKTOP_IPC.updatesOpen, 'app'))
    const signal = await checking.promise
    await requested.promise
    expect(signal.aborted).toBe(false)
    expect(harness.dialog.showMessageBox).toHaveBeenCalledTimes(1)
    expect(harness.updateCheck).toHaveBeenLastCalledWith(true)
    checked.resolve({ phase: 'idle' })
    await prompt
    expect(signal.aborted).toBe(true)
    expect(harness.dialog.showMessageBox).toHaveBeenLastCalledWith(expect.objectContaining({
      message: 'You’re up to date!', detail: 'Current version: 1.0.0',
    }))
  })

  it('announces the latest public GitHub release with its notes when the build cannot update in place', async () => {
    const fetchRelease = harness.netFetch
    await readyForUpdate()
    const check = applicationMenuItems().find(item => item.label === en.checkUpdatesMenu)?.click as () => void
    const page = 'https://github.com/AkumaRealLabs/hallucodex-desktop/releases/tag/hallucodex-v99.0.0'
    fetchRelease.mockResolvedValueOnce(Response.json({ tag_name: 'hallucodex-v99.0.0', html_url: page,
      body: '## 99.0.0\n- 新功能\n<!-- hallucodex:install-notes -->\n安装说明' }))
    harness.dialog.showMessageBox.mockResolvedValueOnce({ response: 0 })
    check()
    await vi.waitFor(() => { expect(harness.openExternal).toHaveBeenCalledWith(page) })
    expect(harness.dialog.showMessageBox).toHaveBeenLastCalledWith(expect.objectContaining({
      message: en.updateAvailable.replace('{version}', '99.0.0'), buttons: [en.updateOpenDownloadPage], releaseNotes: '99.0.0\n• 新功能' }))
    expect(fetchRelease).toHaveBeenLastCalledWith('https://api.github.com/repos/AkumaRealLabs/hallucodex-desktop/releases/latest', expect.anything())
    expect(harness.updateDownload).not.toHaveBeenCalled()

    fetchRelease.mockResolvedValueOnce(new Response('Not Found', { status: 404 }))
    harness.dialog.showMessageBox.mockResolvedValueOnce({ response: 0 })
    check()
    await vi.waitFor(() => {
      expect(harness.dialog.showMessageBox).toHaveBeenLastCalledWith(expect.objectContaining({ message: en.updateCurrent }))
    })

    fetchRelease.mockRejectedValueOnce(new Error('offline'))
    harness.dialog.showMessageBox.mockResolvedValueOnce({ response: 0 })
    check()
    await vi.waitFor(() => {
      expect(harness.dialog.showMessageBox).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'error', message: en.updateCheckNetworkFailed }))
    })
    expect(harness.openExternal).toHaveBeenCalledOnce()
  })

  it('reports a manual check failure without offering a download', async () => {
    await readyForUpdate()
    harness.updateCheck.mockResolvedValueOnce({ phase: 'error', failedOperation: 'check', message: 'Feed unavailable' })
    harness.dialog.showMessageBox.mockResolvedValue({ response: 0 })
    await invoke(DESKTOP_IPC.updatesOpen, 'app')
    expect(harness.dialog.showMessageBox).toHaveBeenCalledTimes(2)
    expect(harness.dialog.showMessageBox).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'error',
      message: 'Could not check for updates. Please try again later.', technicalDetails: 'Feed unavailable' }))
    expect(harness.updateDownload).not.toHaveBeenCalled()
  })

  it('reports a stale download confirmation as a download failure', async () => {
    harness.dialog.showMessageBox.mockResolvedValue({ response: 0 })
    await readyForUpdate()
    harness.updateCheck.mockResolvedValueOnce({ phase: 'available', version: '1.0.1-nightly.1' })
    harness.updateDownload.mockRejectedValueOnce(new Error('desktop update: download confirmation is stale'))
    await invoke(DESKTOP_IPC.updatesOpen, 'app')
    expect(harness.dialog.showMessageBox).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'error',
      message: en.updateDownloadFailed, technicalDetails: 'desktop update: download confirmation is stale' }))
  })

  it('downloads only after the changelog confirmation and opens installation confirmation after readiness', async () => {
    await readyForUpdate()
    harness.dialog.showMessageBox.mockResolvedValue({ response: 0 })
    harness.updateState = { phase: 'available', version: '1.0.1-nightly.1' }
    const downloading = Promise.withResolvers<DesktopUpdateState>()
    const started = Promise.withResolvers<undefined>()
    harness.updateDownload.mockImplementationOnce(async (version) => {
      harness.updateState = { phase: 'downloading', version }
      started.resolve(undefined)
      return downloading.promise
    })
    const action = invoke(DESKTOP_IPC.updatesOpen, 'app')
    await started.promise
    const repeated = invoke(DESKTOP_IPC.updatesOpen, 'app')
    expect(harness.dialog.showMessageBox).toHaveBeenCalledOnce()
    expect(harness.dialog.showMessageBox.mock.calls[0]?.at(-1)).toMatchObject({
      message: en.updateAvailable.replace('{version}', '1.0.1-nightly.1'), detail: en.updateDetail, buttons: [en.updateDownload] })
    expect(harness.updateDownload).toHaveBeenCalledExactlyOnceWith('1.0.1-nightly.1')
    expect(harness.updateInstall).not.toHaveBeenCalled()
    downloading.resolve({ phase: 'ready', version: '1.0.1-nightly.1' })
    await Promise.all([action, repeated])
    expect(harness.updateInstall).toHaveBeenCalledExactlyOnceWith('1.0.1-nightly.1')
    await harness.updateCheck()
    expect(harness.updateInstall).toHaveBeenCalledOnce()
  })

  it('shows the release notes with the download confirmation and downloads nothing when it is dismissed', async () => {
    await readyForUpdate()
    harness.updateState = { phase: 'available', version: '1.0.1' }
    harness.netFetch.mockResolvedValueOnce(Response.json({
      tag_name: 'hallucodex-v1.0.1', html_url: 'https://github.com/AkumaRealLabs/hallucodex-desktop/releases/tag/hallucodex-v1.0.1',
      body: '## 1.0.1\n- **修复**登录问题\n<!-- hallucodex:install-notes -->\n安装说明' }))
    harness.dialog.showMessageBox.mockResolvedValueOnce({ response: 1 })
    await invoke(DESKTOP_IPC.updatesOpen, 'app')
    expect(harness.netFetch).toHaveBeenCalledWith('https://api.github.com/repos/AkumaRealLabs/hallucodex-desktop/releases/tags/hallucodex-v1.0.1', expect.anything())
    expect(harness.dialog.showMessageBox.mock.calls.at(-1)?.at(-1)).toMatchObject({ releaseNotes: '1.0.1\n• 修复登录问题' })
    expect(harness.updateDownload).not.toHaveBeenCalled()
  })

  it('does not lock or stop tasks when restart confirmation is dismissed', async () => {
    const host = await readyForUpdate()
    harness.dialog.showMessageBox.mockResolvedValueOnce({ response: 1 })
    await expect(harness.prepareUpdate()).resolves.toBe(false)
    expect(host.updateTasks.mock.calls).toEqual([['inspect']])
    expect(host.stop).not.toHaveBeenCalled()
  })

  it('rechecks admission after approval and rejects work that started during confirmation', async () => {
    const host = await readyForUpdate()
    host.updateTasks.mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    harness.dialog.showMessageBox.mockResolvedValueOnce({ response: 0 })
    await expect(harness.prepareUpdate()).rejects.toThrow(/New tasks/u)
    expect(host.updateTasks.mock.calls).toEqual([['inspect'], ['lock'], ['unlock']])
    expect(host.stop).not.toHaveBeenCalled()
  })

  it('warns about active tasks and waits for a graceful Host exit after approval', async () => {
    const host = await readyForUpdate()
    host.updateTasks.mockResolvedValue(true)
    harness.dialog.showMessageBox.mockResolvedValueOnce({ response: 0 })
    const preparing = harness.prepareUpdate()
    await host.stopping.promise
    expect(harness.dialog.showMessageBox).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Tasks are still in progress', buttons: ['Stop tasks and update', 'Update later'],
    }))
    expect(host.stop).toHaveBeenCalledWith(true)
    host.exited.resolve()
    await expect(preparing).resolves.toBe(true)
  })

  it('unlocks admission without stopping the Host when request draining fails', async () => {
    const host = await readyForUpdate()
    host.updateTasks.mockResolvedValueOnce(false).mockRejectedValueOnce(new Error('task inspection timed out'))
    harness.dialog.showMessageBox.mockResolvedValueOnce({ response: 0 })
    await expect(harness.prepareUpdate()).rejects.toThrow('task inspection timed out')
    expect(host.updateTasks.mock.calls).toEqual([['inspect'], ['lock'], ['unlock']])
    expect(host.stop).not.toHaveBeenCalled()
  })

  it.each(['inspection', 'dialog'] as const)('closes the main window and cancels the pending quit %s when the installer quits Electron', async (pendingPhase) => {
    const host = await readyWorkspace()
    const inspected = Promise.withResolvers<{ activeTasks: boolean; scheduledTasks: boolean }>()
    const answered = Promise.withResolvers<Electron.MessageBoxReturnValue>()
    host.inspectQuit.mockReturnValue(inspected.promise)
    // Only the quit confirmation stays pending; the restart confirmation is approved.
    const quitPrompt = (options: unknown) => (options as { message?: string }).message === en.quitTitle
    harness.dialog.showMessageBox.mockImplementation((...args: unknown[]) =>
      quitPrompt(args.at(-1)) ? answered.promise : Promise.resolve({ response: 0, checkboxChecked: false }))
    const quitPrompts = () => harness.dialog.showMessageBox.mock.calls.filter(call => quitPrompt(call.at(-1)))
    harness.app.quit()
    await vi.advanceTimersByTimeAsync(0)
    expect(host.inspectQuit).toHaveBeenCalledOnce()
    if (pendingPhase === 'dialog') {
      inspected.resolve({ activeTasks: true, scheduledTasks: true })
      await vi.advanceTimersByTimeAsync(0)
      expect(quitPrompts()).toHaveLength(1)
    }
    const modal = harness.windows[0]!
    const preparing = harness.prepareUpdate()
    await host.stopping.promise
    host.exited.resolve()
    await expect(preparing).resolves.toBe(true)
    harness.closeWindowsOnQuit = true
    harness.app.quit()
    await harness.quitCompleted.promise
    expect(modal.isDestroyed()).toBe(true)
    expect(harness.app.quit).toHaveBeenCalledTimes(2)
    inspected.resolve({ activeTasks: true, scheduledTasks: true })
    answered.resolve({ response: 0, checkboxChecked: false })
    await vi.advanceTimersByTimeAsync(0)
    expect(quitPrompts()).toHaveLength(pendingPhase === 'dialog' ? 1 : 0)
    expect(harness.app.quit).toHaveBeenCalledTimes(2)
  })

  it('restores a cleanly stopped Host after installer failure', async () => {
    const host = await readyForUpdate()
    harness.dialog.showMessageBox.mockResolvedValueOnce({ response: 0 })
    const preparing = harness.prepareUpdate()
    await host.stopping.promise
    host.exited.resolve()
    await expect(preparing).resolves.toBe(true)
    harness.dialog.showMessageBox.mockResolvedValue({ response: 1 })
    const restarted = harness.nextHostStart()
    harness.publishUpdate({ phase: 'error', version: '1.0.1-nightly.1', failedOperation: 'install', message: 'Installer failed' })
    await restarted
    const replacement = harness.hosts[1]!
    replacement.url = 'http://127.0.0.1:3099/?token=replacement'
    const retry = harness.prepareUpdate()
    expect(replacement.updateTasks).not.toHaveBeenCalled()
    replacement.ready.resolve()
    await vi.waitFor(() => { expect(harness.windows[0]!.urls).toEqual(['dsh-app://app/', 'dsh-app://app/']) })
    await expect(Promise.resolve(invoke(DESKTOP_IPC.boot))).resolves.toEqual({ injections: [], streamBaseUrl: 'http://127.0.0.1:3099' })
    await expect(retry).resolves.toBe(false)
    expect(replacement.updateTasks.mock.calls).toEqual([['inspect']])
    expect(replacement.stop).not.toHaveBeenCalled()
  })

  it('restores a confirmed non-graceful exit without approving installation', async () => {
    const host = await readyForUpdate()
    harness.dialog.showMessageBox.mockResolvedValueOnce({ response: 0 })
    const preparing = harness.prepareUpdate()
    const rejected = expect(preparing).rejects.toMatchObject(new DesktopUpdatePreparationError('stop-failed', en.updateStopFailed, 'Task teardown failed after child exit'))
    await host.stopping.promise
    host.exited.reject(new DesktopHostUncleanExitError('Task teardown failed after child exit'))
    await rejected
    expect(host.updateTasks.mock.calls).toEqual([['inspect'], ['lock']])
    harness.dialog.showMessageBox.mockResolvedValue({ response: 1 })
    const restarted = harness.nextHostStart()
    harness.publishUpdate({ phase: 'error', version: '1.0.1-nightly.1', failedOperation: 'install', message: 'Task teardown failed' })
    await restarted
    const replacement = harness.hosts[1]!
    const retry = harness.prepareUpdate()
    expect(replacement.updateTasks).not.toHaveBeenCalled()
    replacement.ready.resolve()
    await vi.waitFor(() => { expect(harness.windows[0]!.urls).toEqual(['dsh-app://app/', 'dsh-app://app/']) })
    await expect(retry).resolves.toBe(false)
    expect(replacement.updateTasks.mock.calls).toEqual([['inspect']])
    expect(replacement.stop).not.toHaveBeenCalled()
  })

  it('does not replace a Host whose failed stop has not confirmed process exit', async () => {
    const host = await readyForUpdate()
    harness.dialog.showMessageBox.mockResolvedValueOnce({ response: 0 })
    const preparing = harness.prepareUpdate()
    const rejected = expect(preparing).rejects.toThrow('child did not exit')
    await host.stopping.promise
    host.exited.reject(new Error('child did not exit'))
    await rejected
    harness.dialog.showMessageBox.mockResolvedValue({ response: 1 })
    harness.publishUpdate({ phase: 'error', version: '1.0.1-nightly.1', failedOperation: 'install', message: 'child did not exit' })
    await expect(harness.prepareUpdate()).rejects.toThrow('Task status is unavailable')
    expect(harness.hosts).toHaveLength(1)
    expect(host.updateTasks.mock.calls).toEqual([['inspect'], ['lock'], ['unlock']])
  })

  it('reports replacement startup failure without authorizing installation or retrying automatically', async () => {
    const host = await readyForUpdate()
    harness.dialog.showMessageBox.mockResolvedValueOnce({ response: 0 })
    const preparing = harness.prepareUpdate()
    const rejected = expect(preparing).rejects.toMatchObject(new DesktopUpdatePreparationError('stop-failed', en.updateStopFailed, 'Task teardown failed after child exit'))
    await host.stopping.promise
    host.exited.reject(new DesktopHostUncleanExitError('Task teardown failed after child exit'))
    await rejected
    harness.dialog.showMessageBox.mockResolvedValue({ response: 1 })
    const restarted = harness.nextHostStart()
    harness.publishUpdate({ phase: 'error', version: '1.0.1-nightly.1', failedOperation: 'install', message: 'Task teardown failed' })
    await restarted
    const replacement = harness.hosts[1]!
    harness.dialog.showMessageBox.mockImplementation(() => { harness.dialogShown.resolve(); return new Promise(() => {}) })
    replacement.ready.reject(new Error('replacement startup failed'))
    replacement.exited.resolve()
    await harness.dialogShown.promise
    expect(harness.dialog.showMessageBox.mock.calls.some(call =>
      (call.at(-1) as MessageBoxOptions).detail?.includes('replacement startup failed'))).toBe(true)
    await expect(harness.prepareUpdate()).rejects.toThrow('replacement startup failed')
    expect(harness.hosts).toHaveLength(2)
  })

  it('opens fatal recovery when the replacement page cannot reload', async () => {
    const host = await readyForUpdate()
    harness.dialog.showMessageBox.mockResolvedValueOnce({ response: 0 })
    const preparing = harness.prepareUpdate()
    await host.stopping.promise
    host.exited.resolve()
    await expect(preparing).resolves.toBe(true)
    const window = harness.windows[0]!
    vi.spyOn(window, 'loadURL').mockRejectedValueOnce(new Error('replacement page failed to load'))
    harness.dialog.showMessageBox.mockImplementation((options: MessageBoxOptions) => {
      if (options.detail?.includes('replacement page failed to load')) {
        harness.dialogShown.resolve()
        return new Promise(() => {})
      }
      return Promise.resolve({ response: 1 })
    })
    const restarted = harness.nextHostStart()
    harness.publishUpdate({ phase: 'error', version: '1.0.1-nightly.1', failedOperation: 'install', message: 'Installer failed' })
    await restarted
    harness.hosts[1]!.ready.resolve()
    await harness.dialogShown.promise
    expect(harness.dialog.showMessageBox.mock.calls.some(call =>
      (call.at(-1) as MessageBoxOptions).detail?.includes('replacement page failed to load'))).toBe(true)
  })

  it('reports a window construction failure without requiring a window', async () => {
    const shown = Promise.withResolvers<undefined>()
    harness.dialog.showMessageBox.mockImplementation(() => { shown.resolve(undefined); return new Promise(() => {}) })
    harness.failWindow(new Error('window creation failed'))
    await import('../src/main.ts')
    await shown.promise
    expect(harness.windows).toHaveLength(0)
    expect((harness.dialog.showMessageBox.mock.calls[0]![0] as MessageBoxOptions).detail).toContain('window creation failed')
  })

  it('accepts Web fatal reports only from the primary application frame', async () => {
    await import('../src/main.ts')
    await harness.preparing.promise
    const window = harness.windows[0]!
    const frame = { url: 'dsh-app://app/' }
    Object.assign(window.webContents, { mainFrame: frame })
    const handler = harness.handlers.get(DESKTOP_IPC.bootFailed)! as (event: unknown, message: unknown) => void
    const event = { sender: window.webContents, senderFrame: frame }
    expect(() => { handler({ ...event, senderFrame: { url: 'https://other.example/' } }, 'untrusted') }).toThrow('unowned renderer')
    expect(() => { handler({ ...event, senderFrame: { ...frame } }, 'subframe') }).toThrow('non-primary frame')
    expect(() => { handler(event, {}) }).toThrow('must be text')
    expect(harness.dialog.showMessageBox).not.toHaveBeenCalled()
    handler(event, 'client mount failed')
    await harness.dialogShown.promise
    expect((harness.dialog.showMessageBox.mock.calls[0]![0] as MessageBoxOptions).detail).toContain('client mount failed')
    expect((harness.dialog.showMessageBox.mock.calls[0]![0] as MessageBoxOptions).detail).toContain('desktop-test-logs/crash-test.log')
    expect(writeCrashReport).toHaveBeenCalledWith('desktop-test-logs', expect.objectContaining({ source: 'web-boot', phase: 'startup' }))
    expect(window.urls).toEqual(['dsh-app://app/'])
  })

  it('ignores subresource failures and navigation cancellation but reports a failed main document', async () => {
    await import('../src/main.ts')
    await harness.preparing.promise
    const window = harness.windows[0]!
    window.webContents.emit('did-fail-load', {}, -2, 'failed', 'dsh-app://app/image.png', false)
    window.webContents.emit('did-fail-load', {}, -3, 'aborted', 'dsh-app://app/', true)
    expect(harness.dialog.showMessageBox).not.toHaveBeenCalled()
    window.webContents.emit('did-fail-load', {}, -2, 'failed', 'dsh-app://app/', true)
    await harness.dialogShown.promise
    expect((harness.dialog.showMessageBox.mock.calls[0]![0] as MessageBoxOptions).detail).toContain('Desktop page failed to load')
    expect(writeCrashReport).toHaveBeenCalledWith('desktop-test-logs', expect.objectContaining({ source: 'renderer' }))
  })

  it('offers all recovery choices when resources fail before the Host starts', async () => {
    await import('../src/main.ts')
    await harness.preparing.promise
    harness.prepared.reject(new Error('runtime resources missing'))
    await harness.dialogShown.promise
    expect((harness.dialog.showMessageBox.mock.calls[0]![0] as MessageBoxOptions).detail).toContain('runtime resources missing')
    expect((harness.dialog.showMessageBox.mock.calls[0]![0] as MessageBoxOptions).buttons).toEqual(['Exit', 'Restart', 'Disable third-party plugins, back up profile patch, and restart'])
    expect(harness.windows[0]!.urls).toEqual(['dsh-app://app/'])
  })

  it.each(['preload', 'renderer'])('retains the document after a fatal %s failure and reports only the first error', async (kind) => {
    await import('../src/main.ts')
    await harness.preparing.promise
    const window = harness.windows[0]!
    if (kind === 'preload') window.webContents.emit('preload-error', {}, 'preload-app.cjs', new Error('preload unavailable'))
    else window.webContents.emit('render-process-gone', {}, { reason: 'crashed' })
    window.webContents.emit('preload-error', {}, 'preload-app.cjs', new Error('secondary failure'))
    harness.prepared.reject(new Error('backend also failed'))
    await harness.dialogShown.promise
    expect(harness.dialog.showMessageBox).toHaveBeenCalledOnce()
    expect((harness.dialog.showMessageBox.mock.calls[0]![0] as MessageBoxOptions).detail).not.toContain('secondary failure')
    expect(window.urls).toEqual(['dsh-app://app/'])
  })

  it('ignores clean renderer exits and exits of a destroyed window', async () => {
    await import('../src/main.ts')
    await harness.preparing.promise
    const window = harness.windows[0]!
    window.webContents.emit('render-process-gone', {}, { reason: 'clean-exit' })
    window.destroy()
    window.webContents.emit('render-process-gone', {}, { reason: 'crashed' })
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.dialog.showMessageBox).not.toHaveBeenCalled()
  })

  it('reports a rejected document load without navigating to a recovery page', async () => {
    const shown = Promise.withResolvers<undefined>()
    harness.dialog.showMessageBox.mockImplementation(() => { shown.resolve(undefined); return new Promise(() => {}) })
    vi.spyOn(harness.FakeWindow.prototype, 'loadURL').mockRejectedValueOnce(new Error('document missing'))
    await import('../src/main.ts')
    await shown.promise
    expect(harness.dialog.showMessageBox).toHaveBeenCalledOnce()
    expect((harness.dialog.showMessageBox.mock.calls[0]![0] as MessageBoxOptions).detail).toContain('document missing')
    expect(harness.hosts).toHaveLength(0)
  })

  it('writes the Host\'s own diagnostic into a startup-phase crash report when the Host reports a fatal error before ready', async () => {
    await import('../src/main.ts')
    await harness.preparing.promise
    harness.prepared.resolve()
    await harness.hostStarted.promise
    const host = harness.hosts[0]!
    const diagnostic = "Error: profile has no cordis.yml\n    at loadProfileDirectory (app-boot/lib/index.js:12:3) {\n  code: 'ENOENT',\n  path: '/profiles/desktop/cordis.yml'\n}"
    // DesktopHostProcess.fail() rejects start() and calls onFailure with the same error object.
    const failure = new DesktopHostFatalError('profile has no cordis.yml', diagnostic)
    host.onFailure!(failure)
    host.ready.reject(failure)
    await host.stopping.promise
    host.exited.resolve()
    await harness.dialogShown.promise
    const [directory, report] = vi.mocked(writeCrashReport).mock.calls[0]!
    expect(directory).toBe('desktop-test-logs')
    expect(report.source).toBe('host')
    expect(report.phase).toBe('startup')
    expect(report.error).toBeInstanceOf(DesktopHostFatalError)
    expect(report.hostDiagnostic).toBe(diagnostic)
    expect((harness.dialog.showMessageBox.mock.calls[0]![0] as MessageBoxOptions).detail).toContain('profile has no cordis.yml')
  })

  it('attaches the primary window\'s error-level console output to a running-phase Host crash report', async () => {
    harness.dialog.showMessageBox.mockResolvedValue({ response: 0, checkboxChecked: false })
    await import('../src/main.ts')
    await harness.preparing.promise
    harness.prepared.resolve()
    await harness.hostStarted.promise
    const host = harness.hosts[0]!
    host.ready.resolve()
    await Promise.resolve(invoke(DESKTOP_IPC.boot))
    const window = harness.windows[0]!
    window.webContents.emit('console-message', { level: 'info', message: 'boot ok', sourceId: 'dsh-app://app/assets/entry.js', lineNumber: 1 })
    window.webContents.emit('console-message', {
      level: 'error', message: 'client-modules: bundle script plugins/??a/client.js&rev=1 failed to load',
      sourceId: 'dsh-app://app/assets/entry.js', lineNumber: 12,
    })
    host.onFailure!(new Error('dsh desktop host exited with 1: fatal uncaught exception: ENOENT'))
    await host.stopping.promise
    expect(writeCrashReport).toHaveBeenCalledOnce()
    const [directory, report] = vi.mocked(writeCrashReport).mock.calls[0]!
    expect(directory).toBe('desktop-test-logs')
    expect(report.source).toBe('host')
    expect(report.phase).toBe('running')
    expect(report.error).toBeInstanceOf(Error)
    expect((report.error as Error).message).toContain('fatal uncaught exception: ENOENT')
    expect(report.rendererConsole).toEqual(['dsh-app://app/assets/entry.js:12 client-modules: bundle script plugins/??a/client.js&rev=1 failed to load'])
    expect(report.app).toMatchObject({ name: 'Desktop test', version: '1.0.0', platform: process.platform, locale: 'en' })
    expect(report.time).toBeInstanceOf(Date)
    host.exited.resolve()
    await harness.quitCompleted.promise
  })

  it.each([0, 1, 2])('waits for Host exit before recovery action %s', async (response) => {
    harness.dialog.showMessageBox.mockResolvedValue({ response, checkboxChecked: false })
    await import('../src/main.ts')
    await harness.preparing.promise
    harness.prepared.resolve()
    await harness.hostStarted.promise
    const host = harness.hosts[0]!
    host.ready.resolve()
    await Promise.resolve(invoke(DESKTOP_IPC.boot))
    host.onFailure!(new Error('backend exited'))
    await host.stopping.promise
    expect(harness.app.relaunch).not.toHaveBeenCalled()
    expect(harness.disableAllPlugins).not.toHaveBeenCalled()
    host.exited.resolve()
    await harness.quitCompleted.promise
    expect(harness.app.relaunch).toHaveBeenCalledTimes(response === 0 ? 0 : 1)
    expect(harness.disableAllPlugins).toHaveBeenCalledTimes(response === 2 ? 1 : 0)
    if (response === 2) {
      expect(console.info).toHaveBeenCalledWith('Desktop profile recovery completed:', {
        profilePatchBackup: 'desktop-test-profile/cordis.patch.yml.bak-1789555200000', homePatch: 'unchanged',
      })
    } else {
      expect(console.info).not.toHaveBeenCalled()
    }
    expect(harness.dialog.showMessageBox).toHaveBeenCalledOnce()
    expect(harness.windows[0]!.urls).toEqual(['dsh-app://app/'])
  })

  it('creates the Host only after the login-shell read and ends the read on quit', async () => {
    let finishRead!: () => void
    const read = new Promise<void>((resolve) => { finishRead = resolve })
    harness.loginShell.mockImplementation(async (base) => { await read; return harness.readLoginShell(base) })
    await import('../src/main.ts')
    await harness.preparing.promise
    const boot = invoke(DESKTOP_IPC.boot)
    harness.prepared.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.hosts).toHaveLength(0)
    finishRead()
    await harness.hostStarted.promise
    expect(harness.hosts[0]!.environment?.DSH_TEST_LOGIN_SHELL).toBe('login')
    harness.hosts[0]!.ready.resolve()
    await Promise.all([boot, harness.navigated.promise])
    const { signal } = harness.loginShell.mock.calls[0]![2]
    expect(signal?.aborted).toBe(false)
    harness.app.emit('will-quit')
    expect(signal?.aborted).toBe(true)
  })

  it('prepares recovery offscreen and starts one Host before choosing the first visible window', async () => {
    await import('../src/main.ts')
    await harness.preparing.promise
    expect(harness.windows).toHaveLength(1)
    const window = harness.windows[0]!
    expect(window.options.show).toBe(false)
    expect(window.show).not.toHaveBeenCalled()
    expect(window.urls).toEqual(['dsh-app://app/'])
    expect(harness.hosts).toHaveLength(0)
    const retry = invoke(DESKTOP_IPC.boot)
    const secondRetry = invoke(DESKTOP_IPC.boot)
    harness.prepared.resolve()
    await harness.hostStarted.promise
    expect(harness.hosts).toHaveLength(1)
    expect(window.urls).toEqual(['dsh-app://app/'])
    harness.hosts[0]!.ready.resolve()
    await Promise.all([retry, secondRetry, harness.navigated.promise])
    expect(harness.applyRelease).toHaveBeenCalledTimes(1)
    expect(harness.hosts[0]).toMatchObject({
      node: process.execPath,
      runtime: join(harness.app.getAppPath(), 'dsh'),
      primaryRuntime: join('desktop-test-resources', 'runtime', 'primary-runtime'),
      profile: 'desktop-test-profile',
    })
    expect(harness.hosts[0]!.environment).not.toBe(process.env)
    expect(harness.hosts[0]!.environment?.DSH_CLIENT_VERSION).toBe('1.2.3')
    expect(harness.hosts[0]!.environment?.DSH_TEST_LOGIN_SHELL).toBe('login')
    expect(console.warn).toHaveBeenCalledWith('desktop login shell: /account/shell failed (timeout)')
    expect(harness.hosts[0]!.start).toHaveBeenCalledTimes(1)
    expect(harness.windows).toHaveLength(1)
    expect(window.urls).toEqual(['dsh-app://app/'])
  })

  it('prepares an independent plugin profile for the unpackaged Host', async () => {
    harness.app.isPackaged = false
    vi.stubEnv('DSH_DESKTOP_DSH_DIR', undefined)
    await import('../src/main.ts')
    await harness.preparing.promise
    harness.prepared.resolve()
    await harness.hostStarted.promise
    const project = join(harness.app.getAppPath(), '.desktop-build', 'development', 'project')
    expect(harness.hosts[0]).toMatchObject({ node: process.execPath, runtime: project,
      primaryRuntime: 'test-primary-runtime', profile: 'desktop-test-profile' })
    expect(harness.applyRelease).toHaveBeenCalledOnce()
    harness.hosts[0]!.ready.resolve()
    await harness.navigated.promise
    expect(harness.dialog.showErrorBox).not.toHaveBeenCalled()
  })

  it('fails an unpackaged launch that receives no primary runtime directory', async () => {
    harness.app.isPackaged = false
    vi.stubEnv('DSH_DESKTOP_PRIMARY_RUNTIME_DIR', undefined)
    await import('../src/main.ts')
    await harness.dialogShown.promise
    const options = harness.dialog.showMessageBox.mock.calls[0]![0] as MessageBoxOptions
    expect(options.detail).toContain('DSH_DESKTOP_PRIMARY_RUNTIME_DIR is required for an unpackaged launch')
    expect(harness.hosts).toHaveLength(0)
  })

  it('keeps startup errors in the existing window without a retry handler', async () => {
    await import('../src/main.ts')
    await harness.preparing.promise
    harness.prepared.resolve()
    await harness.hostStarted.promise
    const first = harness.hosts[0]!
    first.exited.resolve()
    first.ready.reject(new Error('plugin composition failed'))
    await harness.dialogShown.promise
    expect(harness.windows[0]!.urls).toEqual(['dsh-app://app/'])
    expect(harness.dialog.showMessageBox).toHaveBeenCalledOnce()
    expect(harness.handlers.has('dsh-desktop:backend-retry')).toBe(false)
    expect(harness.hosts).toHaveLength(1)
  })

  it('waits for a pending child to exit on quit without late window navigation', async () => {
    await import('../src/main.ts')
    await harness.preparing.promise
    harness.prepared.resolve()
    await harness.hostStarted.promise
    const window = harness.windows[0]!
    const host = harness.hosts[0]!
    host.stop.mockImplementation(() => { host.stopping.resolve(); return host.exited.promise })
    window.close()
    harness.app.quit()
    await host.stopping.promise
    expect(harness.app.quit).toHaveBeenCalledTimes(1)
    host.ready.resolve()
    host.exited.resolve()
    await harness.quitCompleted.promise
    expect(host.stop).toHaveBeenCalledTimes(1)
    expect(window.urls).toEqual(['dsh-app://app/'])
    expect(harness.windows).toHaveLength(1)
  })
})
