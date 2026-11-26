---
description: "侧栏与会话首屏的 HalluCodex 品牌填充、默认首页点击浮出的像素鲸鱼，以及桌面端账号入口；供选择或替换品牌呈现的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-brand-official

[English](README.md) | 中文

## 概述

本包让所有客户端构建都以 HalluCodex 呈现——无论构建 profile 如何，侧栏都显示 HalluCodex 标志与名称，会话首屏显示该标志——并在空白首页提供点击浮出的像素鲸鱼。在 HalluCodex 桌面外壳中，它还会在主区域加入账号页面，并在「设置」上方加一个账号入口，显示已登录的名字或登录提示，点击后切到该页面。使用其他品牌的部署应提供替代品牌包。背景只持有临时 Canvas 资源，不增加模型请求。

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

随产品提供的 Web 与 Desktop 组合已挂载本插件。品牌填充与首页反馈在所有构建 profile 中直接注册，不需要额外安装或启用；账号入口与账号页面只在页面暴露了桌面端账号桥时注册。

### 桌面端账号入口

HalluCodex preload 暴露的 `window.dshHalluCodex` 只有三个操作：`subscribe` 推送不含凭据的摘要（`signed-out`、`signing-in`，或带显示名的 `signed-in`）；`onOpen` 推送外壳要求显示账号页面的请求，来自应用菜单或未登录时打开的工作区；`mount` 把原生账号页面渲染进页面框架的标题区和内容区，并返回卸载函数。页面是 `hallucodex-account` 主区域面板：高度固定的框架，标题行可拖动 macOS 窗口，在外壳渲染的标题旁显示 HalluCodex 标志，其余部分由外壳内容填满。入口渲染在 `sidebar.footer.action` slot 中，样式与「设置」触发器一致，点击后切到该页面，显示期间保持选中样式，收起侧栏时变成头像或图标。Web 客户端没有这个桥，因此两者都不显示。

### 首页反馈

默认首页保持留白，主按钮点击空白处才播放一次浅灰色鲸鱼跃起。每次播放结束后的点击在点阵与代码填充之间交替，首次为点阵；两种填充使用相同的大幅动态轮廓。动画持续 5.7 秒，随后清空。连续点击不会打断当前播放。点击由鲸鱼的 frame 层自己判定：外框内部的留白可触发播放，包括输入卡片两侧的空白；输入框、控件、输入卡片、portal 出去的浮层以及结束文字选择的点击都不触发。Canvas 不获取焦点或指针事件，点击由外框接收。窄屏首页中的鲸鱼保留较大比例，在 Canvas 边缘裁切，不增加横向滚动。减少动态效果偏好会禁用它，离开空白首页时释放动画与观察器。

鲸鱼使用非常浅的主题中性色，呈现轻微的背景隐纹；代码文字的对比度略高于点阵。水花保留细小颗粒并使用较深的颜色，尤其是入水时左侧的水花。随包帧图提供动作，首次符合条件的点击时由浏览器经插件 asset 路由加载一次。代码填充使用密排的 7px 文字，内容只来自预设的代码标语，出水与入水时文本随动态轮廓裁切。解码或像素读取失败时停止装饰，首页仍可正常使用，并在日志中提示重新加载。

图形参数固定，本行不接受配置。这是内置呈现，没有需要单独安装的 Bundle 或插件页面开关。

### 替换品牌

自有身份的部署不组合本包，而是组合另一个占据相同侧栏、首屏与 `conversation.hero.frame` slot 的包。占据 slot 是唯一的组合路径；品牌图形身份不可配置。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

两个侧栏填充作为一组声明感知的注册安装：嵌套的 `ctx.slots.inject()` 调用等待侧栏声明，因此无论本行在声明者之前还是之后激活，这组注册都能工作；声明消失时两个填充一并撤回，HMR 期间也不会留下残缺的品牌混合。首屏标志、`conversation.hero.frame` 层与账号入口以同样方式等待各自的声明。`hero` 为 true 时该层以负 `z-index` 绘制 Canvas，按 frame 层约定画在 Conversation 背景之上、所有 Conversation 内容之下；它在点击落到自身外框、且不在控件和输入卡片上时播放，忽略 portal 浮层与结束文字选择的点击，且不更改输入框或会话状态。账号入口通过注入面拿到桥和页面切换操作，并在挂载期间订阅；页面在显示期间挂载外壳内容。外壳的打开请求在页面注册内部订阅，因此客户端开始监听前保留的请求会选中已注册的面板。浏览器半部是 [`src/client/index.ts`](src/client/index.ts)；node 半部是一个空 Loader 座位。[帧图](src/client/assets/breach-atlas.webp) 来自用户提供的[展示视频](https://yinghuo-hg.deepseek.com/wuyexinrui/dev-cpu/web-showcase/orca.mp4)：截取 1.5–7.2 秒，以每秒 24 帧采样为 192 × 108 个单元，以无损 WebP 存储；红色与绿色通道以 32 级分别编码圆点半径和不透明度，在首次符合条件的点击后读取一次。浏览器标题是构建环境的事（`DSH_CLIENT_TITLE`，未设置时回退到外壳的 `brand.localBuild` 文本），不在 slot 系统之内。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当品牌面不够用时阅读以下页面。它们从本包占据的 slot 进入渲染这些 slot 的外壳。

- [ui-sidebar](../ui-sidebar/README.zh.md)——声明 `sidebar.brand.mark`、`sidebar.brand.name` 与 `sidebar.footer.action`，并渲染品牌回退。
- [ui-conversation](../ui-conversation/README.zh.md)——在首屏声明 `conversation.hero.brand.mark`，以及本包占用的 `conversation.hero.frame` 层。
- [桌面端](../../../apps/desktop/hallucodex/README.zh.md)——账号入口背后的账号页面与 preload 桥。
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
- **标志不随主题变化**——侧栏和首屏在浅色与深色主题下都显示全彩标志原图（`HALLUCODEX_MARK_IMAGE`）。
- **装饰绘制需要 Canvas 2D**——上下文不可用或偏好减少动态效果时，首页保持留白。
- **浏览器标题独立**——`DSH_CLIENT_TITLE` 在构建时选择标题文本，而非通过 UI slot。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
