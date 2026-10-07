/** Quota display settings from New API's public site status, applied the way its web console shows balances. */

/** How the site shows quota: US dollars, yuan, a custom unit, or raw quota. */
export interface HalluCodexQuotaDisplay {
  readonly type: 'USD' | 'CNY' | 'CUSTOM' | 'TOKENS'
  /** Quota units per US dollar. */
  readonly quotaPerUnit: number
  /** Display units per US dollar: the yuan or custom exchange rate, otherwise 1. */
  readonly rate: number
  /** Unit symbol, used only by CUSTOM. */
  readonly symbol: string
}

const DISPLAY_TYPES = ['USD', 'CNY', 'CUSTOM', 'TOKENS'] as const

function positive(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

/**
 * Read the display settings from a GET /api/status response.
 * @param value - Untrusted decoded JSON.
 * @returns The settings, with the web console's fallbacks for unset rates and symbols.
 * @throws When the response is not a successful status or has no usable quota unit.
 */
export function parseQuotaDisplay(value: unknown): HalluCodexQuotaDisplay {
  if (typeof value !== 'object' || value === null || !('success' in value) || value.success !== true
    || !('data' in value) || typeof value.data !== 'object' || value.data === null) {
    throw new Error('hallucodex: invalid site status')
  }
  const data = value.data as Record<string, unknown>
  const quotaPerUnit = positive(data.quota_per_unit)
  if (quotaPerUnit === undefined) throw new Error('hallucodex: invalid quota unit')
  const declared = DISPLAY_TYPES.find(type => type === data.quota_display_type)
  // Servers older than quota_display_type only say whether quota is shown as currency.
  const type = declared ?? (data.display_in_currency === false ? 'TOKENS' : 'USD')
  const symbol = typeof data.custom_currency_symbol === 'string' ? data.custom_currency_symbol.trim() : ''
  return {
    type, quotaPerUnit,
    rate: (type === 'CNY' ? positive(data.usd_exchange_rate) : type === 'CUSTOM' ? positive(data.custom_currency_exchange_rate) : 1) ?? 1,
    symbol: symbol.length > 0 && symbol.length <= 16 && !/[\u0000-\u001f\u007f]/u.test(symbol) ? symbol : '¤',
  }
}

function trimZeros(value: string): string {
  return value.includes('.') ? value.replace(/(\.\d*?)0+$/u, '$1').replace(/\.$/u, '') : value
}

/**
 * Format a quota counter like the web console's balance cards.
 * @param quota - Decimal quota counter from the server.
 * @param display - Site settings, or undefined when they could not be read.
 * @param locale - Number formatting locale of the dialog.
 * @returns The amount in the site's unit, or the raw counter without settings.
 */
export function formatQuota(quota: string, display: HalluCodexQuotaDisplay | undefined, locale: string): string {
  const raw = Number(quota)
  if (display === undefined || !Number.isFinite(raw)) return quota
  if (display.type === 'TOKENS') {
    if (Math.abs(raw) >= 1000) return `${trimZeros((raw / 1000).toFixed(1))}k`
    return trimZeros(raw.toFixed(Math.abs(raw) >= 1 ? 0 : 4))
  }
  const amount = raw / display.quotaPerUnit * display.rate
  const digits = Math.abs(amount) >= 1 ? 2 : 4
  // Like the web console, a nonzero amount never rounds to zero.
  const threshold = 10 ** -digits
  const shown = amount !== 0 && Math.abs(amount) < threshold ? Math.sign(amount) * threshold : amount
  const options = { minimumFractionDigits: 0, maximumFractionDigits: digits }
  if (display.type === 'CUSTOM') return `${display.symbol} ${new Intl.NumberFormat(locale, options).format(shown)}`
  return new Intl.NumberFormat(locale, { ...options, style: 'currency', currency: display.type, currencyDisplay: 'narrowSymbol' }).format(shown)
}
