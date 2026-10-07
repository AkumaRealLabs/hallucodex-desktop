import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile, chmod } from 'node:fs/promises'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { HalluCodexAuthBroker } from '../src/hallucodex/auth-broker.ts'
import { authorizationUrl, HalluCodexAuthError, HalluCodexHttpAuthTransport, parseAccessGrant, parseRefreshRecord, type AccessGrant, type AuthorizationRequest, type CodeExchange, type RefreshGrant } from '../src/hallucodex/auth-protocol.ts'
import { createLoopbackLogin } from '../src/hallucodex/loopback-login.ts'
import { CALLBACK_PAGE_CSP, callbackLanguage, callbackPage } from '../src/hallucodex/callback-page.ts'
import { DEFAULT_HALLUCODEX_ORIGIN as HALLUCODEX_ORIGIN } from '../src/hallucodex/server-origin.ts'
import { SafeStorageRefreshStore, type RefreshStore, type SafeStorageEncryption } from '../src/hallucodex/secure-storage.ts'

const start = Date.UTC(2026, 9, 6)
const refreshDeadline = start / 1000 + 30 * 86400
const scopes = 'relay:invoke profile:read balance:read models:read groups:read'
const selectScopes = `${scopes} group:select`

function wire(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    token_type: 'Bearer', access_token: 'dsk.access-secret', refresh_token: 'dsr.refresh-secret', expires_in: 900,
    refresh_expires_at: refreshDeadline, scope: scopes, device_session_id: 'session-1',
    profile: { id: 'user-1', display_name: 'Example', role: 'admin', website_token: 'private' },
    group: 'discount', allowed_groups: ['discount', 'default'], ...overrides,
  }
}

function fixture(scope = scopes) {
  let now = start
  let saved: RefreshGrant | null = null
  const store = {
    assertAvailable: vi.fn(), load: vi.fn(async () => saved),
    save: vi.fn(async (grant: RefreshGrant) => { saved = structuredClone(grant) }),
    clear: vi.fn(async () => { saved = null }),
  } satisfies RefreshStore
  const transport = {
    authorize: vi.fn(async (_request: AuthorizationRequest, _signal: AbortSignal) => ({
      authorizationUrl: `${HALLUCODEX_ORIGIN}/desktop/authorize?request_id=dar.request`, requestId: 'dar.request',
    })),
    exchange: vi.fn(async (_request: CodeExchange, _signal: AbortSignal) => parseAccessGrant(wire({ scope }), now)),
    refresh: vi.fn(async (_grant: RefreshGrant, _signal: AbortSignal) => parseAccessGrant(wire({
      access_token: 'dsk.rotated-access', refresh_token: 'dsr.rotated-refresh', scope,
    }), now)),
    selectGroup: vi.fn(async (_grant: RefreshGrant, group: string, _signal: AbortSignal) => parseAccessGrant(wire({
      access_token: 'dsk.moved-access', refresh_token: 'dsr.moved-refresh', group, scope,
    }), now)),
    cancel: vi.fn(async (_id: string, _verifier: string) => {}),
    revoke: vi.fn(async (_token: string) => {}),
  }
  const openExternal = vi.fn(async (_url: string) => {})
  const onChange = vi.fn()
  const broker = new HalluCodexAuthBroker({ store, transport, openExternal, origin: () => HALLUCODEX_ORIGIN, deviceName: 'Test desktop', now: () => now, onChange })
  onTestFinished(() => broker.dispose())
  const registration = () => {
    const value = transport.authorize.mock.calls.at(-1)?.[0]
    if (!value) throw new Error('missing registration')
    return value
  }
  const complete = async () => {
    const value = registration()
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(`${value.redirectUri}?state=${value.state}&code=dsc.single-use`, (response) => {
        response.resume()
        response.on('end', () =>{  resolve(response.statusCode ?? 0) })
      })
      req.on('error', reject)
      req.end()
    })
    expect(status).toBe(200)
  }
  const login = async () => {
    await broker.startSignIn()
    await complete()
    await vi.waitFor(() =>{  expect(broker.getSnapshot().status).toBe('signed-in') })
  }
  return { broker, transport, store, openExternal, onChange, registration, complete, login,
    saved: () => saved, setSaved: (value: RefreshGrant) => { saved = value }, advance: (ms: number) => { now += ms } }
}

