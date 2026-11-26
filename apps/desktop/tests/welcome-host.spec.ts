/** Native settings reads reuse authenticated Web RPC and never read credential values. */
import { describe, expect, it, vi } from 'vitest'
import { connectDesktopWelcome } from '../src/welcome-backend.ts'

function transport(preference?: string) {
  const keys = new Set<string>()
  const namespaces = [
    { ns: 'llm-deepseek', value: { apiKeyEnv: 'CUSTOM_DEEPSEEK_KEY' } },
    { ns: 'llm-pi-ai', value: { profiles: { example: { apiKeyEnv: 'EXAMPLE_API_KEY' } } } },
    { ns: 'locale', value: preference === undefined ? {} : { preference } },
  ]
  const providers = [
    { settingsNs: 'llm-deepseek', settingsPath: [] },
    { settingsNs: 'llm-pi-ai', settingsPath: ['profiles', 'example'] },
  ]
  const send = vi.fn<NonNullable<Parameters<typeof connectDesktopWelcome>[2]>>(async (_input, init) => {
    const { rpcId, method, payload } = JSON.parse(init!.body as string) as {
      rpcId: string
      method: string
      payload: { args: { refs: string[] } }
    }
    let value: unknown
    if (method === 'settings/describe') value = { namespaces }
    else if (method === 'llm/listConfigurableProviders') value = providers
    else value = Object.fromEntries(payload.args.refs.map(ref => [ref, { configured: keys.has(ref), writable: true }]))
    return Response.json({ type: 'server-response', rpcId, result: { ok: true, value } })
  })
  return { send, keys, namespaces, providers }
}

const url = 'http://127.0.0.1:19387/'
const cookie = 'dsh-auth-fixture=signed'

describe('desktop native settings Web operations', () => {
  it.each(['light', 'dark', 'system'] as const)('reads the live %s theme in the existing settings request', async (preference) => {
    const host = transport()
    host.namespaces.push({ ns: 'ui-theme', value: { preference } })
    const backend = connectDesktopWelcome(url, cookie, host.send)
    expect(await backend.read()).toMatchObject({ themePreference: preference })
    expect(host.send.mock.calls.filter(([input]) => input.endsWith('/api/settings/describe'))).toHaveLength(1)
    host.namespaces.find(item => item.ns === 'ui-theme')!.value.preference = 'system'
    expect(await backend.read()).toMatchObject({ themePreference: 'system' })
  })

  it('falls back for an invalid optional theme without blocking startup metadata', async () => {
    const host = transport()
    host.namespaces.push({ ns: 'ui-theme', value: { preference: 'invalid' } })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(await connectDesktopWelcome(url, cookie, host.send).read()).toMatchObject({ themePreference: 'system' })
      expect(warn).toHaveBeenCalledOnce()
    } finally { warn.mockRestore() }
  })

  it('authenticates with the explicit Host cookie and reads only credential metadata over authenticated RPC', async () => {
    const host = transport()
    const backend = connectDesktopWelcome(url, cookie, host.send)
    expect(await backend.read()).toEqual({ hasApiKey: false, localePreference: null, themePreference: 'system' })
    const methods = /^http:\/\/127\.0\.0\.1:19387\/api\/(?:settings\/describe|llm\/listConfigurableProviders|credentials\/describe)$/u
    for (const [input, init] of host.send.mock.calls) {
      expect(input).toMatch(methods)
      expect(init).toMatchObject({ redirect: 'error', headers: { cookie } })
      expect(init).not.toHaveProperty('credentials')
    }
  })

  it('reads the explicit language preference and recognizes a key under any configurable provider', async () => {
    const host = transport('zh')
    const backend = connectDesktopWelcome(url, cookie, host.send)
    host.keys.add('CUSTOM_DEEPSEEK_KEY')
    expect(await backend.read()).toEqual({ hasApiKey: true, localePreference: 'zh', themePreference: 'system' })
    host.keys.clear()
    host.keys.add('EXAMPLE_API_KEY')
    expect(await backend.read()).toMatchObject({ hasApiKey: true })
    host.keys.clear()
    expect(await backend.read()).toMatchObject({ hasApiKey: false })
  })

  it('ignores a settings row that no configurable provider names', async () => {
    const host = transport()
    host.providers.splice(0, 1)
    host.keys.add('CUSTOM_DEEPSEEK_KEY')
    const backend = connectDesktopWelcome(url, cookie, host.send)
    expect(await backend.read()).toMatchObject({ hasApiKey: false })
    host.keys.add('EXAMPLE_API_KEY')
    expect(await backend.read()).toMatchObject({ hasApiKey: true })
  })

  it('reads language without querying account or model providers', async () => {
    const host = transport('zh')
    const backend = connectDesktopWelcome(url, cookie, host.send)
    host.send.mockClear()
    expect(await backend.readLocalePreference()).toBe('zh')
    expect(host.send).toHaveBeenCalledOnce()
    expect(host.send.mock.calls[0]![0]).toContain('/api/settings/describe')
  })

  it('rejects unmatched RPC envelopes', async () => {
    const host = transport()
    const backend = connectDesktopWelcome(url, cookie, host.send)
    host.send.mockResolvedValueOnce(Response.json({ type: 'server-response', rpcId: 'other', result: { ok: true } }))
    await expect(backend.read()).rejects.toThrow('Web RPC failed')
  })
})
