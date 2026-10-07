/** HalluCodex brand and desktop-account dictionaries. */

export const NS = 'hallucodex'

/** Simplified Chinese HalluCodex messages. */
export const zh = {
  'brand.name': 'HalluCodex',
  'account.signIn': '登录 HalluCodex',
  'account.signingIn': '正在登录…',
  'account.open': 'HalluCodex 账号',
} satisfies Record<string, string>

/** Translation keys owned by the HalluCodex namespace. */
export type HalluCodexKey = keyof typeof zh

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** HalluCodex brand and desktop-account copy. */
    hallucodex: HalluCodexKey
  }
}

/** English HalluCodex messages. */
export const en = {
  'brand.name': 'HalluCodex',
  'account.signIn': 'Sign in to HalluCodex',
  'account.signingIn': 'Signing in…',
  'account.open': 'HalluCodex account',
} satisfies Record<HalluCodexKey, string>
