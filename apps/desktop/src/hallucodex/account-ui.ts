/** Owned-document account page; renders only safe snapshots and fixed localized copy into the hosts the client page supplies. */
import { AUTO_GROUP, sameGroupSelection, type DesktopAutoGroup, type DesktopGroup, type GroupSelection } from './group-policy.ts'
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
  /** Move this device to another routing; the new state arrives through subscribe. */
  selectGroup(selection: GroupSelection): Promise<GroupSelectionResult>
  /** Re-read only the wallet and device usage; the snapshot change arrives through subscribe. */
  refreshWallet(): Promise<void>
  /** Select another server while signed out; rejects an invalid address. */
  setServer(origin: string): Promise<HalluCodexDesktopSnapshot>
  openPage(page: 'wallet' | 'usage' | 'devices'): Promise<void>
  subscribe(listener: (snapshot: HalluCodexDesktopSnapshot) => void): () => void
}

/** The rendered account page: mounted into the client's page hosts while that page is shown. */
export interface HalluCodexAccountPage {
  /**
   * Render into the page head and content hosts, then re-read the account and, when signed in, the wallet.
   * @param head - Host inside the page's head row, beside the page mark.
   * @param content - Host filling the rest of the page; the layout adapts to its size.
   * @returns once the account state has been read; rejects when the page was disposed meanwhile.
   */
  mount(head: HTMLElement, content: HTMLElement): Promise<void>
  /** Remove the rendered page from its hosts; a sign-in in progress continues and stays cancellable from the page. */
  unmount(): void
  /** Remove the page and its styles and stop following account changes. */
  dispose(): void
}

import type { HalluCodexAccountCopy } from './locale.ts'
export { halluCodexAccountCopy } from './locale.ts'

