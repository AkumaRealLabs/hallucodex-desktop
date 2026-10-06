/** Owned-document account dialog; renders only safe snapshots and fixed localized copy. */
import type { HalluCodexDesktopSnapshot } from './runtime.ts'

/** High-level native operations; the UI has no credential, URL, provider, or filesystem operations. */
export interface HalluCodexAccountUiOperations {
  state(): Promise<HalluCodexDesktopSnapshot | null>
  start(): Promise<HalluCodexDesktopSnapshot>
  cancel(): Promise<HalluCodexDesktopSnapshot>
  signOut(): Promise<{ remoteRevoked: boolean }>
  refresh(): Promise<void>
  openPage(page: 'wallet' | 'usage' | 'devices'): Promise<void>
  subscribe(listener: (snapshot: HalluCodexDesktopSnapshot) => void): () => void
}

import type { HalluCodexAccountCopy } from './locale.ts'
export { halluCodexAccountCopy } from './locale.ts'

/**
 * Create one native-owned account dialog in the existing application document.
 * @param document - owned main-frame document.
 * @param operations - validated main-process account methods.
 * @param copy - current native locale.
 * @returns explicit open and teardown operations.
 */
export function createHalluCodexAccountUi(
  document: Document, operations: HalluCodexAccountUiOperations, copy: HalluCodexAccountCopy,
): { open(): Promise<void>; dispose(): void } {
  const dialog = document.createElement('dialog')
  dialog.setAttribute('aria-labelledby', 'hallucodex-account-title')
  dialog.style.cssText = 'max-width:520px;width:calc(100vw - 48px);border:1px solid #777;border-radius:16px;padding:24px;background:Canvas;color:CanvasText;font:15px system-ui;'
  const title = document.createElement('h2')
  title.id = 'hallucodex-account-title'; title.textContent = copy.title
  const status = document.createElement('p')
  status.setAttribute('aria-live', 'polite')
  const details = document.createElement('p')
  const quota = document.createElement('p')
  const hint = document.createElement('p'); hint.textContent = copy.selectGroup
  const privacy = document.createElement('p'); privacy.textContent = copy.privacy
  const error = document.createElement('p'); error.setAttribute('role', 'alert')
  const actions = document.createElement('div'); actions.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap'
  const start = document.createElement('button'); start.textContent = copy.signIn
  const cancel = document.createElement('button'); cancel.textContent = copy.cancel
  const signOut = document.createElement('button'); signOut.textContent = copy.signOut
  const refresh = document.createElement('button'); refresh.textContent = copy.refresh
  const close = document.createElement('button'); close.textContent = copy.close
  const walletPage = document.createElement('button'); walletPage.textContent = copy.walletPage
  const usagePage = document.createElement('button'); usagePage.textContent = copy.usagePage
  const devicePage = document.createElement('button'); devicePage.textContent = copy.devicePage
  for (const button of [start, cancel, signOut, refresh, walletPage, usagePage, devicePage, close]) {
    button.type = 'button'; button.style.cssText = 'font:inherit;padding:8px 12px;cursor:pointer'
    actions.append(button)
  }
  dialog.append(title, status, details, quota, hint, privacy, error, actions)
  document.body.append(dialog)
  let snapshot: HalluCodexDesktopSnapshot | null = null
  let busy: 'start' | 'cancel' | 'sign-out' | 'refresh' | undefined
  const lifetime = new AbortController()
  let generation = 0
  const render = (): void => {
    if (lifetime.signal.aborted) return
    const account = snapshot?.account
    status.textContent = account?.status === 'signed-in' ? account.profile.displayName || account.profile.id
      : account?.status === 'signing-in' ? copy.waiting : copy.signedOut
    details.textContent = account?.status === 'signed-in'
      ? `${copy.group}: ${account.group}. ${snapshot?.catalogStatus === 'ready' ? `${copy.models}: ${String(snapshot.catalog?.models.filter(model => model.contextWindow !== undefined && model.maxOutputTokens !== undefined).length ?? 0)}` : copy.unavailable}` : ''
    quota.textContent = account?.status !== 'signed-in' ? '' : snapshot?.walletStatus === 'ready' && snapshot.wallet
      ? `${copy.wallet}: ${snapshot.wallet.remaining}. ${copy.accountUsage}: ${snapshot.wallet.accountUsage}` : copy.quotaUnavailable
    if (account?.status === 'signed-out' && account.errorCode && account.errorCode !== 'cancelled') {
      error.textContent = account.errorCode === 'secure_storage_unavailable' ? copy.secureStorage : copy.failed
    }
    if (account?.status === 'signing-in') error.textContent = ''
    start.disabled = busy !== undefined || account?.status === 'signing-in'
    cancel.hidden = account?.status !== 'signing-in' && busy !== 'start'
    signOut.hidden = account?.status !== 'signed-in'
    refresh.hidden = account?.status !== 'signed-in'
    walletPage.hidden = account?.status !== 'signed-in'
    usagePage.hidden = account?.status !== 'signed-in'
    cancel.disabled = busy === 'cancel'; signOut.disabled = busy !== undefined; refresh.disabled = busy !== undefined
  }
  const perform = async (action: NonNullable<typeof busy>): Promise<void> => {
    if (lifetime.signal.aborted || (busy !== undefined && action !== 'cancel')) return
    const operation = ++generation
    busy = action; error.textContent = ''; render()
    try {
      if (action === 'start') { const next = await operations.start(); if (operation === generation) snapshot = next }
      else if (action === 'cancel') { const next = await operations.cancel(); if (operation === generation) snapshot = next }
      else if (action === 'sign-out') {
        const result = await operations.signOut()
        if (operation === generation && !result.remoteRevoked) error.textContent = copy.remoteRevokeFailed
        const next = await operations.state(); if (operation === generation) snapshot = next
      } else { await operations.refresh(); const next = await operations.state(); if (operation === generation) snapshot = next }
    } catch (_operationError) { if (operation === generation) error.textContent = copy.failed }
    finally { if (operation === generation) { busy = undefined; render() } }
  }
  start.addEventListener('click', () => { void perform('start') })
  cancel.addEventListener('click', () => { void perform('cancel') })
  signOut.addEventListener('click', () => { void perform('sign-out') })
  refresh.addEventListener('click', () => { void perform('refresh') })
  walletPage.addEventListener('click', () => { void operations.openPage('wallet').catch(() => { error.textContent = copy.failed }) })
  devicePage.addEventListener('click', () => { void operations.openPage('devices').catch(() => { error.textContent = copy.failed }) })
  usagePage.addEventListener('click', () => { void operations.openPage('usage').catch(() => { error.textContent = copy.failed }) })
  close.addEventListener('click', () => { dialog.close() })
  dialog.addEventListener('close', () => {
    if (snapshot?.account.status === 'signing-in' || busy === 'start') void perform('cancel')
  })
  const unsubscribe = operations.subscribe((next) => { snapshot = next; render() })
  render()
  return {
    async open() {
      if (lifetime.signal.aborted) return
      const next = await operations.state()
      lifetime.signal.throwIfAborted()
      if (next === null) return
      snapshot = next; error.textContent = ''; render()
      if (!dialog.open) dialog.showModal()
    },
    dispose() { lifetime.abort(); generation++; unsubscribe(); dialog.remove() },
  }
}
