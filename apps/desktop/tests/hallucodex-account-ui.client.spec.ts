// @vitest-environment jsdom
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { createHalluCodexAccountUi, halluCodexAccountCopy } from '../src/hallucodex/account-ui.ts'
import type { GroupSelectionResult, HalluCodexDesktopSnapshot } from '../src/hallucodex/runtime.ts'

const serverOrigin = 'https://api.hallucodex.com'
const signedOut: HalluCodexDesktopSnapshot = { account: { status: 'signed-out' }, serverOrigin, catalogStatus: 'unavailable' }
const signedIn: HalluCodexDesktopSnapshot = {
  account: { status: 'signed-in', profile: { id: 'fixture-id', displayName: '<img src=x onerror=alert(1)>' }, group: 'discount', allowedGroups: ['discount'], canSelectGroup: false },
  serverOrigin, walletStatus: 'ready', wallet: { remaining: '900', accountUsage: '100', deviceUsage: '40', deviceLimit: '500', unit: 'quota' },
  catalogStatus: 'ready', catalog: { group: 'discount', groups: [], models: [
    { id: 'ready-model', endpoints: ['/v1/responses'], contextWindow: 8192, maxOutputTokens: 2048 },
    { id: 'unknown-capacity', endpoints: ['/v1/responses'] },
  ] },
}
const disposers: (() => void)[] = []
afterEach(() => { while (disposers.length) disposers.pop()?.(); document.body.replaceChildren(); vi.restoreAllMocks() })

function fixture(initial = signedOut, language = 'en') {
  let latest = initial
  let listener: (state: HalluCodexDesktopSnapshot) => void = () => {}
  const unsubscribe = vi.fn()
  const operations = {
    state: vi.fn(async () => latest),
    start: vi.fn<() => Promise<HalluCodexDesktopSnapshot>>(async () => ({ account: { status: 'signing-in' as const, expiresAt: 100 }, serverOrigin, catalogStatus: 'unavailable' as const })),
    setServer: vi.fn<(origin: string) => Promise<HalluCodexDesktopSnapshot>>(async origin => ({ ...signedOut, serverOrigin: origin })),
    openPage: vi.fn(async (_page: 'wallet' | 'usage' | 'devices') => {}),
    cancel: vi.fn(async () => signedOut), signOut: vi.fn(async () => ({ remoteRevoked: true })),
    refresh: vi.fn(async () => {}), refreshWallet: vi.fn(async () => {}), refreshCatalog: vi.fn(async () => {}),
    restore: vi.fn(async () => latest),
    selectGroup: vi.fn<(group: string) => Promise<GroupSelectionResult>>(async () => 'selected'),
    subscribe: (callback: typeof listener) => { listener = callback; return unsubscribe },
  }
  const ui = createHalluCodexAccountUi(document, operations, halluCodexAccountCopy(language))
  disposers.push(() => { ui.dispose() })
  const dialog = document.querySelector('dialog')!
  dialog.showModal = () => { dialog.open = true }
  dialog.close = () => { dialog.open = false; dialog.dispatchEvent(new Event('close')) }
  return { ui, operations, dialog, unsubscribe,
    publish: (snapshot: HalluCodexDesktopSnapshot) => { latest = snapshot; listener(snapshot) },
  }
}

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')]
    .find(candidate => candidate.textContent === label || candidate.getAttribute('aria-label') === label)
  if (!found) throw new Error('missing button')
  return found
}

function row(label: string): string | null | undefined {
  const term = [...document.querySelectorAll('dt')].find(candidate => candidate.textContent === label)
  return term?.nextElementSibling?.textContent
}

