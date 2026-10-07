import { describe, expect, it, vi } from 'vitest'
import { allowedGroup, concreteGroup, parseDesktopGroups } from '../src/hallucodex/group-policy.ts'
import { desktopEndpoint, parseDesktopModels } from '../src/hallucodex/catalog.ts'
import { HalluCodexRelayBroker } from '../src/hallucodex/relay-broker.ts'
import type { RelayAccess, RelaySelection } from '../src/hallucodex/relay-broker.ts'

const selection: RelaySelection = {
  deviceSessionId: 'test-device', group: 'discount', allowedGroups: ['discount', 'default'],
  models: [{ id: 'fixture-model', endpoints: ['/v1/chat/completions', '/v1/responses', '/v1/messages'] }],
}
const access: RelayAccess = { accessToken: 'test-only-token', deviceSessionId: 'test-device', group: 'discount' }
const ORIGIN = 'https://api.hallucodex.com'

function fixture(response = new Response('data: {"delta":"ok"}\n\ndata: [DONE]\n\n', {
  headers: { 'content-type': 'text/event-stream' },
})) {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response)
  const resolve = vi.fn<() => Promise<RelayAccess>>().mockResolvedValue(access)
  const broker = new HalluCodexRelayBroker({ fetch, access: resolve, origin: () => ORIGIN, maxRequestBytes: 1024 })
  broker.configure(selection)
  return { broker, fetch, resolve }
}

describe('HalluCodex explicit group policy', () => {
  it.each(['', 'auto', 'AUTO', 'Auto', ' auto', 'default ', '\n', null, undefined])('refuses implicit or automatic group %s', (group) => {
    expect(() => concreteGroup(group)).toThrow('concrete group')
  })
  it('distinguishes literal default from inheritance and never grants a public group', () => {
    expect(allowedGroup('default', ['default'])).toBe('default')
    expect(() => allowedGroup('discount', ['default'])).toThrow('not allowed')
    expect(() => allowedGroup('default', ['default', 'auto'])).toThrow('concrete group')
  })
  it('parses only concrete authenticated groups, preserving a free ratio', () => {
    expect(parseDesktopGroups({ groups: [{ name: 'default', description: 'Free fixture', ratio: 0 }] }))
      .toEqual([{ name: 'default', description: 'Free fixture', ratio: 0 }])
    expect(() => parseDesktopGroups({ groups: [{ name: 'auto', description: '', ratio: 1 }] })).toThrow()
    expect(() => parseDesktopGroups({ groups: [{ name: 'default', description: '', ratio: -1 }] })).toThrow()
    expect(() => parseDesktopGroups({ groups: [
      { name: 'default', description: '', ratio: 1 }, { name: 'default', description: '', ratio: 1 },
    ] })).toThrow('duplicate')
  })
})

describe('HalluCodex group-scoped catalog', () => {
  it('normalizes advertised response aliases and refuses unknown protocols', () => {
    expect(desktopEndpoint('openai-response')).toBe('/v1/responses')
    expect(desktopEndpoint('openai-responses')).toBe('/v1/responses')
    expect(desktopEndpoint('gemini')).toBeUndefined()
    expect(desktopEndpoint('https://untrusted.example/v1/responses')).toBeUndefined()
  })
  it('does not infer a model protocol or accept a catalog for a different group', () => {
    const data = [
      { id: 'name-is-not-a-protocol', endpoints: ['openai-response', 'openai-responses'] },
      { id: 'unknown-model', endpoints: ['unsupported'] },
    ]
    expect(parseDesktopModels({ group: 'discount', data }, 'discount')).toEqual([
      { id: 'name-is-not-a-protocol', endpoints: ['/v1/responses'] },
    ])
    expect(() => parseDesktopModels({ group: 'default', data }, 'discount')).toThrow('group mismatch')
    expect(() => parseDesktopModels({ group: 'discount', data: [...data, data[0]] }, 'discount')).toThrow('duplicate')
  })
})

