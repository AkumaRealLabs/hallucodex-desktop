/** Locale-owned text for the native HalluCodex account dialog. */
/** Localized account dialog copy. */
export interface HalluCodexAccountCopy {
  title: string
  signIn: string
  cancel: string
  signOut: string
  close: string
  refresh: string
  signedOut: string
  waiting: string
  group: string
  models: string
  unavailable: string
  failed: string
  privacy: string
  secureStorage: string
  selectGroup: string
  remoteRevokeFailed: string
  wallet: string
  accountUsage: string
  quotaUnavailable: string
  walletPage: string
  usagePage: string
  devicePage: string
  deviceUsage: string
  deviceLimit: string
  deviceUnlimited: string
  server: string
  serverSave: string
  serverHint: string
  insecureServer: string
  invalidServer: string
  customServer: string
  changeServer: string
  useDefaultServer: string
  denied: string
}

/**
 * Resolve the native account dictionary; unrecognized languages use English.
 * @param language - desktop UI language.
 * @returns the complete localized dictionary.
 */
export function halluCodexAccountCopy(language: string): HalluCodexAccountCopy {
  return language.toLowerCase().startsWith('zh') ? {
    devicePage: '安全与设备', walletPage: '钱包与充值', usagePage: '用量记录', wallet: '钱包剩余（额度）', accountUsage: '账号累计用量', quotaUnavailable: '暂不可用',
    title: 'HalluCodex 账号', signIn: '在浏览器中登录', cancel: '取消登录', signOut: '退出登录', close: '关闭', refresh: '刷新账号',
    signedOut: '尚未登录', waiting: '请在系统浏览器中完成授权…', group: '分组', models: '可用模型', unavailable: '暂不可用',
    failed: '操作未完成，请重试', privacy: '发送给模型的内容会经过 HalluCodex 并可能发送给模型供应商。本机文件不会自动全部上传。',
    secureStorage: '请先启用系统钥匙串。不能使用明文存储登录凭证。', selectGroup: '登录时在网页中选择账号允许的具体分组；切组需要重新授权。',
    remoteRevokeFailed: '本机已退出，远端撤销尚未确认，该设备的远端权限可能仍然有效，可前往“安全与设备”撤销。',
    deviceUsage: '本设备已用', deviceLimit: '本设备上限', deviceUnlimited: '不限',
    server: '服务器', serverSave: '切换', serverHint: '填写 New API 站点地址，例如你的测试站，不要带 /v1 等路径。',
    insecureServer: '这是 HTTP 地址，登录凭证和对话内容会明文传输，只适合本机或内网测试。',
    invalidServer: '服务器地址无效。请填写以 http:// 或 https:// 开头、不带路径的站点地址。',
    denied: '你在浏览器中拒绝了授权。', customServer: '使用自定义服务器', changeServer: '修改', useDefaultServer: '恢复官方服务',
  } : {
    devicePage: 'Security & devices', walletPage: 'Wallet & top-up', usagePage: 'Usage', wallet: 'Wallet balance (quota)', accountUsage: 'Account usage', quotaUnavailable: 'Unavailable',
    title: 'HalluCodex account', signIn: 'Sign in using browser', cancel: 'Cancel sign-in', signOut: 'Sign out', close: 'Close', refresh: 'Refresh account',
    signedOut: 'Not signed in', waiting: 'Finish authorization in your browser…', group: 'Group', models: 'Available models',
    unavailable: 'Unavailable', failed: 'The operation did not complete. Please retry.',
    privacy: 'Model context is sent through HalluCodex and may reach the model provider. Your entire workspace is not uploaded automatically.',
    secureStorage: 'Enable your operating-system keyring first. Plaintext credential storage is not allowed.',
    selectGroup: 'Choose a concrete account-allowed group on the authorization page. Changing groups requires new authorization.',
    remoteRevokeFailed: 'Signed out locally. Remote revocation was not confirmed; remote access may remain active. Use Security / devices to revoke it.',
    deviceUsage: 'This device used', deviceLimit: 'Device limit', deviceUnlimited: 'None',
    server: 'Server', serverSave: 'Switch', serverHint: 'Enter a New API site address, such as your test server, without a path like /v1.',
    insecureServer: 'This is an HTTP address. Credentials and conversations travel unencrypted; use it only for local or private-network testing.',
    invalidServer: 'Invalid server address. Enter a site address starting with http:// or https://, without a path.',
    denied: 'You denied the authorization in the browser.', customServer: 'Use a custom server', changeServer: 'Change', useDefaultServer: 'Use HalluCodex service',
  }
}