describe('native HalluCodex account UI', () => {
  it('renders safe identity and concrete group without interpreting account HTML', async () => {
    const { ui, dialog, operations } = fixture(signedIn)
    await ui.open()
    expect(dialog.open).toBe(true)
    expect(dialog.textContent).toContain('<img src=x onerror=alert(1)>')
    expect(dialog.querySelector('img')).toBeNull()
    expect(row('Group')).toBe('discount')
    expect(row('Available models')).toBe('1')
    expect(row('This device used')).toBe('40')
    expect(row('Device limit')).toBe('500')
    expect(row('Server')).toBe(serverOrigin)
    expect(dialog.querySelector('form')?.hidden).toBe(true)
    expect(document.head.querySelector('style')?.textContent).toContain('--dsw-alias-label-primary')
    expect(dialog.querySelector('select')?.hidden).toBe(true)
    button('Wallet & top-up').click()
    button('Usage').click()
    button('Security & devices').click()
    expect(operations.openPage.mock.calls).toEqual([['wallet'], ['usage'], ['devices']])
  })
  it('re-reads usage each time a signed-in dialog opens, never while signed out', async () => {
    const signedInView = fixture(signedIn)
    await signedInView.ui.open()
    await signedInView.ui.open()
    expect(signedInView.operations.refreshWallet).toHaveBeenCalledTimes(2)
    signedInView.ui.dispose()
    document.body.replaceChildren()
    const signedOutView = fixture()
    await signedOutView.ui.open()
    expect(signedOutView.operations.refreshWallet).not.toHaveBeenCalled()
  })

  it('cancels a pending login on Close and ignores the late start result', async () => {
    const { ui, operations, dialog } = fixture()
    const pending = Promise.withResolvers<HalluCodexDesktopSnapshot>()
    operations.start.mockImplementationOnce(() => pending.promise)
    await ui.open()
    button('Sign in using browser').click()
    button('Sign in using browser').click()
    expect(operations.start).toHaveBeenCalledOnce()
    button('Close').click()
    await vi.waitFor(() => { expect(operations.cancel).toHaveBeenCalledOnce() })
    pending.resolve(signedIn)
    await pending.promise
    await vi.waitFor(() => { expect(dialog.textContent).toContain('Not signed in') })
    expect(dialog.open).toBe(false)
    await ui.open()
    expect(dialog.textContent).not.toContain('fixture-id')
  })
  it('discloses incomplete remote revocation while remaining locally signed out', async () => {
    const { ui, operations, publish, dialog } = fixture(signedIn)
    operations.signOut.mockImplementation(async () => { publish(signedOut); return { remoteRevoked: false } })
    await ui.open(); button('Sign out').click()
    await vi.waitFor(() => { expect(dialog.textContent).toContain('Remote revocation was not confirmed') })
    expect(dialog.textContent).toContain('Not signed in')
  })
  it('provides actionable keyring failure without a plaintext fallback', async () => {
    const { ui, dialog } = fixture({ account: { status: 'signed-out', errorCode: 'secure_storage_unavailable' }, serverOrigin, catalogStatus: 'unavailable' })
    await ui.open()
    expect(dialog.textContent).toContain('Enable your operating-system keyring')
    expect(dialog.querySelector('input[type="password"]')).toBeNull()
    expect(halluCodexAccountCopy('zh-CN').signIn).toBe('在浏览器中登录')
  })
  it('does not reopen a disposed view when an earlier state read resolves', async () => {
    const { ui, operations, dialog, unsubscribe } = fixture()
    const pending = Promise.withResolvers<HalluCodexDesktopSnapshot>()
    operations.state.mockImplementationOnce(() => pending.promise)
    const opening = ui.open()
    ui.dispose()
    pending.resolve(signedIn)
    await expect(opening).rejects.toThrow()
    expect(dialog.isConnected).toBe(false)
    expect(unsubscribe).toHaveBeenCalledOnce()
  })
  it('keeps the server address behind a small link and warns about plain HTTP', async () => {
    const { ui, dialog, operations, publish } = fixture()
    await ui.open()
    const form = dialog.querySelector('form')!
    expect(form.hidden).toBe(true)
    button('Use a custom server').click()
    expect(form.hidden).toBe(false)
    const input = dialog.querySelector('input')!
    expect(input.value).toBe(serverOrigin)
    input.value = 'http://localhost:3000'
    button('Switch').click()
    await vi.waitFor(() => { expect(operations.setServer).toHaveBeenCalledWith('http://localhost:3000') })
    await vi.waitFor(() => { expect(form.hidden).toBe(true) })
    expect(dialog.textContent).toContain('Server: http://localhost:3000')
    expect(dialog.textContent).toContain('This is an HTTP address')
    operations.setServer.mockRejectedValueOnce(new Error('hallucodex: invalid server address'))
    button('Change').click()
    input.value = 'ftp://example.com'
    button('Switch').click()
    await vi.waitFor(() => { expect(dialog.textContent).toContain('Invalid server address') })
    publish({ ...signedOut, serverOrigin: 'http://localhost:3000' })
    button('Use HalluCodex service').click()
    await vi.waitFor(() => { expect(operations.setServer).toHaveBeenLastCalledWith(serverOrigin) })
  })
  it('switches groups in the dialog when the server allows it', async () => {
    const groups = [{ name: 'discount', description: '', ratio: 1 }, { name: 'premium', description: 'Fast', ratio: 2 }]
    const selectable = (group: string): HalluCodexDesktopSnapshot => ({
      ...signedIn, account: { ...signedIn.account, group, allowedGroups: ['discount', 'premium'], canSelectGroup: true } as HalluCodexDesktopSnapshot['account'],
      catalog: { group, groups, models: [] },
    })
    const { ui, dialog, operations, publish } = fixture(selectable('discount'))
    await ui.open()
    const select = dialog.querySelector('select')!
    expect(select.hidden).toBe(false)
    expect(select.getAttribute('aria-label')).toBe('Selected group')
    expect(select.value).toBe('discount')
    expect([...select.options].map(option => option.textContent)).toEqual(['discount', 'premium'])
    expect(dialog.querySelector('.hcx-group')?.textContent).toContain('ratio: 1')
    expect(dialog.textContent).toContain('Select a group to preview its rate and description')
    const pending = Promise.withResolvers<GroupSelectionResult>()
    operations.selectGroup.mockImplementationOnce(() => pending.promise)
    select.value = 'premium'
    select.dispatchEvent(new Event('change'))
    expect(operations.selectGroup).not.toHaveBeenCalled()
    expect(dialog.querySelector('.hcx-group')?.textContent).toContain('ratio: 2Fast')
    expect(row('Group')).toBe('discount')
    button('Switch group').click()
    expect(operations.selectGroup).toHaveBeenCalledWith('premium')
    expect(dialog.textContent).toContain('Switching to premium')
    // The catalog reloads during the move; the list stays, showing the pending choice.
    publish({ account: selectable('discount').account, serverOrigin, catalogStatus: 'loading' })
    expect(select.hidden).toBe(false)
    expect(select.disabled).toBe(true)
    expect(select.value).toBe('premium')
    publish(selectable('premium'))
    pending.resolve('selected')
    await vi.waitFor(() => { expect(select.disabled).toBe(false) })
    expect(select.value).toBe('premium')
    expect(dialog.textContent).toContain('Switched to premium')
    operations.selectGroup.mockResolvedValueOnce('group_unavailable')
    select.value = 'discount'
    select.dispatchEvent(new Event('change'))
    button('Switch group').click()
    await vi.waitFor(() => { expect(dialog.textContent).toContain('That group is no longer available.') })
    expect(select.value).toBe('premium')
  })
  it('keeps the group fixed on a server without group selection', async () => {
    const groups = [{ name: 'discount', description: '', ratio: 1 }, { name: 'premium', description: '', ratio: 2 }]
    const { ui, dialog } = fixture({ ...signedIn, catalog: { group: 'discount', groups, models: [] } })
    await ui.open()
    expect(dialog.querySelector('select')?.hidden).toBe(true)
    expect(row('Group')).toContain('discount')
    expect(dialog.textContent).toContain('This server does not support switching groups in the app.')
  })
  it('shows wallet figures in the site currency, or raw quota without its settings', async () => {
    const wallet = { remaining: '6172839', accountUsage: '500000', deviceUsage: '1234', deviceLimit: '5000000', unit: 'quota' as const }
    const { ui, publish } = fixture({ ...signedIn, wallet, quotaDisplay: { type: 'USD', quotaPerUnit: 500000, rate: 1, symbol: '¤' } })
    await ui.open()
    expect(row('Wallet balance')).toBe('$12.35')
    expect(row('Account usage')).toBe('$1')
    expect(row('This device used')).toBe('$0.0025')
    expect(row('Device limit')).toBe('$10')
    publish({ ...signedIn, wallet })
    expect(row('Wallet balance (quota)')).toBe('6172839')
  })
  it.each(['en', 'zh-CN'])('shows stale balance and operation-specific recovery in %s', async (language) => {
    const copy = halluCodexAccountCopy(language)
    const updated = Date.UTC(2026, 9, 7, 4, 5, 6)
    const { ui, publish, dialog, operations } = fixture({ ...signedIn, walletUpdatedAt: updated }, language)
    await ui.open()
    publish({ ...signedIn, walletUpdatedAt: updated, walletStatus: 'loading' })
    expect(row(copy.walletQuota)).toBe('900')
    expect(dialog.textContent).toContain(copy.refreshing)
    expect(button(copy.refreshWallet).disabled).toBe(true)
    publish({ ...signedIn, walletUpdatedAt: updated, walletStatus: 'failed', walletError: 'network_error',
      catalogStatus: 'unavailable', catalogError: 'catalog_unavailable' })
    expect(row(copy.walletQuota)).toBe('900')
    expect(dialog.textContent).toContain(copy.staleWallet)
    expect(dialog.textContent).toContain(new Intl.DateTimeFormat(copy.numberLocale, { dateStyle: 'short', timeStyle: 'medium' }).format(updated))
    expect({ balance: row(copy.walletQuota), messages: [...dialog.querySelectorAll('.hcx-feedback [role="status"]')].map(node => node.textContent),
      retries: [button(copy.refreshWallet).textContent, button(copy.retryCatalog).textContent] }).toMatchSnapshot()
    button(copy.retryCatalog).click()
    await vi.waitFor(() => { expect(operations.refreshCatalog).toHaveBeenCalledOnce() })
    await vi.waitFor(() => { expect(button(copy.refreshWallet).disabled).toBe(false) })
    button(copy.refreshWallet).click()
    await vi.waitFor(() => { expect(operations.refreshWallet).toHaveBeenCalledTimes(2) })
    expect(operations.refresh).not.toHaveBeenCalled()
  })

  it('clears resolved capability errors and removes no-longer-granted group choices before discovery finishes', async () => {
    if (signedIn.account.status !== 'signed-in') throw new Error('fixture must be signed in')
    const account = { ...signedIn.account, canSelectGroup: true, allowedGroups: ['discount', 'premium'] }
    const catalog = { group: 'discount', models: [], groups: [
      { name: 'discount', ratio: 1, description: '' }, { name: 'premium', ratio: 2, description: '' },
    ] }
    const { ui, dialog, publish, operations } = fixture({ ...signedIn, account, catalog,
      accountRefreshStatus: 'failed', accountRefreshError: 'network_error' })
    await ui.open()
    expect(dialog.querySelector('[role="alert"]')?.textContent).toContain('Could not refresh account capabilities')
    operations.refresh.mockImplementationOnce(async () => {
      publish({ ...signedIn, account: { ...account, allowedGroups: ['discount'] }, catalogStatus: 'loading', accountRefreshStatus: 'ready' })
    })
    button('Refresh account').click()
    await vi.waitFor(() => { expect(button('Refresh account').disabled).toBe(false) })
    expect(dialog.querySelector('[role="alert"]')?.textContent).toBe('')
    expect([...dialog.querySelector('select')!.options].map(option => option.value)).toEqual(['discount'])
    expect(dialog.querySelector<HTMLElement>('.hcx-group')?.hidden).toBe(true)
  })

  it('shows unavailable rather than zero when the first balance read fails', async () => {
    const { ui, dialog } = fixture({ account: signedIn.account, serverOrigin, catalogStatus: 'ready',
      walletStatus: 'failed', walletError: 'wallet_unavailable' })
    await ui.open()
    expect(row('Wallet balance (quota)')).toBe(halluCodexAccountCopy('en').quotaUnavailable)
    expect(dialog.textContent).not.toContain(halluCodexAccountCopy('en').updatedAt)
    expect(dialog.textContent).not.toContain(halluCodexAccountCopy('en').staleWallet)
  })

  it('offers saved-login restoration for network failures and browser login for expired sessions', async () => {
    const { ui, publish, operations, dialog } = fixture({ ...signedOut, account: { status: 'signed-out', errorCode: 'network_error' } })
    await ui.open()
    button('Retry restoring sign-in').click()
    await vi.waitFor(() => { expect(operations.restore).toHaveBeenCalledOnce() })
    expect(operations.start).not.toHaveBeenCalled()
    publish({ ...signedOut, account: { status: 'signed-out', errorCode: 'invalid_grant' } })
    expect(button('Retry restoring sign-in').hidden).toBe(true)
    expect(dialog.textContent).toContain('Your sign-in has expired')
    await vi.waitFor(() => { expect(button('Sign in using browser').disabled).toBe(false) })
    button('Sign in using browser').click()
    expect(operations.start).toHaveBeenCalledOnce()
  })

  it('ignores an older state query after a subscribed balance update', async () => {
    const { ui, operations, publish } = fixture(signedIn)
    const delayed = Promise.withResolvers<HalluCodexDesktopSnapshot>()
    operations.state.mockReturnValueOnce(delayed.promise)
    const opening = ui.open()
    publish({ ...signedIn, wallet: { ...signedIn.wallet!, remaining: '45' } })
    delayed.resolve(signedIn)
    await opening
    expect(row('Wallet balance (quota)')).toBe('45')
  })

  it('clears old account group choices on sign-out and keeps long descriptions as text', async () => {
    const description = '<img src=x onerror=alert(1)> ' + 'Long description '.repeat(20)
    const initial: HalluCodexDesktopSnapshot = { ...signedIn,
      account: { status: 'signed-in', profile: { id: 'first', displayName: 'First' }, group: 'discount', allowedGroups: ['discount', 'premium'], canSelectGroup: true },
      catalog: { group: 'discount', models: [], groups: [{ name: 'discount', ratio: 1, description: '' }, { name: 'premium', ratio: 2, description }] },
    }
    const { ui, dialog, publish } = fixture(initial)
    await ui.open()
    const select = dialog.querySelector('select')!
    select.value = 'premium'; select.dispatchEvent(new Event('change'))
    expect(dialog.querySelector('.hcx-group')?.textContent).toContain(description)
    expect(dialog.querySelector('img')).toBeNull()
    publish(signedOut)
    expect(select.options.length).toBe(0)
    publish({ ...initial, account: { ...initial.account, profile: { id: 'second', displayName: 'Second' } } as HalluCodexDesktopSnapshot['account'], catalogStatus: 'loading' })
    expect(select.options.length).toBe(0)
    expect(dialog.querySelector<HTMLElement>('.hcx-group')?.hidden).toBe(true)
  })

  it('keeps a successful group move visible when its new catalog fails', async () => {
    const account = { status: 'signed-in' as const, profile: { id: 'fixture', displayName: 'Fixture' }, group: 'discount', allowedGroups: ['discount', 'premium'], canSelectGroup: true }
    const catalog = { group: 'discount', models: [], groups: [{ name: 'discount', ratio: 1, description: '' }, { name: 'premium', ratio: 2, description: '' }] }
    const { ui, dialog, operations, publish } = fixture({ ...signedIn, account, catalog })
    operations.selectGroup.mockImplementationOnce(async () => {
      publish({ ...signedIn, account: { ...account, group: 'premium' }, catalogStatus: 'unavailable', catalogError: 'network_error' })
      return 'selected'
    })
    await ui.open()
    const select = dialog.querySelector('select')!
    select.value = 'premium'; select.dispatchEvent(new Event('change')); button('Switch group').click()
    await vi.waitFor(() => { expect(dialog.textContent).toContain('Switched to premium') })
    expect(dialog.textContent).toContain('Could not read groups and models')
    expect(row('Group')).toBe('premium')
    expect(button('Refresh groups and models').hidden).toBe(false)
  })

  it('drives capability refresh, group confirmation and balance recovery through the real native runtime', async () => {
    const { HalluCodexDesktopRuntime } = await import('../src/hallucodex/runtime.ts')
    const { HalluCodexHttpAuthTransport } = await import('../src/hallucodex/auth-protocol.ts')
    const { ServerOriginSetting } = await import('../src/hallucodex/server-origin.ts')
    const now = Date.UTC(2026, 9, 7, 4, 5, 6)
    let rotations = 0
    let group = 'discount'
    let offline = false
    const requests: string[] = []
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const path = new URL(url).pathname
      requests.push(path)
      if (path.endsWith('/token') || path.endsWith('/group')) {
        if (path.endsWith('/group')) {
          if (typeof init?.body !== 'string') throw new Error('missing group request')
          const body: unknown = JSON.parse(init.body)
          if (typeof body !== 'object' || body === null || !('group' in body) || typeof body.group !== 'string') {
            throw new Error('invalid group request')
          }
          group = body.group
        }
        rotations++
        return Response.json({ token_type: 'Bearer', access_token: `dsk.fixture-${rotations}`, refresh_token: `dsr.fixture-${rotations}`,
          expires_in: 900, refresh_expires_at: (now + 86_400_000) / 1000, device_session_id: 'fixture-device',
          profile: { id: 'fixture', display_name: 'Fixture' }, group, allowed_groups: ['discount', 'premium'],
          scope: 'relay:invoke profile:read balance:read models:read groups:read' + (rotations > 1 ? ' group:select' : '') })
      }
      if (path.endsWith('/groups')) return Response.json({ groups: [{ name: 'discount', ratio: 1, description: '' }, { name: 'premium', ratio: 2, description: 'Fast' }] })
      if (path.endsWith('/models')) return Response.json({ group, data: [{ id: 'fixture-model', endpoints: ['openai-response'] }] })
      if (path.endsWith('/balance')) {
        if (offline) throw new Error('Authorization: fixture-secret')
        return Response.json({ quota_remaining: '500000', quota_used: '0', unit: 'quota', quota_used_kind: 'account_usage_total', device_quota_used: '0', device_quota_limit: null })
      }
      if (path === '/api/status') return Response.json({ success: true, data: { quota_per_unit: 500000, quota_display_type: 'USD' } })
      throw new Error('unexpected endpoint')
    })
    let listener: (snapshot: HalluCodexDesktopSnapshot) => void = () => {}
    const runtime = new HalluCodexDesktopRuntime({
      server: new ServerOriginSetting(undefined, serverOrigin), fetch: fetcher, now: () => now, maxRequestBytes: 4096,
      transport: new HalluCodexHttpAuthTransport(() => serverOrigin, fetcher, () => now), deviceName: 'Fixture', openExternal: vi.fn(),
      store: { assertAvailable() {}, load: async () => ({ refreshToken: 'dsr.saved', refreshExpiresAt: now + 86_400_000,
        deviceSessionId: 'fixture-device', profile: { id: 'fixture', displayName: 'Fixture' }, group: 'discount' }), save: vi.fn(), clear: vi.fn() },
      onChange: (snapshot) => { listener(snapshot) },
    })
    onTestFinished(() => runtime.dispose())
    const ui = createHalluCodexAccountUi(document, {
      state: async () => runtime.getSnapshot(), start: () => runtime.startSignIn(), cancel: () => runtime.cancelSignIn(),
      signOut: () => runtime.signOut(), restore: () => runtime.restore(), refresh: () => runtime.refreshAccount(),
      refreshCatalog: () => runtime.refreshCatalog(), refreshWallet: () => runtime.refreshWallet(),
      selectGroup: value => runtime.selectGroup(value), setServer: value => runtime.setServerOrigin(value), openPage: vi.fn(),
      subscribe: (callback) => { listener = callback; return () => { listener = () => {} } },
    }, halluCodexAccountCopy('en'))
    disposers.push(() => { ui.dispose() })
    const dialog = document.querySelector('dialog')!
    dialog.showModal = () => { dialog.open = true }
    await runtime.restore()
    await vi.waitFor(() => { expect(runtime.getSnapshot().walletStatus).toBe('ready') })
    await ui.open()
    const select = dialog.querySelector('select')!
    expect(select.hidden).toBe(true)
    button('Refresh account').click()
    await vi.waitFor(() => { expect(select.hidden).toBe(false); expect(select.disabled).toBe(false) })
    expect(rotations).toBe(2)
    select.value = 'premium'; select.dispatchEvent(new Event('change'))
    expect(requests.filter(path => path.endsWith('/group'))).toHaveLength(0)
    button('Switch group').click()
    await vi.waitFor(() => { expect(dialog.textContent).toContain('Switched to premium'); expect(button('Refresh balance').disabled).toBe(false) })
    expect(group).toBe('premium')
    expect(rotations).toBe(3)
    offline = true
    button('Refresh balance').click()
    await vi.waitFor(() => { expect(dialog.textContent).toContain('Refresh failed; showing the last successful data.') })
    expect(row('Wallet balance')).toBe('$1')
    expect(dialog.textContent).not.toContain('fixture-secret')
    offline = false
    await vi.waitFor(() => { expect(button('Refresh balance').disabled).toBe(false) })
    button('Refresh balance').click()
    await vi.waitFor(() => { expect(dialog.textContent).not.toContain('Refresh failed; showing the last successful data.') })
    expect(JSON.stringify(runtime.getSnapshot())).not.toMatch(/dsk\.|dsr\.|refreshToken|accessToken/u)
  })

  it('explains a browser denial instead of a generic failure', async () => {
    const { ui, dialog } = fixture({ account: { status: 'signed-out', errorCode: 'access_denied' }, serverOrigin, catalogStatus: 'unavailable' })
    await ui.open()
    expect(dialog.textContent).toContain('You denied the authorization in the browser.')
  })
})
