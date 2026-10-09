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

/** Dialog styles built from the DSH modal, settings-card and button tokens of the host document, with neutral fallbacks. */
const STYLES = `
.hcx-dialog { box-sizing: border-box; width: min(440px, calc(100vw - 48px)); max-height: calc(100vh - 48px); padding: 0; overflow: auto;
  border: 0; border-radius: var(--dsw-radius-panel, 28px); background: var(--dsw-alias-bg-layer-2, #fff);
  color: var(--dsw-alias-label-primary, #0f1115); font-family: var(--dsw-font-family, system-ui, sans-serif);
  box-shadow: var(--dsw-elevation-prominent, 0 0 0 .5px #00000029, 0 3px 8px #0000000a, 0 0 20px #0000000d);
  font-size: 14px; line-height: 22px; -webkit-font-smoothing: antialiased;
  animation: hcx-enter var(--ds-transition-duration, .2s) var(--ds-ease-in-out, ease); }
.hcx-dialog::backdrop { background: var(--dsw-alias-bg-mask-1, #0000003d); }
@keyframes hcx-enter { from { opacity: 0; } }
@media (prefers-reduced-motion: reduce) { .hcx-dialog { animation: none; } }
.hcx-dialog [hidden] { display: none !important; }
.hcx-dialog :where(h2, p, dl, dd) { margin: 0; }
.hcx-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.hcx-body { display: flex; flex-direction: column; gap: 16px; padding: 22px 24px 24px; }
.hcx-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.hcx-title { font-size: 16px; font-weight: 500; line-height: 24px; }
.hcx-status { margin-top: 2px; color: var(--dsw-alias-label-secondary, #61666b); font-size: 13px; line-height: 20px; }
.hcx-close { flex: none; display: grid; place-items: center; width: 28px; height: 28px; margin: -2px -10px 0 0; padding: 0;
  border: 0; border-radius: var(--dsw-radius-sm, 8px); background: transparent; color: var(--dsw-alias-label-secondary, #61666b);
  font: inherit; font-size: 20px; line-height: 1; cursor: pointer; }
.hcx-close:hover { background: var(--dsw-alias-interactive-bg-hover, #2631480f); color: var(--dsw-alias-label-primary, #0f1115); }
.hcx-card { display: flex; flex-direction: column; gap: 12px; padding: 14px 16px; min-width: 0;
  border: .5px solid var(--dsw-alias-settings-card-stroke, var(--dsw-alias-border-l4, #00000029));
  border-radius: var(--dsw-radius-xl, 20px); background: var(--dsw-alias-settings-card-fill, transparent); }
.hcx-profile { flex-direction: row; align-items: center; }
.hcx-profile .hcx-button { flex: none; }
.hcx-avatar { flex: none; display: grid; place-items: center; width: 40px; height: 40px; border-radius: 50%;
  background: var(--dsw-alias-bg-skeleton, #0000000a); color: var(--dsw-alias-label-secondary, #61666b); font-size: 16px; font-weight: 500; }
.hcx-identity { flex: 1; min-width: 0; }
.hcx-name { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hcx-origin dd { color: var(--dsw-alias-label-tertiary, #81858c); font-size: 12px; line-height: 18px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hcx-card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.hcx-card dt { color: var(--dsw-alias-label-secondary, #61666b); }
.hcx-card-head .hcx-button { flex: none; }
.hcx-figure, .hcx-plan { flex: 1; min-width: 0; }
.hcx-figure dt, .hcx-plan dt { font-size: 13px; line-height: 20px; }
.hcx-amount { margin-top: 2px; font-size: 26px; font-weight: 500; line-height: 34px; letter-spacing: -.3px;
  font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.hcx-stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; padding-top: 12px;
  border-top: .5px solid var(--dsw-alias-border-l2, #0000001a); }
.hcx-stats dt { font-size: 12px; line-height: 18px; }
.hcx-stats dd { margin-top: 2px; font-weight: 500; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.hcx-plan { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.hcx-plan dd { margin-top: 2px; font-size: 18px; font-weight: 500; line-height: 26px; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
.hcx-group { display: flex; flex-direction: column; gap: 8px; padding-top: 12px; border-top: .5px solid var(--dsw-alias-border-l2, #0000001a); }
.hcx-inline { display: flex; gap: 8px; }
.hcx-select { flex: 1; min-width: 0; height: 36px; padding: 0 32px 0 12px; appearance: none;
  border: .5px solid var(--dsw-alias-border-l3, #0000001f); border-radius: var(--dsw-radius-md, 12px);
  background: transparent url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12' fill='none'%3E%3Cpath d='M3 4.5L6 7.5L9 4.5' stroke='%2381858C' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") no-repeat right 12px center / 12px;
  color: inherit; font: inherit; cursor: pointer; }
.hcx-select option { background: var(--dsw-alias-bg-layer-1, #fff); color: var(--dsw-alias-label-primary, #0f1115); }
.hcx-select:disabled { color: var(--dsw-alias-label-tertiary, #81858c); cursor: default; }
.hcx-group-meta { display: flex; flex-direction: column; gap: 2px; font-size: 12px; line-height: 18px; overflow-wrap: anywhere; }
.hcx-group-name { color: var(--dsw-alias-label-primary, #0f1115); font-weight: 500; }
.hcx-group-ratio { color: var(--dsw-alias-label-secondary, #61666b); }
.hcx-group-ratio:not(:empty)::before { content: '·'; margin: 0 6px; color: var(--dsw-alias-label-tertiary, #81858c); }
.hcx-group-description { color: var(--dsw-alias-label-tertiary, #81858c); white-space: pre-wrap; }
.hcx-feedback { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; }
.hcx-feedback:not(:has(> :not(:empty):not([hidden]))) { display: none; }
.hcx-field { display: flex; flex-direction: column; gap: 8px; margin: 0; }
.hcx-label { color: var(--dsw-alias-label-secondary, #61666b); font-size: 13px; }
.hcx-input { flex: 1; min-width: 0; height: 36px; padding: 0 12px; border: .5px solid var(--dsw-alias-border-l3, #0000001f);
  border-radius: var(--dsw-radius-md, 12px); background: transparent; color: inherit; font: inherit; outline: none;
  transition: border-color var(--ds-transition-duration, .2s) var(--ds-ease-in-out, ease); }
.hcx-input:focus { border-color: var(--dsw-alias-state-business-primary, #4176e6); }
.hcx-input:disabled { color: var(--dsw-alias-label-tertiary, #81858c); }
.hcx-note { color: var(--dsw-alias-label-tertiary, #81858c); font-size: 12px; line-height: 18px; overflow-wrap: anywhere; }
.hcx-note:empty { display: none; }
.hcx-note[data-tone="warning"] { color: var(--dsw-alias-state-error-primary, #ec1313); }
.hcx-error { padding: 10px 12px; border-radius: var(--dsw-radius-md, 12px); background: var(--dsw-alias-interactive-bg-hover-danger, #ec13130d);
  color: var(--dsw-alias-state-error-primary, #ec1313); font-size: 13px; line-height: 20px; }
.hcx-error:empty { display: none; }
.hcx-dialog :is(button, select):focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid
  var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, #4176e6)); outline-offset: 1px; }
.hcx-actions { display: flex; flex-direction: column; gap: 8px; }
.hcx-actions:not(:has(> :not([hidden]))) { display: none; }
.hcx-actions .hcx-button { height: 40px; }
.hcx-button { box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center; height: 36px; padding: 0 14px;
  border: .5px solid transparent; border-radius: var(--dsw-radius-md, 12px); background: transparent;
  color: var(--dsw-alias-label-primary, #0f1115); font: inherit; white-space: nowrap; cursor: pointer;
  transition: background-color var(--ds-transition-duration, .2s) var(--ds-ease-in-out, ease); }
.hcx-button:disabled { opacity: .4; cursor: default; }
.hcx-primary { background: var(--dsw-alias-button-primary-fill, #0f1115); color: var(--dsw-alias-label-primary-foreground, #fff); font-weight: 500; }
.hcx-primary:not(:disabled):hover { background: var(--dsw-alias-button-primary-hover, #43454a); }
.hcx-outline { border-color: var(--dsw-alias-border-l3, #0000001f); }
.hcx-outline:not(:disabled):hover { background: var(--dsw-alias-interactive-bg-hover, #2631480f); }
.hcx-small { height: 28px; padding: 0 10px; border-radius: var(--dsw-radius-sm, 8px); font-size: 12px; line-height: 18px; }
.hcx-button[data-tone="danger"] { color: var(--dsw-alias-state-error-primary, #ec1313); }
.hcx-links { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
.hcx-links .hcx-button { min-width: 0; padding: 0 8px; font-size: 13px; }
.hcx-link { padding: 2px 0; border: 0; background: transparent; color: var(--dsw-alias-label-secondary, #61666b); font: inherit;
  font-size: 12px; line-height: 18px; cursor: pointer; text-decoration: underline transparent; text-underline-offset: 3px; }
.hcx-link:not(:disabled):hover { color: var(--dsw-alias-label-primary, #0f1115); text-decoration-color: currentColor; }
.hcx-link:disabled { opacity: .4; cursor: default; }
.hcx-server-line { display: flex; flex-wrap: wrap; justify-content: center; align-items: baseline; gap: 4px 10px; margin-top: -4px;
  color: var(--dsw-alias-label-tertiary, #81858c); font-size: 12px; line-height: 18px; overflow-wrap: anywhere; text-align: center; }
.hcx-footer { display: flex; flex-direction: column; gap: 4px; padding-top: 14px; border-top: .5px solid var(--dsw-alias-border-l2, #0000001a); }
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

  // Each figure is a dt/dd pair; the wrapping div only groups the pair for layout.
  const term = (list: HTMLDListElement, label: string): HTMLElement => {
    const value = element('dd', '')
    const pair = element('div', '')
    pair.append(element('dt', '', label), value)
    list.append(pair)
    return value
  }
  const profileCard = element('section', 'hcx-card hcx-profile')
  const avatar = element('span', 'hcx-avatar')
  avatar.setAttribute('aria-hidden', 'true')
  const identityText = element('div', 'hcx-identity')
  const nameText = element('p', 'hcx-name')
  const originList = element('dl', 'hcx-origin')
  const serverValue = term(originList, copy.server)
  serverValue.previousElementSibling?.classList.add('hcx-sr')
  identityText.append(nameText, originList)
  const signOut = button('hcx-button hcx-outline hcx-small', copy.signOut)
  signOut.dataset.tone = 'danger'
  profileCard.append(avatar, identityText, signOut)

  const balanceCard = element('section', 'hcx-card')
  const balanceHead = element('div', 'hcx-card-head')
  const figure = element('dl', 'hcx-figure')
  const walletValue = term(figure, copy.wallet)
  walletValue.className = 'hcx-amount'
  const walletLabel = walletValue.previousElementSibling
  const refreshWallet = button('hcx-button hcx-outline hcx-small', copy.refreshWallet)
  balanceHead.append(figure, refreshWallet)
  const walletFeedback = element('div', 'hcx-feedback')
  const walletProgress = element('p', 'hcx-note')
  walletProgress.setAttribute('role', 'status')
  const walletTime = element('p', 'hcx-note')
  walletFeedback.append(walletProgress, walletTime)
  const stats = element('dl', 'hcx-stats')
  const usageValue = term(stats, copy.accountUsage)
  const deviceValue = term(stats, copy.deviceUsage)
  const limitValue = term(stats, copy.deviceLimit)
  balanceCard.append(balanceHead, walletFeedback, stats)

  // Account refresh re-reads granted groups and the model catalog, so it sits on this card.
  const planCard = element('section', 'hcx-card')
  const planHead = element('div', 'hcx-card-head')
  const plan = element('dl', 'hcx-plan')
  const groupValue = term(plan, copy.group)
  const modelsValue = term(plan, copy.models)
  const refresh = button('hcx-button hcx-outline hcx-small', copy.refresh)
  planHead.append(plan, refresh)
  const groupPanel = element('div', 'hcx-group')
  const groupPicker = element('div', 'hcx-inline')
  const groupSelect = element('select', 'hcx-select')
  groupSelect.setAttribute('aria-label', copy.candidateGroup)
  const groupConfirm = button('hcx-button hcx-outline', copy.switchGroup)
  groupPicker.append(groupSelect, groupConfirm)
  const groupMeta = element('div', 'hcx-group-meta')
  const groupHeadline = element('p', '')
  const groupName = element('span', 'hcx-group-name')
  const groupRatio = element('span', 'hcx-group-ratio')
  groupHeadline.append(groupName, groupRatio)
  const groupDescription = element('p', 'hcx-group-description')
  groupMeta.append(groupHeadline, groupDescription)
  groupPanel.append(groupPicker, groupMeta)
  const groupProgress = element('p', 'hcx-note')
  groupProgress.setAttribute('role', 'status')
  const catalogFeedback = element('div', 'hcx-feedback')
  const catalogProgress = element('p', 'hcx-note')
  catalogProgress.setAttribute('role', 'status')
  const retryCatalog = button('hcx-link', copy.retryCatalog)
  catalogFeedback.append(catalogProgress, retryCatalog)
  const groupHint = element('p', 'hcx-note')
  planCard.append(planHead, groupPanel, groupProgress, catalogFeedback, groupHint)

  const serverForm = element('form', 'hcx-field')
  const serverLabel = element('label', 'hcx-label', copy.server)
  serverLabel.htmlFor = 'hallucodex-server-address'
  const serverRow = element('div', 'hcx-inline')
  const serverInput = element('input', 'hcx-input')
  serverInput.id = 'hallucodex-server-address'
  serverInput.type = 'url'; serverInput.required = true; serverInput.spellcheck = false
  const serverSave = element('button', 'hcx-button hcx-outline', copy.serverSave)
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
  const cancel = button('hcx-button hcx-outline', copy.cancel)
  const retryRestore = button('hcx-button hcx-outline', copy.retryRestore)
  actions.append(start, cancel, retryRestore)
  const links = element('div', 'hcx-links')
  const walletPage = button('hcx-button hcx-outline', copy.walletPage)
  const usagePage = button('hcx-button hcx-outline', copy.usagePage)
  const devicePage = button('hcx-button hcx-outline', copy.devicePage)
  links.append(walletPage, usagePage, devicePage)
  const footer = element('div', 'hcx-footer')
  const groupNote = element('p', 'hcx-note')
  footer.append(groupNote, element('p', 'hcx-note', copy.privacy))
  body.append(header, error, profileCard, balanceCard, planCard, actions, serverLine, serverWarning, serverForm, links, footer)
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
  /** @returns whether the dialog offers a group switch. */
  const renderGroups = (current: string, canSelect: boolean, allowed: readonly string[]): boolean => {
    const catalog = snapshot?.catalogStatus === 'ready' ? snapshot.catalog : undefined
    groups = (catalog?.groups ?? groups).filter(group => allowed.includes(group.name))
    const selectable = canSelect && groups.length > 1 && groups.some(group => group.name === current)
    groupValue.textContent = current
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
    // The confirmation turns primary only once another group is chosen.
    groupConfirm.classList.toggle('hcx-primary', !groupConfirm.disabled)
    groupConfirm.classList.toggle('hcx-outline', groupConfirm.disabled)
    return selectable
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
    groupProgress.textContent = busy === 'group' ? `${copy.switchingGroup} ${pendingGroup}…` : groupNotice
    profileCard.hidden = !signedIn; balanceCard.hidden = !signedIn; planCard.hidden = !signedIn
    // Signed in, the profile card names the account, so the header line only carries sign-in progress.
    status.hidden = signedIn
    status.textContent = account?.status === 'signing-in' ? copy.waiting : copy.signedOut
    const name = signedIn ? account.profile.displayName || account.profile.id : ''
    nameText.textContent = name
    avatar.textContent = Array.from(new Intl.Segmenter().segment(name.trim()), part => part.segment)[0]?.toUpperCase() ?? ''
    groupHint.textContent = ''
    if (signedIn) {
      const selectable = renderGroups(account.group, account.canSelectGroup, account.allowedGroups)
      groupHint.textContent = !account.canSelectGroup ? copy.groupFixed : selectable ? copy.groupSwitchNote : ''
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
    groupNote.textContent = signedIn ? '' : copy.selectGroup
    const needsLogin = [snapshot?.walletError, snapshot?.catalogError, snapshot?.accountRefreshError, actionError].includes('session_expired')
    start.hidden = !signedOut && !needsLogin
    start.disabled = busy !== undefined
    cancel.hidden = account?.status !== 'signing-in' && busy !== 'start'
    cancel.disabled = busy === 'cancel'
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
