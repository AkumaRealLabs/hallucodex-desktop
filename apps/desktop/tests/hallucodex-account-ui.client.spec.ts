// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHalluCodexAccountUi, halluCodexAccountCopy } from '../src/hallucodex/account-ui.ts'
import type { HalluCodexDesktopSnapshot } from '../src/hallucodex/runtime.ts'

const signedOut: HalluCodexDesktopSnapshot = { account: { status: 'signed-out' }, catalogStatus: 'unavailable' }
const signedIn: HalluCodexDesktopSnapshot = {
  account: { status: 'signed-in', profile: { id: 'fixture-id', displayName: '<img src=x onerror=alert(1)>' }, group: 'discount', allowedGroups: ['discount'] },
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
    start: vi.fn<() => Promise<HalluCodexDesktopSnapshot>>(async () => ({ account: { status: 'signing-in' as const, expiresAt: 100 }, catalogStatus: 'unavailable' as const })),
    openPage: vi.fn(async (_page: 'wallet' | 'usage' | 'devices') => {}),
    cancel: vi.fn(async () => signedOut), signOut: vi.fn(async () => ({ remoteRevoked: true })), refresh: vi.fn(async () => {}),
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
  const found = [...document.querySelectorAll('button')].find(candidate => candidate.textContent === label)
  if (!found) throw new Error('missing button')
  return found
}

describe('native HalluCodex account UI', () => {
  it('renders safe identity and concrete group without interpreting account HTML', async () => {
    const { ui, dialog, operations } = fixture(signedIn)
    await ui.open()
    expect(dialog.open).toBe(true)
    expect(dialog.textContent).toContain('<img src=x onerror=alert(1)>')
    expect(dialog.querySelector('img')).toBeNull()
    expect(dialog.textContent).toContain('Current group: discount')
    expect(dialog.textContent).toContain('Available models: 1')
    expect(dialog.querySelector('input')).toBeNull()
    expect(dialog.querySelector('select')).toBeNull()
    button('Wallet / top up').click()
    button('Usage records').click()
    button('Security / devices').click()
    expect(operations.openPage.mock.calls).toEqual([['wallet'], ['usage'], ['devices']])
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
    const { ui, dialog } = fixture({ account: { status: 'signed-out', errorCode: 'secure_storage_unavailable' }, catalogStatus: 'unavailable' })
    await ui.open()
    expect(dialog.textContent).toContain('Enable your operating-system keyring')
    expect(dialog.querySelector('input')).toBeNull()
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
})