describe('desktop authorization wire validation', () => {
  it('projects only display data and binds the explicit server-allowed group', () => {
    const grant = parseAccessGrant(wire({ server_address: 'https://evil.example' }), start)
    expect(grant.profile).toEqual({ id: 'user-1', displayName: 'Example' })
    expect(grant.group).toBe('discount')
    expect(grant).not.toHaveProperty('server_address')
    expect(grant.accessExpiresAt).toBe(start + 900_000)
  })

  it.each([
    { group: 'auto' }, { group: 'AUTO' }, { group: '' }, { group: ' discount ' }, { group: 'ungranted' },
    { allowed_groups: ['discount', 'auto'] }, { allowed_groups: [] }, { allowed_groups: null },
    { expires_in: 901 }, { expires_in: 0 }, { expires_in: 1.5 }, { expires_in: '900' },
    { token_type: 'JWT' }, { access_token: 'sk-management-key' }, { access_token: 'dsk.secret\n' },
    { refresh_token: 'website-jwt' }, { refresh_expires_at: start / 1000 }, { refresh_expires_at: refreshDeadline + 601 },
    { scope: 'relay:invoke' }, { scope: `${scopes} admin` }, { profile: { id: 'a', display_name: 'line\nbreak' } },
  ])('rejects unsafe token fields: %j', (fields) => {
    expect(() => parseAccessGrant(wire(fields), start)).toThrow(HalluCodexAuthError)
  })

  it('offers group selection only when the server grants it', () => {
    expect(parseAccessGrant(wire(), start).canSelectGroup).toBe(false)
    expect(parseAccessGrant(wire({ scope: selectScopes }), start).canSelectGroup).toBe(true)
  })

  it('accepts a server clock that runs ahead of the desktop clock', () => {
    const grant = parseAccessGrant(wire({ refresh_expires_at: refreshDeadline + 5 }), start)
    expect(grant.refreshExpiresAt).toBe((refreshDeadline + 5) * 1000)
  })

  it.each([
    'https://evil.example/desktop/authorize', 'http://api.hallucodex.com/desktop/authorize',
    'https://api.hallucodex.com.evil.example/desktop/authorize', 'https://user@api.hallucodex.com/desktop/authorize',
    'https://api.hallucodex.com/desktop/authorize#secret', 'https://api.hallucodex.com/admin', 'file:///desktop/authorize',
  ])('refuses untrusted browser URLs: %s', (url) => {
    expect(() => authorizationUrl(url, HALLUCODEX_ORIGIN)).toThrow('invalid_response')
  })

  it('binds browser URLs and saved credentials to the selected server origin', () => {
    const local = 'http://localhost:3000'
    expect(authorizationUrl(`${local}/desktop/authorize?request_id=dar.x`, local)).toBe(`${local}/desktop/authorize?request_id=dar.x`)
    expect(() => authorizationUrl(`${HALLUCODEX_ORIGIN}/desktop/authorize`, local)).toThrow('invalid_response')
    const saved = { version: 1, origin: HALLUCODEX_ORIGIN, refreshToken: 'dsr.saved', refreshExpiresAt: refreshDeadline * 1000,
      deviceSessionId: 'session-1', group: 'discount', profile: { id: 'user-1', displayName: 'Example' } }
    expect(parseRefreshRecord(saved, HALLUCODEX_ORIGIN).refreshToken).toBe('dsr.saved')
    expect(() => parseRefreshRecord(saved, local)).toThrow('invalid_response')
  })

  it('pins requests to the selected origin, omits browser cookies, refuses redirects, and redeems PKCE without retries', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json(wire()))
    let origin = HALLUCODEX_ORIGIN
    const transport = new HalluCodexHttpAuthTransport(() => origin, fetcher, () => start)
    await transport.exchange({ code: 'dsc.single', codeVerifier: 'private-verifier', redirectUri: 'http://127.0.0.1:1234/oauth/callback' }, new AbortController().signal)
    expect(fetcher).toHaveBeenCalledOnce()
    expect(fetcher.mock.calls[0]?.[0]).toBe(`${HALLUCODEX_ORIGIN}/api/desktop/v1/token`)
    const options = fetcher.mock.calls[0]?.[1]
    expect(options).toMatchObject({ credentials: 'omit', cache: 'no-store', redirect: 'error', method: 'POST' })
    if (typeof options?.body !== 'string') throw new Error('missing JSON request body')
    expect(JSON.parse(options.body)).toMatchObject({ grant_type: 'authorization_code', code_verifier: 'private-verifier', client_id: 'hallucodex-desktop' })
    origin = 'http://localhost:3000'
    await transport.revoke('dsr.refresh-secret')
    expect(fetcher.mock.calls[1]?.[0]).toBe('http://localhost:3000/api/desktop/v1/revoke')
  })

  it('discards server messages and limits secret-bearing response bodies', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ error: { code: 'invalid_grant', message: 'dsr.do-not-log' } }, { status: 401 }))
    const transport = new HalluCodexHttpAuthTransport(() => HALLUCODEX_ORIGIN, fetcher, () => start)
    await expect(transport.refresh(parseAccessGrant(wire(), start), new AbortController().signal)).rejects.toThrow(/^invalid_grant$/u)
    fetcher.mockResolvedValueOnce(Response.json({ huge: 'x'.repeat(70_000) }))
    await expect(transport.refresh(parseAccessGrant(wire(), start), new AbortController().signal)).rejects.toThrow(/^invalid_response$/u)
    fetcher.mockResolvedValueOnce(new Response('<html>login</html>', { headers: { 'Content-Type': 'text/html' } }))
    await expect(transport.refresh(parseAccessGrant(wire(), start), new AbortController().signal)).rejects.toThrow(/^invalid_response$/u)
  })

  it('posts a group move to the selected server and keeps an unavailable group distinct from a dead login', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json(wire({ group: 'default', scope: selectScopes })))
    const transport = new HalluCodexHttpAuthTransport(() => HALLUCODEX_ORIGIN, fetcher, () => start)
    const grant = parseAccessGrant(wire(), start)
    const signal = new AbortController().signal
    await expect(transport.selectGroup(grant, 'default', signal)).resolves.toMatchObject({ group: 'default', canSelectGroup: true })
    expect(fetcher.mock.calls[0]?.[0]).toBe(`${HALLUCODEX_ORIGIN}/api/desktop/v1/group`)
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: 'POST', credentials: 'omit', redirect: 'error' })
    const body = fetcher.mock.calls[0]?.[1]?.body
    if (typeof body !== 'string') throw new Error('missing JSON request body')
    expect(JSON.parse(body)).toEqual({ client_id: 'hallucodex-desktop', refresh_token: 'dsr.refresh-secret', group: 'default' })
    fetcher.mockResolvedValueOnce(Response.json({ error: 'group_unavailable' }, { status: 403 }))
    await expect(transport.selectGroup(grant, 'default', signal)).rejects.toThrow(/^group_unavailable$/u)
    fetcher.mockResolvedValueOnce(Response.json({ error: 'invalid_grant' }, { status: 400 }))
    await expect(transport.selectGroup(grant, 'default', signal)).rejects.toThrow(/^invalid_grant$/u)
    await expect(transport.selectGroup(grant, 'auto', signal)).rejects.toThrow(/^group_invalid$/u)
    expect(fetcher).toHaveBeenCalledTimes(3)
  })

  it('treats an unavailable server as transient even when it answers 404', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ error: 'temporarily_unavailable' }, { status: 404 }))
    const transport = new HalluCodexHttpAuthTransport(() => HALLUCODEX_ORIGIN, fetcher, () => start)
    await expect(transport.refresh(parseAccessGrant(wire(), start), new AbortController().signal)).rejects.toThrow('network_error')
  })

  it.each([408, 429, 500, 502, 503])('classifies non-JSON status %s as transient without discarding an account', async (status) => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response('<html>temporary proxy error</html>', { status }))
    const transport = new HalluCodexHttpAuthTransport(() => HALLUCODEX_ORIGIN, fetcher, () => start)
    await expect(transport.refresh(parseAccessGrant(wire(), start), new AbortController().signal)).rejects.toThrow('network_error')
  })

  it('accepts an empty display name while requiring a nonempty account ID', () => {
    expect(parseAccessGrant(wire({ profile: { id: 'user-1', display_name: '' } }), start).profile).toEqual({ id: 'user-1', displayName: '' })
    expect(() => parseAccessGrant(wire({ profile: { id: '', display_name: 'Name' } }), start)).toThrow('invalid_response')
  })
})