describe('HalluCodex private relay admission', () => {
  it.each(['/v1/chat/completions', '/v1/responses', '/v1/messages'] as const)('streams %s only to the configured origin', async (endpoint) => {
    const { broker, fetch } = fixture()
    const result = await broker.invoke(endpoint, { model: 'fixture-model', stream: true, messages: [] })
    expect(result.group).toBe('discount')
    expect(await result.response.text()).toContain('[DONE]')
    expect(fetch).toHaveBeenCalledOnce()
    expect(fetch).toHaveBeenCalledWith(`https://api.hallucodex.com${endpoint}`, expect.objectContaining({
      method: 'POST', redirect: 'error', credentials: 'omit', cache: 'no-store',
    }))
    expect(fetch.mock.calls[0]?.[1]?.headers).toMatchObject({ authorization: 'Bearer test-only-token' })
  })
  it.each([{ group: 'auto' }, { group: 'default' }, { auto_groups: [] }, { cross_group_retry: false }])('rejects payload group controls %s', async (routing) => {
    const { broker, fetch } = fixture()
    await expect(broker.invoke('/v1/responses', { model: 'fixture-model', ...routing })).rejects.toThrow('routing overrides')
    expect(fetch).not.toHaveBeenCalled()
  })
  it('validates the serialized payload so toJSON cannot smuggle routing controls', async () => {
    const { broker, fetch } = fixture()
    await expect(broker.invoke('/v1/responses', {
      model: 'fixture-model', toJSON: () => ({ model: 'fixture-model', group: 'auto' }),
    })).rejects.toThrow('routing overrides')
    expect(fetch).not.toHaveBeenCalled()
  })
  it('denies missing/unknown models, unsupported endpoint and oversized UTF-8 payload before auth', async () => {
    const { broker, fetch, resolve } = fixture()
    await expect(broker.invoke('/v1/responses', {})).rejects.toThrow('invalid model')
    await expect(broker.invoke('/v1/responses', { model: 'other-model' })).rejects.toThrow('not allowed')
    broker.configure({ ...selection, models: [{ id: 'fixture-model', endpoints: ['/v1/responses'] }] })
    await expect(broker.invoke('/v1/messages', { model: 'fixture-model' })).rejects.toThrow('not allowed')
    await expect(broker.invoke('/v1/responses', { model: 'fixture-model', input: '汉'.repeat(400) })).rejects.toThrow('too large')
    expect(resolve).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })
  it.each([{ group: 'default' }, { group: 'auto' }, { deviceSessionId: 'other-device' }])('rejects a changed access grant %s', async (changed) => {
    const { broker, fetch, resolve } = fixture()
    resolve.mockResolvedValue({ ...access, ...changed })
    await expect(broker.invoke('/v1/responses', { model: 'fixture-model' })).rejects.toThrow()
    expect(fetch).not.toHaveBeenCalled()
  })
  it('fences a late refresh when group changes or logout begins', async () => {
    const { broker, fetch, resolve } = fixture()
    let complete!: (value: RelayAccess) => void
    resolve.mockImplementation(() => new Promise((resolveAccess) => { complete = resolveAccess }))
    const pending = broker.invoke('/v1/responses', { model: 'fixture-model' })
    broker.suspend()
    complete(access)
    await expect(pending).rejects.toThrow('selection changed')
    await expect(broker.invoke('/v1/responses', { model: 'fixture-model' })).rejects.toThrow('select an allowed group')
    expect(fetch).not.toHaveBeenCalled()
  })
  it('keeps an already-admitted stream on its original group snapshot', async () => {
    const { broker, fetch } = fixture()
    let complete!: (response: Response) => void
    fetch.mockImplementation(() => new Promise((resolveResponse) => { complete = resolveResponse }))
    const pending = broker.invoke('/v1/responses', { model: 'fixture-model' })
    await vi.waitFor(() => { expect(fetch).toHaveBeenCalledOnce() })
    broker.configure({ ...selection, group: 'default' })
    complete(new Response('old stream'))
    expect((await pending).group).toBe('discount')
  })
  it('suspends new calls after a rejected credential without fallback', async () => {
    const { broker, fetch } = fixture(new Response('denied', { status: 401 }))
    expect((await broker.invoke('/v1/responses', { model: 'fixture-model' })).response.status).toBe(401)
    await expect(broker.invoke('/v1/responses', { model: 'fixture-model' })).rejects.toThrow('select an allowed group')
    expect(fetch).toHaveBeenCalledOnce()
  })
  it('keeps admitting calls after a 403 business limit such as an exhausted wallet or device cap', async () => {
    const { broker, fetch } = fixture(new Response('{"error":{"code":"desktop_device_quota_reached"}}', { status: 403 }))
    expect((await broker.invoke('/v1/responses', { model: 'fixture-model' })).response.status).toBe(403)
    fetch.mockResolvedValueOnce(new Response('ok'))
    expect((await broker.invoke('/v1/responses', { model: 'fixture-model' })).response.status).toBe(200)
    expect(fetch).toHaveBeenCalledTimes(2)
  })
  it.each([402, 429, 500, 503])('does not retry billable requests or change group on status %i', async (status) => {
    const { broker, fetch } = fixture(new Response('failure', { status }))
    const result = await broker.invoke('/v1/responses', { model: 'fixture-model' })
    expect(result.response.status).toBe(status)
    expect(result.group).toBe('discount')
    expect(fetch).toHaveBeenCalledOnce()
  })
  it('redacts transport errors and never retries an ambiguous delivery', async () => {
    const { broker, fetch } = fixture()
    fetch.mockRejectedValue(new Error('authorization: Bearer test-only-token'))
    await expect(broker.invoke('/v1/responses', { model: 'fixture-model' })).rejects.toThrow(/^hallucodex: relay network failure$/u)
    expect(fetch).toHaveBeenCalledOnce()
  })
  it('honors cancellation before issuing a request', async () => {
    const { broker, fetch } = fixture()
    const signal = AbortSignal.abort(new Error('cancelled'))
    await expect(broker.invoke('/v1/responses', { model: 'fixture-model' }, signal)).rejects.toThrow('cancelled')
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('HalluCodex authenticated catalog refresh', () => {
  const groups = { groups: [{ name: 'discount', description: 'Fixture', ratio: 0.5 }] }
  const models = { group: 'discount', data: [{ id: 'fixture-model', endpoints: ['openai-response'] }] }
  async function controllerFixture() {
    const { HalluCodexCatalogController } = await import('../src/hallucodex/catalog-controller.ts')
    const { broker, resolve } = fixture()
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (input) => {
      return Response.json((typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).endsWith('/groups') ? groups : models)
    })
    const controller = new HalluCodexCatalogController({ access: resolve, origin: () => ORIGIN, fetch, relay: broker })
    return { controller, broker, resolve, fetch }
  }
  it('commits a whole authenticated catalog and admits its protocol only', async () => {
    const { controller, broker, fetch } = await controllerFixture()
    expect(await controller.refresh()).toEqual({
      group: 'discount', groups: groups.groups, models: [{ id: 'fixture-model', endpoints: ['/v1/responses'] }],
    })
    expect(fetch.mock.calls.map(([url]) => typeof url === 'string' ? url : url instanceof URL ? url.href : url.url)).toEqual([
      'https://api.hallucodex.com/api/desktop/v1/groups', 'https://api.hallucodex.com/api/desktop/v1/models',
    ])
    await expect(broker.invoke('/v1/chat/completions', { model: 'fixture-model' })).rejects.toThrow('not allowed')
    expect((await broker.invoke('/v1/responses', { model: 'fixture-model' })).group).toBe('discount')
    expect(JSON.stringify(controller.getSnapshot())).not.toContain(access.accessToken)
  })
  it('refuses changed/revoked group and leaves admission closed', async () => {
    const { controller, broker, fetch } = await controllerFixture()
    fetch.mockResolvedValueOnce(Response.json({ groups: [{ name: 'default', description: '', ratio: 1 }] }))
    await expect(controller.refresh()).rejects.toThrow('catalog unavailable')
    expect(controller.getSnapshot()).toBeUndefined()
    await expect(broker.invoke('/v1/responses', { model: 'fixture-model' })).rejects.toThrow('select an allowed group')
  })
  it('rejects sign-out during a pending read and ignores its late result', async () => {
    const { controller, broker, fetch } = await controllerFixture()
    let finish!: (response: Response) => void
    fetch.mockImplementationOnce(() => new Promise((resolveResponse) => { finish = resolveResponse }))
    const pending = controller.refresh()
    await vi.waitFor(() => { expect(fetch).toHaveBeenCalledTimes(2) })
    controller.clear()
    finish(Response.json(groups))
    await expect(pending).rejects.toThrow('catalog unavailable')
    expect(controller.getSnapshot()).toBeUndefined()
    await expect(broker.invoke('/v1/responses', { model: 'fixture-model' })).rejects.toThrow('select an allowed group')
  })
  it('rejects an account switched between discovery reads', async () => {
    const { controller, broker, resolve } = await controllerFixture()
    resolve.mockResolvedValueOnce(access).mockResolvedValueOnce({ ...access, deviceSessionId: 'changed' })
    await expect(controller.refresh()).rejects.toThrow('catalog unavailable')
    await expect(broker.invoke('/v1/responses', { model: 'fixture-model' })).rejects.toThrow('select an allowed group')
  })
  it.each([
    new Response('<html>login</html>', { headers: { 'content-type': 'text/html' } }),
    new Response('permission denied', { status: 403 }),
    new Response('x'.repeat(2 * 1024 * 1024 + 1), { headers: { 'content-type': 'application/json' } }),
  ])('rejects non-JSON, failure, or oversized discovery responses', async (response) => {
    const { controller, fetch } = await controllerFixture()
    fetch.mockResolvedValueOnce(response)
    await expect(controller.refresh()).rejects.toThrow('catalog unavailable')
    expect(controller.getSnapshot()).toBeUndefined()
  })
  it('bounds discovery time and awaits both cancelled reads before reporting a network failure', async () => {
    const { controller, broker, fetch } = await controllerFixture()
    const timeout = new AbortController()
    const deadline = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal)
    const cleanup = Promise.withResolvers<undefined>()
    let cancelled = 0
    fetch.mockImplementation((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        cancelled++
        void cleanup.promise.then(() => { reject(new Error('Bearer private diagnostic')) })
      }, { once: true })
    }))
    const pending = controller.refresh()
    const outcome = expect(pending).rejects.toMatchObject({ code: 'network_error', message: 'hallucodex: account catalog unavailable' })
    let settled = false
    void pending.then(() => { settled = true }, () => { settled = true })
    try {
      await vi.waitFor(() => { expect(fetch).toHaveBeenCalledTimes(2) })
      expect(deadline).toHaveBeenCalledWith(15_000)
      timeout.abort()
      expect(cancelled).toBe(2)
      expect(settled).toBe(false)
      cleanup.resolve(undefined)
      await outcome
      expect(controller.getSnapshot()).toBeUndefined()
      await expect(broker.invoke('/v1/responses', { model: 'fixture-model' })).rejects.toThrow('select an allowed group')
    } finally {
      timeout.abort()
      cleanup.resolve(undefined)
      await pending.catch(() => {})
      deadline.mockRestore()
    }
  })
  it('sanitizes interrupted JSON streams and releases their reader', async () => {
    const { controller, fetch } = await controllerFixture()
    const body = new ReadableStream<Uint8Array>({
      start(stream) { stream.enqueue(new TextEncoder().encode('{"groups":')) },
      pull(stream) { stream.error(new Error('Bearer private stream diagnostic')) },
    })
    fetch.mockResolvedValueOnce(new Response(body, { headers: { 'content-type': 'application/json' } }))
    await expect(controller.refresh()).rejects.toMatchObject({ code: 'network_error', message: 'hallucodex: account catalog unavailable' })
    expect(body.locked).toBe(false)
    expect(controller.getSnapshot()).toBeUndefined()
  })
  it('reports a rejected access token separately so the runtime can rotate it', async () => {
    const { HalluCodexUnauthorizedError } = await import('../src/hallucodex/account-info.ts')
    const { controller, fetch } = await controllerFixture()
    fetch.mockResolvedValueOnce(Response.json({ error: 'invalid_token' }, { status: 401 }))
    await expect(controller.refresh()).rejects.toBeInstanceOf(HalluCodexUnauthorizedError)
  })
})

