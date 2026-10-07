// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHalluCodexAccountUi, halluCodexAccountCopy } from '../src/hallucodex/account-ui.ts'
import type { HalluCodexDesktopSnapshot } from '../src/hallucodex/runtime.ts'

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

function fixture(initial = signedOut) {
  let latest = initial
  let listener: (state: HalluCodexDesktopSnapshot) => void = () => {}
  const unsubscribe = vi.fn()
  const operations = {
    state: vi.fn(async () => latest),
    start: vi.fn<() => Promise<HalluCodexDesktopSnapshot>>(async () => ({ account: { status: 'signing-in' as const, expiresAt: 100 }, serverOrigin, catalogStatus: 'unavailable' as const })),
    setServer: vi.fn<(origin: string) => Promise<HalluCodexDesktopSnapshot>>(async origin => ({ ...signedOut, serverOrigin: origin })),
    openPage: vi.fn(async (_page: 'wallet' | 'usage' | 'devices') => {}),
    cancel: vi.fn(async () => signedOut), signOut: vi.fn(async () => ({ remoteRevoked: true })),
    refresh: vi.fn(async () => {}), refreshWallet: vi.fn(async () => {}),
    selectGroup: vi.fn<(group: string) => Promise<'selected' | 'group_unavailable'>>(async () => 'selected'),
    subscribe: (callback: typeof listener) => { listener = callback; return unsubscribe },
  }
  const ui = createHalluCodexAccountUi(document, operations, halluCodexAccountCopy('en'))
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
    expect(select.getAttribute('aria-label')).toBe('Group')
    expect(select.value).toBe('discount')
    expect([...select.options].map(option => option.textContent)).toEqual(['discount · ratio 1', 'premium · ratio 2 · Fast'])
    expect(select.title).toBe('discount · ratio 1')
    expect(dialog.textContent).toContain('You can switch to another account-allowed group above.')
    const pending = Promise.withResolvers<'selected' | 'group_unavailable'>()
    operations.selectGroup.mockImplementationOnce(() => pending.promise)
    select.value = 'premium'
    select.dispatchEvent(new Event('change'))
    expect(operations.selectGroup).toHaveBeenCalledWith('premium')
    // The catalog reloads during the move; the list stays, showing the pending choice.
    publish({ account: selectable('discount').account, serverOrigin, catalogStatus: 'loading' })
    expect(select.hidden).toBe(false)
    expect(select.disabled).toBe(true)
    expect(select.value).toBe('premium')
    publish(selectable('premium'))
    pending.resolve('selected')
    await vi.waitFor(() => { expect(select.disabled).toBe(false) })
    expect(select.value).toBe('premium')
    operations.selectGroup.mockResolvedValueOnce('group_unavailable')
    select.value = 'discount'
    select.dispatchEvent(new Event('change'))
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
  it('explains a browser denial instead of a generic failure', async () => {
    const { ui, dialog } = fixture({ account: { status: 'signed-out', errorCode: 'access_denied' }, serverOrigin, catalogStatus: 'unavailable' })
    await ui.open()
    expect(dialog.textContent).toContain('You denied the authorization in the browser.')
  })
})