describe('one-shot loopback authorization', () => {
  it('rejects wrong path, Host, Origin, method, state, duplicate fields, and generic credentials without consuming the attempt', async () => {
    const controller = new AbortController()
    const listener = await createLoopbackLogin('state-secret', { signal: controller.signal, expiresAt: Date.now() + 10_000, origin: HALLUCODEX_ORIGIN })
    onTestFinished(() => listener.close())
    const callback = new URL(listener.redirectUri)
    expect(callback.hostname).toBe('127.0.0.1')
    expect(Number(callback.port)).toBeGreaterThan(0)
    const send = (path: string, headers: Record<string, string> = {}, method = 'GET') => new Promise<number>((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port: callback.port, path, headers, method }, (response) => {
        response.resume()
        response.on('end', () =>{  resolve(response.statusCode ?? 0) })
      })
      req.on('error', reject)
      req.end()
    })
    const valid = '/oauth/callback?state=state-secret&code=dsc.one'
    for (const path of ['/other?state=state-secret&code=dsc.one', '/oauth/callback?state=wrong&code=dsc.one',
      `${valid}&state=state-secret`, `${valid}&code=dsc.two`, `${valid}&access_token=dsk.bad`, '/oauth/callback?state=state-secret&code=website-jwt']) {
      expect(await send(path)).toBe(400)
    }
    expect(await send(valid, { Host: 'evil.example' })).toBe(400)
    expect(await send(valid, { Origin: 'https://evil.example' })).toBe(400)
    expect(await send(valid, {}, 'POST')).toBe(400)
    expect(await send(valid)).toBe(200)
    await expect(listener.code).resolves.toBe('dsc.one')
    await listener.close()
    await expect(send(valid)).rejects.toThrow()
  })

  it('ends the attempt with access_denied when the browser denies authorization', async () => {
    const listener = await createLoopbackLogin('state', { signal: new AbortController().signal, expiresAt: Date.now() + 10_000, origin: HALLUCODEX_ORIGIN })
    onTestFinished(() => listener.close())
    interface Page { status: number; type: string | undefined; csp: string | undefined; body: string }
    const page = await new Promise<Page>((resolve, reject) => {
      const headers = { 'Accept-Language': 'zh-CN,zh;q=0.9' }
      const req = request(`${listener.redirectUri}?error=access_denied&state=state`, { headers }, (response) => {
        let body = ''
        response.setEncoding('utf8').on('data', (chunk: string) => { body += chunk })
        response.on('end', () => {
          const csp = response.headers['content-security-policy']
          resolve({ status: response.statusCode ?? 0, type: response.headers['content-type'], csp: typeof csp === 'string' ? csp : undefined, body })
        })
      })
      req.on('error', reject)
      req.end()
    })
    expect(page.status).toBe(200)
    expect(page.type).toBe('text/html; charset=utf-8')
    expect(page.csp).toBe(CALLBACK_PAGE_CSP)
    expect(page.body).toContain('<h1>已拒绝授权</h1>')
    expect(page.body).not.toContain('state')
    await expect(listener.code).rejects.toThrow('access_denied')
  })

  it('closes the listener on cancellation and on expiry', async () => {
    const controller = new AbortController()
    const listener = await createLoopbackLogin('state', { signal: controller.signal, expiresAt: Date.now() + 10_000, origin: HALLUCODEX_ORIGIN })
    controller.abort()
    await expect(listener.code).rejects.toThrow('cancelled')
    await listener.close()
    const expiring = await createLoopbackLogin('state', { signal: new AbortController().signal, expiresAt: Date.now() + 15, origin: HALLUCODEX_ORIGIN })
    await expect(expiring.code).rejects.toThrow('expired')
    await expiring.close()
  })
})