describe('HalluCodex native account-to-relay composition', () => {
  async function runtimeFixture() {
    const { HalluCodexDesktopRuntime } = await import('../src/hallucodex/runtime.ts')
    const now = Date.now()
    const clock = { now }
    const saved = {
      refreshToken: 'dsr.saved-test', refreshExpiresAt: now + 86_400_000,
      deviceSessionId: 'test-device', profile: { id: 'fixture-account', displayName: 'Fixture' }, group: 'discount',
    }
    const grant = {
      ...saved, refreshToken: 'dsr.rotated-test', accessToken: 'dsk.access-test', accessExpiresAt: now + 900_000,
      allowedGroups: ['discount', 'premium'], canSelectGroup: true,
    }
    // The group the server currently binds this device to.
    const server = { group: 'discount' }
    const store = {
      assertAvailable: vi.fn(), load: vi.fn().mockResolvedValue(saved),
      save: vi.fn().mockResolvedValue(undefined), clear: vi.fn().mockResolvedValue(undefined),
    }
    const transport = {
      authorize: vi.fn(), exchange: vi.fn(), refresh: vi.fn().mockResolvedValue(grant),
      selectGroup: vi.fn(async (_grant: unknown, group: string) => {
        server.group = group
        return { ...grant, group, refreshToken: 'dsr.moved-test', accessToken: 'dsk.moved-test' }
      }),
      revoke: vi.fn().mockResolvedValue(undefined), cancel: vi.fn().mockResolvedValue(undefined),
    }
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (input) => {
      const path = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (path.endsWith('/groups')) return Response.json({ groups: [{ name: 'discount', description: '', ratio: 1 }, { name: 'premium', description: 'Fast', ratio: 2 }] })
      if (path.endsWith('/balance')) return Response.json({ quota_remaining: '9007199254740993', quota_used: '123', unit: 'quota', quota_used_kind: 'account_usage_total', device_quota_used: '45', device_quota_limit: null })
      if (path.endsWith('/models')) return Response.json({ group: server.group, data: [{ id: `${server.group}-model`, endpoints: ['openai-response'] }] })
      if (path.endsWith('/api/status')) return Response.json({ success: true, data: { quota_per_unit: 500000, quota_display_type: 'CNY', usd_exchange_rate: 7 } })
      return new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
    })
    const { ServerOriginSetting } = await import('../src/hallucodex/server-origin.ts')
    const runtime = new HalluCodexDesktopRuntime({
      server: new ServerOriginSetting(undefined, ORIGIN),
      transport, store, fetch, maxRequestBytes: 4096, openExternal: vi.fn(), deviceName: 'Fixture Linux', now: () => clock.now,
    })
    return { runtime, store, transport, fetch, server, grant, clock }
  }
  it('refreshes server capabilities before discovery, serializing a queued group move', async () => {
    const { runtime, transport, grant, store } = await runtimeFixture()
    try {
      transport.refresh.mockResolvedValueOnce({ ...grant, canSelectGroup: false })
      await runtime.restore()
      await vi.waitFor(() => { expect(runtime.getSnapshot().catalogStatus).toBe('ready') })
      const release = Promise.withResolvers<typeof grant>()
      transport.refresh.mockReturnValueOnce(release.promise)
      const first = runtime.refreshAccount()
      const second = runtime.refreshAccount()
      const selecting = runtime.selectGroup('premium')
      await vi.waitFor(() => { expect(transport.refresh).toHaveBeenCalledTimes(2) })
      expect(runtime.getSnapshot()).toMatchObject({ accountRefreshStatus: 'loading', account: { canSelectGroup: false } })
      expect(transport.selectGroup).not.toHaveBeenCalled()
      release.resolve({ ...grant, accessToken: 'dsk.capabilities', refreshToken: 'dsr.capabilities' })
      await Promise.all([first, second])
      await expect(selecting).resolves.toBe('selected')
      expect(transport.refresh).toHaveBeenCalledTimes(2)
      expect(store.save).toHaveBeenNthCalledWith(2, expect.objectContaining({ refreshToken: 'dsr.capabilities' }))
      await vi.waitFor(() => { expect(runtime.getSnapshot()).toMatchObject({ catalogStatus: 'ready', account: { group: 'premium', canSelectGroup: true } }) })
    } finally { await runtime.dispose() }
  })

  it('reports capability refresh failure without erasing login or claiming success', async () => {
    const { runtime, transport, store } = await runtimeFixture()
    try {
      await runtime.restore()
      await vi.waitFor(() => { expect(runtime.getSnapshot().walletStatus).toBe('ready') })
      transport.refresh.mockRejectedValue(new Error('Bearer private credential'))
      await runtime.refreshAccount()
      expect(runtime.getSnapshot()).toMatchObject({ account: { status: 'signed-in' }, accountRefreshStatus: 'failed', accountRefreshError: 'network_error' })
      expect(store.clear).not.toHaveBeenCalled()
      expect(JSON.stringify(runtime.getSnapshot())).not.toContain('private credential')
    } finally { await runtime.dispose() }
  })

  it('coalesces wallet reads, publishes progress and preserves the successful time on failure', async () => {
    const { runtime, fetch, clock } = await runtimeFixture()
    try {
      await runtime.restore()
      await vi.waitFor(() => { expect(runtime.getSnapshot().walletStatus).toBe('ready') })
      const before = runtime.getSnapshot()
      const release = Promise.withResolvers<Response>()
      fetch.mockClear()
      fetch.mockReturnValueOnce(release.promise)
      const first = runtime.refreshWallet()
      const second = runtime.refreshWallet()
      await vi.waitFor(() => { expect(runtime.getSnapshot().walletStatus).toBe('loading') })
      expect(fetch).toHaveBeenCalledOnce()
      expect(runtime.getSnapshot().wallet).toEqual(before.wallet)
      expect(runtime.getSnapshot().walletUpdatedAt).toBe(before.walletUpdatedAt)
      clock.now += 1000
      release.resolve(new Response('Authorization: private', { status: 503 }))
      await Promise.all([first, second])
      expect(runtime.getSnapshot()).toMatchObject({ walletStatus: 'failed', walletError: 'network_error', walletUpdatedAt: before.walletUpdatedAt })
      expect(runtime.getSnapshot().wallet).toEqual(before.wallet)
      fetch.mockResolvedValueOnce(Response.json({ quota_remaining: '9', quota_used: '8', unit: 'quota', quota_used_kind: 'account_usage_total', device_quota_used: '7', device_quota_limit: null }))
      await runtime.refreshWallet()
      expect(runtime.getSnapshot()).toMatchObject({ walletStatus: 'ready', walletUpdatedAt: clock.now, wallet: { remaining: '9' } })
      expect(runtime.getSnapshot().walletError).toBeUndefined()
      await runtime.signOut()
      expect(runtime.getSnapshot().wallet).toBeUndefined()
      expect(runtime.getSnapshot().walletUpdatedAt).toBeUndefined()
    } finally { await runtime.dispose() }
  })

  it('leaves the first failed balance unavailable without hiding a usable catalog', async () => {
    const { runtime, fetch } = await runtimeFixture()
    const normal = fetch.getMockImplementation()!
    fetch.mockImplementation((input, init) => {
      const path = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (path.endsWith('/balance')) return Promise.resolve(Response.json({ quota_remaining: 'invalid' }))
      return normal(input, init)
    })
    try {
      await runtime.restore()
      await vi.waitFor(() => {
        expect(runtime.getSnapshot()).toMatchObject({ catalogStatus: 'ready', walletStatus: 'failed', walletError: 'wallet_unavailable' })
      })
      expect(runtime.getSnapshot().wallet).toBeUndefined()
      expect(runtime.getSnapshot().walletUpdatedAt).toBeUndefined()
      fetch.mockImplementation(normal)
      await runtime.refreshWallet()
      expect(runtime.getSnapshot().walletStatus).toBe('ready')
    } finally { await runtime.dispose() }
  })

  it.each([401, 403])('handles wallet status %i without an unbounded retry or false logout', async (status) => {
    const { runtime, fetch, transport, grant } = await runtimeFixture()
    try {
      await runtime.restore()
      await vi.waitFor(() => { expect(runtime.getSnapshot().walletStatus).toBe('ready') })
      transport.refresh.mockResolvedValueOnce({ ...grant, refreshToken: 'dsr.wallet', accessToken: 'dsk.wallet' })
      fetch.mockClear()
      fetch.mockResolvedValue(new Response(null, { status }))
      await runtime.refreshWallet()
      expect(fetch).toHaveBeenCalledTimes(status === 401 ? 2 : 1)
      expect(transport.refresh).toHaveBeenCalledTimes(status === 401 ? 2 : 1)
      expect(runtime.getSnapshot()).toMatchObject({ account: { status: 'signed-in' }, walletStatus: 'failed', walletError: status === 401 ? 'session_expired' : 'wallet_unavailable' })
    } finally { await runtime.dispose() }
  })

  it('keeps wallet and directory failures independent after a successful group move', async () => {
    const { runtime, fetch } = await runtimeFixture()
    try {
      await runtime.restore()
      await vi.waitFor(() => { expect(runtime.getSnapshot().catalogStatus).toBe('ready') })
      const normal = fetch.getMockImplementation()!
      fetch.mockImplementation((input, init) => {
        const path = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
        if (path.endsWith('/models')) return Promise.resolve(Response.json({ invalid: true }))
        return normal(input, init)
      })
      await expect(runtime.selectGroup('premium')).resolves.toBe('selected')
      await vi.waitFor(() => { expect(runtime.getSnapshot()).toMatchObject({ catalogError: 'catalog_unavailable', walletStatus: 'ready' }) })
      expect(runtime.getSnapshot().account).toMatchObject({ group: 'premium' })
      expect(runtime.getSnapshot().catalog).toBeUndefined()
      await expect(runtime.invoke('/v1/responses', { model: 'discount-model' })).rejects.toThrow()
      fetch.mockImplementation(normal)
      await runtime.refreshCatalog()
      expect(runtime.getSnapshot()).toMatchObject({ catalogStatus: 'ready', catalog: { group: 'premium' } })
      expect(runtime.getSnapshot().catalogError).toBeUndefined()
    } finally { await runtime.dispose() }
  })

  it('discards a delayed wallet read and capability refresh after sign-out', async () => {
    const { runtime, fetch, transport, grant } = await runtimeFixture()
    try {
      await runtime.restore()
      await vi.waitFor(() => { expect(runtime.getSnapshot().walletStatus).toBe('ready') })
      const wallet = Promise.withResolvers<Response>()
      fetch.mockReturnValueOnce(wallet.promise)
      const reading = runtime.refreshWallet()
      await vi.waitFor(() => { expect(runtime.getSnapshot().walletStatus).toBe('loading') })
      const refreshed = Promise.withResolvers<typeof grant>()
      transport.refresh.mockReturnValueOnce(refreshed.promise)
      const refreshing = runtime.refreshAccount()
      await vi.waitFor(() => { expect(transport.refresh).toHaveBeenCalledTimes(2) })
      await runtime.signOut()
      refreshed.resolve({ ...grant, accessToken: 'dsk.late', refreshToken: 'dsr.late' })
      wallet.resolve(Response.json({ quota_remaining: '9', quota_used: '8', unit: 'quota', quota_used_kind: 'account_usage_total', device_quota_used: '7', device_quota_limit: null }))
      await Promise.all([reading, refreshing])
      expect(runtime.getSnapshot()).toMatchObject({ account: { status: 'signed-out' }, catalogStatus: 'unavailable', walletStatus: 'unavailable' })
      expect(runtime.getSnapshot().walletUpdatedAt).toBeUndefined()
      expect(runtime.getSnapshot().accountRefreshError).toBeUndefined()
    } finally { await runtime.dispose() }
  })

  it('restores a rotated grant, discovers allowed models, streams and signs out without exposing credentials', async () => {
    const { runtime, store, transport, fetch } = await runtimeFixture()
    try {
      await runtime.restore()
      await vi.waitFor(() => { expect(runtime.getSnapshot().walletStatus).toBe('ready') })
      expect(transport.refresh).toHaveBeenCalledOnce()
      expect(store.save).toHaveBeenCalledOnce()
      const serialized = JSON.stringify(runtime.getSnapshot())
      expect(runtime.getSnapshot().wallet).toEqual({ remaining: '9007199254740993', accountUsage: '123', deviceUsage: '45', unit: 'quota' })
      expect(serialized).not.toMatch(/dsk\.|dsr\.|accessToken|refreshToken|deviceSessionId/u)
      const result = await runtime.invoke('/v1/responses', { model: 'discount-model', stream: true, input: 'hello' })
      expect(await result.response.text()).toContain('[DONE]')
      expect(fetch.mock.lastCall?.[1]?.headers).toMatchObject({ authorization: 'Bearer dsk.access-test' })
      // The site's display settings come from its public status, without the account credential.
      expect(runtime.getSnapshot().quotaDisplay).toEqual({ type: 'CNY', quotaPerUnit: 500000, rate: 7, symbol: '¤' })
      expect(fetch.mock.calls.find(call => typeof call[0] === 'string' && call[0].endsWith('/api/status'))?.[1]?.headers).not.toHaveProperty('authorization')
      expect(await runtime.signOut()).toEqual({ remoteRevoked: true })
      expect(runtime.getSnapshot().account.status).toBe('signed-out')
      await expect(runtime.invoke('/v1/responses', { model: 'discount-model' })).rejects.toThrow('select an allowed group')
      expect(transport.revoke).toHaveBeenCalledWith('dsr.rotated-test')
    } finally { await runtime.dispose() }
  })
  it('re-reads only the wallet, keeping the shown figures until fresh ones arrive', async () => {
    const { runtime, fetch } = await runtimeFixture()
    try {
      await runtime.restore()
      await vi.waitFor(() => { expect(runtime.getSnapshot().walletStatus).toBe('ready') })
      fetch.mockClear()
      fetch.mockResolvedValueOnce(Response.json({ quota_remaining: '900', quota_used: '7036', unit: 'quota', quota_used_kind: 'account_usage_total', device_quota_used: '7012', device_quota_limit: '10000' }))
      await runtime.refreshWallet()
      expect(fetch).toHaveBeenCalledOnce()
      expect(fetch.mock.calls[0]?.[0]).toMatch(/\/balance$/u)
      expect(runtime.getSnapshot()).toMatchObject({ catalogStatus: 'ready', walletStatus: 'ready', wallet: { remaining: '900', accountUsage: '7036', deviceUsage: '7012', deviceLimit: '10000' } })
      fetch.mockResolvedValueOnce(new Response('unavailable', { status: 503 }))
      await runtime.refreshWallet()
      expect(runtime.getSnapshot().wallet).toMatchObject({ remaining: '900', deviceUsage: '7012' })
    } finally { await runtime.dispose() }
  })
  it('rotates the credential after a 401 and signs out a device revoked on the website', async () => {
    const { runtime, fetch, transport } = await runtimeFixture()
    try {
      await runtime.restore()
      await vi.waitFor(() => { expect(runtime.getSnapshot().walletStatus).toBe('ready') })
      const { HalluCodexAuthError } = await import('../src/hallucodex/auth-protocol.ts')
      transport.refresh.mockRejectedValueOnce(new HalluCodexAuthError('invalid_grant'))
      fetch.mockResolvedValueOnce(new Response('revoked', { status: 401 }))
      expect((await runtime.invoke('/v1/responses', { model: 'discount-model' })).response.status).toBe(401)
      await vi.waitFor(() => { expect(runtime.getSnapshot().account).toEqual({ status: 'signed-out', errorCode: 'invalid_grant' }) })
      expect(runtime.getSnapshot().catalog).toBeUndefined()
      await expect(runtime.invoke('/v1/responses', { model: 'discount-model' })).rejects.toThrow('select an allowed group')
    } finally { await runtime.dispose() }
  })
  it('keeps the catalog after a 403 business limit', async () => {
    const { runtime, fetch } = await runtimeFixture()
    try {
      await runtime.restore()
      await vi.waitFor(() => { expect(runtime.getSnapshot().walletStatus).toBe('ready') })
      fetch.mockResolvedValueOnce(new Response('{"error":{"code":"insufficient_user_quota"}}', { status: 403 }))
      expect((await runtime.invoke('/v1/responses', { model: 'discount-model' })).response.status).toBe(403)
      expect(runtime.getSnapshot().catalogStatus).toBe('ready')
      expect((await runtime.invoke('/v1/responses', { model: 'discount-model' })).response.status).toBe(200)
    } finally { await runtime.dispose() }
  })
  it('moves the device to another group and reloads that group\'s models and wallet', async () => {
    const { runtime, fetch, transport, store } = await runtimeFixture()
    try {
      await runtime.restore()
      await vi.waitFor(() => { expect(runtime.getSnapshot().walletStatus).toBe('ready') })
      expect(runtime.getSnapshot().catalog?.groups.map(group => group.name)).toEqual(['discount', 'premium'])
      await expect(runtime.selectGroup('premium')).resolves.toBe('selected')
      expect(transport.selectGroup).toHaveBeenCalledOnce()
      expect(transport.selectGroup.mock.calls[0]?.[1]).toBe('premium')
      expect(store.save).toHaveBeenLastCalledWith(expect.objectContaining({ refreshToken: 'dsr.moved-test', group: 'premium' }))
      await vi.waitFor(() => { expect(runtime.getSnapshot()).toMatchObject({ catalogStatus: 'ready', walletStatus: 'ready' }) })
      expect(runtime.getSnapshot()).toMatchObject({ account: { group: 'premium' }, catalog: { group: 'premium', models: [{ id: 'premium-model' }] } })
      await expect(runtime.invoke('/v1/responses', { model: 'discount-model' })).rejects.toThrow()
      const result = await runtime.invoke('/v1/responses', { model: 'premium-model' })
      expect(result.group).toBe('premium')
      expect(fetch.mock.lastCall?.[1]?.headers).toMatchObject({ authorization: 'Bearer dsk.moved-test' })
      await expect(runtime.selectGroup('auto')).rejects.toThrow('group_invalid')
    } finally { await runtime.dispose() }
  })
  it('keeps the current group and reopens its models when the server refuses the new one', async () => {
    const { runtime, transport, store } = await runtimeFixture()
    try {
      await runtime.restore()
      await vi.waitFor(() => { expect(runtime.getSnapshot().walletStatus).toBe('ready') })
      const { HalluCodexAuthError } = await import('../src/hallucodex/auth-protocol.ts')
      transport.selectGroup.mockRejectedValueOnce(new HalluCodexAuthError('group_unavailable'))
      await expect(runtime.selectGroup('premium')).resolves.toBe('group_unavailable')
      expect(store.clear).not.toHaveBeenCalled()
      await vi.waitFor(() => { expect(runtime.getSnapshot()).toMatchObject({ catalogStatus: 'ready', walletStatus: 'ready' }) })
      expect(runtime.getSnapshot()).toMatchObject({ account: { status: 'signed-in', group: 'discount' }, catalog: { group: 'discount' } })
      expect((await runtime.invoke('/v1/responses', { model: 'discount-model' })).group).toBe('discount')
    } finally { await runtime.dispose() }
  })
  it('changes the server only while signed out and sends later requests there', async () => {
    const { runtime, fetch, store } = await runtimeFixture()
    try {
      await runtime.restore()
      await vi.waitFor(() => { expect(runtime.getSnapshot().walletStatus).toBe('ready') })
      await expect(runtime.setServerOrigin('http://localhost:3000')).rejects.toThrow('sign out before changing the server')
      await runtime.signOut()
      await expect(runtime.setServerOrigin('http://localhost:3000/v1')).rejects.toThrow('invalid server address')
      expect((await runtime.setServerOrigin('http://LOCALHOST:3000/')).serverOrigin).toBe('http://localhost:3000')
      expect(store.clear).toHaveBeenCalled()
      store.load.mockResolvedValueOnce(null)
      fetch.mockClear()
      await runtime.startSignIn().catch(() => undefined)
      expect(runtime.getSnapshot().serverOrigin).toBe('http://localhost:3000')
    } finally { await runtime.dispose() }
  })
})

