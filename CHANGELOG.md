# 更新日志

本文件记录 HalluCodex 桌面端各版本的变化，格式参照 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。每次发布 `hallucodex-v<版本>` 标签前，先在这里添加标题为 `## <版本>` 的小节；发布流程把该小节作为 GitHub Release 说明，应用内的更新提示也显示这部分内容。

## 0.1.0

HalluCodex 桌面端的首个版本，提供 Windows、macOS（Apple 芯片与 Intel）和 Linux（AppImage、deb）安装包。

### 新增

- 通过系统浏览器登录 New API 账号：使用 PKCE 与本机回调完成授权，默认连接 `https://api.hallucodex.com`，未登录时也可改用其他 New API 站点。
- 模型请求经由账号代理转发：模型列表来自账号授权的分组，请求按该账号和分组计费，支持 Chat Completions、Responses 与 Anthropic Messages 接口。
- 设备管理与额度：每台设备单独授权，可在网站上查看和撤销；设备额度或余额不足时显示服务器返回的提示。
- HalluCodex 品牌：应用名称、图标、安装程序、菜单与关于面板均改为 HalluCodex，并与 DeepSeek Harness 分开安装和保存数据。
- 侧边栏账号入口：显示登录状态，点击后打开账号对话框完成登录或退出。
- 更新检查：从本仓库公开的 GitHub Releases 检查新版本并显示更新日志；未经确认不会下载或安装任何内容。