describe('loopback callback page', () => {
  it('pins its only inline style by hash, runs no script and follows the browser language', () => {
    const page = callbackPage('approved', 'en')
    const style = /<style>([\s\S]*)<\/style>/u.exec(page)?.[1]
    if (style === undefined) throw new Error('callback page must carry its style')
    expect(CALLBACK_PAGE_CSP).toContain(`style-src 'sha256-${createHash('sha256').update(style).digest('base64')}'`)
    expect(CALLBACK_PAGE_CSP).toContain("default-src 'none'")
    expect(page).not.toMatch(/<script|\son[a-z]+=/iu)
    expect(page).toContain('<h1>Authorization complete</h1>')
    expect(callbackPage('expired', 'zh')).toContain('<h1>登录已失效</h1>')
    expect(callbackPage('invalid', 'zh')).toContain('<html lang="zh-CN">')
    expect([callbackLanguage('zh-TW,en;q=0.8'), callbackLanguage('en-US,zh;q=0.8'), callbackLanguage(undefined)]).toEqual(['zh', 'en', 'en'])
  })
})

describe('main-process account generations', () => {
  it('uses random S256 and only safe snapshots; access tokens never enter persistence', async () => {
    const f = fixture()
    await f.login()
    const request = f.registration()
    const exchange = f.transport.exchange.mock.calls[0]?.[0]
    if (!exchange) throw new Error('missing exchange')
    expect(request.state).toMatch(/^[A-Za-z0-9_-]{43}$/u)
    expect(exchange.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/u)
    expect(request.codeChallenge).toBe(createHash('sha256').update(exchange.codeVerifier).digest('base64url'))
    expect(exchange.redirectUri).toBe(request.redirectUri)
    expect(f.openExternal).toHaveBeenCalledWith(`${HALLUCODEX_ORIGIN}/desktop/authorize?request_id=dar.request`)
    expect(f.broker.getSnapshot()).toEqual({ status: 'signed-in', profile: { id: 'user-1', displayName: 'Example' }, group: 'discount', allowedGroups: ['discount', 'default'], canSelectGroup: false })
    expect(JSON.stringify(f.broker.getSnapshot())).not.toMatch(/dsk\.|dsr\.|verifier|state-secret|session-1/u)
    expect(f.saved()).not.toHaveProperty('accessToken')
    expect(f.transport.cancel).not.toHaveBeenCalled()
    await expect(f.broker.getRequestCredentials()).resolves.toEqual({ accessToken: 'dsk.access-secret', deviceSessionId: 'session-1', group: 'discount' })
  })

  it('coalesces refresh and persists rotation before activating the new access token', async () => {
    const f = fixture()
    await f.login()
    f.advance(880_000)
    const release = Promise.withResolvers<AccessGrant>()
    f.transport.refresh.mockReturnValueOnce(release.promise)
    const calls = [f.broker.getAccessToken(), f.broker.getAccessToken(), f.broker.getAccessToken()]
    expect(f.transport.refresh).toHaveBeenCalledOnce()
    release.resolve(parseAccessGrant(wire({ access_token: 'dsk.next', refresh_token: 'dsr.next' }), start + 880_000))
    await expect(Promise.all(calls)).resolves.toEqual(['dsk.next', 'dsk.next', 'dsk.next'])
    expect(f.saved()?.refreshToken).toBe('dsr.next')
  })

  it('ignores a late exchange after cancellation and revokes the discarded grant', async () => {
    const f = fixture()
    const release = Promise.withResolvers<AccessGrant>()
    f.transport.exchange.mockReturnValueOnce(release.promise)
    await f.broker.startSignIn()
    await f.complete()
    await vi.waitFor(() =>{  expect(f.transport.exchange).toHaveBeenCalledOnce() })
    await f.broker.cancelSignIn()
    release.resolve(parseAccessGrant(wire(), start))
    await vi.waitFor(() =>{  expect(f.transport.revoke).toHaveBeenCalledWith('dsr.refresh-secret') })
    expect(f.broker.getSnapshot()).toEqual({ status: 'signed-out' })
    expect(f.saved()).toBeNull()
    expect(f.store.save).not.toHaveBeenCalled()
  })

  it('rejects an exchange that completes after the original login deadline', async () => {
    const f = fixture()
    const release = Promise.withResolvers<AccessGrant>()
    f.transport.exchange.mockReturnValueOnce(release.promise)
    await f.broker.startSignIn()
    await f.complete()
    await vi.waitFor(() =>{  expect(f.transport.exchange).toHaveBeenCalledOnce() })
    f.advance(300_001)
    release.resolve(parseAccessGrant(wire(), start + 300_001))
    await vi.waitFor(() =>{  expect(f.broker.getSnapshot()).toEqual({ status: 'signed-out', errorCode: 'expired' }) })
    expect(f.saved()).toBeNull()
    expect(f.store.save).not.toHaveBeenCalled()
  })

  it('cannot restore a cancelled attempt when system-browser opening finishes late', async () => {
    const f = fixture()
    const release = Promise.withResolvers<undefined>()
    f.openExternal.mockReturnValueOnce(release.promise)
    const opening = f.broker.startSignIn()
    await vi.waitFor(() =>{  expect(f.openExternal).toHaveBeenCalledOnce() })
    await f.broker.cancelSignIn()
    release.resolve(undefined)
    await opening
    expect(f.broker.getSnapshot()).toEqual({ status: 'signed-out' })
    expect(f.transport.exchange).not.toHaveBeenCalled()
    expect(f.transport.cancel).toHaveBeenCalledWith('dar.request', expect.any(String))
  })

  it('clears a delayed storage result after logout and never reactivates the account', async () => {
    const f = fixture()
    const release = Promise.withResolvers<undefined>()
    f.store.save.mockImplementationOnce(async (grant) => { await release.promise; f.setSaved(grant) })
    await f.broker.startSignIn()
    await f.complete()
    await vi.waitFor(() =>{  expect(f.store.save).toHaveBeenCalledOnce() })
    const logout = f.broker.signOut()
    expect(f.broker.getSnapshot()).toEqual({ status: 'signed-out' })
    release.resolve(undefined)
    await logout
    await vi.waitFor(() =>{  expect(f.transport.revoke).toHaveBeenCalled() })
    expect(f.saved()).toBeNull()
    expect(f.broker.getSnapshot().status).toBe('signed-out')
  })

  it('clears a partial initial save even when remote revocation is unavailable', async () => {
    const f = fixture()
    f.store.save.mockImplementationOnce((grant) => {
      f.setSaved(grant)
      return Promise.reject(new HalluCodexAuthError('storage_error'))
    })
    f.transport.revoke.mockRejectedValueOnce(new Error('offline'))
    await f.broker.startSignIn()
    await f.complete()
    await vi.waitFor(() => { expect(f.broker.getSnapshot()).toEqual({ status: 'signed-out', errorCode: 'storage_error' }) })
    expect(f.saved()).toBeNull()
    expect(f.transport.revoke).toHaveBeenCalledWith('dsr.refresh-secret')
  })

  it('clears a partial save that fails after disposal invalidated the login generation', async () => {
    const f = fixture()
    const release = Promise.withResolvers<undefined>()
    f.store.save.mockImplementationOnce(async (grant) => {
      await release.promise
      f.setSaved(grant)
      throw new HalluCodexAuthError('storage_error')
    })
    f.transport.revoke.mockRejectedValueOnce(new Error('offline'))
    await f.broker.startSignIn()
    await f.complete()
    await vi.waitFor(() => { expect(f.store.save).toHaveBeenCalledOnce() })
    const disposal = f.broker.dispose()
    release.resolve(undefined)
    await disposal
    expect(f.saved()).toBeNull()
    expect(f.broker.getSnapshot()).toEqual({ status: 'signed-out' })
  })

  it('rejects late refresh after logout and leaves no persisted account', async () => {
    const f = fixture()
    await f.login()
    f.advance(880_000)
    const release = Promise.withResolvers<AccessGrant>()
    f.transport.refresh.mockReturnValueOnce(release.promise)
    const access = f.broker.getAccessToken()
    const rejected = expect(access).rejects.toThrow('cancelled')
    await f.broker.signOut()
    release.resolve(parseAccessGrant(wire({ refresh_token: 'dsr.next' }), start + 880_000))
    await rejected
    expect(f.saved()).toBeNull()
    expect(f.broker.getSnapshot().status).toBe('signed-out')
  })

  it('retains the account on transient refresh failure and reports terminal revocation', async () => {
    const f = fixture()
    await f.login()
    f.advance(880_000)
    f.transport.refresh.mockRejectedValueOnce(new Error('private transport detail'))
    f.transport.refresh.mockRejectedValueOnce(new Error('private transport detail'))
    await expect(f.broker.getAccessToken()).rejects.toThrow(/^network_error$/u)
    expect(f.transport.refresh).toHaveBeenCalledTimes(2)
    expect(f.broker.getSnapshot().status).toBe('signed-in')
    expect(f.saved()?.refreshToken).toBe('dsr.refresh-secret')
    f.transport.refresh.mockRejectedValueOnce(new HalluCodexAuthError('invalid_grant'))
    await expect(f.broker.getAccessToken()).rejects.toThrow('invalid_grant')
    expect(f.transport.refresh).toHaveBeenCalledTimes(3)
    expect(f.broker.getSnapshot()).toEqual({ status: 'signed-out', errorCode: 'invalid_grant' })
    expect(f.saved()).toBeNull()
  })

  it('retries one lost refresh response immediately so a committed rotation is not replayed later', async () => {
    const f = fixture()
    await f.login()
    f.advance(880_000)
    f.transport.refresh.mockRejectedValueOnce(new Error('connection reset'))
    await expect(f.broker.getAccessToken()).resolves.toBe('dsk.rotated-access')
    expect(f.transport.refresh).toHaveBeenCalledTimes(2)
    expect(f.transport.refresh.mock.calls[1]?.[0].refreshToken).toBe('dsr.refresh-secret')
    expect(f.saved()?.refreshToken).toBe('dsr.rotated-refresh')
  })

  it('rotates a server-rejected access token on next use', async () => {
    const f = fixture()
    await f.login()
    f.broker.expireAccessToken()
    await expect(f.broker.getAccessToken()).resolves.toBe('dsk.rotated-access')
    expect(f.transport.refresh).toHaveBeenCalledOnce()
  })

  it('revokes a received rotation if persistence fails rather than replaying its consumed predecessor', async () => {
    const f = fixture()
    await f.login()
    f.advance(880_000)
    f.store.save.mockRejectedValueOnce(new HalluCodexAuthError('storage_error'))
    await expect(f.broker.getAccessToken()).rejects.toThrow('storage_error')
    expect(f.saved()).toBeNull()
    await expect(f.broker.getAccessToken()).rejects.toThrow('signed_out')
    expect(f.transport.revoke).toHaveBeenCalledWith('dsr.rotated-refresh')
    expect(f.transport.refresh).toHaveBeenCalledOnce()
  })

  it('refuses an extended absolute refresh lifetime and clears expired saved accounts', async () => {
    const f = fixture()
    await f.login()
    f.advance(880_000)
    f.transport.refresh.mockResolvedValueOnce(parseAccessGrant(wire({ refresh_token: 'dsr.next', refresh_expires_at: refreshDeadline + 100 }), start + 880_000))
    await expect(f.broker.getAccessToken()).rejects.toThrow('invalid_response')
    expect(f.saved()).toBeNull()
    f.setSaved(parseAccessGrant(wire(), start))
    f.advance(30 * 86400 * 1000)
    await f.broker.restore()
    expect(f.broker.getSnapshot()).toEqual({ status: 'signed-out', errorCode: 'expired' })
    expect(f.saved()).toBeNull()
  })

  it.each([
    { group: 'default' }, { profile: { id: 'other-user', display_name: 'Other' } }, { device_session_id: 'other-device' },
    { refresh_token: 'dsr.refresh-secret' },
  ])('requires new authorization for refresh identity changes: %j', async (fields) => {
    const f = fixture()
    await f.login()
    f.advance(880_000)
    f.transport.refresh.mockResolvedValueOnce(parseAccessGrant(wire({ refresh_token: 'dsr.next', ...fields }), start + 880_000))
    await expect(f.broker.getAccessToken()).rejects.toThrow('invalid_response')
    expect(f.broker.getSnapshot().status).toBe('signed-out')
    expect(f.saved()).toBeNull()
  })

  it('revokes the saved family after restore failed transiently', async () => {
    const f = fixture()
    f.setSaved(parseAccessGrant(wire(), start))
    f.transport.refresh.mockRejectedValueOnce(new HalluCodexAuthError('network_error'))
    f.transport.refresh.mockRejectedValueOnce(new HalluCodexAuthError('network_error'))
    await f.broker.restore()
    expect(f.saved()?.refreshToken).toBe('dsr.refresh-secret')
    await expect(f.broker.signOut()).resolves.toEqual({ remoteRevoked: true })
    expect(f.transport.revoke).toHaveBeenCalledWith('dsr.refresh-secret')
    expect(f.saved()).toBeNull()
  })

  it('preserves local logout if remote revocation fails and refuses stale request credentials', async () => {
    const f = fixture()
    await f.login()
    const credentials = f.broker.getRequestCredentials()
    const rejected = expect(credentials).rejects.toThrow('cancelled')
    f.transport.revoke.mockRejectedValueOnce(new Error('private transport detail'))
    await expect(f.broker.signOut()).resolves.toEqual({ remoteRevoked: false })
    await rejected
    expect(f.saved()).toBeNull()
    await expect(f.broker.getAccessToken()).rejects.toThrow('signed_out')
  })

  it('still revokes remotely when local deletion fails, and exposes the local cleanup failure', async () => {
    const f = fixture()
    await f.login()
    f.store.clear.mockRejectedValueOnce(new HalluCodexAuthError('storage_error'))
    await expect(f.broker.signOut()).rejects.toThrow('storage_error')
    expect(f.transport.revoke).toHaveBeenCalledWith('dsr.refresh-secret')
    expect(f.broker.getSnapshot()).toEqual({ status: 'signed-out', errorCode: 'storage_error' })
  })

  it('waits for explicit logout revocation before disposal finishes', async () => {
    const f = fixture()
    await f.login()
    const release = Promise.withResolvers<undefined>()
    f.transport.revoke.mockReturnValueOnce(release.promise)
    const logout = f.broker.signOut()
    await vi.waitFor(() => { expect(f.transport.revoke).toHaveBeenCalledOnce() })
    const disposed = vi.fn()
    const disposal = f.broker.dispose().then(disposed)
    await new Promise(resolve => setImmediate(resolve))
    expect(disposed).not.toHaveBeenCalled()
    release.resolve(undefined)
    await Promise.all([logout, disposal])
    expect(disposed).toHaveBeenCalledOnce()
  })

  it('restores only by rotating the saved grant, and disposal retains ciphertext but not live account state', async () => {
    const f = fixture()
    f.setSaved(parseAccessGrant(wire(), start))
    await Promise.all([f.broker.restore(), f.broker.restore()])
    expect(f.transport.refresh).toHaveBeenCalledOnce()
    expect(f.broker.getSnapshot().status).toBe('signed-in')
    await f.broker.dispose()
    expect(f.saved()?.refreshToken).toBe('dsr.rotated-refresh')
    expect(f.broker.getSnapshot()).toEqual({ status: 'signed-out' })
    await expect(f.broker.startSignIn()).rejects.toThrow('cancelled')
  })

  it('does not launch the browser without OS-backed storage, and sanitizes observer exceptions', async () => {
    const f = fixture()
    f.store.assertAvailable.mockImplementation(() => { throw new HalluCodexAuthError('secure_storage_unavailable') })
    f.onChange.mockImplementation(() => { throw new Error('observer failed') })
    expect(await f.broker.startSignIn()).toEqual({ status: 'signed-out', errorCode: 'secure_storage_unavailable' })
    expect(f.openExternal).not.toHaveBeenCalled()
    expect(f.transport.authorize).not.toHaveBeenCalled()
  })

  it('invalidates earlier registration and browser-open completions when a newer attempt starts', async () => {
    const f = fixture()
    const release = Promise.withResolvers<{ authorizationUrl: string; requestId: string }>()
    f.transport.authorize.mockReturnValueOnce(release.promise)
    const old = f.broker.startSignIn()
    await vi.waitFor(() =>{  expect(f.transport.authorize).toHaveBeenCalledOnce() })
    await f.broker.startSignIn()
    release.resolve({ authorizationUrl: `${HALLUCODEX_ORIGIN}/desktop/authorize?request_id=dar.old`, requestId: 'dar.old' })
    await old
    expect(f.openExternal).toHaveBeenCalledOnce()
    expect(f.transport.cancel).toHaveBeenCalledWith('dar.old', expect.any(String))
    await f.complete()
    await vi.waitFor(() =>{  expect(f.broker.getSnapshot().status).toBe('signed-in') })
  })
})

