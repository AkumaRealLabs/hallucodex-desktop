import { describe, expect, it, vi } from 'vitest'
import { readHalluCodexQuotaDisplay } from '../src/hallucodex/account-info.ts'
import { formatQuota, parseQuotaDisplay, type HalluCodexQuotaDisplay } from '../src/hallucodex/quota-display.ts'

function status(data: Record<string, unknown>): unknown {
  return { success: true, message: '', data: { quota_per_unit: 500000, ...data } }
}

describe('site quota display settings', () => {
  it('reads each display type with the rate that applies to it', () => {
    expect(parseQuotaDisplay(status({ quota_display_type: 'USD', usd_exchange_rate: 7.3 })))
      .toEqual({ type: 'USD', quotaPerUnit: 500000, rate: 1, symbol: '¤' })
    expect(parseQuotaDisplay(status({ quota_display_type: 'CNY', usd_exchange_rate: 7.3 })))
      .toEqual({ type: 'CNY', quotaPerUnit: 500000, rate: 7.3, symbol: '¤' })
    expect(parseQuotaDisplay(status({ quota_display_type: 'CUSTOM', custom_currency_symbol: ' pts ', custom_currency_exchange_rate: 100 })))
      .toEqual({ type: 'CUSTOM', quotaPerUnit: 500000, rate: 100, symbol: 'pts' })
    expect(parseQuotaDisplay(status({ quota_display_type: 'TOKENS' })).type).toBe('TOKENS')
  })

  it('falls back like the web console and refuses a status without a quota unit', () => {
    expect(parseQuotaDisplay(status({ quota_display_type: 'CNY', usd_exchange_rate: 0 })).rate).toBe(1)
    expect(parseQuotaDisplay(status({ quota_display_type: 'CUSTOM', custom_currency_symbol: '\n' })).symbol).toBe('¤')
    // Servers older than quota_display_type only report display_in_currency.
    expect(parseQuotaDisplay(status({ display_in_currency: false })).type).toBe('TOKENS')
    expect(parseQuotaDisplay(status({ quota_display_type: 'EUR' })).type).toBe('USD')
    expect(() => parseQuotaDisplay(status({ quota_per_unit: 0 }))).toThrow('quota unit')
    expect(() => parseQuotaDisplay({ success: false, data: { quota_per_unit: 500000 } })).toThrow('site status')
  })
})

describe('quota amounts', () => {
  const display = (type: HalluCodexQuotaDisplay['type'], rate = 1, symbol = '¤'): HalluCodexQuotaDisplay => ({ type, quotaPerUnit: 500000, rate, symbol })

  it('converts quota to the site currency with two decimals, or four below one unit', () => {
    expect(formatQuota('6172839', display('USD'), 'en-US')).toBe('$12.35')
    expect(formatQuota('500000', display('USD'), 'zh-CN')).toBe('$1')
    expect(formatQuota('500000', display('CNY', 7.3), 'zh-CN')).toBe('¥7.3')
    expect(formatQuota('1234', display('USD'), 'en-US')).toBe('$0.0025')
    expect(formatQuota('1', display('USD'), 'en-US')).toBe('$0.0001')
    expect(formatQuota('-500000', display('USD'), 'en-US')).toBe('-$1')
    expect(formatQuota('500000', display('CUSTOM', 100, 'pts'), 'en-US')).toBe('pts 100')
  })

  it('shows raw quota in token mode and without site settings', () => {
    expect(formatQuota('123456', display('TOKENS'), 'en-US')).toBe('123.5k')
    expect(formatQuota('999', display('TOKENS'), 'en-US')).toBe('999')
    expect(formatQuota('9007199254740993', undefined, 'en-US')).toBe('9007199254740993')
  })

  it('reads the settings from the public status without an account credential', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(status({ quota_display_type: 'CNY', usd_exchange_rate: 7 })))
      .mockResolvedValueOnce(new Response('<html></html>', { headers: { 'content-type': 'text/html' } }))
    await expect(readHalluCodexQuotaDisplay(fetcher, 'http://localhost:3000', new AbortController().signal))
      .resolves.toEqual({ type: 'CNY', quotaPerUnit: 500000, rate: 7, symbol: '¤' })
    expect(fetcher.mock.calls[0]?.[0]).toBe('http://localhost:3000/api/status')
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ credentials: 'omit', redirect: 'error' })
    expect(fetcher.mock.calls[0]?.[1]?.headers).not.toHaveProperty('authorization')
    await expect(readHalluCodexQuotaDisplay(fetcher, 'http://localhost:3000', new AbortController().signal))
      .rejects.toThrow(/^hallucodex: quota display unavailable$/u)
  })
})
