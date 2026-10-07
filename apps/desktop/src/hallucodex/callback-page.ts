/** Static browser page the loopback callback answers with; it carries no script and no request data. */

import { createHash } from 'node:crypto'

/** What the callback did with one browser request. */
export type CallbackOutcome = 'approved' | 'denied' | 'invalid' | 'expired'

type CallbackCopy = Readonly<Record<CallbackOutcome, readonly [title: string, body: string]>> & {
  readonly lang: string
  readonly product: string
}

const COPY: Readonly<Record<'zh' | 'en', CallbackCopy>> = {
  zh: {
    lang: 'zh-CN',
    product: 'HalluCodex 桌面端',
    approved: ['授权完成', '请回到 HalluCodex 桌面端，登录会自动完成。此页面可以关闭。'],
    denied: ['已拒绝授权', 'HalluCodex 桌面端没有获得你账号的访问权限。此页面可以关闭。'],
    invalid: ['链接无效', '这个授权回调无法使用，请回到 HalluCodex 桌面端重新登录。'],
    expired: ['登录已失效', '本次登录已过期或已取消，请回到 HalluCodex 桌面端重新登录。'],
  },
  en: {
    lang: 'en',
    product: 'HalluCodex Desktop',
    approved: ['Authorization complete', 'Return to HalluCodex Desktop; sign-in finishes there automatically. You can close this page.'],
    denied: ['Authorization denied', 'HalluCodex Desktop did not get access to your account. You can close this page.'],
    invalid: ['Invalid link', 'This authorization callback cannot be used. Return to HalluCodex Desktop and sign in again.'],
    expired: ['Sign-in expired', 'This sign-in expired or was cancelled. Return to HalluCodex Desktop and sign in again.'],
  },
}

const STYLE = `
:root { color-scheme: light dark; --bg: #f7f8fa; --card: #fff; --text: #0f1115; --muted: #5c6370; --border: #0000001a;
  --ok: #1f7a4d; --ok-bg: #e7f5ed; --warn: #a15c07; --warn-bg: #fdf1e1; --bad: #c0392b; --bad-bg: #fbeae8; }
@media (prefers-color-scheme: dark) { :root { --bg: #111317; --card: #1a1d23; --text: #eceef2; --muted: #a0a7b4; --border: #ffffff1f;
  --ok: #5fd39a; --ok-bg: #173527; --warn: #f0b45c; --warn-bg: #3a2a12; --bad: #ff8a7a; --bad-bg: #3d1c18; } }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px; background: var(--bg); color: var(--text);
  font: 14px/22px system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; -webkit-font-smoothing: antialiased; }
main { width: min(420px, 100%); padding: 32px 28px 28px; border: 1px solid var(--border); border-radius: 16px; background: var(--card);
  box-shadow: 0 24px 64px #0000001a, 0 2px 8px #0000000f; text-align: center; }
.brand { display: inline-flex; align-items: center; gap: 8px; color: var(--muted); font-size: 13px; }
.brand svg { width: 18px; height: 18px; color: var(--text); }
.status { width: 48px; height: 48px; margin: 24px auto 16px; border-radius: 50%; display: grid; place-items: center; }
.status svg { width: 24px; height: 24px; }
.approved .status { background: var(--ok-bg); color: var(--ok); }
.denied .status, .expired .status { background: var(--warn-bg); color: var(--warn); }
.invalid .status { background: var(--bad-bg); color: var(--bad); }
h1 { margin: 0 0 8px; font-size: 20px; line-height: 28px; font-weight: 600; }
p { margin: 0; color: var(--muted); }
`

/** The only style the callback page may apply; CSP pins it by hash and allows nothing else. */
const STYLE_HASH = createHash('sha256').update(STYLE).digest('base64')

/** Response header pinning the page to its one inline style. */
export const CALLBACK_PAGE_CSP = `default-src 'none'; style-src 'sha256-${STYLE_HASH}'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`

const MARK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M5.5 2A2.5 2.5 0 0 1 8 4.5V19.5A2.5 2.5 0 0 1 3 19.5V4.5A2.5 2.5 0 0 1 5.5 2Z'
  + 'M18.5 2A2.5 2.5 0 0 1 21 4.5V19.5A2.5 2.5 0 0 1 16 19.5V4.5A2.5 2.5 0 0 1 18.5 2ZM8 12.4L16 8V11.6L8 16Z"/></svg>'

const ICONS: Readonly<Record<CallbackOutcome, string>> = {
  approved: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  denied: '<path d="M12 7v6M12 16.5v.5"/><circle cx="12" cy="12" r="9"/>',
  expired: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5V12l3 2"/>',
  invalid: '<path d="M7 7l10 10M17 7L7 17"/>',
}

/**
 * Pick the page language from the browser's own preference.
 * @param acceptLanguage - The request's Accept-Language header.
 * @returns Chinese when the first preference is any Chinese variant, otherwise English.
 */
export function callbackLanguage(acceptLanguage: string | undefined): 'zh' | 'en' {
  return acceptLanguage?.trim().toLowerCase().startsWith('zh') === true ? 'zh' : 'en'
}

/**
 * Render the complete callback page for one outcome; every byte is a constant of this module.
 * @param outcome - What the callback did with the request.
 * @param language - Page language.
 * @returns The HTML document.
 */
export function callbackPage(outcome: CallbackOutcome, language: 'zh' | 'en'): string {
  const copy = COPY[language]
  const [title, body] = copy[outcome]
  return '<!doctype html>'
    + `<html lang="${copy.lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">`
    + `<meta name="referrer" content="no-referrer"><title>${title} · HalluCodex</title><style>${STYLE}</style></head>`
    + `<body><main class="${outcome}"><div class="brand">${MARK}<span>${copy.product}</span></div>`
    + `<div class="status"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[outcome]}</svg></div>`
    + `<h1>${title}</h1><p>${body}</p></main></body></html>`
}