async function diskFixture(backend = 'gnome_libsecret', platform: NodeJS.Platform = process.platform) {
  const root = await mkdtemp(join(tmpdir(), 'hallucodex-auth-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const directory = join(root, 'account')
  const key = randomBytes(32)
  const encryption: SafeStorageEncryption = {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => backend,
    encryptString: (value) => {
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', key, iv)
      const encrypted = Buffer.concat([cipher.update(value), cipher.final()])
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted])
    },
    decryptString: (value) => {
      const cipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12))
      cipher.setAuthTag(value.subarray(12, 28))
      return Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]).toString('utf8')
    },
  }
  const store = new SafeStorageRefreshStore(directory, encryption, () => HALLUCODEX_ORIGIN, platform)
  return { root, directory, file: join(directory, 'refresh.enc'), store, encryption }
}

describe('group selection', () => {
  it('moves the session with a rotated credential and hands waiting requests the new token', async () => {
    const f = fixture(selectScopes)
    await f.login()
    expect(f.broker.getSnapshot()).toMatchObject({ status: 'signed-in', group: 'discount', canSelectGroup: true })
    const moved = Promise.withResolvers<AccessGrant>()
    f.transport.selectGroup.mockImplementationOnce(() => moved.promise)
    const selecting = f.broker.selectGroup('default')
    expect(f.transport.selectGroup).toHaveBeenCalledOnce()
    expect(f.transport.selectGroup.mock.calls[0]?.slice(0, 2)).toEqual([expect.objectContaining({ refreshToken: 'dsr.refresh-secret', group: 'discount' }), 'default'])
    expect(f.transport.selectGroup.mock.calls[0]?.[0]).not.toHaveProperty('accessToken')
    // The old access token is still fresh, but a request must not run under the group being left.
    const waiting = f.broker.getRequestCredentials()
    moved.resolve(parseAccessGrant(wire({ access_token: 'dsk.moved-access', refresh_token: 'dsr.moved-refresh', group: 'default', scope: selectScopes }), start))
    await expect(selecting).resolves.toMatchObject({ status: 'signed-in', group: 'default', canSelectGroup: true })
    await expect(waiting).resolves.toEqual({ accessToken: 'dsk.moved-access', deviceSessionId: 'session-1', group: 'default' })
    expect(f.saved()).toMatchObject({ refreshToken: 'dsr.moved-refresh', group: 'default' })
    expect(f.saved()).not.toHaveProperty('accessToken')
    expect(f.transport.revoke).not.toHaveBeenCalled()
    await expect(f.broker.selectGroup('default')).resolves.toMatchObject({ group: 'default' })
    expect(f.transport.selectGroup).toHaveBeenCalledOnce()
  })

  it('keeps the login and group when the server refuses the group', async () => {
    const f = fixture(selectScopes)
    await f.login()
    f.transport.selectGroup.mockRejectedValueOnce(new HalluCodexAuthError('group_unavailable'))
    await expect(f.broker.selectGroup('default')).rejects.toThrow('group_unavailable')
    expect(f.broker.getSnapshot()).toMatchObject({ status: 'signed-in', group: 'discount' })
    expect(f.saved()).toMatchObject({ refreshToken: 'dsr.refresh-secret', group: 'discount' })
    expect(f.transport.revoke).not.toHaveBeenCalled()
    await expect(f.broker.getAccessToken()).resolves.toBe('dsk.access-secret')
  })

  it('retries one lost move response, since the server repeats the committed successor', async () => {
    const f = fixture(selectScopes)
    await f.login()
    f.transport.selectGroup.mockRejectedValueOnce(new HalluCodexAuthError('network_error'))
    await expect(f.broker.selectGroup('default')).resolves.toMatchObject({ group: 'default' })
    expect(f.transport.selectGroup).toHaveBeenCalledTimes(2)
    expect(f.transport.selectGroup.mock.calls[1]?.[0].refreshToken).toBe('dsr.refresh-secret')
  })

  it('signs out when the server answers with another group, and asks nothing of a server without group selection', async () => {
    const legacy = fixture()
    await legacy.login()
    await expect(legacy.broker.selectGroup('default')).rejects.toThrow('access_denied')
    await expect(legacy.broker.selectGroup('auto')).rejects.toThrow('group_invalid')
    expect(legacy.transport.selectGroup).not.toHaveBeenCalled()
    expect(legacy.broker.getSnapshot()).toMatchObject({ status: 'signed-in', group: 'discount', canSelectGroup: false })
    const f = fixture(selectScopes)
    await f.login()
    f.transport.selectGroup.mockResolvedValueOnce(parseAccessGrant(wire({ refresh_token: 'dsr.moved-refresh', scope: selectScopes }), start))
    await expect(f.broker.selectGroup('default')).rejects.toThrow('invalid_response')
    expect(f.broker.getSnapshot()).toEqual({ status: 'signed-out', errorCode: 'invalid_response' })
    await vi.waitFor(() => { expect(f.transport.revoke).toHaveBeenCalledWith('dsr.moved-refresh') })
    expect(f.saved()).toBeNull()
  })
})