/** Page styles built from the DSH settings-card and button tokens of the host document, with neutral fallbacks. */
const STYLES = `
.hcx-head, .hcx-page { color: var(--dsw-alias-label-primary, #0f1115); font-family: var(--dsw-font-family, system-ui, sans-serif);
  font-size: 14px; line-height: 22px; -webkit-font-smoothing: antialiased; }
.hcx-head [hidden], .hcx-page [hidden] { display: none !important; }
.hcx-head :where(h1), .hcx-page :where(h2, p, dl, dd) { margin: 0; }
.hcx-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.hcx-head { container: hallucodex-account-head / inline-size; display: flex; align-items: center; gap: 8px 12px; min-width: 0; }
.hcx-title { flex: 0 1 auto; min-width: 0; overflow: hidden; font-size: 20px; font-weight: 500; line-height: 28px; text-overflow: ellipsis; white-space: nowrap; }
.hcx-head-server { min-width: 0; overflow: hidden; color: var(--dsw-alias-label-tertiary, #81858c); font-size: 13px; line-height: 20px;
  text-overflow: ellipsis; white-space: nowrap; }
.hcx-chip { flex: none; display: inline-flex; align-items: center; gap: 6px; height: 24px; padding: 0 9px; border-radius: 999px;
  background: var(--dsw-alias-bg-skeleton, #0000000a); color: var(--dsw-alias-label-secondary, #61666b); font-size: 12px; line-height: 18px; white-space: nowrap; }
.hcx-chip[data-status="signed-in"]::before { content: ''; width: 7px; height: 7px; border-radius: 50%;
  background: var(--dsw-alias-state-success-primary, #16a34a); }
.hcx-head-actions { flex: none; display: flex; gap: 8px; margin-left: auto; }
@container hallucodex-account-head (max-width: 520px) { .hcx-head-server { display: none; } }
/* The account card below names the signed-in account, so the narrowest head keeps the title and Refresh. */
@container hallucodex-account-head (max-width: 440px) { .hcx-chip { display: none; } }

.hcx-page { container: hallucodex-account / size; box-sizing: border-box; display: flex; flex-direction: column; gap: 12px; height: 100%; }
.hcx-page > * { flex: none; }
.hcx-error { padding: 10px 12px; border-radius: var(--dsw-radius-md, 12px); background: var(--dsw-alias-interactive-bg-hover-danger, #ec13130d);
  color: var(--dsw-alias-state-error-primary, #ec1313); font-size: 13px; line-height: 20px; }
.hcx-error:empty { display: none; }
.hcx-notice { display: flex; flex-wrap: wrap; gap: 8px; }
.hcx-notice:not(:has(> :not([hidden]) > :not([hidden]))) { display: none; }
.hcx-page > .hcx-body { flex: 0 1 auto; min-height: 0; display: grid; gap: 14px;
  grid-template-columns: minmax(240px, 340px) minmax(0, 1fr); grid-template-rows: minmax(0, 1fr); }
.hcx-col { display: flex; flex-direction: column; gap: 14px; min-width: 0; min-height: 0; }
.hcx-card { box-sizing: border-box; display: flex; flex: none; flex-direction: column; gap: 12px; min-width: 0; padding: 16px 18px;
  border: .5px solid var(--dsw-alias-settings-card-stroke, var(--dsw-alias-border-l4, #00000029));
  border-radius: var(--dsw-radius-xl, 20px); background: var(--dsw-alias-settings-card-fill, transparent); }
.hcx-label { color: var(--dsw-alias-label-secondary, #61666b); font-size: 13px; line-height: 20px; }
.hcx-note { color: var(--dsw-alias-label-tertiary, #81858c); font-size: 12px; line-height: 18px; overflow-wrap: anywhere; }
.hcx-note:empty { display: none; }
.hcx-note[data-tone="warning"] { color: var(--dsw-alias-state-error-primary, #ec1313); }
.hcx-feedback { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; min-width: 0; }
.hcx-feedback:not(:has(> :not(:empty):not([hidden]))) { display: none; }

.hcx-wallet { display: grid; gap: 4px 12px; grid-template-columns: minmax(0, 1fr) auto;
  grid-template-areas: "label refresh" "amount amount" "time time" "stats stats" "links links"; }
.hcx-figure, .hcx-figure > div { display: contents; }
.hcx-figure dt { grid-area: label; align-self: center; color: var(--dsw-alias-label-secondary, #61666b); font-size: 13px; line-height: 20px; }
.hcx-amount { grid-area: amount; margin-top: 2px; font-size: 28px; font-weight: 500; line-height: 36px; letter-spacing: -.3px;
  font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.hcx-wallet-refresh { grid-area: refresh; }
.hcx-wallet > .hcx-feedback { grid-area: time; }
.hcx-stats { grid-area: stats; display: flex; flex-direction: column; gap: 6px; margin: 8px 0 4px; padding-top: 10px;
  border-top: .5px solid var(--dsw-alias-border-l2, #0000001a); }
.hcx-stats > div { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
.hcx-stats dt { color: var(--dsw-alias-label-secondary, #61666b); font-size: 13px; white-space: nowrap; }
.hcx-stats dd { font-weight: 500; text-align: right; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.hcx-links { grid-area: links; display: flex; flex-wrap: wrap; gap: 4px 16px; }
.hcx-page-link { display: inline-flex; align-items: center; gap: 4px; padding: 0; border: 0; background: transparent;
  color: var(--dsw-alias-state-business-primary, #4176e6); font: inherit; font-size: 13px; line-height: 20px; white-space: nowrap; cursor: pointer; }
.hcx-page-link::after { content: ''; width: 11px; height: 11px; background: currentColor;
  mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12' fill='none'%3E%3Cpath d='M7 2h3v3M10 2L5.5 6.5M9 7v2.5a.5.5 0 0 1-.5.5h-6a.5.5 0 0 1-.5-.5v-6a.5.5 0 0 1 .5-.5H5' stroke='%23000' stroke-width='1.2' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") center / 11px no-repeat; }
.hcx-page-link:not(:disabled):hover { text-decoration: underline; text-underline-offset: 3px; }

.hcx-profile { flex-direction: row; align-items: center; }
.hcx-avatar { flex: none; display: grid; place-items: center; width: 38px; height: 38px; border-radius: 50%;
  background: var(--dsw-alias-bg-skeleton, #0000000a); color: var(--dsw-alias-label-secondary, #61666b); font-size: 16px; font-weight: 500; }
.hcx-identity { flex: 1; min-width: 0; }
.hcx-name { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hcx-origin dd { overflow: hidden; color: var(--dsw-alias-label-tertiary, #81858c); font-size: 12px; line-height: 18px; text-overflow: ellipsis; white-space: nowrap; }
.hcx-profile .hcx-button { flex: none; }

/* The group card keeps its natural height while it fits; with less room only the Auto order list shrinks and scrolls. */
.hcx-groups { flex: 0 1 auto; min-height: 0; }
.hcx-groups > *, .hcx-group > *, .hcx-auto > * { flex: none; }
.hcx-groups > .hcx-group, .hcx-group > .hcx-auto { display: flex; flex: 0 1 auto; flex-direction: column; min-height: 0; }
.hcx-group { gap: 10px; }
.hcx-auto { gap: 8px; padding-top: 10px; border-top: .5px solid var(--dsw-alias-border-l2, #0000001a); }
.hcx-groups-head { display: flex; align-items: baseline; gap: 4px 12px; min-width: 0; overflow: hidden; white-space: nowrap; }
.hcx-groups-head > .hcx-label { flex: none; }
.hcx-plan { display: flex; gap: 12px; min-width: 0; font-size: 12px; line-height: 18px; }
.hcx-plan > div { display: flex; gap: 4px; min-width: 0; }
.hcx-plan dt { color: var(--dsw-alias-label-tertiary, #81858c); }
.hcx-plan dd { overflow: hidden; color: var(--dsw-alias-label-secondary, #61666b); text-overflow: ellipsis; font-variant-numeric: tabular-nums; }
.hcx-inline { display: flex; gap: 8px; }
.hcx-select { flex: 1; min-width: 0; height: 34px; padding: 0 32px 0 12px; appearance: none;
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
.hcx-group-description:empty { display: none; }
.hcx-auto-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.hcx-auto-list { display: flex; flex-direction: column; min-height: 108px; margin: 0; padding: 0; overflow: auto; list-style: none;
  border: .5px solid var(--dsw-alias-border-l3, #0000001f); border-radius: var(--dsw-radius-md, 12px); }
.hcx-auto > .hcx-auto-list { flex: 0 1 auto; }
.hcx-auto-list > .hcx-auto-item { flex: none; }
.hcx-auto-item { display: grid; grid-template-columns: 16px minmax(0, 1fr) auto 56px; align-items: center; gap: 8px;
  min-height: 35px; padding: 0 6px 0 10px; border-top: .5px solid var(--dsw-alias-border-l2, #0000001a); }
.hcx-auto-item:first-child { border-top: 0; }
.hcx-auto-item:hover { background: var(--dsw-alias-interactive-bg-hover, #2631480f); }
.hcx-auto-index { color: var(--dsw-alias-label-tertiary, #81858c); font-size: 12px; text-align: center; font-variant-numeric: tabular-nums; }
.hcx-check { display: flex; align-items: center; gap: 8px; min-width: 0; font-size: 13px; line-height: 20px; cursor: pointer; }
.hcx-check input { flex: none; width: 16px; height: 16px; margin: 0; accent-color: var(--dsw-alias-brand-primary, #0f1115); cursor: inherit; }
.hcx-check:has(input:disabled) { opacity: .5; cursor: default; }
.hcx-check > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hcx-auto-name { flex: none; max-width: 100%; font-weight: 500; }
.hcx-auto-desc { flex: 0 1 auto; min-width: 0; color: var(--dsw-alias-label-tertiary, #81858c); font-size: 12px; }
.hcx-auto-ratio { color: var(--dsw-alias-label-secondary, #61666b); font-size: 12px; white-space: nowrap; font-variant-numeric: tabular-nums; }
.hcx-auto-moves { display: flex; justify-content: flex-end; gap: 2px; }
.hcx-icon { flex: none; display: grid; place-items: center; width: 26px; height: 26px; padding: 0; border: 0; border-radius: 6px;
  background: transparent; color: var(--dsw-alias-label-secondary, #61666b); cursor: pointer; }
.hcx-icon::before { content: ''; width: 12px; height: 12px; background: currentColor;
  mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12' fill='none'%3E%3Cpath d='M3 4.5L6 7.5L9 4.5' stroke='%23000' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") center / 12px no-repeat; }
.hcx-icon[data-action="up"]::before { transform: rotate(180deg); }
.hcx-icon:not(:disabled):hover { background: var(--dsw-alias-interactive-bg-hover, #2631480f); color: var(--dsw-alias-label-primary, #0f1115); }
.hcx-icon:disabled { opacity: .35; cursor: default; }
.hcx-route { display: -webkit-box; overflow: hidden; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }

.hcx-signin { box-sizing: border-box; display: flex; flex-direction: column; align-items: center; gap: 12px;
  width: 100%; max-width: 420px; margin: auto; padding-bottom: 24px; text-align: center; }
.hcx-page > .hcx-signin { flex: 0 1 auto; }
.hcx-signin-title { font-size: 18px; font-weight: 500; line-height: 26px; }
.hcx-actions { display: flex; flex-direction: column; align-items: stretch; gap: 8px; width: 100%; max-width: 280px; }
.hcx-actions:not(:has(> :not([hidden]))) { display: none; }
.hcx-notice .hcx-actions { flex-direction: row; width: auto; max-width: none; }
.hcx-signin .hcx-actions .hcx-button { height: 40px; }
.hcx-field { display: flex; flex-direction: column; gap: 8px; width: 100%; margin: 0; text-align: left; }
.hcx-input { flex: 1; min-width: 0; height: 34px; padding: 0 12px; border: .5px solid var(--dsw-alias-border-l3, #0000001f);
  border-radius: var(--dsw-radius-md, 12px); background: transparent; color: inherit; font: inherit; outline: none;
  transition: border-color var(--ds-transition-duration, .2s) var(--ds-ease-in-out, ease); }
.hcx-input:focus { border-color: var(--dsw-alias-state-business-primary, #4176e6); }
.hcx-input:disabled { color: var(--dsw-alias-label-tertiary, #81858c); }
.hcx-server-line { display: flex; flex-wrap: wrap; justify-content: center; align-items: baseline; gap: 4px 10px;
  color: var(--dsw-alias-label-tertiary, #81858c); font-size: 12px; line-height: 18px; overflow-wrap: anywhere; }
.hcx-privacy { color: var(--dsw-alias-label-tertiary, #81858c); font-size: 12px; line-height: 18px; overflow-wrap: anywhere; }

.hcx-head :is(button, select, input):focus-visible, .hcx-page :is(button, select, input):focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid
  var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, #4176e6)); outline-offset: 1px; }
.hcx-button { box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center; height: 34px; padding: 0 14px;
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
.hcx-link { padding: 2px 0; border: 0; background: transparent; color: var(--dsw-alias-label-secondary, #61666b); font: inherit;
  font-size: 12px; line-height: 18px; cursor: pointer; text-decoration: underline transparent; text-underline-offset: 3px; }
.hcx-link:not(:disabled):hover { color: var(--dsw-alias-label-primary, #0f1115); text-decoration-color: currentColor; }
.hcx-link:disabled { opacity: .4; cursor: default; }

/* Short pages tighten the rhythm before anything has to scroll; narrow rules below win where both apply. */
@container hallucodex-account (max-height: 560px) {
  .hcx-page > .hcx-body, .hcx-col { gap: 10px; }
  .hcx-card { gap: 10px; padding: 12px 14px; }
  .hcx-amount { font-size: 24px; line-height: 32px; }
  .hcx-stats { gap: 3px; margin: 6px 0 2px; padding-top: 8px; }
  .hcx-group-description { display: none; }
  .hcx-auto-item { min-height: 32px; }
}
/* Medium width: the account column narrows; descriptions give way to group names and rates. */
@container hallucodex-account (max-width: 790px) {
  .hcx-page > .hcx-body { grid-template-columns: minmax(230px, .75fr) minmax(0, 1fr); }
}
/* Narrow: one column; wallet and account merge into one compact card so the order list keeps the remaining height. */
@container hallucodex-account (max-width: 590px) {
  .hcx-page > .hcx-body { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto minmax(0, 1fr); gap: 10px; }
  .hcx-account { gap: 8px; padding: 10px 14px; border: .5px solid var(--dsw-alias-settings-card-stroke, var(--dsw-alias-border-l4, #00000029));
    border-radius: var(--dsw-radius-xl, 20px); background: var(--dsw-alias-settings-card-fill, transparent); }
  .hcx-account > .hcx-card { padding: 0; border: 0; border-radius: 0; background: none; }
  .hcx-account > .hcx-profile { padding-top: 8px; border-top: .5px solid var(--dsw-alias-border-l2, #0000001a); }
  .hcx-wallet { grid-template-columns: auto minmax(0, 1fr) auto; gap: 2px 10px;
    grid-template-areas: "label amount refresh" "time time time" "stats stats stats" "links links links"; }
  .hcx-amount { margin: 0; font-size: 20px; line-height: 28px; align-self: center; }
  .hcx-stats { flex-direction: row; flex-wrap: wrap; gap: 0 14px; margin: 0; padding-top: 0; border-top: 0; }
  .hcx-stats > div { justify-content: flex-start; gap: 6px; }
  .hcx-stats dt, .hcx-stats dd { font-size: 12px; }
  .hcx-avatar { width: 28px; height: 28px; font-size: 13px; }
  .hcx-groups { gap: 8px; padding: 12px 14px; }
  .hcx-auto-desc, .hcx-route, .hcx-group-description { display: none; }
  .hcx-auto { padding-top: 8px; }
  .hcx-privacy { font-size: 11px; line-height: 16px; }
}
/* Narrow and short (the minimum window): the menu already carries the rate, so the preview line gives way, and a
   notice above the page takes its height from the order list, which keeps at least one row. */
@container hallucodex-account (max-width: 590px) and (max-height: 520px) {
  .hcx-error { padding: 6px 10px; font-size: 12px; line-height: 18px; }
  .hcx-groups { gap: 6px; }
  .hcx-group { gap: 6px; }
  .hcx-group-meta, .hcx-auto > .hcx-note:not([data-tone="warning"]) { display: none; }
  .hcx-auto-list { min-height: 33px; }
}
/* Squeezed further (a sidebar expanded by hand over a narrow window): controls wrap and the page may scroll. */
@container hallucodex-account (max-width: 400px) {
  .hcx-groups .hcx-inline { flex-wrap: wrap; }
  .hcx-groups .hcx-select { flex-basis: 100%; }
  .hcx-auto-ratio { display: none; }
}
`

