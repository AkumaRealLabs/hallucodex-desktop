---
description: "侧栏与会话首屏的 HalluCodex 品牌填充，以及桌面端账号入口；供选择或替换品牌呈现的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-brand-official

[English](README.md) | 中文

## 概述

本包让所有客户端构建都以 HalluCodex 呈现：无论构建 profile 如何，侧栏都显示 HalluCodex 标志与名称，会话首屏显示该标志。在 HalluCodex 桌面外壳中，它还会在「设置」上方加一个账号入口，显示已登录的名字或登录提示，并打开桌面端账号对话框。使用其他品牌的部署应提供替代品牌包。本包不保留自己的运行时状态，也不影响模型请求。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

将本插件挂载到浏览器插件名单即可。品牌填充在所有构建 profile 中注册；账号入口只在页面暴露了桌面端账号桥时注册。

### 桌面端账号入口

HalluCodex preload 暴露的 `window.dshHalluCodex` 只有两个操作：`subscribe` 推送不含凭据的摘要（`signed-out`、`signing-in`，或带显示名的 `signed-in`），`open` 打开原生账号对话框。入口渲染在 `sidebar.footer.action` slot 中，样式与「设置」触发器一致，收起侧栏时变成头像或图标。Web 客户端没有这个桥，因此不显示入口。

### 替换品牌

自有身份的部署不组合本包，而是组合另一个占据相同侧栏与首屏 slot 的包。占据 slot 是唯一的组合路径；这里不存在任何品牌配置面。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

两个侧栏填充作为一组声明感知的注册安装：嵌套的 `ctx.slots.inject()` 调用等待侧栏声明，因此无论本行在声明者之前还是之后激活，这组注册都能工作；声明消失时两个填充一并撤回，HMR 期间也不会留下残缺的品牌混合。首屏标志与账号入口以同样方式等待各自的声明。账号入口通过注入面拿到桥，并在挂载期间订阅。浏览器半部是 [`src/client/index.ts`](src/client/index.ts)；node 半部是一个空 Loader 座位。浏览器标题是构建环境的事（`DSH_CLIENT_TITLE`，未设置时回退到外壳的 `brand.localBuild` 文本），不在 slot 系统之内。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当品牌面不够用时阅读以下页面。它们从本包占据的 slot 进入渲染这些 slot 的外壳。

- [ui-sidebar](../ui-sidebar/README.zh.md)——声明 `sidebar.brand.mark`、`sidebar.brand.name` 与 `sidebar.footer.action`，并渲染品牌回退。
- [ui-conversation](../ui-conversation/README.zh.md)——在首屏声明 `conversation.hero.brand.mark`。
- [桌面端](../../../apps/desktop/hallucodex/README.zh.md)——账号入口背后的账号对话框与 preload 桥。
- [Web 客户端架构](../../../docs/subsystems/web-client.zh.md)——浏览器插件行如何加载并注册 slot。

-----

<a id="model-experience"></a>
## 模型体验

无，因为本包只贡献浏览器呈现；这里没有任何内容进入模型请求。

#### KV Cache 影响

无；本包既不组装也不发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制界定了品牌呈现的供给方式。它们是当前包约束，不是品牌设计对比或任务积压。

- **只有一组填充**——替代呈现属于占据相同 slot 的另一个 Cordis 包。
- **标志是占位图形**——目前绘制的 HalluCodex 标志只是占位，待正式设计稿替换 `HALLUCODEX_MARK_PATH` 与桌面端图标。
- **浏览器标题独立**——`DSH_CLIENT_TITLE` 在构建时选择标题文本，而非通过 UI slot。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
