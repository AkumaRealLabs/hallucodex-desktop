/** Minimal wallet quota read for the owned account dialog; currency comes only from the site's own display settings. */
import { parseQuotaDisplay, type HalluCodexQuotaDisplay } from './quota-display.ts'
import type { RelayAccess } from './relay-broker.ts'

/** Server-authoritative wallet balance, account-wide usage and this device's usage and cap, preserving integer precision. */
export interface HalluCodexWalletQuota {
  readonly remaining: string
  readonly accountUsage: string
  readonly deviceUsage: string
  /** Undefined while the device has no cap. */
  readonly deviceLimit?: string
  readonly unit: 'quota'
}

/** Thrown when the server rejects the access token, so the caller can refresh it once. */
export class HalluCodexUnauthorizedError extends Error {
  constructor() { super('hallucodex: access token rejected') }
}

/**
 * Read bounded quota metadata with the native account credential.
 * @param fetcher - trusted native fetch implementation.
 * @param origin - selected server origin.
 * @param access - private grant, never a renderer argument.
 * @param signal - account generation cancellation.
 * @returns precise quota counters, independent of model availability.
 * @throws {HalluCodexUnauthorizedError} When the server rejects the access token.
 */
export async function readHalluCodexWalletQuota(
  fetcher: typeof fetch, origin: string, access: RelayAccess, signal: AbortSignal,
): Promise<HalluCodexWalletQuota> {
  try {
    const response = await fetcher(`${origin}/api/desktop/v1/balance`, {
      headers: { authorization: `Bearer ${access.accessToken}`, accept: 'application/json' },
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]), redirect: 'error', credentials: 'omit', cache: 'no-store',
    })
    if (response.status === 401) {
      await response.body?.cancel()
      throw new HalluCodexUnauthorizedError()
    }
    const value = await readBoundedJson(response, 8192)
    if (typeof value !== 'object' || value === null || !('unit' in value) || value.unit !== 'quota'
      || !('quota_used_kind' in value) || value.quota_used_kind !== 'account_usage_total'
      || !('quota_remaining' in value) || typeof value.quota_remaining !== 'string' || !/^-?(?:0|[1-9]\d{0,18})$/u.test(value.quota_remaining)
      || !('quota_used' in value) || typeof value.quota_used !== 'string' || !/^(?:0|[1-9]\d{0,18})$/u.test(value.quota_used)
      || !('device_quota_used' in value) || typeof value.device_quota_used !== 'string' || !/^-?(?:0|[1-9]\d{0,18})$/u.test(value.device_quota_used)
      || !('device_quota_limit' in value) || (value.device_quota_limit !== null
        && (typeof value.device_quota_limit !== 'string' || !/^(?:0|[1-9]\d{0,18})$/u.test(value.device_quota_limit)))) {
      throw new Error('invalid quota metadata')
    }
    return {
      remaining: value.quota_remaining, accountUsage: value.quota_used, deviceUsage: value.device_quota_used,
      ...(value.device_quota_limit === null ? {} : { deviceLimit: value.device_quota_limit }), unit: 'quota',
    }
  } catch (error) {
    if (error instanceof HalluCodexUnauthorizedError) throw error
    throw new Error('hallucodex: wallet quota unavailable')
  }
}

/**
 * Read how the site shows quota from its public status, without any account credential.
 * @param fetcher - trusted native fetch implementation.
 * @param origin - selected server origin.
 * @param signal - account generation cancellation.
 * @returns the site's quota unit and currency settings.
 */
export async function readHalluCodexQuotaDisplay(
  fetcher: typeof fetch, origin: string, signal: AbortSignal,
): Promise<HalluCodexQuotaDisplay> {
  try {
    const response = await fetcher(`${origin}/api/status`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]), redirect: 'error', credentials: 'omit', cache: 'no-store',
    })
    // The status also carries site notices and pages, so it gets a larger bound than the wallet.
    return parseQuotaDisplay(await readBoundedJson(response, 1024 * 1024))
  } catch (_error) {
    throw new Error('hallucodex: quota display unavailable')
  }
}

/**
 * Decode a successful JSON response of at most `limit` bytes.
 * @param response - same-origin response.
 * @param limit - largest accepted body in bytes.
 * @returns the decoded value.
 */
async function readBoundedJson(response: Response, limit: number): Promise<unknown> {
  if (!response.ok || !response.body || !response.headers.get('content-type')?.startsWith('application/json')) {
    await response.body?.cancel()
    throw new Error('unavailable')
  }
  const reader = response.body.getReader()
  let size = 0
  const chunks: Uint8Array[] = []
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > limit) throw new Error('oversized')
      chunks.push(chunk.value)
    }
  } finally {
    await reader.cancel().catch((_cancelError: unknown) => { /* Read failures are sanitized by the caller. */ })
    reader.releaseLock()
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  return value
}
