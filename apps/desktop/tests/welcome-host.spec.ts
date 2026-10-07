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
  const send = vi.fn<Parameters<typeof connectDesktopWelcome>[1]>(async (_input, init) => {
    if (init?.method !== 'POST') return new Response('index')
    const { rpcId, method, payload } = JSON.parse(init.body as string) as {
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

const url = 'http://127.0.0.1:19387/?token=fixture'

describe('desktop native settings Web operations', () => {
  it('authenticates through Web and reads only credential metadata over authenticated RPC', async () => {
    const host = transport()
    const backend = await connectDesktopWelcome(url, host.send)
    expect(host.send).toHaveBeenCalledExactlyOnceWith(url, { credentials: 'include' })
    expect(await backend.read()).toEqual({ hasApiKey: false, localePreference: null })
    const methods = /^http:\/\/127\.0\.0\.1:19387\/api\/(?:settings\/describe|llm\/listConfigurableProviders|credentials\/describe)$/u
    for (const [input, init] of host.send.mock.calls.slice(1)) {
      expect(input).toMatch(methods)
      expect(init).toMatchObject({ credentials: 'include', redirect: 'error' })
    }
  })

  it('reads the explicit language preference and recognizes a key under any configurable provider', async () => {
    const host = transport('zh')
    const backend = await connectDesktopWelcome(url, host.send)
    host.keys.add('CUSTOM_DEEPSEEK_KEY')
    expect(await backend.read()).toEqual({ hasApiKey: true, localePreference: 'zh' })
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
    const backend = await connectDesktopWelcome(url, host.send)
    expect(await backend.read()).toMatchObject({ hasApiKey: false })
    host.keys.add('EXAMPLE_API_KEY')
    expect(await backend.read()).toMatchObject({ hasApiKey: true })
  })

  it('reads language without querying account or model providers', async () => {
    const host = transport('zh')
    const backend = await connectDesktopWelcome(url, host.send)
    host.send.mockClear()
    expect(await backend.readLocalePreference()).toBe('zh')
    expect(host.send).toHaveBeenCalledOnce()
    expect(host.send.mock.calls[0]![0]).toContain('/api/settings/describe')
  })

  it('rejects unmatched RPC envelopes', async () => {
    const host = transport()
    const backend = await connectDesktopWelcome(url, host.send)
    host.send.mockResolvedValueOnce(Response.json({ type: 'server-response', rpcId: 'other', result: { ok: true } }))
    await expect(backend.read()).rejects.toThrow('Web RPC failed')
  })

  it('refuses an unauthenticated Web launch', async () => {
    const send = vi.fn<Parameters<typeof connectDesktopWelcome>[1]>(async () => new Response(null, { status: 401 }))
    await expect(connectDesktopWelcome(url, send)).rejects.toThrow('Web authentication failed')
  })
})
