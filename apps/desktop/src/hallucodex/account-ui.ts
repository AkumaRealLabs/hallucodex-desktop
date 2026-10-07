/** Owned-document account dialog; renders only safe snapshots and fixed localized copy. */
import type { DesktopGroup } from './group-policy.ts'
import { formatQuota } from './quota-display.ts'
import type { HalluCodexDesktopSnapshot, GroupSelectionResult } from './runtime.ts'
import type { AccountFailure } from './account-errors.ts'
import { DEFAULT_HALLUCODEX_ORIGIN } from './server-default.ts'

/** High-level native operations; the UI has no credential, URL, provider, or filesystem operations. */
export interface HalluCodexAccountUiOperations {
  state(): Promise<HalluCodexDesktopSnapshot | null>
  start(): Promise<HalluCodexDesktopSnapshot>
  cancel(): Promise<HalluCodexDesktopSnapshot>
  signOut(): Promise<{ remoteRevoked: boolean }>
  refresh(): Promise<void>
  refreshCatalog(): Promise<void>
  restore(): Promise<HalluCodexDesktopSnapshot>
  /** Move this device to another account-allowed group; the new state arrives through subscribe. */
  selectGroup(group: string): Promise<GroupSelectionResult>
  /** Re-read only the wallet and device usage; the snapshot change arrives through subscribe. */
  refreshWallet(): Promise<void>
  /** Select another server while signed out; rejects an invalid address. */
  setServer(origin: string): Promise<HalluCodexDesktopSnapshot>
  openPage(page: 'wallet' | 'usage' | 'devices'): Promise<void>
  subscribe(listener: (snapshot: HalluCodexDesktopSnapshot) => void): () => void
}

import type { HalluCodexAccountCopy } from './locale.ts'
export { halluCodexAccountCopy } from './locale.ts'

