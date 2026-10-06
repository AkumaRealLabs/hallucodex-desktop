# HalluCodex 桌面账号模块

[English](README.md) | 中文

本参考文档说明 [src/hallucodex](../src/hallucodex) 中的原生模块。它们组合安全账号恢复、鉴权模型发现和固定连接到 `https://api.hallucodex.com` 的请求代理。Linux 安装包默认启用原生账号；未打包的开发启动通过 `DSH_HALLUCODEX_DESKTOP=1` 启用。品牌 profile 禁用上游账号、手动 key 和可配置 provider 入口。应用菜单打开原生账号对话框，操作仅限自有主框架。桌面授权端点是独立的 New API 接入，不能把管理台 JWT、PAT 或普通 API key 当作桌面授权。

## 原生进程所有权

在 Electron 主进程完成 `app.whenReady()` 并取得应用单实例锁后构造 `HalluCodexDesktopRuntime`。使用应用可信用户数据目录中的独立目录创建 `SafeStorageRefreshStore`，传入 `HalluCodexHttpAuthTransport`、原生 `fetch` 和 `shell.openExternal`。账号界面可以使用 `getSnapshot`、`startSignIn`、`cancelSignIn`、`restore`、`refreshCatalog` 和 `signOut`。桌面外壳会对每次账号 IPC 验证自有窗口和主框架来源。Preload 只渲染安全快照和本地化文案，关闭对话框会取消登录，不暴露原始 IPC 或凭证读取方法。

可信 Host 通过经过鉴权的 IPv4 本机请求代理调用 `invoke`。随机本机 capability 仅通过 Node IPC 传递，不进入配置文件、环境变量、renderer 状态或会话内容。每次已准备的请求携带账号与目录代际；在账号或分组变化前准备的请求会被拒绝。返回响应流及请求准入时绑定的分组和模型。账号凭证解析器留在主进程。账号快照和 YAML profile 都不包含 access 或 refresh token。操作系统钥匙串和文件权限保护静态凭证，但不能抵御以同一操作系统用户身份运行的失陷进程。

## 授权与存储

登录通过系统浏览器使用 S256 PKCE、随机 state，以及监听随机端口、路径为 `/oauth/callback` 的 `127.0.0.1` 本机回调。远程授权页必须位于固定来源。回调只携带授权码和 state。取消、过期、退出和新登录代际会使旧操作失效，包括延迟返回的网络与存储结果。

Access 凭证只保留在内存。仅包含 refresh 的记录以原子替换方式写入私有加密文件。Linux 必须具有受支持的操作系统钥匙串；`basic_text`、未知后端及不可用的加密均拒绝继续。账号代理在应用实例内串行处理存储和刷新轮换。调用方必须持有单实例锁，存储类本身不提供跨进程协调。

桌面服务在浏览器授权时授予账号允许的具体分组。在这组模块中，切组需重新显式授权；没有客户端分组覆盖，也没有实现 `PUT /group`。过期或撤销的凭证需要重新登录。暂时的网络失败不删除已保存的 refresh。退出本机先阻止请求，再撤销远端授权；结果单独说明远端撤销是否成功。

## 模型与请求代理

分组和模型只从经过鉴权的桌面 API 获取。发现过程拒绝自动或继承分组、重复及无效元数据、分组不一致的模型目录和中途变化的账号。只有完整的账号绑定读取成功后才发布模型并恢复请求。公开价格或状态元数据不能授予模型权限，也不能更改服务来源。

请求代理支持后端声明的 Chat Completions、Responses 和 Anthropic Messages 端点。`openai-response` 与 `openai-responses` 统一为 `/v1/responses`。未知协议不可用，模型名不代表兼容性。每次请求必须选用目录中的模型及其已声明端点。只有服务器同时提供明确的上下文与输出限制时，Host 才把模型列为可运行，不猜测容量。三个原生 provider 复用现有 pi-ai 协议序列化器并关闭自动重试。Anthropic SDK 的本机 x-api-key 和固定 beta 查询由私有代理处理，不作为上游账号凭证转发。请求中的 `group`、`auto_groups` 和 `cross_group_retry` 字段均拒绝，包括序列化过程新增的值。

请求代理不发送浏览器 Cookie，拒绝重定向，执行配置的字节限制，不自动重试推理请求。401 或 403 会关闭新请求准入。429、服务端错误或网络故障都不切组、不触发第二次可能计费的调用。已开始的流保持原选择。价格、余额、用量结算和渠道路由由服务器负责。

## 验证与启用条件

定向无密钥测试使用模拟远端响应和真实本机回调监听器。通过 `vitest run apps/desktop/tests/hallucodex-auth.spec.ts apps/desktop/tests/hallucodex-routing.spec.ts` 运行账号与路由测试。这些测试不验证真实账号、付费模型调用、实际操作系统钥匙串或安装后的桌面构建。

品牌发行需要匹配并显式启用的 New API 桌面端点、已配置的模型容量，以及真实安装的 Linux 验收。Host 适配器使用原有模型选择器，目录发布会刷新已打开的输入框。首次原生启动通过可写 profile 设置尚未选择模型的初始状态，保留用户后续保存的模型选择。Linux 打包支持本身不包含这些接入。发布、真实凭证和生产调用属于独立操作。