describe('encrypted refresh storage', () => {
  it('atomically persists only encrypted refresh data in private files and removes it without decrypting', async () => {
    const f = await diskFixture()
    expect(await f.store.load()).toBeNull()
    const grant = parseAccessGrant(wire(), start)
    await f.store.save(grant)
    if (process.platform !== 'win32') {
      expect((await stat(f.directory)).mode & 0o777).toBe(0o700)
      expect((await stat(f.file)).mode & 0o777).toBe(0o600)
    }
    const encrypted = await readFile(f.file)
    expect(encrypted.toString()).not.toContain(grant.refreshToken)
    const decrypted = f.encryption.decryptString(encrypted)
    expect(decrypted).not.toContain(grant.accessToken)
    expect(decrypted).not.toContain('accessToken')
    expect(JSON.parse(decrypted)).toMatchObject({ origin: HALLUCODEX_ORIGIN })
    expect(await f.store.load()).toMatchObject({ refreshToken: grant.refreshToken, group: 'discount' })
    expect(await readdir(f.directory)).toEqual(['refresh.enc'])
    f.encryption.isEncryptionAvailable = () => false
    await f.store.clear()
    expect(await readdir(f.directory)).toEqual([])
  })

  it.each(['basic_text', 'unknown', 'unrecognized-keyring', ''])('fails closed for insecure Linux backend %s', async (backend) => {
    const f = await diskFixture(backend, 'linux')
    await expect(f.store.save(parseAccessGrant(wire(), start))).rejects.toThrow('secure_storage_unavailable')
    await expect(f.store.load()).rejects.toThrow('secure_storage_unavailable')
    expect(await readdir(f.root)).toEqual([])
  })

  it('rejects corrupted ciphertext, insecure existing file permissions, and foreign persisted origins', async () => {
    const f = await diskFixture()
    await f.store.save(parseAccessGrant(wire(), start))
    if (process.platform !== 'win32') {
      await chmod(f.file, 0o644)
      await expect(f.store.load()).rejects.toThrow('storage_error')
      await expect(f.store.save(parseAccessGrant(wire(), start))).rejects.toThrow('storage_error')
      await chmod(f.file, 0o600)
    }
    await writeFile(f.file, 'malformed')
    await expect(f.store.load()).rejects.toThrow('storage_error')
    const record = { ...parseAccessGrant(wire(), start), version: 1, origin: 'https://evil.example' }
    await writeFile(f.file, f.encryption.encryptString(JSON.stringify(record)))
    await expect(f.store.load()).rejects.toThrow('storage_error')
  })

  it.skipIf(process.platform === 'win32')('refuses a credential symlink, and clear unlinks it without touching its target', async () => {
    const f = await diskFixture()
    await f.store.load()
    const target = join(f.root, 'outside')
    await writeFile(target, 'keep-me')
    await symlink(target, f.file)
    await expect(f.store.load()).rejects.toThrow('storage_error')
    await expect(f.store.save(parseAccessGrant(wire(), start))).rejects.toThrow('storage_error')
    await f.store.clear()
    expect(await readFile(target, 'utf8')).toBe('keep-me')
  })
})