it.each(['Model', 'MODEL', 'mOdEl'])('rejects ambiguous protocol model field %s before network admission', async (key) => {
  const { broker, fetch } = fixture()
  await expect(broker.invoke('/v1/responses', { model: 'fixture-model', [key]: 'other-model' })).rejects.toThrow('ambiguous model')
  expect(fetch).not.toHaveBeenCalled()
})

it('keeps quota errors unavailable instead of inventing zero or a currency', async () => {
  const { readHalluCodexWalletQuota } = await import('../src/hallucodex/account-info.ts')
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({
    quota_remaining: 10, quota_used: '1', unit: 'USD', quota_used_kind: 'account_usage_total',
  })).mockRejectedValueOnce(new Error('Authorization: secret'))
  await expect(readHalluCodexWalletQuota(fetcher, ORIGIN, access, new AbortController().signal))
    .rejects.toThrow(/^hallucodex: wallet quota unavailable$/u)
  await expect(readHalluCodexWalletQuota(fetcher, ORIGIN, access, new AbortController().signal))
    .rejects.toThrow(/^hallucodex: wallet quota unavailable$/u)
})

it('reads this device usage and cap from the selected server', async () => {
  const { readHalluCodexWalletQuota, HalluCodexUnauthorizedError } = await import('../src/hallucodex/account-info.ts')
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({
    quota_remaining: '10', quota_used: '1', unit: 'quota', quota_used_kind: 'account_usage_total',
    device_quota_used: '7', device_quota_limit: '500',
  })).mockResolvedValueOnce(Response.json({ error: 'invalid_token' }, { status: 401 }))
  await expect(readHalluCodexWalletQuota(fetcher, 'http://localhost:3000', access, new AbortController().signal))
    .resolves.toEqual({ remaining: '10', accountUsage: '1', deviceUsage: '7', deviceLimit: '500', unit: 'quota' })
  expect(fetcher.mock.calls[0]?.[0]).toBe('http://localhost:3000/api/desktop/v1/balance')
  await expect(readHalluCodexWalletQuota(fetcher, ORIGIN, access, new AbortController().signal))
    .rejects.toBeInstanceOf(HalluCodexUnauthorizedError)
})
