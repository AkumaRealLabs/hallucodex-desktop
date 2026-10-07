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
  groupSwitchNote: string
  groupFixed: string
  groupUnavailable: string
  ratio: string
  remoteRevokeFailed: string
  wallet: string
  /** Wallet label when the site's quota display settings are unknown and raw quota is shown. */
  walletQuota: string
  /** Locale for formatting amounts. */
  numberLocale: string
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
  refreshing: string
  updatedAt: string
  staleWallet: string
  refreshWallet: string
  retryCatalog: string
  retryRestore: string
  networkError: string
  sessionExpired: string
  catalogFailed: string
  walletFailed: string
  accountRefreshFailed: string
  switchGroup: string
  switchingGroup: string
  groupSelected: string
  candidateGroup: string
}

/**
 * Resolve the native account dictionary; unrecognized languages use English.
 * @param language - desktop UI language.
 * @returns the complete localized dictionary.
 */
export function halluCodexAccountCopy(language: string): HalluCodexAccountCopy {
  return language.toLowerCase().startsWith('zh') ? {
    devicePage: '安全与设备', walletPage: '钱包与充值', usagePage: '用量记录', wallet: '钱包剩余', walletQuota: '钱包剩余（额度）', numberLocale: 'zh-CN', accountUsage: '账号累计用量', quotaUnavailable: '暂不可用',
    title: 'HalluCodex 账号', signIn: '在浏览器中登录', cancel: '取消登录', signOut: '退出登录', close: '关闭', refresh: '刷新账号',
    signedOut: '尚未登录', waiting: '请在系统浏览器中完成授权…', group: '分组', models: '可用模型', unavailable: '暂不可用',
    failed: '操作未完成，请重试', privacy: '发送给模型的内容会经过 HalluCodex 并可能发送给模型供应商。本机文件不会自动全部上传。',
    secureStorage: '请先启用系统钥匙串。不能使用明文存储登录凭证。', selectGroup: '登录时在网页中选择账号允许的分组。',
    refreshing: '正在刷新…', updatedAt: '上次成功更新', staleWallet: '刷新失败，显示上次数据。', refreshWallet: '刷新余额',
    retryCatalog: '刷新可用分组与模型', retryRestore: '重试恢复登录', networkError: '网络连接失败或服务器暂不可用，请稍后重试。',
    sessionExpired: '登录已失效，请重新在浏览器中登录。', catalogFailed: '分组与模型目录读取失败。', walletFailed: '余额读取失败。',
    accountRefreshFailed: '账号能力刷新失败。', switchGroup: '切换分组', switchingGroup: '正在切换至', groupSelected: '已切换至', candidateGroup: '待切换分组',
    groupSwitchNote: '选择分组查看倍率和说明，再点击“切换分组”确认。之后的请求按新分组的倍率计费。',
    groupFixed: '当前服务器不支持在客户端切换分组。要换分组，请退出后重新登录，并在网页中选择。',
    groupUnavailable: '该分组已不可用，仍使用原来的分组。', ratio: '倍率',
    remoteRevokeFailed: '本机已退出，远端撤销尚未确认，该设备的远端权限可能仍然有效，可前往“安全与设备”撤销。',
    deviceUsage: '本设备已用', deviceLimit: '本设备上限', deviceUnlimited: '不限',
    server: '服务器', serverSave: '切换', serverHint: '填写 New API 站点地址，例如你的测试站，不要带 /v1 等路径。',
    insecureServer: '这是 HTTP 地址，登录凭证和对话内容会明文传输，只适合本机或内网测试。',
    invalidServer: '服务器地址无效。请填写以 http:// 或 https:// 开头、不带路径的站点地址。',
    denied: '你在浏览器中拒绝了授权。', customServer: '使用自定义服务器', changeServer: '修改', useDefaultServer: '恢复官方服务',
  } : {
    devicePage: 'Security & devices', walletPage: 'Wallet & top-up', usagePage: 'Usage', wallet: 'Wallet balance', walletQuota: 'Wallet balance (quota)', numberLocale: 'en-US', accountUsage: 'Account usage', quotaUnavailable: 'Unavailable',
    title: 'HalluCodex account', signIn: 'Sign in using browser', cancel: 'Cancel sign-in', signOut: 'Sign out', close: 'Close', refresh: 'Refresh account',
    signedOut: 'Not signed in', waiting: 'Finish authorization in your browser…', group: 'Group', models: 'Available models',
    unavailable: 'Unavailable', failed: 'The operation did not complete. Please retry.',
    privacy: 'Model context is sent through HalluCodex and may reach the model provider. Your entire workspace is not uploaded automatically.',
    secureStorage: 'Enable your operating-system keyring first. Plaintext credential storage is not allowed.',
    selectGroup: 'Choose an account-allowed group on the authorization page.',
    refreshing: 'Refreshing…', updatedAt: 'Last updated', staleWallet: 'Refresh failed; showing the last successful data.', refreshWallet: 'Refresh balance',
    retryCatalog: 'Refresh groups and models', retryRestore: 'Retry restoring sign-in', networkError: 'The network or server is unavailable. Please retry later.',
    sessionExpired: 'Your sign-in has expired. Sign in again using your browser.', catalogFailed: 'Could not read groups and models.', walletFailed: 'Could not read the balance.',
    accountRefreshFailed: 'Could not refresh account capabilities.', switchGroup: 'Switch group', switchingGroup: 'Switching to', groupSelected: 'Switched to', candidateGroup: 'Selected group',
    groupSwitchNote: 'Select a group to preview its rate and description, then confirm with Switch group. Later requests are charged at the new group\'s rate.',
    groupFixed: 'This server does not support switching groups in the app. To change groups, sign out, sign in again and choose one on the web page.',
    groupUnavailable: 'That group is no longer available. The current group is still in use.', ratio: 'ratio',
    remoteRevokeFailed: 'Signed out locally. Remote revocation was not confirmed; remote access may remain active. Use Security / devices to revoke it.',
    deviceUsage: 'This device used', deviceLimit: 'Device limit', deviceUnlimited: 'None',
    server: 'Server', serverSave: 'Switch', serverHint: 'Enter a New API site address, such as your test server, without a path like /v1.',
    insecureServer: 'This is an HTTP address. Credentials and conversations travel unencrypted; use it only for local or private-network testing.',
    invalidServer: 'Invalid server address. Enter a site address starting with http:// or https://, without a path.',
    denied: 'You denied the authorization in the browser.', customServer: 'Use a custom server', changeServer: 'Change', useDefaultServer: 'Use HalluCodex service',
  }
}