it('accepts the complete server group limit without rejecting a legitimate large token response', async () => {
  const groups = Array.from({ length: 1024 }, (_, index) => `g${String(index).padStart(4, '0')}${'x'.repeat(59)}`)
  const data = wire({ group: groups[0], allowed_groups: groups })
  expect(Buffer.byteLength(JSON.stringify(data))).toBeGreaterThan(65_536)
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(data))
  const transport = new HalluCodexHttpAuthTransport(() => HALLUCODEX_ORIGIN, fetcher, () => start)
  const grant = await transport.exchange({ code: 'dsc.fixture', codeVerifier: 'v'.repeat(43), redirectUri: 'http://127.0.0.1:43210/oauth/callback' }, new AbortController().signal)
  expect(grant.allowedGroups).toHaveLength(1024)
  expect(() => parseAccessGrant(wire({ group: groups[0], allowed_groups: [...groups, 'extra'] }), start)).toThrow('group_invalid')
})

describe('server selection and device naming', () => {
  it('normalizes a site address to its origin and refuses paths, credentials and other schemes', async () => {
    const { normalizeServerOrigin } = await import('../src/hallucodex/server-origin.ts')
    expect(normalizeServerOrigin(' https://API.HalluCodex.com/ ')).toBe('https://api.hallucodex.com')
    expect(normalizeServerOrigin('http://192.168.1.20:3000')).toBe('http://192.168.1.20:3000')
    for (const value of ['http://sgm1.example:60003/v1', 'https://user:pass@example.com', 'ftp://example.com', 'https://example.com/?a=1', 'https://example.com/#x', 'example.com', 7]) {
      expect(() => normalizeServerOrigin(value)).toThrow('invalid server address')
    }
  })

  it('persists the selection and falls back to the production service when the file is missing or damaged', async () => {
    const { DEFAULT_HALLUCODEX_ORIGIN, ServerOriginSetting, readServerOrigin } = await import('../src/hallucodex/server-origin.ts')
    const root = await mkdtemp(join(tmpdir(), 'hallucodex-server-'))
    onTestFinished(() => rm(root, { recursive: true, force: true }))
    const file = join(root, 'hallucodex-server.json')
    expect(ServerOriginSetting.load(file).get()).toBe(DEFAULT_HALLUCODEX_ORIGIN)
    ServerOriginSetting.load(file).set('http://localhost:3000/')
    expect(ServerOriginSetting.load(file).get()).toBe('http://localhost:3000')
    await writeFile(file, '{"origin":"javascript:alert(1)"}')
    expect(readServerOrigin(file)).toBe(DEFAULT_HALLUCODEX_ORIGIN)
  })

  it('names the device after its host and system within the server limit', async () => {
    const { desktopDeviceName } = await import('../src/hallucodex/device-name.ts')
    expect(desktopDeviceName('akuma-laptop', 'linux', 'x64')).toBe('akuma-laptop · Linux x64')
    expect(desktopDeviceName('DESKTOP-01\n', 'win32', 'x64')).toBe('DESKTOP-01 · Windows x64')
    expect(desktopDeviceName('', 'darwin', 'arm64')).toBe('HalluCodex · macOS arm64')
    const long = desktopDeviceName('主机'.repeat(80), 'darwin', 'arm64')
    expect(Buffer.byteLength(long)).toBeLessThanOrEqual(128)
    expect(long.endsWith(' · macOS arm64')).toBe(true)
  })
})