/** Dialog styles built from the DSH design tokens of the host document, with neutral fallbacks. */
const STYLES = `
.hcx-dialog { width: min(460px, calc(100vw - 48px)); max-height: calc(100vh - 48px); padding: 0; overflow: auto;
  border: 1px solid var(--dsw-alias-border-l2, #0000001a); border-radius: var(--dsw-radius-lg, 16px);
  background: var(--dsw-alias-bg-layer-1, var(--dsw-alias-button-elevated-fill, #fff)); color: var(--dsw-alias-label-primary, #0f1115);
  box-shadow: 0 24px 64px #0000002e, 0 2px 8px #00000014; font-family: var(--dsw-font-family, system-ui, sans-serif);
  font-size: 14px; line-height: 22px; -webkit-font-smoothing: antialiased; }
.hcx-dialog [hidden] { display: none !important; }
.hcx-dialog::backdrop { background: var(--dsw-alias-bg-mask-1, #0000004d); }
.hcx-body { display: flex; flex-direction: column; gap: 20px; padding: 24px 28px 28px; }
.hcx-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.hcx-title { margin: 0; font-family: var(--dsw-font-family-brand, var(--dsw-font-family, system-ui)); font-size: 20px;
  font-weight: 500; line-height: 28px; letter-spacing: -0.2px; }
.hcx-status { margin: 2px 0 0; color: var(--dsw-alias-label-secondary, #61666b); }
.hcx-status[data-tone="signed-in"] { color: var(--dsw-alias-label-primary, #0f1115); font-weight: 500; }
.hcx-close { flex: none; display: grid; place-items: center; width: 32px; height: 32px; margin: -2px -8px 0 0; padding: 0;
  border: 0; border-radius: var(--dsw-radius-sm, 8px); background: transparent; color: var(--dsw-alias-label-tertiary, #81858c);
  font: inherit; font-size: 20px; line-height: 1; cursor: pointer; }
.hcx-close:hover { background: var(--dsw-alias-interactive-bg-hover, #0000000d); color: var(--dsw-alias-label-primary, #0f1115); }
.hcx-rows { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 10px 20px; margin: 0; padding: 16px;
  border-radius: var(--dsw-radius-md, 12px); background: var(--dsw-alias-bg-layer-2, #0000000a); }
.hcx-rows dt { color: var(--dsw-alias-label-secondary, #61666b); }
.hcx-rows dd { margin: 0; min-width: 0; text-align: right; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
.hcx-select { max-width: 100%; height: 30px; margin: -4px 0; padding: 0 8px; border: 1px solid var(--dsw-alias-border-l2, #0000001a);
  border-radius: var(--dsw-radius-sm, 8px); background: var(--dsw-alias-bg-layer-1, var(--dsw-alias-button-elevated-fill, #fff));
  color: inherit; font: inherit; cursor: pointer; }
.hcx-select:disabled { color: var(--dsw-alias-label-tertiary, #81858c); cursor: default; }
.hcx-group { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.hcx-group p { margin: 0; overflow-wrap: anywhere; white-space: pre-wrap; }
.hcx-group .hcx-select { margin: 0; width: 100%; }
.hcx-feedback { display: flex; flex-direction: column; gap: 6px; }
.hcx-feedback:empty { display: none; }
.hcx-field { display: flex; flex-direction: column; gap: 8px; margin: 0; }
.hcx-label { color: var(--dsw-alias-label-secondary, #61666b); font-size: 13px; }
.hcx-inline { display: flex; gap: 8px; }
.hcx-input { flex: 1; min-width: 0; height: 40px; padding: 0 12px; border: 1px solid var(--dsw-alias-border-l2, #0000001a);
  border-radius: 10px; background: transparent; color: inherit; font: inherit; outline: none;
  transition: border-color var(--ds-transition-duration, .2s) var(--ds-ease-in-out, ease); }
.hcx-input:focus { border-color: var(--dsw-alias-border-l4, #00000029); }
.hcx-input:disabled { color: var(--dsw-alias-label-tertiary, #81858c); }
.hcx-note { margin: 0; color: var(--dsw-alias-label-tertiary, #81858c); font-size: 12px; line-height: 18px; }
.hcx-note[data-tone="warning"] { color: var(--dsw-alias-state-error-primary, #d4380d); }
.hcx-error { margin: 0; padding: 10px 12px; border-radius: 10px; background: var(--dsw-alias-interactive-bg-hover-danger, #f031311a);
  color: var(--dsw-alias-state-error-primary, #d4380d); }
.hcx-error:empty { display: none; }
.hcx-actions { display: flex; flex-direction: column; gap: 12px; }
.hcx-button { display: flex; align-items: center; justify-content: center; height: 44px; padding: 0 16px; border: 1px solid transparent;
  border-radius: 10px; font: inherit; font-weight: 500; cursor: pointer;
  transition: background-color var(--ds-transition-duration, .2s) var(--ds-ease-in-out, ease),
    border-color var(--ds-transition-duration, .2s) var(--ds-ease-in-out, ease); }
.hcx-button:disabled { opacity: .45; cursor: default; }
.hcx-primary { background: var(--dsw-alias-label-primary, #0f1115); color: var(--dsw-alias-label-primary-inverted, #fff); }
.hcx-primary:not(:disabled):hover { background: var(--dsw-alias-button-primary-hover, #43454a); }
.hcx-secondary { border-color: var(--dsw-alias-border-l2, #0000001a); background: var(--dsw-alias-button-elevated-fill, transparent);
  color: var(--dsw-alias-label-primary, #0f1115); }
.hcx-secondary:not(:disabled):hover { background: var(--dsw-alias-button-floating-hover, #f1f3f5); }
.hcx-inline .hcx-button { height: 40px; }
.hcx-links { display: flex; flex-wrap: wrap; justify-content: center; gap: 4px 16px; }
.hcx-link { padding: 4px 2px; border: 0; background: transparent; color: var(--dsw-alias-label-secondary, #61666b); font: inherit;
  font-size: 13px; cursor: pointer; }
.hcx-link:hover { color: var(--dsw-alias-label-primary, #0f1115); text-decoration: underline; text-underline-offset: 3px; }
.hcx-link[data-tone="danger"] { color: var(--dsw-alias-state-error-primary, #d4380d); }
.hcx-server-line { display: flex; flex-wrap: wrap; justify-content: center; align-items: baseline; gap: 4px 10px; margin: -4px 0 0;
  color: var(--dsw-alias-label-tertiary, #81858c); font-size: 12px; line-height: 18px; overflow-wrap: anywhere; text-align: center; }
.hcx-server-line .hcx-link { padding: 0; font-size: 12px; }
.hcx-footer { display: flex; flex-direction: column; gap: 6px; padding-top: 16px; border-top: 1px solid var(--dsw-alias-border-l1, #0000000f); }
`

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
  const element = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] => {
    const node = document.createElement(tag)
    node.className = className
    if (text !== undefined) node.textContent = text
    return node
  }
  const button = (className: string, text: string): HTMLButtonElement => {
    const node = element('button', className, text)
    node.type = 'button'
    return node
  }
  const style = element('style', '')
  style.textContent = STYLES
  document.head.append(style)

  const dialog = element('dialog', 'hcx-dialog')
  dialog.setAttribute('aria-labelledby', 'hallucodex-account-title')
  const body = element('div', 'hcx-body')
  const header = element('div', 'hcx-header')
  const heading = element('div', '')
  const title = element('h2', 'hcx-title', copy.title)
  title.id = 'hallucodex-account-title'
  const status = element('p', 'hcx-status')
  status.setAttribute('aria-live', 'polite')
  heading.append(title, status)
  const close = button('hcx-close', '×')
  close.setAttribute('aria-label', copy.close)
  header.append(heading, close)

  const rows = element('dl', 'hcx-rows')
  const row = (label: string): HTMLElement => {
    const value = element('dd', '')
    rows.append(element('dt', '', label), value)
    return value
  }
  const groupValue = row(copy.group)
  const groupText = element('span', '')
  const groupSelect = element('select', 'hcx-select')
  groupSelect.setAttribute('aria-label', copy.candidateGroup)
  groupValue.append(groupText)
  const groupPanel = element('section', 'hcx-group')
  const groupName = element('p', '')
  const groupRatio = element('p', 'hcx-note')
  const groupDescription = element('p', 'hcx-note')
  const groupConfirm = button('hcx-button hcx-secondary', copy.switchGroup)
  const groupProgress = element('p', 'hcx-note')
  groupProgress.setAttribute('role', 'status')
  groupPanel.append(groupSelect, groupName, groupRatio, groupDescription, groupConfirm)
  const modelsValue = row(copy.models)
  const walletValue = row(copy.wallet)
  const walletLabel = walletValue.previousElementSibling
  const usageValue = row(copy.accountUsage)
  const deviceValue = row(copy.deviceUsage)
  const limitValue = row(copy.deviceLimit)
  const serverValue = row(copy.server)

  const serverForm = element('form', 'hcx-field')
  const serverLabel = element('label', 'hcx-label', copy.server)
  serverLabel.htmlFor = 'hallucodex-server-address'
  const serverRow = element('div', 'hcx-inline')
  const serverInput = element('input', 'hcx-input')
  serverInput.id = 'hallucodex-server-address'
  serverInput.type = 'url'; serverInput.required = true; serverInput.spellcheck = false
  const serverSave = element('button', 'hcx-button hcx-secondary', copy.serverSave)
  serverSave.type = 'submit'
  serverRow.append(serverInput, serverSave)
  const serverHint = element('p', 'hcx-note')
  serverForm.append(serverLabel, serverRow, serverHint)
  // The server address stays out of the way: one small line that expands into the form on request.
  const serverLine = element('div', 'hcx-server-line')
  const serverCurrent = element('span', '')
  const serverEdit = button('hcx-link', copy.customServer)
  const serverReset = button('hcx-link', copy.useDefaultServer)
  serverLine.append(serverCurrent, serverEdit, serverReset)
  const serverWarning = element('p', 'hcx-note', copy.insecureServer)
  serverWarning.dataset.tone = 'warning'
  let serverExpanded = false

  const error = element('p', 'hcx-error')
  error.setAttribute('role', 'alert')
  const actions = element('div', 'hcx-actions')
  const start = button('hcx-button hcx-primary', copy.signIn)
  const cancel = button('hcx-button hcx-secondary', copy.cancel)
  const refresh = button('hcx-button hcx-secondary', copy.refresh)
  const retryRestore = button('hcx-button hcx-secondary', copy.retryRestore)
  const retryCatalog = button('hcx-link', copy.retryCatalog)
  const refreshWallet = button('hcx-link', copy.refreshWallet)
  const walletFeedback = element('div', 'hcx-feedback')
  const walletProgress = element('p', 'hcx-note')
  walletProgress.setAttribute('role', 'status')
  const walletTime = element('p', 'hcx-note')
  walletFeedback.append(walletProgress, walletTime, refreshWallet)
  const catalogFeedback = element('div', 'hcx-feedback')
  const catalogProgress = element('p', 'hcx-note')
  catalogProgress.setAttribute('role', 'status')
  catalogFeedback.append(catalogProgress, retryCatalog)
  actions.append(start, cancel, refresh, retryRestore)
  const links = element('div', 'hcx-links')
  const walletPage = button('hcx-link', copy.walletPage)
  const usagePage = button('hcx-link', copy.usagePage)
  const devicePage = button('hcx-link', copy.devicePage)
  const signOut = button('hcx-link', copy.signOut)
  signOut.dataset.tone = 'danger'
  links.append(walletPage, usagePage, devicePage, signOut)
  const footer = element('div', 'hcx-footer')
  const groupNote = element('p', 'hcx-note')
  footer.append(groupNote, element('p', 'hcx-note', copy.privacy))
  body.append(header, rows, walletFeedback, groupPanel, groupProgress, catalogFeedback, error, actions,
    serverLine, serverWarning, serverForm, links, footer)
  dialog.append(body)
  document.body.append(dialog)

  let snapshot: HalluCodexDesktopSnapshot | null = null
  let shownOrigin = ''
  let busy: 'start' | 'cancel' | 'sign-out' | 'refresh' | 'server' | 'group' | 'wallet' | 'catalog' | 'restore' | undefined
  const lifetime = new AbortController()
  let generation = 0
  let revision = 0
  let opening = 0
  let identity = ''
  let actionError: AccountFailure | undefined
  let operationMessage = ''
  let groupNotice = ''
  let groups: readonly DesktopGroup[] = []
  let shownGroups = ''
  let pendingGroup = ''
  const failureText = (code: AccountFailure): string => {
    switch (code) {
      case 'network_error': return copy.networkError
      case 'session_expired': return copy.sessionExpired
      case 'group_unavailable': return copy.groupUnavailable
      case 'catalog_unavailable': return copy.catalogFailed
      case 'wallet_unavailable': return copy.walletFailed
      case 'operation_failed': return copy.failed
      case 'cancelled': return ''
    }
  }
  const renderGroups = (current: string, canSelect: boolean, allowed: readonly string[]): void => {
    const catalog = snapshot?.catalogStatus === 'ready' ? snapshot.catalog : undefined
    groups = (catalog?.groups ?? groups).filter(group => allowed.includes(group.name))
    const selectable = canSelect && groups.length > 1 && groups.some(group => group.name === current)
    groupText.textContent = current
    groupSelect.hidden = !selectable
    groupPanel.hidden = !selectable
    const key = JSON.stringify(groups)
    if (key !== shownGroups) {
      groupSelect.replaceChildren(...groups.map((group) => {
        const option = element('option', '', group.name)
        option.value = group.name
        return option
      }))
      shownGroups = key
    }
    if (!groups.some(group => group.name === pendingGroup)) pendingGroup = current
    groupSelect.value = pendingGroup
    const candidate = groups.find(group => group.name === pendingGroup)
    groupName.textContent = candidate?.name ?? ''
    groupRatio.textContent = candidate === undefined ? '' : `${copy.ratio}: ${candidate.ratio}`
    groupDescription.textContent = candidate?.description ?? ''
    groupSelect.disabled = busy !== undefined || snapshot?.catalogStatus !== 'ready' || snapshot.accountRefreshStatus === 'loading'
    groupConfirm.disabled = groupSelect.disabled || pendingGroup === current
  }
  const render = (): void => {
    if (lifetime.signal.aborted) return
    const account = snapshot?.account
    const signedIn = account?.status === 'signed-in'
    const signedOut = account === undefined || account.status === 'signed-out'
    const nextIdentity = signedIn ? JSON.stringify([snapshot?.serverOrigin, account.profile.id]) : ''
    if (nextIdentity !== identity) {
      identity = nextIdentity
      groups = []; shownGroups = ''; pendingGroup = ''; groupNotice = ''; actionError = undefined
      groupSelect.replaceChildren()
      operationMessage = ''
    }
    error.textContent = operationMessage
    groupPanel.hidden = !signedIn
    groupProgress.hidden = !signedIn
    groupProgress.textContent = busy === 'group' ? `${copy.switchingGroup} ${pendingGroup}…` : groupNotice
    walletFeedback.hidden = !signedIn
    catalogFeedback.hidden = !signedIn
    status.dataset.tone = account?.status ?? 'signed-out'
    if (signedIn) status.textContent = account.profile.displayName || account.profile.id
    else status.textContent = account?.status === 'signing-in' ? copy.waiting : copy.signedOut
    rows.hidden = !signedIn
    if (signedIn) {
      renderGroups(account.group, account.canSelectGroup, account.allowedGroups)
      const runnable = snapshot?.catalog?.models.filter(model => model.contextWindow !== undefined && model.maxOutputTokens !== undefined)
      modelsValue.textContent = snapshot?.catalogStatus === 'ready' ? String(runnable?.length ?? 0) : copy.unavailable
      const wallet = snapshot?.wallet
      const walletFailure = snapshot?.walletError
      walletProgress.textContent = snapshot?.walletStatus === 'loading' ? copy.refreshing : walletFailure
        ? [...new Set([copy.walletFailed, failureText(walletFailure), wallet ? copy.staleWallet : ''])].filter(Boolean).join(' ') : ''
      walletTime.textContent = snapshot?.walletUpdatedAt === undefined ? ''
        : `${copy.updatedAt}: ${new Intl.DateTimeFormat(copy.numberLocale, { dateStyle: 'short', timeStyle: 'medium' }).format(snapshot.walletUpdatedAt)}`
      refreshWallet.disabled = busy !== undefined || snapshot?.walletStatus === 'loading' || snapshot?.accountRefreshStatus === 'loading'
      const catalogFailure = snapshot?.catalogError
      catalogProgress.textContent = snapshot?.catalogStatus === 'loading' ? copy.refreshing
        : catalogFailure ? [...new Set([copy.catalogFailed, failureText(catalogFailure)])].join(' ') : ''
      retryCatalog.hidden = catalogFailure === undefined && actionError !== 'group_unavailable'
      retryCatalog.disabled = busy !== undefined || snapshot?.catalogStatus === 'loading' || snapshot?.accountRefreshStatus === 'loading'
      const display = snapshot?.quotaDisplay
      const amount = (quota: string): string => formatQuota(quota, display, copy.numberLocale)
      if (walletLabel) walletLabel.textContent = display === undefined ? copy.walletQuota : copy.wallet
      walletValue.textContent = wallet ? amount(wallet.remaining) : copy.quotaUnavailable
      usageValue.textContent = wallet ? amount(wallet.accountUsage) : '—'
      deviceValue.textContent = wallet ? amount(wallet.deviceUsage) : '—'
      limitValue.textContent = wallet ? wallet.deviceLimit === undefined ? copy.deviceUnlimited : amount(wallet.deviceLimit) : '—'
      serverValue.textContent = snapshot?.serverOrigin ?? ''
    }
    const origin = snapshot?.serverOrigin ?? ''
    const custom = origin !== '' && origin !== DEFAULT_HALLUCODEX_ORIGIN
    serverLine.hidden = !signedOut || serverExpanded
    serverCurrent.textContent = custom ? `${copy.server}: ${origin}` : ''
    serverCurrent.hidden = !custom
    serverEdit.textContent = custom ? copy.changeServer : copy.customServer
    serverReset.hidden = !custom
    serverEdit.disabled = busy !== undefined; serverReset.disabled = busy !== undefined
    serverForm.hidden = !signedOut || !serverExpanded
    // Refill the field only when the selected server changes, so a pending edit survives re-rendering.
    if (origin !== shownOrigin) { serverInput.value = origin; shownOrigin = origin }
    const editable = signedOut && busy === undefined
    serverInput.disabled = !editable; serverSave.disabled = !editable
    const insecure = origin.startsWith('http:')
    serverWarning.hidden = !signedOut || serverExpanded || !insecure
    serverHint.textContent = insecure ? copy.insecureServer : copy.serverHint
    if (insecure) serverHint.dataset.tone = 'warning'
    else delete serverHint.dataset.tone
    if (account?.status === 'signed-out' && account.errorCode && account.errorCode !== 'cancelled') {
      if (account.errorCode === 'secure_storage_unavailable') error.textContent = copy.secureStorage
      else if (account.errorCode === 'access_denied') error.textContent = copy.denied
      else if (account.errorCode === 'network_error') error.textContent = copy.networkError
      else if (['invalid_grant', 'expired', 'signed_out'].includes(account.errorCode)) error.textContent = copy.sessionExpired
      else error.textContent = copy.failed
    }
    if (signedIn && snapshot?.accountRefreshError) error.textContent = `${copy.accountRefreshFailed} ${failureText(snapshot.accountRefreshError)}`
    if (actionError !== undefined) error.textContent = failureText(actionError)
    if (account?.status === 'signing-in') error.textContent = ''
    retryRestore.hidden = account?.status !== 'signed-out' || account.errorCode !== 'network_error'
    retryRestore.disabled = busy !== undefined
    groupNote.textContent = !signedIn ? copy.selectGroup : account.canSelectGroup ? copy.groupSwitchNote : copy.groupFixed
    const needsLogin = [snapshot?.walletError, snapshot?.catalogError, snapshot?.accountRefreshError, actionError].includes('session_expired')
    start.hidden = !signedOut && !needsLogin
    start.disabled = busy !== undefined
    cancel.hidden = account?.status !== 'signing-in' && busy !== 'start'
    cancel.disabled = busy === 'cancel'
    refresh.hidden = !signedIn
    refresh.textContent = busy === 'refresh' || snapshot?.accountRefreshStatus === 'loading' ? copy.refreshing : copy.refresh
    refresh.disabled = busy !== undefined || snapshot?.accountRefreshStatus === 'loading'
    links.hidden = !signedIn
    signOut.disabled = busy !== undefined
  }
  const readState = async (operation: number): Promise<void> => {
    const version = revision
    const next = await operations.state()
    if (operation === generation && version === revision && !lifetime.signal.aborted) { snapshot = next; render() }
  }
  const perform = async (action: NonNullable<typeof busy>): Promise<void> => {
    if (lifetime.signal.aborted || (busy !== undefined && action !== 'cancel')) return
    const operation = ++generation
    const version = revision
    const server = serverInput.value
    const target = pendingGroup
    busy = action; actionError = undefined; operationMessage = ''; groupNotice = ''; render()
    try {
      if (action === 'start' || action === 'cancel' || action === 'restore') {
        const next = await operations[action]()
        if (operation === generation && version === revision) snapshot = next
      } else if (action === 'sign-out') {
        const result = await operations.signOut()
        await readState(operation)
        if (operation === generation && !result.remoteRevoked) operationMessage = copy.remoteRevokeFailed
      } else if (action === 'server') {
        const next = await operations.setServer(server)
        if (operation === generation) {
          if (version === revision) snapshot = next
          serverExpanded = false
        }
      } else if (action === 'group') {
        const result = await operations.selectGroup(target)
        await readState(operation)
        if (operation === generation && snapshot?.account.status === 'signed-in') {
          if (result === 'selected') groupNotice = `${copy.groupSelected} ${target}`
          else actionError = result
          pendingGroup = snapshot.account.group
        }
      } else {
        if (action === 'wallet') await operations.refreshWallet()
        else if (action === 'catalog') await operations.refreshCatalog()
        else await operations.refresh()
        await readState(operation)
      }
    } catch (_operationError) {
      if (operation === generation) operationMessage = action === 'server' ? copy.invalidServer : copy.failed
    } finally { if (operation === generation) { busy = undefined; render() } }
  }
  start.addEventListener('click', () => { void perform('start') })
  cancel.addEventListener('click', () => { void perform('cancel') })
  signOut.addEventListener('click', () => { void perform('sign-out') })
  refresh.addEventListener('click', () => { void perform('refresh') })
  groupSelect.addEventListener('change', () => { pendingGroup = groupSelect.value; groupNotice = ''; render() })
  groupConfirm.addEventListener('click', () => { void perform('group') })
  refreshWallet.addEventListener('click', () => { void perform('wallet') })
  retryCatalog.addEventListener('click', () => { void perform('catalog') })
  retryRestore.addEventListener('click', () => { void perform('restore') })
  serverForm.addEventListener('submit', (event) => { event.preventDefault(); void perform('server') })
  serverEdit.addEventListener('click', () => { serverExpanded = true; render(); serverInput.focus(); serverInput.select() })
  serverReset.addEventListener('click', () => { serverInput.value = DEFAULT_HALLUCODEX_ORIGIN; void perform('server') })
  for (const [link, page] of [[walletPage, 'wallet'], [devicePage, 'devices'], [usagePage, 'usage']] as const) {
    link.addEventListener('click', () => {
      const operation = generation
      void operations.openPage(page).catch(() => {
        if (operation === generation && !lifetime.signal.aborted) { operationMessage = copy.failed; render() }
      })
    })
  }
  close.addEventListener('click', () => { dialog.close() })
  dialog.addEventListener('close', () => {
    opening++
    if (snapshot?.account.status === 'signing-in' || busy === 'start') void perform('cancel')
  })
  const unsubscribe = operations.subscribe((next) => {
    const previous = snapshot?.account
    if (previous?.status === 'signed-in' && (next.account.status !== 'signed-in'
      || next.account.profile.id !== previous.profile.id || next.serverOrigin !== snapshot?.serverOrigin)) {
      if (busy !== 'sign-out' && busy !== 'start') { generation++; busy = undefined }
    }
    revision++; snapshot = next; render()
  })
  render()
  return {
    async open() {
      if (lifetime.signal.aborted) return
      const version = revision
      const request = ++opening
      const next = await operations.state()
      lifetime.signal.throwIfAborted()
      if (request !== opening) return
      if (version === revision) snapshot = next
      if (snapshot === null) return
      operationMessage = ''; render()
      if (!dialog.open) dialog.showModal()
      const operation = generation
      if (snapshot.account.status === 'signed-in') void operations.refreshWallet().catch((_walletError: unknown) => {
        if (operation === generation && !lifetime.signal.aborted) { operationMessage = copy.failed; render() }
      })
    },
    dispose() { lifetime.abort(); generation++; unsubscribe(); dialog.remove(); style.remove() },
  }
}
