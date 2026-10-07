/** Safe account failure categories; transport diagnostics never cross native IPC. */
import { HalluCodexAuthError } from './auth-protocol.ts'

/** Serializable account operation failure, independent of Electron's Error serialization. */
export type AccountFailure = 'network_error' | 'session_expired' | 'group_unavailable' | 'catalog_unavailable' | 'wallet_unavailable' | 'operation_failed' | 'cancelled'

/** Server rejection of the bearer; callers may rotate and retry once. */
export class HalluCodexUnauthorizedError extends Error {
  constructor() { super('hallucodex: access token rejected') }
}

/** Sanitized data-read error with a closed, renderer-safe category. */
export class HalluCodexReadError extends Error {
  constructor(readonly code: AccountFailure, message: string) { super(message) }
}

/**
 * Project native failures without copying their messages or causes.
 * @param error - Native operation failure.
 * @param fallback - Owning operation's safe category.
 * @returns A fixed category, never server text.
 */
export function accountFailure(error: unknown, fallback: AccountFailure): AccountFailure {
  if (error instanceof HalluCodexReadError) return error.code
  if (error instanceof HalluCodexUnauthorizedError) return 'session_expired'
  if (error instanceof HalluCodexAuthError) {
    if (error.code === 'network_error' || error.code === 'cancelled' || error.code === 'group_unavailable') return error.code
    if (error.code === 'invalid_grant' || error.code === 'expired' || error.code === 'signed_out') return 'session_expired'
  }
  return fallback
}

/**
 * Fetch bounded JSON, distinguishing transport failures from invalid metadata.
 * @param fetcher - Trusted native fetch.
 * @param url - Native-owned endpoint.
 * @param init - Native-owned headers and cancellation signal.
 * @param limit - Maximum response bytes.
 * @returns Untrusted JSON for endpoint-specific validation.
 */
export async function readAccountJson(fetcher: typeof fetch, url: string, init: RequestInit, limit: number): Promise<unknown> {
  let response: Response
  try { response = await fetcher(url, init) }
  catch (_error) { throw new HalluCodexReadError('network_error', 'hallucodex: network unavailable') }
  if (!response.ok || !response.body || !response.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    await response.body?.cancel().catch((_error: unknown) => { /* The rejected body is already unavailable. */ })
    if (response.status === 401) throw new HalluCodexUnauthorizedError()
    if (response.status >= 500 || response.status === 408 || response.status === 429) {
      throw new HalluCodexReadError('network_error', 'hallucodex: network unavailable')
    }
    throw new Error('hallucodex: invalid JSON response')
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const chunk = await reader.read().catch(() => { throw new HalluCodexReadError('network_error', 'hallucodex: network unavailable') })
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > limit) throw new Error('hallucodex: oversized response')
      chunks.push(chunk.value)
    }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return value
  } finally {
    await reader.cancel().catch((_error: unknown) => { /* The read result already determines the operation outcome. */ })
    reader.releaseLock()
  }
}