/**
 * Create one native-owned account page in the existing application document.
 * @param document - owned main-frame document.
 * @param operations - validated main-process account methods.
 * @param copy - current native locale.
 * @returns explicit mount, unmount and teardown operations.
 */
export function createHalluCodexAccountUi(
  document: Document, operations: HalluCodexAccountUiOperations, copy: HalluCodexAccountCopy,
): HalluCodexAccountPage {
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

  // Head row: title, server, status, and the account refresh that re-reads groups and the model catalog.
  const headRoot = element('div', 'hcx-head')
  const title = element('h1', 'hcx-title', copy.title)
  const headServer = element('span', 'hcx-head-server')
  const status = element('span', 'hcx-chip')
  status.setAttribute('role', 'status')
  const headActions = element('div', 'hcx-head-actions')
  const refresh = button('hcx-button hcx-outline hcx-small', copy.refresh)
  headActions.append(refresh)
  headRoot.append(title, headServer, status, headActions)

  const page = element('div', 'hcx-page')
  const error = element('p', 'hcx-error')
  error.setAttribute('role', 'alert')
  const notice = element('div', 'hcx-notice')

  // Each figure is a dt/dd pair; the wrapping div only groups the pair for layout.
  const term = (list: HTMLDListElement, label: string): HTMLElement => {
    const value = element('dd', '')
    const pair = element('div', '')
    pair.append(element('dt', '', label), value)
    list.append(pair)
    return value
  }
  const balanceCard = element('section', 'hcx-card hcx-wallet')
  const figure = element('dl', 'hcx-figure')
  const walletValue = term(figure, copy.wallet)
  walletValue.className = 'hcx-amount'
  const walletLabel = walletValue.previousElementSibling
  const refreshWallet = button('hcx-button hcx-outline hcx-small hcx-wallet-refresh', copy.refreshWallet)
  const walletFeedback = element('div', 'hcx-feedback')
  const walletProgress = element('p', 'hcx-note')
  walletProgress.setAttribute('role', 'status')
  const walletTime = element('p', 'hcx-note')
  walletFeedback.append(walletProgress, walletTime)
  const stats = element('dl', 'hcx-stats')
  const usageValue = term(stats, copy.accountUsage)
  const deviceValue = term(stats, copy.deviceUsage)
  const limitValue = term(stats, copy.deviceLimit)
  const links = element('div', 'hcx-links')
  const walletPage = button('hcx-page-link', copy.walletPage)
  const usagePage = button('hcx-page-link', copy.usagePage)
  const devicePage = button('hcx-page-link', copy.devicePage)
  links.append(walletPage, usagePage, devicePage)
  balanceCard.append(figure, refreshWallet, walletFeedback, stats, links)

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
  const accountColumn = element('div', 'hcx-col hcx-account')
  accountColumn.append(balanceCard, profileCard)

  const planCard = element('section', 'hcx-card hcx-groups')
  const planHead = element('div', 'hcx-groups-head')
  const plan = element('dl', 'hcx-plan')
  const groupValue = term(plan, copy.group)
  const modelsValue = term(plan, copy.models)
  planHead.append(element('span', 'hcx-label', copy.groupsTitle), plan)
  const groupPanel = element('div', 'hcx-group')
  const groupPicker = element('div', 'hcx-inline')
  const groupSelect = element('select', 'hcx-select')
  groupSelect.setAttribute('aria-label', copy.candidateGroup)
  const groupDiscard = button('hcx-button hcx-outline', copy.discard)
  const groupConfirm = button('hcx-button hcx-outline', copy.switchGroup)
  groupPicker.append(groupSelect, groupDiscard, groupConfirm)
  const groupMeta = element('div', 'hcx-group-meta')
  const groupHeadline = element('p', '')
  const groupName = element('span', 'hcx-group-name')
  const groupRatio = element('span', 'hcx-group-ratio')
  groupHeadline.append(groupName, groupRatio)
  const groupDescription = element('p', 'hcx-group-description')
  groupMeta.append(groupHeadline, groupDescription)
  // Automatic routing: the checked groups, in order, are the device's own order; unchecked groups follow them.
  const autoPanel = element('div', 'hcx-auto')
  const autoHead = element('div', 'hcx-auto-head')
  const autoMode = element('span', 'hcx-label')
  const autoRestore = button('hcx-button hcx-outline hcx-small', copy.autoRestore)
  autoHead.append(autoMode, autoRestore)
  const autoList = element('ol', 'hcx-auto-list')
  autoList.setAttribute('aria-label', copy.routeOrder)
  const autoNote = element('p', 'hcx-note')
  const retryOption = element('label', 'hcx-check')
  const retryBox = element('input', '')
  retryBox.type = 'checkbox'
  retryOption.append(retryBox, element('span', '', copy.autoRetry))
  const routeNote = element('p', 'hcx-note hcx-route')
  autoPanel.append(autoHead, autoList, autoNote, retryOption, routeNote)
  groupPanel.append(groupPicker, groupMeta, autoPanel)
  const groupProgress = element('p', 'hcx-note')
  groupProgress.setAttribute('role', 'status')
  const catalogFeedback = element('div', 'hcx-feedback')
  const catalogProgress = element('p', 'hcx-note')
  catalogProgress.setAttribute('role', 'status')
  const retryCatalog = button('hcx-link', copy.retryCatalog)
  catalogFeedback.append(catalogProgress, retryCatalog)
  const groupHint = element('p', 'hcx-note')
  planCard.append(planHead, groupPanel, groupProgress, catalogFeedback, groupHint)
  const routingColumn = element('div', 'hcx-col')
  routingColumn.append(planCard)
  const body = element('div', 'hcx-body')
  body.append(accountColumn, routingColumn)

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

  const actions = element('div', 'hcx-actions')
  const start = button('hcx-button hcx-primary', copy.signIn)
  const cancel = button('hcx-button hcx-outline', copy.cancel)
  const retryRestore = button('hcx-button hcx-outline', copy.retryRestore)
  actions.append(start, cancel, retryRestore)
  const signin = element('div', 'hcx-signin')
  const signinTitle = element('h2', 'hcx-signin-title')
  const groupNote = element('p', 'hcx-note', copy.selectGroup)
  signin.append(signinTitle, groupNote, actions, serverLine, serverWarning, serverForm)
  const privacy = element('p', 'hcx-privacy', copy.privacy)
  page.append(error, notice, body, signin, privacy)

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
  let autoOffer: DesktopAutoGroup | null = null
  let shownGroups = ''
  let shownOrder = ''
  // The unsaved choice follows the account's routing until the user edits it; the retry choice starts on for a move to auto.
  let pending: GroupSelection = { group: '', autoGroups: null, crossGroupRetry: true }
  let edited = false
  let focusAfterRender: { group: string; action: string } | undefined
  /** @returns the checked groups in order: the device's own order, or the complete global order while following it. */
  const autoOrder = (): string[] => {
    const names = groups.map(group => group.name)
    return (pending.autoGroups ?? autoOffer?.defaultGroups ?? []).filter(name => names.includes(name))
  }
  /** @returns the groups an edit starts from; a custom order made from the global order keeps at most its first allowed groups. */
  const editableOrder = (): string[] => pending.autoGroups === null ? autoOrder().slice(0, autoOffer?.maxGroups ?? 0) : autoOrder()
  /** @returns the selection the server receives: a concrete group has no order or retry choice; an order has only the groups shown. */
  const outgoing = (): GroupSelection => pending.group !== AUTO_GROUP ? { group: pending.group, autoGroups: null, crossGroupRetry: false }
    : { ...pending, autoGroups: pending.autoGroups === null ? null : autoOrder() }
  const edit = (next: Partial<GroupSelection>): void => {
    pending = { ...pending, ...next }
    edited = true
    groupNotice = ''
    render()
  }
  const editOrder = (name: string, action: 'toggle' | 'up' | 'down'): void => {
    const order = editableOrder()
    const index = order.indexOf(name)
    if (action === 'toggle') {
      if (index >= 0) order.splice(index, 1)
      else if (order.length < (autoOffer?.maxGroups ?? 0)) order.push(name)
    } else {
      const other = index + (action === 'up' ? -1 : 1)
      if (index < 0 || other < 0 || other >= order.length) return
      order.splice(other, 0, ...order.splice(index, 1))
    }
    focusAfterRender = { group: name, action }
    edit({ autoGroups: order })
  }
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
  const renderOrder = (automatic: DesktopAutoGroup, disabled: boolean): void => {
    const order = autoOrder()
    const editable = editableOrder()
    const following = pending.autoGroups === null
    const max = automatic.maxGroups
    const full = editable.length >= max
    autoMode.textContent = following ? copy.autoFollowSite(order.length) : copy.autoCustom(order.length, max)
    autoRestore.hidden = following
    autoRestore.disabled = disabled
    retryBox.checked = pending.crossGroupRetry
    retryBox.disabled = disabled
    const warning = following ? order.length === 0 ? copy.autoNoDefault : ''
      : order.length === 0 ? copy.autoEmpty : order.length > max ? copy.autoOverLimit(max) : ''
    autoNote.textContent = warning || (following && order.length > max ? copy.autoKeepFirst(max) : full ? copy.autoLimitReached(max) : '')
    if (warning) autoNote.dataset.tone = 'warning'
    else delete autoNote.dataset.tone
    const rows = [...order, ...groups.map(group => group.name).filter(name => !order.includes(name))]
    const key = JSON.stringify([rows, order.length, editable.length, full, disabled])
    const focus = focusAfterRender
    focusAfterRender = undefined
    if (key === shownOrder) return
    shownOrder = key
    autoList.replaceChildren(...rows.map((name, index) => {
      const checked = index < order.length
      const group = groups.find(candidate => candidate.name === name)
      const item = element('li', 'hcx-auto-item')
      item.title = group?.description ? `${name}: ${group.description}` : name
      const position = element('span', 'hcx-auto-index', checked ? String(index + 1) : '–')
      position.setAttribute('aria-hidden', 'true')
      const option = element('label', 'hcx-check')
      const box = element('input', '')
      box.type = 'checkbox'
      box.checked = checked
      box.disabled = disabled || (!checked && full)
      Object.assign(box.dataset, { group: name, action: 'toggle' })
      box.addEventListener('change', () => { editOrder(name, 'toggle') })
      option.append(box, element('span', 'hcx-auto-name', name), element('span', 'hcx-auto-desc', group?.description ?? ''))
      const ratio = element('span', 'hcx-auto-ratio', group === undefined ? '' : `${copy.ratio}: ${group.ratio}`)
      // Rows without moves keep the empty column so rates stay aligned; global groups past the limit cannot be moved.
      const moves = element('span', 'hcx-auto-moves')
      if (index < editable.length) {
        for (const [action, label, edge] of [['up', copy.moveUp, 0], ['down', copy.moveDown, editable.length - 1]] as const) {
          const move = button('hcx-icon', '')
          move.setAttribute('aria-label', `${label} ${name}`)
          move.disabled = disabled || index === edge
          Object.assign(move.dataset, { group: name, action })
          move.addEventListener('click', () => { editOrder(name, action) })
          moves.append(move)
        }
      }
      item.append(position, option, ratio, moves)
      return item
    }))
    if (focus === undefined) return
    const controls = [...autoList.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input, button')]
      .filter(control => control.dataset.group === focus.group && !control.disabled)
    // A move that reached the edge leaves focus on the opposite move, or the checkbox of a single group.
    ;(controls.find(control => control.dataset.action === focus.action) ?? controls.at(-1))?.focus()
  }
  /** @returns whether the page offers a group switch. */
  const renderGroups = (account: Extract<HalluCodexDesktopSnapshot['account'], { status: 'signed-in' }>): boolean => {
    const catalog = snapshot?.catalogStatus === 'ready' ? snapshot.catalog : undefined
    groups = (catalog?.groups ?? groups).filter(group => account.allowedGroups.includes(group.name))
    if (catalog !== undefined) autoOffer = catalog.auto
    const names = groups.map(group => group.name)
    const options = autoOffer === null ? names : [...names, AUTO_GROUP]
    const current: GroupSelection = { group: account.group, autoGroups: account.autoGroups, crossGroupRetry: account.crossGroupRetry }
    const selectable = account.canSelectGroup && options.length > 1 && options.includes(current.group)
    groupValue.textContent = current.group
    groupSelect.hidden = !selectable
    groupPanel.hidden = !selectable
    const key = JSON.stringify([groups, autoOffer !== null])
    if (key !== shownGroups) {
      groupSelect.replaceChildren(...options.map((name) => {
        const option = element('option', '', name === AUTO_GROUP ? copy.autoOption : name)
        option.value = name
        return option
      }))
      shownGroups = key
    }
    if (!edited || !options.includes(pending.group)) {
      pending = { ...current, crossGroupRetry: current.group !== AUTO_GROUP || current.crossGroupRetry }
      edited = false
    }
    groupSelect.value = pending.group
    const automatic = pending.group === AUTO_GROUP ? autoOffer : null
    const candidate = groups.find(group => group.name === pending.group)
    groupName.textContent = automatic === null ? candidate?.name ?? '' : AUTO_GROUP
    groupRatio.textContent = automatic !== null ? copy.autoBilling : candidate === undefined ? '' : `${copy.ratio}: ${candidate.ratio}`
    groupDescription.textContent = automatic?.description ?? candidate?.description ?? ''
    groupSelect.disabled = busy !== undefined || snapshot?.catalogStatus !== 'ready' || snapshot.accountRefreshStatus === 'loading'
    autoPanel.hidden = automatic === null
    if (automatic !== null) renderOrder(automatic, groupSelect.disabled)
    const order = automatic === null ? [] : autoOrder()
    const valid = automatic === null || (order.length > 0 && (pending.autoGroups === null || order.length <= automatic.maxGroups))
    const unchanged = sameGroupSelection(outgoing(), current)
    groupConfirm.textContent = current.group === AUTO_GROUP && pending.group === AUTO_GROUP ? copy.saveRouting : copy.switchGroup
    groupConfirm.disabled = groupSelect.disabled || !valid || unchanged
    // The confirmation turns primary only once another routing is chosen.
    groupConfirm.classList.toggle('hcx-primary', !groupConfirm.disabled)
    groupConfirm.classList.toggle('hcx-outline', groupConfirm.disabled)
    // Discard appears only with something to discard, so the menu keeps its width otherwise.
    groupDiscard.hidden = !edited || unchanged
    groupDiscard.disabled = groupSelect.disabled
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
      groups = []; autoOffer = null; shownGroups = ''; shownOrder = ''; edited = false; groupNotice = ''; actionError = undefined
      groupSelect.replaceChildren()
      operationMessage = ''
    }
    error.textContent = operationMessage
    groupProgress.textContent = busy === 'group' ? `${copy.switchingGroup} ${pending.group}…` : groupNotice
    body.hidden = !signedIn
    signin.hidden = signedIn
    headActions.hidden = !signedIn
    status.dataset.status = account?.status ?? 'signed-out'
    status.textContent = signedIn ? copy.signedIn : account?.status === 'signing-in' ? copy.signingIn : copy.signedOut
    signinTitle.textContent = account?.status === 'signing-in' ? copy.waiting : copy.signedOut
    headServer.textContent = snapshot?.serverOrigin ?? ''
    // The sign-in actions sit in the sign-in panel; a signed-in account whose login expired gets them above the page.
    if (signedIn) notice.append(actions)
    else signin.insertBefore(actions, serverLine)
    const name = signedIn ? account.profile.displayName || account.profile.id : ''
    nameText.textContent = name
    avatar.textContent = Array.from(new Intl.Segmenter().segment(name.trim()), part => part.segment)[0]?.toUpperCase() ?? ''
    groupHint.textContent = ''
    routeNote.textContent = ''
    if (signedIn) {
      const selectable = renderGroups(account)
      const routes = account.group === AUTO_GROUP && snapshot?.catalogStatus === 'ready' ? snapshot.catalog?.routeGroups : undefined
      routeNote.textContent = routes === undefined ? '' : routes.length === 0 ? copy.autoNoRoute : `${copy.routeOrder}: ${routes.join(' → ')}`
      if (routes?.length === 0) routeNote.dataset.tone = 'warning'
      else delete routeNote.dataset.tone
      // The note names Switch group, so it is left out while the confirmation saves auto settings.
      groupHint.textContent = !account.canSelectGroup ? copy.groupFixed
        : selectable && groupConfirm.textContent === copy.switchGroup ? copy.groupSwitchNote : ''
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
    groupNote.hidden = account?.status === 'signing-in'
    const needsLogin = [snapshot?.walletError, snapshot?.catalogError, snapshot?.accountRefreshError, actionError].includes('session_expired')
    start.hidden = !signedOut && !needsLogin
    start.disabled = busy !== undefined || snapshot === null
    cancel.hidden = account?.status !== 'signing-in' && busy !== 'start'
    cancel.disabled = busy === 'cancel'
    refresh.textContent = busy === 'refresh' || snapshot?.accountRefreshStatus === 'loading' ? copy.refreshing : copy.refresh
    refresh.disabled = busy !== undefined || snapshot?.accountRefreshStatus === 'loading'
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
    const selection = outgoing()
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
        const previous = snapshot?.account.status === 'signed-in' ? snapshot.account.group : undefined
        const result = await operations.selectGroup(selection)
        await readState(operation)
        if (operation === generation && snapshot?.account.status === 'signed-in') {
          if (result === 'selected') groupNotice = selection.group === previous ? copy.routingSaved : `${copy.groupSelected} ${selection.group}`
          else actionError = result
          edited = false
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
  groupSelect.addEventListener('change', () => { edit({ group: groupSelect.value }) })
  autoRestore.addEventListener('click', () => { edit({ autoGroups: null }) })
  retryBox.addEventListener('change', () => { edit({ crossGroupRetry: retryBox.checked }) })
  groupDiscard.addEventListener('click', () => { edited = false; groupNotice = ''; render() })
  groupConfirm.addEventListener('click', () => { void perform('group') })
  refreshWallet.addEventListener('click', () => { void perform('wallet') })
  retryCatalog.addEventListener('click', () => { void perform('catalog') })
  retryRestore.addEventListener('click', () => { void perform('restore') })
  serverForm.addEventListener('submit', (event) => { event.preventDefault(); void perform('server') })
  serverEdit.addEventListener('click', () => { serverExpanded = true; render(); serverInput.focus(); serverInput.select() })
  serverReset.addEventListener('click', () => { serverInput.value = DEFAULT_HALLUCODEX_ORIGIN; void perform('server') })
  for (const [link, target] of [[walletPage, 'wallet'], [devicePage, 'devices'], [usagePage, 'usage']] as const) {
    link.addEventListener('click', () => {
      const operation = generation
      void operations.openPage(target).catch(() => {
        if (operation === generation && !lifetime.signal.aborted) { operationMessage = copy.failed; render() }
      })
    })
  }
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
    async mount(head, content) {
      if (lifetime.signal.aborted) return
      head.replaceChildren(headRoot)
      content.replaceChildren(page)
      const version = revision
      const request = ++opening
      const next = await operations.state()
      lifetime.signal.throwIfAborted()
      if (request !== opening) return
      if (version === revision) snapshot = next
      operationMessage = ''; render()
      const operation = generation
      if (snapshot?.account.status === 'signed-in') void operations.refreshWallet().catch((_walletError: unknown) => {
        if (operation === generation && !lifetime.signal.aborted) { operationMessage = copy.failed; render() }
      })
    },
    unmount() { opening++; headRoot.remove(); page.remove() },
    dispose() { lifetime.abort(); generation++; opening++; unsubscribe(); headRoot.remove(); page.remove(); style.remove() },
  }
}
