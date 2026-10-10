# HalluCodex 桌面端

[English](README.md) | 中文

Desktop 不发送产品埋点。HalluCodex profile 禁用埋点与遥测插件以及其他由 DeepSeek 托管的服务（[HalluCodex 账号模块](hallucodex/README.zh.md)），壳在启动 Host 时设置 `DSH_TELEMETRY_DISABLED=1`。

桌面应用是完整 dsh Web 应用外的一层 Electron 壳。Electron RunAsNode 子进程启动共享 profile runner，Electron 立即从 `dsh-app://app/` 加载打包内的 Web 入口。共享加载页等待 Host 启动注入，然后在同一文档中启动客户端。Electron 将应用 HTTP 请求转发给已认证的 Web Host，转发时丢弃描述 Node fetch 连接而非资源本身的响应头（`transfer-encoding`、`connection`、`keep-alive`），并把插件 bundle 响应标记为 `no-store`，因为其每次启动都变化的 revision 只会在 Chromium 磁盘缓存中累积；WebSocket 流连接到该 Host，仅为归属的应用窗口附加凭据。Node IPC 承载启动注入、就绪与关闭。Desktop 默认监听系统分配的端口，因此不会与 Web 的 `3080` 或系统保留端口冲突；可通过 `webserver.config.port` patch 覆盖。

Desktop 绑定 `127.0.0.1`，即 Electron 为就绪 URL 与 WebSocket 凭据过滤器拨号的地址。WebSocket 流按 Host 监听器使用 `ws:` 或 `wss:`；附加凭据要求 authority 与 scheme 均匹配。

应用菜单第一项“**关于 HalluCodex**”在 macOS 和 Linux 上打开 Electron 原生关于面板，展示应用图标、产品名称和当前安装的发布版本；Windows 没有系统关于面板，由壳自己的对话框显示产品名称和版本。下一项“**HalluCodex 账号**”打开[账号对话框](hallucodex/README.zh.md)。菜单文案跟随桌面壳的语言。macOS 的隐藏、隐藏其他、显示全部和退出条目使用本地化文案，隐藏和退出条目包含 HalluCodex 产品名称。这些条目保留原生动作和快捷键。macOS 从应用包读取图标，因此未打包的开发启动会显示 Electron 图标；Linux 使用随包分发的 `resources/icon-windows.png` 副本。

Desktop 的本地原生目录流程打开绑定应用窗口的 Electron 文件夹对话框，并先恢复、显示和聚焦该窗口。并发请求共用一个对话框；取消不返回路径，失败后可以重试。普通 Web 使用 Host 选择器。浏览模式列出 Host 目录。Linux 缺少 zenity 或 kdialog 时，自动选择使用浏览模式，不使用 Electron 对话框。

Desktop 在 `resources/runtime/primary-runtime/dependencies/pnpm` 中携带一份 pnpm 分发包。构建时的生产依赖安装、安装版 `dsh` CLI、Creator 和 Web 插件管理器通过 Electron Node 模式执行其中的 `bin/pnpm.mjs`；包操作不要求 PATH 上存在 pnpm。私有 Node 启动器环境仅用于包操作。agent（智能体）的工作区依赖将同一份完整 primary-runtime 复制到 Harness 主目录，并使用其中的独立 Node 执行 pnpm。

Host 就绪后，启动流程显示带工作区的主窗口；在此之前再次启动应用不会显示窗口。此时若 HalluCodex 账号未登录，[HalluCodex 账号对话框](hallucodex/README.zh.md)会自动打开；浏览器登录、退出登录和服务器地址设置见该文档。

桌面麦克风访问仅允许主 `dsh-app://app` 页面发起的音频请求。macOS 使用系统麦克风授权、随包用途说明，以及主应用与 Helper 签名中的 `com.apple.security.device.audio-input` 权限。

按 F12（多媒体功能键键盘上为 Fn+F12）、macOS 的 Command+Option+I 或 Windows 的 Ctrl+Shift+I，可切换当前获得焦点的应用页面的 DevTools，打包版本同样支持。这些原生快捷键通过隐藏的应用菜单项注册。更新遮罩和打包版本的内嵌浏览器禁用 DevTools。

## 终端命令

应用菜单中的**管理 dsh 命令…**位于**检查更新…**下方，显示当前命令，并提供安装、修复和移除操作。命令复用 Desktop 已安装的运行时和普通 [dsh CLI](../cli/README.zh.md)，Desktop 应用关闭后也可以使用。安装后打开新终端，运行 `dsh --version`。

macOS 安装会创建 `/usr/local/bin/dsh`；目录权限需要时，系统会请求管理员认证，不会修改 shell 启动文件。Windows 管理对话框将命令注册到当前用户的 PATH。切换已有命令前会要求确认；修复当前已选中的 Desktop 命令不会重复要求切换确认。macOS 链接会保留并恢复被替换的启动器；Windows 会保留其他 PATH 条目，包括注册前就已存在的条目。若其他命令的 PATH 优先级更高，对话框会显示其位置。移动应用后，macOS 使用“修复”，Windows 从新位置使用“安装”。“移除”不会改动无关安装。

命令注册是安装 Desktop 后的可选操作。卸载 Desktop 前，请通过**管理 dsh 命令… → 移除**删除其 CLI 注册；应用卸载程序不会移除该注册。更新或卸载 Desktop 前请结束 CLI 命令。CLI 运行时版本随已安装的 Desktop 版本变化。Desktop 插件命令与运行时限制见[内置命令运行时](#bundled-command-runtime)。

## 关闭窗口与退出

关闭主窗口（macOS 的关闭按钮和 ⌘W；Windows 与 Linux 的 ×、Alt+F4 和任务栏"关闭窗口"）不会退出应用：macOS 与 Windows 隐藏窗口，Linux 将窗口最小化到任务栏。Windows 与 Linux 首次关闭前需要确认。页面和 Host 继续运行，任务不受影响，下次显示时仍是原来的文档，会话、草稿和滚动位置都保留；macOS 全屏窗口先退出全屏再隐藏。macOS 通过 Dock 图标或再次启动找回窗口，Windows 通过托盘或再次启动找回，Linux 通过任务栏或再次启动找回。Wayland 不允许应用自行取消最小化或把窗口提到前面，因此 Linux 上再次启动时会重新映射不在前台的窗口。最小化行为不变。

Windows 与 Linux 在整个运行期间创建托盘图标。悬停提示为产品名，单击显示并聚焦窗口，右键菜单提供壳语言下的"打开 HalluCodex"和"退出 HalluCodex"。Electron 44.0.0 注册 Linux StatusNotifierItem 时使用的名称会被 KDE Plasma 忽略、被 GNOME 拒绝（[electron/electron#53213](https://github.com/electron/electron/issues/53213)，Electron 44.1.0 已修复），因此 Linux 托盘图标暂时不会出现，关闭后的窗口改为最小化而不是隐藏。升级 Electron 要等 `node-addon-require-builtin` 发布支持更新运行时的版本；当前随附的版本只接受少数几个精确的 Electron 版本，44.0.0 是其中之一。首次关闭前复用更新弹窗，说明正在运行的任务不会中断以及窗口去向：Windows 上是系统托盘；Linux 上是任务栏，并说明要退出请选择“应用”菜单中的“退出”。弹窗只有一个“确认”按钮。确认后隐藏或最小化窗口，并在 Electron userData 下写入 `background-close-confirmed`；Esc、关闭弹窗或加载失败均保持主窗口可见，不记录确认。重复关闭请求会聚焦已有壳弹窗。覆盖更新保留标记，卸载删除标记。旧的 `background-notice-shown` 标记不会跳过此确认。关闭窗口不发送系统通知。Windows 托盘位图是 `resources/tray-windows.ico`，由 `pnpm --dir apps/desktop run render:tray-icon` 从 `resources/icon-windows.svg` 按 16、20、24、32、40、48、64 像素分别渲染，打包为 `resources/tray.ico`。同一命令还渲染 64 像素的 `resources/tray-linux.png`，打包为 `resources/tray.png`，由面板缩放显示；图标能够出现后，GNOME 仍需安装 AppIndicator 扩展才会显示。macOS 不提供菜单栏图标。

所有普通退出入口——⌘Q、应用菜单、Dock 菜单、Windows 与 Linux 的托盘和标题栏"应用程序"菜单——都先向 Host 查询退出会中断什么。Host 通过私有 IPC 通道回答两项事实：与更新重启检查同一口径的运行中任务（运行中的 agent，包括子代理和等待审批的回合、排队消息、运行中或停止中的后台任务），以及本次运行中已加载会话里由 `workspace/session-activity` 的 `schedule` family 报告的已挂定时器的提醒。两项都没有时直接退出，不弹框。否则弹出一个没有父窗口的原生消息框——隐藏的窗口保持隐藏——标题为**退出 HalluCodex？**，正文为三种本地化说明之一：正在运行的任务将会中断、应用关闭期间定时任务不会运行，或两者兼有。"退出"是默认按钮，Esc 等同"取消"；macOS 上"取消"在"退出"左侧，Windows 上"退出"在"取消"左侧，Windows 任务对话框显示应用图标且不跟随应用主题、始终为浅色。Host 尚未就绪或已失败时不可能有任务在跑，直接退出。查询失败或 Host 超过两秒截止时间未答复，按运行中任务处理。弹框打开期间，再次请求退出只会并入同一弹框而不叠加新弹框（macOS 上还会把它提到前面；Electron 不暴露 Windows 任务对话框的句柄）；任务开始或结束不会改变文案；点"退出"不再重新查询即停止应用；点"取消"不发生任何变化。在进入工作区前取消退出时，启动流程照常继续，Host 就绪后打开工作区。

更新的重启确认在 Windows 上额外显示等待提示，macOS 只显示简短的重启说明。

以下情况跳过确认：安装更新的重启已确认过任务中断、致命错误恢复对话框中的退出或重启、开发版"重启应用与 Host"命令，以及操作系统关机、重启或注销：Windows 在确定性的会话结束消息上设置该状态；macOS 在关机通知上设置，而其他应用仍可能取消这次关机，因此主窗口下一次获得焦点或显示时会清除它。安装器接管退出时会取消尚未结束的普通退出决策；晚到的查询结果和弹框答复不会再次打开确认框或重复清理。窗口隐藏期间完成的用户主动发起的更新下载，把"安装并重启"确认推迟到窗口再次显示时。Windows 安装程序和卸载程序在应用仍在运行时提示用户先在系统托盘中退出。Desktop 默认未开启定时任务，定时任务的说明只在该功能开启后出现；提醒只在已加载的会话中触发，未加载的会话既不计入，也要等到打开后才会继续。

托盘渲染器以底板中心为基准将 HalluCodex 标志放大 20%，保留背景和宽高比；应用和安装器图标保持原有比例。

## 关键技术决策

`resources/icon-windows.*` 和 `resources/icon-macos.*` 把 HalluCodex “H” 标志和渐变放在各平台的圆角底板上；Linux 包使用 Windows 的底板。平台 SVG 导出为 1024×1024 的透明 PNG。Linux 菜单通过 hicolor 主题查找图标，而该主题只搜索其索引列出的尺寸，因此修改 `icon-windows.svg` 后，运行 `pnpm --dir apps/desktop run render:linux-icons` 重新生成 `resources/linux-icons/` 下 16 至 512 像素的图标集，electron-builder 会把每个文件装到对应尺寸的 hicolor 目录。Linux 窗口还带上随包的 `resources/icon.png`，没有桌面条目匹配的 AppImage 也显示 HalluCodex 图标。修改 `icon-windows.svg` 后，还要运行 `pnpm --dir apps/desktop run render:tray-icon` 重新生成 `resources/tray-windows.ico` 和 `resources/tray-linux.png`。electron-builder 为 Windows 应用、安装程序和卸载程序生成多尺寸 ICO（[Windows 图标要求](https://learn.microsoft.com/en-us/windows/apps/design/iconography/app-icon-construction)）。安装页面使用浅色和深色两套 `installer/assets/brand*.png`；卸载程序的欢迎和完成页共用 `installer/assets/uninstaller-sidebar.png`，准备阶段将其转换为 164×314 BMP。这些安装器图片使用 HalluCodex 标志。

快捷键覆盖保存在 `app.getPath('userData')/keybindings.json`，与 `DSH_HOME` 分离。主进程校验并串行保存修改后才发布已接受键位。读取失败保留上次接受的键位并阻止编辑，包括全部恢复；不可读和未来版本的文件保持不变。开发时可通过 `DSH_DESKTOP_USER_DATA_DIR` 隔离这些偏好，启动器会输出解析后的路径。格式和冲突语义见[快捷键服务](../../packages/client/shortcuts/README.zh.md)。

macOS“文件”菜单显示已接受的单键绑定（包括方向键），并通过 Client 页面 owner 路由“关闭页面或窗口”。Windows 和 macOS 在主文档、内嵌 frame 和浏览器 guest 输入之前拦截所有已接受的完整绑定，包括编辑和终端输入。录制和输入法组合状态仍受保护。更新蒙层从创建到最后一个蒙层关闭期间阻挡父窗口及其浏览器 guest 的产品快捷键和编辑按键递送。每次打开或关闭蒙层都会作废待完成的组合键状态。主进程通过显式的创建能力和输入状态读取能力，让更新对话框与快捷键输入共享同一个蒙层管理实例。双键组合会将首键的初次按下事件交给页面，且不拦截其松开事件；完整组合及其重复事件会被消费。渲染进程将可配置绑定的分发交给原生适配器。双键组合不注册原生菜单快捷键。已接受的命令通过可信 preload 转发一次。Linux 通过 DOM 分发主文档快捷键，并将已接受的内嵌 frame 绑定转发给 Client 解析器。关闭最后一个窗口后 macOS 保留应用生命周期；Windows 退出桌面实例并停止其任务。[关窗决策](../../.agents/notes/implemented/architecture/2026-09-21-desktop-page-close-shortcuts.zh.md)记录了这一生命周期选择。

macOS PNG 使用带留白的圆角底板，供传统 ICNS 打包使用，包含最高 1024 像素的表示。它是扁平图标，并非 Icon Composer 文档。Apple 的[应用图标指南](https://developer.apple.com/design/human-interface-guidelines/app-icons)要求向 Icon Composer 提供未遮罩的图层；这些输入需要在 macOS 上单独导出，不能复用已做圆角的 ICNS 图案。发布前须在支持的 macOS 版本中验收 Finder 和 Dock 的显示效果。

<a id="bundled-workspace-dependencies"></a>

### 内置工作区依赖

electron-builder 只把清单中的 `dependencies` 复制进 `app.asar/node_modules`，因此 Electron 主进程 bundle `lib/main.js` 内联其工作区 devDependencies，裸导入只剩 `electron`、Node 内置模块与这些 `dependencies`；沙箱 preload 只能留下 `electron`、`events`、`timers` 与 `url`，即其 `require` polyfill 能解析的模块。主进程 bundle 从被内联包的 `lib/` 产物解析它们，所以根 `build:lib:host` 在并发的工作区 tsdown 阶段之后才为 `apps/desktop` 打 bundle，并由 [`desktop-bundle-imports`](scripts/desktop-bundle-imports.mjs) 让任何静态、动态或 `require()` 导入无法在打包应用内解析的 Desktop bundle 直接失败。没有这项检查时，rolldown 无法解析的导入会作为外部说明符进入产物，并在启动时以 `ERR_MODULE_NOT_FOUND` 失败。[已归档的bundle 顺序决策](../../.agents/notes/archived/process/2026-09-22-desktop-main-bundle-after-workspace-tsdown.md)记录了备选方案。

Windows 签名打包按 PE 文件内容扫描第一方运行时和应用生产依赖，包括没有常规扩展名的文件。最终扫描覆盖整个解包应用。目录链接、格式错误的 `MZ` 文件以及非 PE 的 `.exe`、`.dll` 或 `.pyd` 文件会使打包停止；以 `MZ` 开头的数据文件也会被拒绝，除非包含有效 PE 头。它保留有效的上游签名，并在记录运行时哈希或执行冒烟检查前为未签名代码补签。公钥验签每个进程处理最多 32 个文件，同时最多运行四个进程；硬件令牌签名仍串行执行，每个新签名必须匹配配置的证书且带时间戳。硬件签名或验签失败会停止本轮执行；独立的时间戳请求遵循下文的有界重试规则。electron-builder 只有在验签和逐字节比对通过后，才保留复制后运行时可执行文件的签名。写入发布完成记录前，必须通过最终 PE 签名检查，以及使用全新缓存的 ASAR 载荷和 Host 冒烟检查。开发、仅准备和未签名构建不使用硬件令牌，可能被 Windows 代码完整性策略阻止；任何构建模式都不会关闭该策略。冒烟检查通过不代表兼容所有企业策略。

Desktop 携带独立的 Python、Node.js 和 pnpm 分发包。Python 包含 numpy、pandas、python-docx、python-pptx、openpyxl、Pillow、lxml、XlsxWriter 及其完整依赖。`load_workspace_dependencies` 工具首次使用时，将该产物离线安装到 `$DSH_HOME/dsh-runtimes/dsh-primary-runtime`（打包版默认主目录下为 `~/.hallucodex/dsh-runtimes/dsh-primary-runtime`），并返回解释器、pnpm 脚本和库目录的绝对路径，以及记录内置分发包名称与版本的 `pythonDistributions`。版本报告不包含用户自行安装的包。Office 任务默认使用这些库，用户或工作区指令指定其他环境时遵循其要求。pnpm 脚本通过返回的 Node 可执行文件运行。返回的 Node 库目录为随包交付的库预留，不是 pnpm 的全局安装目录。

Desktop 默认注册 `office-docx`、`office-pptx` 和 `office-xlsx`。这些技能使用内置 Python 库创建文件和进行定点编辑，随后重新打开文件，并在交付前运行共享结构检查器。PowerPoint 的创建和编辑使用 python-pptx。技能资源复制到 ASAR 外的 `runtime/office-skills`，让 Python 可以读取检查器。可用的 `render_document` 工具可以补充视觉检查；缺少该工具不妨碍创作或交付。检查范围与限制见 [Office 技能包](../../packages/skill/skill-office/README.zh.md)。

该产物随 Desktop 版本发布。`runtime.json` 记录 Desktop 版本、目标平台、顶层解释器和包管理器版本及 Python 分发包版本表，以及所选目标的锁定产物输入与组装格式的摘要。分发包名称按 PEP 503 归一化；名称归一化后重复时，清单会被拒绝。旧 `components` 清单通过归一化继续可读，并保留其原有库版本一致性校验。匹配的安装会被复用；依赖或压缩包变化后，即使 Desktop 版本不变，也会在完整暂存副本完成后替换目录。不含摘要的旧清单会在下次安装时被替换。用户自行添加的 Python 包仅在产物身份一致时保留。目录替换失败时保留之前的安装；解释器仍在运行时，Windows 可能拒绝替换。

Desktop 私有的 `runtime/bin` 目录仅添加到包安装进程，不进入 PTC 和 agent shell 从 Host 继承的 PATH。该工具不修改 PATH、环境变量或用户包管理器配置。pnpm 的全局包、命令入口和 store 保留自身默认值及用户设置，包括环境不支持全局安装时的原生错误。不提供独立依赖更新器。[第一方 Runtime 决策](../../.agents/notes/implemented/feature/2026-09-14-desktop-primary-runtime.zh.md)记录这些选择。

Node 准备内置解释器和 Python 库，无需系统 Python 或 pip。[下载锁](../../scripts/primary-runtime/lock.json)固定解释器压缩包、Python 分发包版本及目标平台 wheel 的 URL 和哈希；共享构建器从根开发依赖中解析 pnpm 固定版本。测试检查根 package-manager 版本和 Desktop 固定版本保持一致。每个目标的 wheel 文件名必须与分发包版本一致。所选目标、wheel 记录及分发包映射内部的键顺序，以及 wheel 条目顺序都会影响产物身份，编辑时须保留；锁文件顶层键的顺序不影响该身份。库 wheel 解压到 site-packages，各 wheel 的 `.data/scripts` 目录保留辅助文件，不生成命令行包装器。其他安装方案会被拒绝。本机目标检查在清理暂存目录后以及 macOS 签名后验证锁定 wheel 的集合与版本，允许解释器自带的 pip，并检查 Python 版本、Office 文档读写和依赖完整性，不写入字节码。独立 Node 可执行文件获得 V8 所需的 JIT 权限；x64 目标还获得 `com.apple.security.cs.allow-unsigned-executable-memory`，允许可执行代码页，包括在 Rosetta 下运行时。ARM64 Node 和 Office 辅助程序保留仅 JIT 权限。跨目标执行和签名安装需要对应的发布主机。`dev:desktop` 和 `start:desktop` 都会在启动 Electron 前准备 `.desktop-build/targets/<target>/runtime/primary-runtime`；首次准备可能需要下载锁定的依赖。准备未完成时，启动命令不能报告成功退出。

Desktop/SDK 共享运行时构建器在复制或签名产物前，裁剪 NumPy 和 pandas 下名为 `tests` 的目录，并移除各分发包 `RECORD` 中对应的记录。它保留 `numpy.testing`、`pandas.testing`、`pandas._testing`、原生扩展和许可证。完整上游测试套件不可用；本机检查验证保留的 testing API、测试目录已移除，以及清单所列文件存在。

| 决策 | 原因 | 直接结果 |
|---|---|---|
| 发布身份 | 桌面壳 API、Web 客户端、后端与插件依赖图作为一个组合完成验证；独立版本会产生未经验证的组合，并让更新可用性含糊不清。 | Electron 与 `@deepseek-ai/dsh` 始终使用同一精确版本。即使桌面壳代码不变，升级 dsh 也必须发布新 Desktop 版本。 |
| 运行时 | 应用必须能够在没有系统 Node.js 或 pnpm 的机器上运行。 | dsh 通过设置 `ELECTRON_RUN_AS_NODE=1` 和 `--expose-internals` 的 Electron 运行，所有包操作都使用内置 pnpm。包管理器配置和 Host 环境遵循用户设置。包脚本通过 `node` shell 启动器转发给 Electron。 |
| 包来源 | 即使离线，启动时安装核心依赖也会增加开销。 | `app.asar/dsh` 携带完整生产依赖树；profile 只安装外部插件。 |
| 状态归属 | 共享可执行依赖图会让 CLI（命令行界面）与 Desktop 相互改变 dsh、Cordis、插件或原生模块版本，而两个桌面进程还可能争用同一个 profile。 | Electron 在访问任何 profile 前获取进程生命周期单实例锁，并独占 `$DSH_HOME/profiles/desktop` 及其包管理器状态。CLI 与 Desktop 共享 `$DSH_HOME` 下受支持的产品数据，但绝不共享可执行包、插件激活、锁文件或 `node_modules`。 |
| 传输 | Web 服务与认证共享一套实现。 | Electron 加载打包的 Web 资源；Host 提供启动注入和经过认证的 API。 |
| 插件变更 | Desktop 与 Web 需要一致的安装和激活行为。 | 主应用使用共享 Web 插件管理器和内置 pnpm。 |
| 更新 | 桌面壳与 dsh 独立更新会重新产生版本分裂，而桌面壳未变化的数据块不应强制完整传输。 | Electron 壳、匹配的 dsh 运行时与 pnpm 组成一个已签名更新单元。平台更新产物可以复用未变化的数据块，但运行时版本选择绝不脱离 Desktop 发布。 |

[薄壳决策](../../.agents/notes/implemented/architecture/2026-09-10-desktop-web-wrapper.zh.md)负责共享 Web 行为与 Desktop 适配。[Electron 打包与更新决策](../../.agents/notes/implemented/architecture/2026-08-25-electron-desktop-packaging-and-updates.zh.md)负责发布身份、签名及更新验收。

<a id="bundled-command-runtime"></a>

## 内置命令运行时

安装后的 `resources/runtime/cli/bin/dsh` shell 脚本（Windows 为 `dsh.cmd`）使用 Desktop 的 Electron 可执行文件和内置 pnpm 运行普通 CLI 分派入口。Desktop 关闭时也可使用，并保留 Electron 运行时限制。普通 profile、配置和插件命令与 npm dsh 使用相同实现；该命令不会打开 Desktop。

管理 Desktop 插件前，先启动一次 Desktop 以初始化其 profile，完全退出应用，再运行 `dsh plugin --profile desktop add <package>`、`list` 或 `remove <package>`。重新打开 Desktop 后使用更改。包操作保留共享的 profile 写锁和兼容性检查。内置命令拒绝未初始化的 Desktop profile，不会在其位置创建普通 CLI profile。

更新或卸载 Desktop 前请结束 CLI 命令；安装程序不与运行中的命令协调。CLI 不提供 Office 创作 skill 的资源路径。Desktop 现有 Office 设置与 Web 附件转换保留各自的资源配置。`prepare:runtime` 复制启动脚本，无需编译原生 CLI 启动器。

## 安装归属

Electron 拥有 `$DSH_HOME/profiles/desktop`。其 `dependencies` 包含 pnpm 安装的包；`dsh.profile.bundles` 包含内置 bundle，后接已启用插件。签名应用从 `resources/app.asar/dsh` 提供 dsh、私有 Desktop Host 及其生产依赖。打包应用选择 runtime profile 解析，不创建包链接；开发 profile 使用文件系统链接。宿主与插件在同一个 Electron Node 模式进程中执行；Desktop 不启用 `--preserve-symlinks`。CLI 不能启动此 profile。Desktop 内置命令可在应用退出后管理其插件；npm 安装的 dsh 不能修改它。

应用 preload 只向 `dsh-app://app` 文档暴露启动就绪、致命启动失败上报、原生目录选择、用于 composer 路径引用的 `__DSH_HOST_PATHS__` 桥接和租约范围内的 Browser 桥接。同一个 preload 通过 `dshDesktop.deviceInfo()` 转发主进程采集的机器描述，按 `name=value` 字段以 `; ` 分隔：`platform`、`os`、`app_arch`（应用二进制实际运行的架构，模拟运行时与硬件架构不同）、`cpu` 和 `memory_gib`（物理内存总量，GiB，保留一位小数）。取值不可用时省略对应字段。该描述不包含主机名、用户名或序列号。产品页面还获得 Desktop 标记、更新展示数据和打开原生确认的操作，不能选择安装产物或授权安装。插件管理使用 Web 应用经过认证的 HTTP API；Electron 在 `dsh-app://shell/` 本地提供更新弹窗文档和资源，不依赖 Host 就绪。Electron 不提供插件管理 IPC 或独立管理页面。任何渲染进程都不会获得文件系统访问、原始 Electron IPC、shell 或任意 pnpm 参数。

只有主应用窗口启用 `<webview>`。guest 挂载必须匹配主进程签发的租约和分区；guest 保持 sandbox、context isolation 和 Web security，不启用 Node integration 或 guest preload。Browser IPC 监听只为应用文档创建。[Sidebar Browser](../../packages/client/ui-sidebar-browser/README.zh.md) 说明存储分组和 guest 限制；Host 鉴权仍独立于 URL 过滤而必需。

`dsh-app://shell/` 无需联系 Host 即可提供打包的更新文档、脚本和样式。静态请求保留 GET/HEAD、路径范围和 MIME 处理；每个更新文档继续使用隔离 preload 和所属窗口的 IPC 校验。

产品 UI 保留 Web 操作，包括通过共享认证 HTTP 路由执行的“打开方式…”。Desktop 使用 Web 的自动目录选择机制，并以共享 Web 模板的 bundle 列表初始化新 profile。

升级文案完整展示版本号（包括预发布后缀），不额外添加 v 或 V。无可用更新时，弹窗标题显示检查结果，正文显示当前版本。

Electron 选择类型化的英文或中文 shell 文案：启动时取系统首选语言中第一个受支持的语言，并回退到英文。macOS 应用包通过 `CFBundleLocalizations` 声明支持英语和简体中文，让 macOS 根据用户的首选语言匹配初始应用语言。主界面在挂载前通过隔离 preload 读取共享的 `locale.preference` 和同一系统语言顺序；用户明确选择的英文或中文优先，自动选择不会写入偏好。主界面上报当前语言（包括之后在设置中的切换），壳随之切换菜单、托盘文案以及恢复与更新提示。仓库 Client UI i18n 检查覆盖桌面端源码。

macOS、Windows 和 Linux 会在原生全屏切换及每次页面加载后向渲染器同步全屏状态，让浮层调整顶栏避让距离。

Windows 与 Linux 用 40 DIP 顶栏取代原生标题栏和菜单栏：窗口按钮由 Electron 绘制在顶栏上，颜色随应用调色板同步。页面内容盖不住这些按钮，因此模态对话框打开期间，顶栏会叠上对话框遮罩的颜色；下文所述的 Linux 更新浮层也是如此。侧栏开关旁的本地化“应用”和“编辑”入口打开原生弹出菜单。仅当应用框架发布 shell overlay 席位后才挂载菜单，启动加载期间不显示。“应用”提供关于、HalluCodex 账号、检查更新、管理命令（仅 Windows）和退出；只有 macOS 有系统“关于”面板，其他平台的“关于”打开壳自己的弹窗；“编辑”向当前编辑器发送对应按键，提供撤销、重做、剪切、复制、粘贴、删除和全选，不受自定义快捷键绑定影响。插件管理使用主应用的“插件”页面。按 Alt 不会出现额外的原生菜单行。macOS 保留原生菜单。可编辑区域保留快捷键和不带快捷键标注的右键菜单；命令可用状态由 Chromium 提供，选中的只读文本提供“复制”命令。

macOS 上自定义菜单保留 Electron 的标准 Window 菜单及应用隐藏命令，包括 Minimize（⌘M）和 Hide（⌘H）。Linux 保留应用菜单和 Edit 菜单。

### 运行时与插件激活

签名资源中的 `resources/app.asar/dsh/desktop-runtime.json` 绑定 shell 版本、Electron 的 Node 版本、平台、架构、共享包版本和最终文件清单。启动读取元数据，并检查共享包记录。发布 schema、shell 版本、目标兼容性和文件完整性在打包时验证。只有出现打包校验与实际 Host 诊断无法充分解释的具体安装故障，才重新引入启动时的发布信息比较。首次启动不会把核心包复制到 profile 存储或通过 pnpm 安装核心包。

1. 主窗口在 profile 准备或后端启动前，从打包静态资源于屏幕外加载共享 Web 加载页。共享 profile 初始化创建缺失的 manifest、空用户 patch 与 pnpm workspace 文件，不覆盖现有文件。
2. 启动 Host 前，Desktop 校验运行时描述符并准备 profile，不改动已安装的包、依赖声明与锁文件；只删除早期 Link 后端启动写下的 `.dsh-module-fallback` 投影，启动从不运行 pnpm。profile 内的包保持原生优先级，本体包名通过 runtime resolution 解析（[查找顺序](../../.agents/notes/implemented/architecture/2026-09-19-profile-resolution-lookup-order.zh.md)；[清理移除](../../.agents/notes/implemented/simplification/2026-09-19-remove-desktop-profile-core-cleanup.zh.md)）。
3. Electron 的 Node 版本、平台或架构变化时保留已安装插件。原生兼容性问题在加载时报错，可通过 pnpm 修复。
4. 主应用的“插件”页面通过共享[插件管理器](../../packages/boot/plugin-manager/README.zh.md)操作 Desktop profile。包操作使用内置 pnpm 及正常的用户和 profile 配置。
5. 共享管理器负责安装错误、激活和重启要求。即使 Host 无法启动，原生恢复仍可禁用第三方 bundle。

[Web 插件 UI](../../packages/client/ui-plugin-manager/README.zh.md)负责管理界面。Desktop profile 初始化和恢复保留已安装插件文件。

主窗口创建、主文档加载、preload、渲染器、Web 初始化或后端的致命失败，会在每个应用进程中打开一次原生恢复对话框。对话框显示首次错误末尾的限长摘要，标明截断情况，并提供退出、重启、禁用第三方插件、备份 profile patch 并重启。启动失败保留 Web 加载页和动画；运行中失败保留当前页面。预期关闭、取消导航和普通请求错误不会触发恢复。共享 Web 插件管理器报告包操作错误；插件变更后的 Host 启动失败会进入原生恢复。不通过启动超时推断故障。 包含 `listen EADDRINUSE` 的监听失败以退出其他正在运行的 HalluCodex 实例的提示替代诊断和重装建议，仅提供退出和重启。

原生弹窗详情最多包含 1,200 个 UTF-16 代码单元和八行诊断，若已写入下述崩溃报告则附上其路径。Host 错误诊断仅保留 stderr 输出的最后 64 Ki 个字符。更早的输出会被丢弃，避免长期运行的 Host 使壳的诊断缓冲区无限增长。

首个致命弹窗打开前，Electron 会向平台日志目录（`app.getPath('logs')`：macOS 为 `~/Library/Logs/<应用名>`，Windows 与 Linux 为应用 `userData` 目录下的 `logs`）写入一份崩溃报告，最多等待写入一秒；写入缓慢或失败时弹窗不带路径。文件 `crash-<UTC 时间>-<source>.log` 记录来源（`host` 为 Host 退出、`web-boot` 为渲染进程启动失败、`renderer` 为渲染进程或文档失败、`main` 为壳自身错误）、后端是否已就绪、应用与运行时版本、包含可枚举属性与 cause 链的错误（截至 256 KiB）、Host 在退出前通过 IPC 报告启动失败时自己的 inspect 错误（最多 64 KiB），以及主窗口最近的 error 级 console 输出（最多 64 KiB）。因此 Host 退出报告包含保留的 stderr 尾部，其中可能含有插件输出。关闭过程中的致命失败只写报告、不弹窗。平台支持时文件仅所有者可读；启动时保留最新十份报告并删除更早的，不触碰目录中的其他文件。

恢复操作等待 Host 关闭后才修改插件启用状态。原生恢复操作在 profile 事务锁内调用共享 app-boot 恢复函数。它禁用第三方 bundle，并将 profile 的 `cordis.patch.yml` 重命名为 `cordis.patch.yml.bak-<timestamp>`（重名时追加序号），无需解析；下次启动创建空 patch。已安装包和已有备份保留。home 级 patch 不变。Electron 控制台记录备份路径（或原文件不存在）以及 home 级 patch 未修改。profile 数据无效、重命名失败或写入失败会作为恢复操作错误报告；已完成的修改保留，Desktop 不会假装恢复成功后重启。Desktop 不提供 profile 重置操作或应急 HTML 文档。

### Host 环境

macOS 和 Linux 从图形界面启动的程序只继承会话管理器提供的环境，不包含 shell 启动文件导出的变量。第一个 Host 启动之前，Desktop 以 `<shell> -ilc` 运行一次账户的登录 shell（取自用户数据库，不看 `$SHELL`），读取定界符之间的 `env -0` 输出，使 `~/.zprofile` 和 `~/.zshrc`（或该 shell 的对应文件）对 Host、agent shell、终端和 profile 配置生效。读取与 profile 准备并行进行。读取进程没有终端输入，并设置 `DISABLE_AUTO_UPDATE=true`、`ZSH_TMUX_AUTOSTARTED=true` 和 `ZSH_TMUX_AUTOSTART=false`，避免 oh-my-zsh 和 tmux 插件阻塞。shell 的值覆盖继承的值，但 `PWD`、`OLDPWD`、`SHLVL`、`_`、上述读取变量以及启动方自有的 `DSH_*` 和 `ELECTRON_*` 除外；Desktop 在读取之前已按 `DSH_HOME` 等变量解析路径，因此 Host 保持相同的值。读取在结束定界符出现时完成，因此启动文件启动的后台进程可以继续运行，其输出被丢弃。候选 shell 无法启动、以非零状态退出、没有输出定界内容或超过 `DSH_DESKTOP_LOGIN_SHELL_TIMEOUT_MS`（1000 到 2147483647 的整数毫秒，默认 `10000`；超时会结束其进程组）时，Desktop 记录一条警告，并依次尝试 `/bin/zsh`、`/bin/bash` 和 `/bin/sh`；全部失败时 Host 使用继承的环境。读取命令使用 POSIX 语法，因此 csh、tcsh 或 nushell 等账户 shell 会失败，Host 改为获得第一个系统 shell 的启动文件所设置的环境。读取期间退出 Desktop 会结束正在运行的读取进程组。每个应用进程只读取一次，因此修改 shell 启动文件后需要退出并重新打开 Desktop。Windows 从图形界面启动的程序已经从注册表继承用户和系统环境变量，因此 Windows 跳过这一步。

## 开发

开发环境应用菜单提供“刷新页面”（macOS 为 Cmd+R，其他平台为 Ctrl+R）和“重启应用与 Host”。重启会等待 Host 关闭，再重新启动 Electron 和新的 Host；这两项操作都不会重新构建源码。

`dev:desktop` 会构建当前 Host、客户端 bundle、Web 前端和 Electron 壳，把已构建的 CLI 包、私有 Desktop Host 包及其 workspace 依赖投影为一次性桌面 npm 项目，然后直接启动 Electron；这条路径不从 npm 解析 dsh：

```sh
pnpm run dev:desktop
```

开发 Harness 状态默认写入 `apps/desktop/.desktop-build/development/home`，一次性 npm 项目位于 `apps/desktop/.desktop-build/development/project`，Electron 浏览器数据则位于 `apps/desktop/.desktop-build/development/electron-user-data`。因此，会话、设置、凭据、包链接和浏览器数据都不会进入用户正常使用的 Harness home；显式 `DSH_HOME` 只会替换开发 Harness home。生成的开发项目同时链接已声明的 workspace 依赖闭包和 pnpm 提升的包，因此未提升的配置插件仍能解析。Renderer DevTools 默认自动打开，Main、Renderer 和 dsh Host 调试端口依次为 9229、9222 和 9230。`DSH_DESKTOP_MAIN_INSPECT_PORT`、`DSH_DESKTOP_RENDERER_DEBUG_PORT` 与 `DSH_DESKTOP_HOST_INSPECT_PORT` 可以替换这些端口，`DSH_DESKTOP_OPEN_DEVTOOLS=0` 则保持 Renderer 调试窗口关闭。

显式构建完成后，`start:desktop` 会重新生成一次性项目，并跳过构建直接启动已有产物：

```sh
pnpm run start:desktop
```

Web 侧的对应命令是 `pnpm run dev:web` 与 `pnpm run start:web`，见[开发指南](../../docs/development.zh.md)。Workspace 开发使用 Electron RunAsNode 运行当前 CLI 与私有 Desktop Host 包，插件管理和恢复使用 `$DSH_HOME/profiles/desktop`，与一次性工作区运行时分离。Host 在开发与打包构建中都使用 runtime 模块解析，不创建官方包的 fallback 链接；开发者安装的包（包括链接）保留原生优先级。需要验证 Electron RunAsNode、内置 pnpm、内置 dsh 资源、插件安装和修复时，应运行未封装安装器的应用目录。

在 macOS 上，`dev:desktop` 和 `start:desktop` 通过 `.desktop-build/development` 下经临时签名、已注册到 Launch Services 的 `HalluCodex Dev.app` 启动 Electron；它加载当前工作区，并记录选定的开发 home、浏览器数据路径和调试设置，以供冷启动使用。它和打包后的应用一样不声明任何 URL 协议，因此不会占用上游的 `dsh` 协议。生成的应用包不包含账号 token，依赖工作区和已准备的运行环境继续存在。

[原生输入与渲染进程键盘测试](tests/keyboard.spec.ts)直接纳入仓库 Client 类型检查。它只导入不依赖 Cordis 的 Desktop 输入、持久化、IPC、浏览器 guest 和蒙层模块。

安装工作区依赖不会自动运行锁定版本 Electron 提供的独立二进制安装程序。直接运行 [Windows 控制台信号测试](tests/windows-cli-signals.spec.ts)前，在仓库根目录执行 `pnpm --filter @deepseek-ai/dsh-desktop exec install-electron`，准备锁定版本的 Electron 二进制。通过代理下载时，为该安装进程启用 `ELECTRON_GET_USE_PROXY=1`。Windows 覆盖率检查要求安装成功后，才启动带覆盖率插桩的单元测试集。

## 打包

<a id="release-versions"></a>

### 发布版本

HalluCodex 发布使用独立的版本线。每次发布对应标签 `hallucodex-v<版本>`，其中 `<版本>` 是不含构建元数据的 SemVer 版本，例如 `hallucodex-v0.1.0` 或预发布版本 `hallucodex-v0.1.0-beta.1`。[发布工作流](#upload-updates)把 `<版本>` 作为 `--build-version` 传给打包，该值同时决定产物文件名、更新元数据与已安装应用的版本。清单保留内置 dsh 运行时的产品版本，因此发布不改写任何受版本控制的文件。上游的 `dsh-v*` 标签不会启动桌面端发布。

本地测试构建可以传入任意这类版本，也可以使用 `--build-version auto`：它根据本目标本地输出目录中的 HalluCodex 及更早 DeepSeek Harness 产物，按 `<产品版本>.<日期>.<序号>`（稳定产品版本使用 `-test.<日期>.<序号>`）给出下一个版本。run script 会自行透传 `--`，打包入口两种写法都接受：

```sh
pnpm --dir apps/desktop run package:linux:x64 --build-version 0.1.0-test.1
```

不传 `--build-version` 时，构建使用产品版本。所有产物的清单都记录 `dshBuildCommit` 与 `dshBuildDirty`，直接分发的构建同样可溯源。更新器按 SemVer 比较版本，绝不会把已安装应用更新到更低版本，因此纠正发布必须使用比被替换版本更高的版本号。

打包以及手动 macOS 签名检查从 `apps/desktop/.env.windows`、`.env.macos` 或 `.env.linux` 读取发布配置，由目标平台选择。复制对应的 [Windows 模板](.env.windows.example)、[macOS 模板](.env.macos.example) 或 [Linux 模板](.env.linux.example)，填写本机配置；Git 忽略这些本地文件，安装产物也不包含它们。发布字段只从所选来源读取，不回退到系统或 shell 中的同名变量；`PATH`、代理和构建工具环境仍保留。CI 改为设置 `DSH_DESKTOP_PACKAGE_SETTINGS=environment`：打包随后从自身环境读取同一组允许的字段，并在目标 dotenv 文件同时存在时拒绝运行，确保每个发布字段只有一个来源。构建版本是命令参数而非发布字段。文件使用 UTF-8，支持 BOM；相对证书、SignTool、Apple API Key 和钥匙串路径以 `apps/desktop` 为基准，变量值不做 shell 展开，包含 `#` 或空格的密码需要引号。

每条打包命令在构建与下载前检查应用 ID（必须不同于 DeepSeek Harness 的 `com.deepseek.harness`）和该模式需要的签名配置，随后探测本次运行要用的外部工具：归档读取工具，以及 Windows 目标的安装器编译器。macOS 检查身份、Team ID、一套完整公证凭据、`CSC_LINK` 指定的可读本地 p12 文件、显式配置的 `CSC_KEY_PASSWORD`，以及引用的 API Key 和钥匙串文件；Windows 检查公开代码签名证书、SignTool 文件、容器名称和 PIN 格式。仅准备资源的构建以及显式未签名的 Windows 与 macOS 构建不要求签名凭据。配置检查不验证 PIN 是否正确、Token 是否登录、钥匙串是否解锁或 Apple 是否接受凭据；实际签名与公证负责这些检查。更新源固定为本仓库的 GitHub Releases，不需要任何设置或凭据，打包始终传入 `--publish never`。生成安装包后，打包要求已打包的 `app-update.yml` 指向该更新源，并要求 `latest` 元数据文件列出的安装包大小与 SHA-512 一致且附带其 blockmap；签名构建随后写入列出这些文件的发布完成记录。单独运行相同检查：

```sh
pnpm --dir apps/desktop run check:package
```

无需提前执行 `prepare:desktop`：

```sh
pnpm run package:desktop
```

发布自动化使用固定目标命令，确保运行时准备、dsh 准备与 electron-builder 接收相同的平台和架构。在具备签名证书前，发布工作流运行的是 `:unsigned` 命令：

```sh
pnpm run package:desktop:mac:arm64
pnpm run package:desktop:mac:x64
pnpm run package:desktop:win:x64
pnpm run package:desktop:mac:arm64:unsigned
pnpm run package:desktop:mac:x64:unsigned
pnpm run package:desktop:win:x64:unsigned
pnpm run package:linux:x64
```

macOS arm64 命令要求 Apple Silicon。macOS x64 命令可以在 Intel macOS 或带 Rosetta 的 Apple Silicon 上运行。Windows x64 命令要求 Windows x64，Linux x64 命令要求 Linux x64（见 [Linux 安装包](#linux-packages)）。

每个目标都在 `apps/desktop/.desktop-build/targets/<target>/` 下持有自己的打包输入、已准备运行时、包集合、dsh 依赖树、pnpm 准备状态、未打包应用和最终产物。Electron 归档缓存继续由 `.desktop-build/downloads` 共享，因为每个归档文件名都包含版本、平台和架构，并且在解包前经过验证。目标构建绝不读取其他目标的可变准备状态。

### 用回环 registry 安装本地 Official 包

打包后的应用不包含 Official 按需目录所宣传的 provider 运行时，而正式发布才会把对应版本的 bundle 发到 npm。要在发布前安装本地构建的 bundle，请启动一个回环 registry，它会打包并提供该目录的完整本地依赖闭包：

```sh
pnpm run dev:bundle-registry
```

该命令先校验目录与 workspace 清单，运行 `pnpm run build:official`，把闭包打包进新的 `dist/test-bundles/<run-id>/` 目录，最后写入 `bundle-registry.json` 作为完成标记，然后才打印产物路径、registry URL 和精确的 `name@version` 规格。它在分配到的端口上只监听 `127.0.0.1`，使用一次性的命名空间提供服务，直到 Ctrl+C 或 SIGTERM；停止后产物和已安装的包都保留在磁盘上。它不需要 `.env.macos`、Apple 凭据或 npm 凭据，也不改变桌面端打包。

在打包应用中打开“插件 → 添加插件”，粘贴一条打印出的规格，选择**自定义地址**，粘贴打印出的 registry URL 后安装。自定义 registry 会被单独询问，因此必须由本进程回答每一个依赖：仓库自有的包取自本次运行的产物，第三方包则通过固定重定向到 `registry.npmjs.org` 保留 npm 的真实元数据与字节，因此仍需要网络访问。安装后的条目仍归类为 Official，因为它的包名在目录中。registry 选择会在此浏览器中记住；再次选择某个提供的 registry 即可切回。

一次运行的产物是不可变的，所以重新构建会提供新的命名空间和新 URL；当已安装版本与运行版本一致时，Official 的**更新**控件不会出现。profile 会在 `pnpm-lock.yaml` 中记录上一次运行的 tarball URL，而 pnpm 会校验已记录的条目，因此用新 URL 再次安装或重装该 bundle 会被 `ERR_PNPM_TARBALL_URL_MISMATCH` 拒绝，并且可能继续保留旧文件。要在同一版本上验证改动后的代码，请先清除过期的解析结果——在 `$DSH_HOME/profiles/<profile>` 中运行 `pnpm clean --lockfile`，或改用全新的 profile——然后再从新 URL 安装。`bundle-registry.json` 记录每个归档的版本、文件名、大小和 SHA-512 完整性，以及打包所用 checkout 的 commit 和 dirty 标记。

所提供的 `time` 是真实的打包时间，因此 pnpm 11 默认的 24 小时 `minimumReleaseAge` 会在 profile 的 `pnpm-workspace.yaml` 中记录它授予的豁免（`minimumReleaseAgeExclude`）；如果那里显式配置了更严格的策略，安装会以 pnpm 自己的报错失败，而不会被覆盖。`~/.npmrc` 或 profile 的 `.npmrc` 中的 `@scope:registry` 路由会覆盖该 scope 的 `--registry`，因此不能让它们指向正在提供服务的 scope。

### 运行时文件筛选

Desktop 在本地打包工作区包，并通过目标捆绑的 Node 和 pnpm 安装外部依赖。[Desktop 文件策略](scripts/runtime-file-policy.ts)随后在签名和完整性封装前过滤不可变的 `resources/app.asar/dsh/node_modules` 副本。它排除 TypeScript 声明、已识别的 JavaScript/CSS/TypeScript source map、TypeScript 构建缓存、Domino 测试目录、选定的原生编译器输出和其他平台的 node-pty 预构建文件。它保留运行时 JavaScript、原生模块及其 DLL/EXE 辅助文件、WASM、未知资源、许可证和 notices。依赖清单在完整性封装前经过 electron-builder 的元数据清理，确保归档保持已记录的字节。该策略不修改 npm tarball、捆绑的包管理器或用户安装的插件文件。

[Office 转换提供方](../../packages/document/office-to-pdf/README.zh.md)携带目标已声明的原生引擎；kit 未声明匹配原生目标时携带 WASM 引擎。准备阶段在打包前拒绝缺少目标引擎的情况。完整 Office 依赖（CLI、JavaScript 库和选定引擎的可执行文件、数据、许可证及 notices）解包到 `resources/app.asar.unpacked/dsh/node_modules/` 下。Desktop Host 将引擎清单解析到这些物理目录，并向加载的技能提供独立 Node 和解包后 CLI 的绝对路径。Node 位于 `resources/runtime/primary-runtime/dependencies/node/bin/`；CLI 位于解包后的 `@deepseek-ai/libreoffice-kit/lib/cli.js`。macOS 上的原生辅助程序获得 [LibreOffice UNO 桥](https://github.com/LibreOffice/core/blob/master/sysui/desktop/macosx/hardened_runtime.xcent.in)所需的 JIT entitlement。

打包应用运行编译后的 JavaScript 和预生成的 Typert 元数据，不编译 TypeScript 插件。源码级调试导航和编辑器声明仍可从开发包中获取。[复制规则测试](tests/runtime-file-policy.spec.ts)覆盖排除项和保留资源；[产物 smoke](tests/fixtures/runtime-payload-smoke.mjs) 在 Host smoke 和最终清单验证之前，使用 Electron RunAsNode 执行。产物 smoke 解析搜索工具使用的 ripgrep 可执行文件，并验证文本搜索和文件枚举。Windows 签名构建在依赖签名后运行这些检查；其他构建在 `prepare:dsh` 中运行。[Host smoke](scripts/smoke-runtime.ts) 使用捆绑的 Python 创建 DOCX、XLSX 和 PPTX 输入，通过真实 Office 提供方逐一转换并检查 PDF 输出。每个组装后的应用（包括目录包和未签名构建）都会针对 ASAR 重复产物和 Host 检查。归档完整性检查将归档内完整描述符与准备结果比对，并核对归档和解包目录中的文件内容与清单、归档内文件记录的执行标志，以及解包文件的物理权限。转换失败会在写入发布记录前终止打包；macOS DMG/ZIP 构建在公证前执行这些检查。

Windows 发布验收还需在 Desktop 构建后手动运行[目录和替换检查](scripts/smoke-windows.ps1)。将 `$Makensis`、`$SevenZip` 和 `$PluginDir` 分别设为锁定版本构建器的 NSIS 编译器、7-Zip 可执行文件和 x86-unicode NSIS 插件目录；通过 `-FrameLibrary` 传入已准备好的 `window-frame.dll`，即可同时覆盖原生解压路径及其失败报告。从仓库根目录运行以下命令。它验证 目录替换与回滚和两种文件占用替换方式；不属于单元测试通道。

```powershell
pwsh -NoProfile -File apps/desktop/scripts/smoke-windows.ps1 -Makensis $Makensis -SevenZip $SevenZip -PluginDir $PluginDir -FrameLibrary apps/desktop/.desktop-build/targets/win-x64/installer-ui/window-frame.dll
```

Windows 安装器在启动时和选定目标目录后检查应用是否正在运行，通过检查后才将新版本解压到安装目录旁边。通过同卷目录改名替换前，安装器会再次检查。运行中的应用会阻止安装；更新启动允许等待应用退出，最长十秒。同路径升级在替换成功前保留旧目录；解压失败时旧版不变，替换失败时尝试恢复旧目录。安装器在启动前清理旧版备份。强制结束安装器或断电可能留下 `.new-*` 或 `.old-*` 目录；不同安装位置或安装范围迁移仍使用 electron-builder 的旧卸载器流程。

解压失败时，安装器会把 7-Zip 的结果和完整错误输出写入更新缓存目录 `%LOCALAPPDATA%\<按包名派生>-updater\installer-logs\extract-failure-<时间戳>.log`（当前为 `hallucodex-updater`），并在弹窗中显示首条错误行和 **复制错误信息** 按钮；静默安装只写入报告。未签名的 Windows 构建（`DSH_DESKTOP_UNSIGNED=1`）会将安装包命名为 `hallucodex-<版本>-win-x64-unsigned.exe`，`latest.yml` 也引用该文件名。

<a id="upload-updates"></a>

### 发布工作流

推送 `hallucodex-v<版本>` 标签，或以已有标签手动运行[发布工作流](../../.github/workflows/hallucodex-desktop-release.yml)，会为本仓库发布一个 GitHub Release：

1. 在仓库根目录的 [CHANGELOG.md](../../CHANGELOG.md) 中添加 `## <版本>` 小节并在打标签前合并。标签不是 `hallucodex-v<SemVer>` 或缺少该小节时，工作流在构建前停止。
2. 推送标签，例如 `git tag hallucodex-v0.1.0 && git push origin hallucodex-v0.1.0`。
3. 每个目标由一个任务在 GitHub 托管运行器上以标签版本打包未签名安装包：`windows-2025`（NSIS）、`macos-15`（Apple Silicon 的 DMG 与 ZIP）、`macos-15-intel`（Intel 的 DMG 与 ZIP）和 `ubuntu-24.04`（AppImage 与 deb）。每个任务在上传前用安装包校验自己的更新元数据。
4. 发布任务合并两个架构的 `latest-mac.yml`，再次校验每个元数据文件，写入 `SHA256SUMS`，并以全部安装包、`latest.yml`、`latest-mac.yml`、`latest-linux.yml`、blockmap 与 `SHA256SUMS` 运行 `gh release create`。版本号含 `-` 时发布为预发布版本。

Release 正文依次为对应的 CHANGELOG 小节、一行 `<!-- hallucodex:install-notes -->`，以及未签名构建的安装说明。应用把该标记之前的文字作为更新日志显示，因此小节内容不得包含该标记。打包从不发布：electron-builder 始终以 `--publish never` 运行，只有发布任务拥有 `contents: write`。安装包通过 electron-builder 为 `github` provider（`AkumaRealLabs/hallucodex-desktop`，发布类型 `release`）嵌入的 `app-update.yml` 读取更新，使用固定的 `latest` 通道文件；GitHub 不会把预发布版本报告为最新发布。

### 未签名安装包

在具备签名证书前，发布提供以下未签名安装包：

- Windows：`hallucodex-<版本>-win-x64-unsigned.exe` 不带 Authenticode 签名。首次运行时 SmartScreen 会提示，点击“更多信息”再点击“仍要运行”。
- macOS：`--unsigned` 跳过 Developer ID 签名、使用身份的运行时签名和公证，随后对完成的 App 施加 ad-hoc 签名（`codesign --force --deep --sign -`），使其能在 Apple Silicon 上启动。Gatekeeper 会拦截下载 App 的首次启动：按住 Control 点按 App 并选择“打开”（macOS 15 及以上在“系统设置 → 隐私与安全性”中点按“仍要打开”），或执行 `xattr -dr com.apple.quarantine /Applications/HalluCodex.app`。这类 App 无法替换自身，因此更新弹窗会打开 Release 页面。
- Linux：AppImage 和 deb 不带签名；`latest-linux.yml` 记录它们的 SHA-512。

未签名命令写入 `.desktop-build/targets/<目标>/unsigned-artifacts/`，产物名带有更新元数据所引用的 `-unsigned` 后缀，从子进程中清除签名凭据，运行已打包运行时冒烟检查，且不创建发布完成记录。它们要求设置 `DSH_DESKTOP_APP_ID` 并具备常规构建依赖，包括 Python，以及 Windows 上编译原生模块所需的 Visual C++ 构建工具；Python 不在 `PATH` 中时设置 `PYTHON`。

<a id="enabling-signing"></a>

### 启用签名

签名接入同一个工作流，无需新增工具：

- macOS：把 Developer ID p12（Base64）、其导出密码、签名身份、Team ID 以及一套公证凭据（例如 App Store Connect API Key）存为仓库 secrets。macOS 任务随后把文件解码到 `$RUNNER_TEMP`，通过环境变量传入 `DSH_DESKTOP_MACOS_SIGNING_IDENTITY`、`DSH_DESKTOP_MACOS_TEAM_ID`、`CSC_LINK`、`CSC_KEY_PASSWORD` 以及 `APPLE_API_KEY`、`APPLE_API_KEY_ID`、`APPLE_API_ISSUER`，运行不带 `:unsigned` 的 `package:mac:<arch>`，并从 `artifacts/` 收集产物。签名的 macOS 构建在清单中记录 `hallucodexUpdateMode: install`，应用因此可以原地安装更新。
- Windows：签名路径通过 [Windows EV 签名](#windows-ev-signing)所述的硬件 Token 签名，需要挂载该 Token 的自托管 Windows 运行器；云签名服务需要单独接入签名器。

工作流文件标注了这些输入的接入位置。

### macOS 签名与公证

macOS 签名配置使用必填发布环境，不会接受钥匙串中最先发现的证书。空值、格式错误的 Team ID、包含 electron-builder 不支持的 `Developer ID Application:` 前缀的签名身份，以及不完整的公证凭据都会被拒绝。macOS 签名打包要求已配置的身份及其私钥可用。运行时准备会把该身份、安全时间戳与 hardened runtime 应用到每个内嵌 Mach-O 文件；应用签名完成后，深度严格检查会拒绝其他叶证书 Authority 或 Team ID，验证通过才生成发布产物。macOS 签名固定目标安装包命令为已签名应用创建独立副本，并发执行两条产物流。一路先公证 App 并钉票，再生成 ZIP 及其更新元数据。另一路把已签名 App 副本封装进签名 DMG，再公证 DMG、钉票并验证；其中的 App 不单独附加票据。只有两路均成功结束，产物才会移入最终目录并写入发布完成记录。签名的仅目录命令同样需要公证凭据，并等待 Apple 公证和 App 钉票完成。[并行公证决策](../../.agents/notes/implemented/process/2026-09-09-parallel-macos-notarization.zh.md)负责副本隔离与容器票据语义。`CSC_LINK` 必须指向包含 Developer ID Application 证书及私钥的本地 p12，不支持 URL 或 Base64 输入。`CSC_KEY_PASSWORD` 是其导出密码，不是 Apple 账号或登录密码；未加密的 p12 可显式填写空值。构建前，打包流程自动创建并解锁私有临时钥匙串、导入 p12、授权签名并签署小型探针。运行时与 App 签名显式使用该钥匙串，无需预先配置或手动解锁登录钥匙串。子进程只接收钥匙串路径，不接收 p12 密码。成功或普通失败后删除临时钥匙串；强制终止后由 CI 清理临时凭据。CI 从密钥存储生成证书文件和 `.env.macos`，限制文件访问权限，并在作业结束后删除二者。环境中的 `CSC_NAME` 与证书发现顺序都不能选择发布所有者。公证凭据也可以使用 electron-builder 支持的完整 Apple ID 或钥匙串 profile 方式。手动执行 `pnpm --dir apps/desktop run verify:mac-signature -- <path-to-app>` 重复应用检查时，也必须提供两个 macOS 身份变量。

macOS 签名遍历真实文件，不跟随 Framework 的软链接别名。PAK 资源保留全部随附语言，由外层 Framework 或应用签名记录完整性，不逐个签名。[发布策略](../../.agents/notes/implemented/architecture/2026-08-25-electron-desktop-packaging-and-updates.zh.md)负责依赖补丁和验证要求。

macOS 运行时准备将已验证的单架构 Mach-O 签名缓存在 `.desktop-build/targets/<target>/signature-cache`。缓存键包含输入字节与权限、签名探针实际使用的叶证书、签名标识、entitlement 字节、macOS 版本，以及签名工具与策略。复用不取决于 Git 提交：未提交的字节变更会使对应文件失效。每次命中都验证缓存字节、严格签名、证书、标识、entitlements、安全时间戳和 hardened runtime，再替换未被并发修改的输入。通用二进制每次重新签名。运行时完整性与 smoke 检查、App 签名和 Apple 公证仍会执行。缓存要求受信任的本地构建存储。缓存损坏或不安全链接会令构建失败；停止打包后删除对应缓存目录再重试。成功的签名阶段会将完整缓存条目的内容总量裁剪至一 GiB；中断留下的临时条目需手动清理。并发淘汰可能使读取方安全失败。日志记录命中、未命中及未缓存数量。

Mac 打包命令通过 `DESKTOP_PACKAGING_RECORD` 输出 `apps/desktop/.desktop-build/packaging-runs/` 下的唯一目录。读取本地配置后，每次运行保留 `run.json`（发布版本、产品版本、Git 提交、工作区是否有改动、目标及 Node 版本）、`events.jsonl`（带时间戳的阶段、耗时、并行输出归属及代理恢复状态）、脱敏后的子进程 `stdout.log` / `stderr.log`，以及 `result.json`（整体结果、阶段结果和产物目录）。事件还记录打包并发数及各代理是否配置。失败和后续打包不会清除日志；没有自动删除流程。缺少 `result.json` 表示完成状态未经确认。已知凭据值会被遮盖；不记录环境变量全集或 notarytool 认证参数。运行时准备分别记录包暂存、安装、依赖树复制、签名、清单生成、smoke 检查、描述文件校验和清理。嵌套阶段的耗时存在重叠，不能直接相加。

App 和 DMG 公证分别记录 submission ID，以及独立的 `notarytool:upload:*` 和 `notarytool:wait:*` 耗时。上传使用 `submit --no-wait`，包含认证、本地校验、传输和服务端受理，并非纯传输时间。等待从该命令返回后开始，包含轮询及剩余的 Apple 处理时间；Apple 可能在上传提交命令返回前已开始处理。日志保留 Apple 状态与诊断信息，包括拒绝结果；签名检查、接受状态校验和 stapling 仍由 `@electron/notarize` 负责。仅生成目录的打包命令也使用同一条可计时的 App 公证路径。各子进程输出仍实时显示在终端，阶段失败及嵌套错误保留在事件日志中。两个平台均记录父进程打包失败，并在终端显示脱敏诊断，包括代理恢复操作指引。仅检查配置的 `check:package` 命令不创建运行日志。

Mac 打包从 `.env.macos` 读取三个调优字段：

| 设置 | 默认值 | 作用范围 |
|---|---|---|
| `DSH_DESKTOP_MACOS_PACK_CONCURRENCY` | `4` | 第一方与 vendor workspace tarball 的打包 worker 数；必须是正整数。 |
| `DSH_DESKTOP_MACOS_DOWNLOAD_PROXY` | 空 | Electron、运行时资源、pnpm 安装及 builder 下载使用的 HTTP/HTTPS 代理 origin。 |
| `DSH_DESKTOP_MACOS_NOTARIZATION_PROXY` | 空 | 通过临时系统代理设置供 Apple 工具使用的 HTTP 代理 origin。 |

两个代理字段互相独立，拒绝 URL 中的凭证、路径、查询参数和片段。空值沿用继承的网络设置。显式下载代理会替换子进程的代理变量，仅绕过本地主机；它不修改系统设置。Windows 与独立 `release:pack` 保持现有并发默认值。公司代理地址仅写入 Git 忽略的本地文件；具体地址参见内部文档。

Apple 工具使用 macOS 当前活动网络服务的 HTTP/HTTPS 代理。配置公证代理后，打包会检查代理可达性、保存该服务的设置，在两条产物任务期间启用代理，并在两条任务均结束后恢复原设置。对于原本关闭、服务器为空且端口为零的代理，恢复时仅关闭代理；临时服务器和端口可能保留，但不生效。仅生成目录的打包会在签名目录构建完成后的 App 公证期间启用代理。这会临时影响其他应用，并要求修改系统代理的权限；必须先禁用 PAC、自动发现、SOCKS 及需要认证的代理配置。打包和恢复在读取恢复记录或修改代理前获取同一个用户级 POSIX 文件锁；进程退出会释放锁的持有权，锁文件保留。该锁在首次使用时才加载 `@deepseek-ai/node-addon-system/flock`，而不是在脚本启动时加载，因此 `check:package` 和打包入口在未构建 `native/system` 的 checkout 上也能加载；加锁时若宿主 addon 二进制或入口的 JavaScript 缺失，加载器会先运行 `pnpm run build:native-system` 和 `pnpm --dir native/system run build:ts` 再加锁，因此恢复命令在这样的 checkout 上同样可用。这会阻止不同 checkout 的代理事务重叠；其他用户及网络设置工具不得同时修改这些设置。SIGINT/SIGTERM 会等待活动任务结束后恢复。强制终止或恢复失败后，先停止残留公证进程，再运行 `pnpm --dir apps/desktop run restore:mac-proxy`；保存的记录会保留到恢复成功。配置检查仅验证 URL 语法，不修改系统设置或连接代理。

### Windows 安装界面

Windows 安装程序使用原生 NSIS 页面，提供亮暗配色、系统阴影、可编辑的安装目录，以及默认勾选立即启动的完成页。安装仅面向当前用户。点击安装或按 Enter 均校验当前路径；路径规范化后仍拒绝磁盘根目录，包括带重复末尾分隔符的写法。新安装位置必须为空，非空位置必须是已登记的安装目录。受影响安装路径中的程序运行时显示系统提示，并保持应用运行；其他目录中的同名应用不阻止安装。静默更新最多等待受影响应用退出十秒，若仍在运行则以退出码 2 结束。

主题在启动时跟随 Windows；可用 `/THEME=light`、`/THEME=dark` 和 `/THEME=auto` 显式选择配色。窗口在品牌控件准备完成后显示。欢迎页首次出现时，安装窗口会一次性移到普通窗口前方；若焦点在其他窗口，任务栏按钮会闪烁提示，但安装窗口不会始终置顶。进度读取锁定版本的 7-Zip 解压器百分比；目录替换、注册和清理仍使用有界估算。加权百分比不代表剩余时间。NSIS 报告成功后，进度条用 600 毫秒补满并短暂显示 100%，再显示完成页；切换目标时长为 750 毫秒。完成页保留窗口位置。点击完成后，安装程序先隐藏窗口，再启动已安装的可执行文件；启动失败会恢复页面以供重试。目录替换和失败恢复遵循上文描述的安装流程。首次启动的配置档案准备仍属于独立的 Desktop 操作。

Windows 打包使用 Visual C++ Build Tools 和 Windows SDK 编译 x86 Win32/GDI+ 辅助库；签名构建通过已配置的 Windows 签名器对该库签名。准备钩子在所有平台上均由 electron-builder 继续负责收集生产依赖。

在有交互式桌面的 Windows x64 上，从仓库根目录运行 `pnpm --dir apps/desktop run test:installer`，可将小型原生测试载荷接入正式安装配置并执行验证。每次运行使用独立产品身份，依次验证仅英文和仅中文的安装器变体，并根据实际显示的欢迎页按钮选择测试文案。两个变体均安装到私有目录并在测试后卸载；截图和结果保留在 `.desktop-build/installer-tests/` 下。检查包含末尾带分隔符的已登记路径升级，以及磁盘根目录拒绝。可选的 `--signed` 标志使用下文的 Windows EV 配置，在嵌入前对测试程序和辅助库签名；它不会启用更新源。

Windows 卸载程序会随应用一起删除 Electron 用户数据目录（以包名命名的 `%APPDATA%\hallucodex`，存放浏览器存储与缓存）、`%APPDATA%` 下的产品目录，以及 `%LOCALAPPDATA%` 下的更新下载缓存。数据主目录（未设置 `DSH_HOME` 时为 `%USERPROFILE%\.hallucodex`：会话、设置、凭据、插件）不会被触碰；以 Windows 环境变量发布的 `DSH_HOME` 还会保护所有与其重叠的目标。静默卸载删除相同的数据；以 `--updated` 或 `/KEEP_APP_DATA` 启动的卸载程序保留数据，electron-builder 在原地更新和从其他目录替换旧安装时正是这样启动它。删除通过原生辅助程序执行：它拒绝受保护的 Windows 目录以及与安装目录或主目录重叠的路径，要求固定的本地驱动器，链接的根目录或祖先目录原样保留，遇到重解析点只解除链接而不进入目标，清除只读属性，并在遇到被占用文件后继续删除其余兄弟项；残余不会中止卸载，也不会提示。安装时在 Windows 卸载注册项上记录 `InstallLocation` 作为标准的清单元数据；在 Windows 11 上，开始菜单右键菜单中的“卸载”对所有 Win32 应用都会打开已安装应用列表，只有 MSIX 包能从那里直接卸载。卸载程序声明 DPI 感知，中文使用微软雅黑 UI。此行为仅适用于 Windows。

使用 `node apps/desktop/scripts/test-windows-installer.mjs --uninstall-only --compile-only` 以每次运行唯一的带作用域包名编译独立的中英文夹具。省略 `--compile-only` 可对预置数据运行原生删除器回归，以及交互、静默、`--updated`、`/KEEP_APP_DATA` 和 `DSH_HOME` 位于 Electron 数据内的检查。编译本身不能证明已安装卸载行为。

<a id="windows-ev-signing"></a>

### Windows EV 签名

运行时签名在当前 Windows 账户的各 worktree 间共享完整的已签名文件。`.env.windows` 中的 `DSH_DESKTOP_WINDOWS_SIGNATURE_CACHE_DIR` 指定固定本地磁盘上的绝对目录；默认值为 `%USERPROFILE%\.dsh-desktop-signing\signature-cache\v1`。缓存目录必须属于当前账户，访问权限不得向其他普通账户开放；带链接的路径会被拒绝。缓存项标识原始字节、公钥证书和签名工具链。每次恢复都检查摘要、Windows 信任状态、时间戳和证书，再替换未签名文件；缓存项无效会停止打包，不回退到硬件签名。不会仅因缓存较旧而重新签名。缓存信任同账户运行的程序，不防御管理员。[运行时签名缓存决策](../../.agents/notes/implemented/process/2026-09-17-windows-runtime-signature-cache.zh.md)定义验收要求和设计限制。

预检、主要运行时签名、应用运行时签名和产物生成分别持有账户级签名阶段锁，直到受监督的子进程结束。其他构建进入这些阶段前等待；编译和准备步骤不持锁。运行时签名进程自行持锁，因此仅终止外层打包进程不会释放仍在访问缓存的阶段锁。迁移及维护获取同一把锁；旧版或外部签名命令不参与排队，应另行避免并发。阶段等待不计入预检期限。关闭阶段句柄会释放普通竞争锁，不删除独立的硬件尝试互锁；遗留硬件失败仍需操作人员恢复。

缓存命中的复制、摘要和逐文件信任检查使用 `.env.windows` 中的 `DSH_DESKTOP_WINDOWS_SIGNATURE_CACHE_CONCURRENCY` 个工作任务（默认 `4`，整数 `1`–`8`）。所有恢复及后置验签完成后，未命中项才进入串行硬件签名。恢复或验签失败会停止派发新任务，并在释放阶段锁前等待在途工作结束；硬件签名、运行时 smoke 检查和最终完整性校验仍须执行。

每个运行时阶段向标准输出及打包日志写入 `SIGNATURE_CACHE_SUMMARY`，包含实际目录、策略标识、命中及未命中数、新发布及保留项数、签名请求数、省去的签名请求数和验证失败数。计时区分签名、恢复文件和新签名文件的信任验证及恢复；恢复耗时包含其信任检查和暂存清理。这些统计不包含预检、最终产物签名及外层运行时验签。阶段锁事件单独记录等待时间。 并发计时累加逐文件工作耗时，不代表阶段墙钟时间。

使用 `pnpm --dir apps/desktop run cache:windows-signatures --usage` 查看结构完整的缓存项字节数和数量，或用 `--from <absolute-old-cache>` 导入显式指定、属于同账户的旧缓存。迁移不修改源目录，跳过暂存名称，拒绝损坏项，并保留已有有效项，即使它们的时间戳字节不同。`--clear` 在阶段锁保护下显式删除完整缓存项；不执行自动容量淘汰。`--directory <absolute-cache>` 指定维护目标目录，无需加载发布凭据。不完整暂存项保持原状并单独计数；仅在所有构建停止后检查它们。这些命令绝不清除硬件失败证据。默认存储位于 AppData 之外，避免 MSIX 启动器虚拟化将账户缓存拆开；被重定向的覆盖目录会明确失败。

Windows 签名构建在编译或准备依赖前执行受监督的签名预检。静态配置、证书有效期、审计存储、编译器可用性及遗留签名锁的检查不访问 Token。本地 .NET Framework C# 编译器生成一个专用小探针，由正式签名器仅签名一次，随后必须验出配置的证书和时间戳才能继续构建。探针绝不执行。预检的整体 60 秒期限包含时间戳尝试；超时、硬件签名报错或验签失败都会停止本轮流程，不再次调用硬件。成功只证明当前签名路径可用，不证明 PIN 已独立认证：SafeNet 可能复用登录状态。不要为了验证 PIN 而注销或重复认证。`--check`、仅准备和 `--unsigned` 模式不执行此硬件预检。自动回归测试使用假签名器，真实硬件由发布操作人员单独验收。

Windows 发布要求安装包旁存在生成的非空 `.exe.blockmap`，用于差量下载；打包和发布工作流都会拒绝其安装包缺少该文件的 `latest.yml`。

签名 Windows 配置从同一份公开证书的 `CN`、`O` 和 `C` 属性生成 electron-builder 的 `publisherName`。每个属性都必须存在、非空且只有一个值。这些身份属性允许证书续期，无需固定叶证书指纹。electron-builder 把该发布者写入已打包的 `app-update.yml`，因此 updater 会拒绝其他发布者签名的安装包；未签名构建不携带预期发布者。真实文件验证及其限制见[签名验收记录](tests/README.zh.md)。

本项目使用的 SafeNet Token 出现 `SignTool Error: No private key is available.` 时，说明 PIN（密码）错误。立即停止所有签名尝试，等待用户处理 PIN 后再继续。PIN 输错达到五次会锁定 Token。遇到该错误后，不得重试打包或签名探针。签名器串行执行 Token 操作，首次失败后拒绝所有排队任务。

Windows 打包命令通过 `DESKTOP_PACKAGING_RECORD` 输出 `.desktop-build/packaging-runs/` 下的唯一目录。每次运行保留 `run.json`、带时间戳的 `events.jsonl`、脱敏后的 `stdout.log` 和 `stderr.log`，以及 `result.json`。签名失败还会写入 `fatal.json` 并通过 stderr 通知父进程；监督程序立即请求终止当前阶段的进程树并等待退出。失败阶段不能启动后续阶段或生成发布完成记录。日志写入失败也会停止运行。终止错误仍按失败处理，需要操作者检查；缺少最终记录表示尚未确认完成。

硬件签名必须属于受监督的打包运行。调用命令解释器前，签名器原子获取 `%USERPROFILE%/.dsh-desktop-signing/attempt.json` 并记录本次尝试。只有签名成功且配置证书的主签名通过验证后才释放该文件；随后完成时间戳，不再访问硬件。失败、中断、已有锁定文件或审计存储不可用都会阻止再次访问硬件，包括同一 Windows 账户下的另一个签名器实例、进程或代码检出目录。没有定时恢复或自动重试。管理员必须检查保留的证据及令牌状态，再明确授权恢复锁定状态；登录令牌或替换 PIN 文件不会清除它。记录区分签名意图、命令解释器 PID 和完成结果，不计量 CSP／令牌内部的认证次数。不记录命令参数、PIN 或凭据环境。其他 Windows 账户及无关签名程序不在此锁定机制的保护范围内。

Windows 打包将 7-Zip 过滤器固定为 `BCJ`，以兼容内置的 NSIS 解码器。这样可以保留 x64 安装包中由依赖携带的 ARM64 二进制文件；自动 ARM64 过滤会生成该解码器无法解压的条目。

NSIS 在安装阶段清理临时解压目录，完成后才显示完成页或自动启动应用。已安装的生产依赖保持为普通文件；启动时不会再次解压。安装仍会写入完整的应用目录树。

在 `.env.windows` 中填写 `DSH_DESKTOP_WINDOWS_CER_FILE`（公开 EV 叶证书）、`DSH_DESKTOP_WINDOWS_SIGNTOOL`（SafeNet 兼容的 SignTool）、`DSH_DESKTOP_WINDOWS_KEY_CONTAINER`（匹配的私钥容器）和 `DSH_DESKTOP_WINDOWS_TOKEN_PIN`（Token Password）。私钥仍保留在 USB Token；不要把证书或本地凭据文件提交到 Git。

```sh
pnpm run package:desktop:win:x64
```

打包前插入并解锁 Token。electron-builder 钩子把每个产物交给采用 CRLF 的 `scripts/windows-sign.cmd`；该 CMD 只调用一次已配置的 SignTool，并指定 `/f`、SafeNet `/kc "[{{PIN}}]=容器"`、`/csp "eToken Base Cryptographic Provider"`和 SHA-256 文件摘要，不请求时间戳。随后钩子在隔离副本上完成 DigiCert SHA-256 RFC 3161 时间戳，不传递签名凭据。钩子不会改用 electron-builder 内置的 SignTool，也不会重试失败的签名请求。SignTool、证书、容器、PIN、Token 或签名不可用时，Windows 发布打包会失败，不会生成未签名产物。

时间戳处理仅对正常退出但返回失败或警告的时间戳命令重试，最多尝试三次，间隔为一秒和两秒。每次均从同一份已验证的主签名开始。启动错误、终止状态不确定或验签失败会立即停止。SignTool 使用短的私有路径；发布时先把已验证字节复制到目标卷，再原子替换。最终必须通过 Windows 信任、证书、时间戳和规范化全文件相等检查。尝试耗尽后停止打包并保留证据，不再次调用硬件。参见[签名完成决策](../../.agents/notes/implemented/process/2026-09-17-windows-signature-completion.zh.md)。

PIN 不能包含 `]`、引号或换行，因为这些字符用于分隔 SafeNet `/kc` 值或对应的 CMD 参数。CMD 会禁用延迟展开，因此包含 `!` 的 PIN 可以原样到达 SafeNet。打包流程不会把任何 `DSH_DESKTOP_WINDOWS_*` 字段传给构建与 运行时准备子进程；它只向签名预检、独立的第一方运行时签名阶段与 electron-builder 提供四个配置输入，在其他字段已经清理的环境中只向签名 CMD 提供经过校验的签名字段，在 SignTool 启动前清除这些字段，并遮盖 SignTool 诊断。SafeNet 仍要求 PIN 出现在 SignTool 进程命令行中。本地 `.env.windows` 明文保存 PIN，应限制文件访问权限；CI 使用临时文件并在任务结束后删除。不要提交或分享文件内容，也不要把凭据写入日志。配置检查不会消耗 Token 的 PIN 尝试次数；签名仍在首次失败后停止整批任务。

使用对应的 `:dir` 命令可以生成可直接运行的应用目录，而不是安装包，例如：

```sh
pnpm run package:desktop:dir
pnpm run package:desktop:mac:arm64:dir
```

需要检查或诊断为宿主目标准备的资源而不调用 electron-builder 时，可以让同一流水线在准备完成后停止：

```sh
pnpm run prepare:desktop
```

这条诊断命令是另一种停止位置，并非两条命令构建流程的前半段。之后执行 `package:desktop*` 时仍会重新完成正式构建与准备，避免使用陈旧的 dsh 包、运行时文件或 dsh 内容。

<a id="desktop-runtime-preparation"></a>

### Desktop 运行时准备

Desktop [补丁策略](scripts/runtime-patch-policy.ts) 将每份工作区补丁明确归为共享、仅工作区或仅运行时。共享项复用根目录补丁字节，并对照根锁文件校验 hash；仅运行时项使用仓库内的独立文件，不改变工作区安装。仅工作区补丁用于构建工具或已嵌入客户端 bundle 的依赖。未分类或过期的条目、文件缺失、hash 改变、解析版本不兼容，以及仅工作区包进入运行时，都会阻止打包。[准备脚本](scripts/prepare-runtime-patches.ts) 只写入临时项目；pnpm 负责应用选中的补丁，应用失败时会报错。

Desktop 依赖 overrides 在补丁策略模块中单独声明，不从补丁版本推导。pi-ai 约束使运行时版本保持在共享补丁已验证的版本。Desktop 仍会在每次构建时重新解析运行时锁文件，再通过 `--frozen-lockfile` 安装；不同构建之间的依赖解析尚不保证可复现。CLI 打包安装测试及其他交付流程保留各自的配置。

每条打包命令都会构建仓库，打包以 dsh 和私有 Desktop Host 为根的第一方生产依赖闭包，并准备目标专用的 Electron 分发包和包含共享 pnpm CLI 的 primary-runtime。`prepare:dsh` 在构建时安装一次生产依赖图，准备物化包供 electron-builder 归档到 `app.asar/dsh`，移除包管理器元数据，并生成包含共享包版本和最终文件哈希的 `desktop-runtime.json`。macOS 签名构建先签名并验证原生文件，再生成清单；electron-builder 不对已签名的此目录重复进行嵌套签名。资源映射明确包含默认根目录过滤器会忽略的 `dsh/node_modules`；准备完成的运行时清单在原生签名后检查。原生可执行文件及库解包到 ASAR 旁；Python、独立 Node 和 pnpm 保留在外部 runtime 资源中。Windows 打包逐项检查准备好的 PE，确认其 ASAR 条目已标记为解包，且磁盘副本字节一致；未签名构建也执行此检查。Builder glob 规则用单字符通配符匹配 PE 文件名中的花括号，因此同目录中名称匹配的文件也可能被解包。准备好的运行时 smoke 沿用已验证的目标描述符，不使用构建宿主的架构。签名安装包、公证、已安装应用升级和各目标原生模块的验收需要发布环境。

electron-builder 只为 DMG 和 ZIP 目标写入 `app-update.yml`，因此 macOS 目录构建会在签名前自行写入同一份 GitHub Releases 配置，每个 macOS 构建都会校验该文件。签名安装包流程从 ZIP 产物流移入 `hallucodex-<version>-mac-<arch>.dmg`、`.zip`、`.zip.blockmap` 和 `latest-mac.yml`；未签名构建的同名文件带有 `-unsigned` 后缀。

未压缩产物包含 Electron、物化后的 dsh 生产依赖树、pnpm，以及壳应用。安装包大小与文件系统占用不同；发布验收需要测量两者，以及 profile 插件存储和首次启动耗时。此布局用更多应用内文件换取消除用户机器上的核心包安装过程。

## 更新

HalluCodex 从本仓库公开的 GitHub Releases 检查更新，每次提示都会显示更新日志，即对应的 CHANGELOG 小节；未经用户确认不会下载或安装任何内容，也不存在强制更新策略。在 Windows 和 AppImage 中，用户先确认下载，再确认安装与重启。没有 Developer ID 签名的 macOS 构建和 deb 安装无法替换自身，弹窗会显示更新日志并打开 Release 页面；签名的 macOS 构建可以原地安装。[账号模块参考](hallucodex/README.zh.md)负责检查时机与弹窗；以下段落说明共用的更新器机制。

Windows 下载完成后的更新确认说明应用会在安装期间关闭、完成后自动打开，并提示期间不要重复启动。安装器携带 `--updated` 启动应用并打开工作区时，壳会将主窗口前置并聚焦一次，不启用永久置顶。普通启动和其他平台不执行此前置步骤。

原生更新浮层在文档就绪且父窗口可见时显示，并在父窗口再次显示时恢复。关闭浮层会释放输入拦截和父窗口监听。Wayland 合成器自行决定子窗口的位置，与主窗口同尺寸的子窗口可能错位，露出未遮住的部分；因此 Linux 把更新浮层画成主窗口内部的透明视图，尺寸随内容区变化，并随主窗口一起关闭。窗口按钮仍在这个视图之上，所以浮层打开期间，壳会把按钮的底色和图标按遮罩同样的 24% 黑色调暗。[本地窗口验证](tests/README.zh.md#verification-overlay)无需启动工作区即可检查这些切换。

存在更新源时，应用在启动后异步检查 `latest` 通道。常规轮询以十分钟为基础间隔，每次独立采样 ±20% 的随机抖动。每次检查失败将基础延迟翻倍，上限为一小时；成功后重置。随机延迟不超过该上限，并从全部复用调用结算后开始计时。本地化的“检查更新…”菜单项（Windows 与 Linux 可从顶栏的“应用”菜单进入）立即执行，并复用正在进行的检查。回到前台和系统恢复时遵守相同的单调时钟截止时间。自动检查从不弹窗或下载安装包。手动检查显示正在检查、失败或包含已安装版本号的无更新反馈。常规更新弹窗原位渐入渐出；连续弹窗替换卡片内容并重置其滚动位置，保留黑色半透明蒙层，不模糊父页面。

`DSH_DESKTOP_UPDATE_CHECK_INTERVAL_MS` 配置常规基础间隔，`DSH_DESKTOP_UPDATE_CHECK_MAX_BACKOFF_MS` 配置上限；两者均接受 1000 至 2147483647 的整数毫秒数，且上限不能小于间隔。省略上限时取一小时与间隔中的较大值。`DSH_DESKTOP_UPDATE_CHECK_JITTER` 配置 0 至 1 的抖动比例，默认 `0.2`；最终延迟至少一秒，且不超过上限。这些配置不授权下载重试。

左下角账户行显示本地化的更新可用状态、加载图标与下载百分比、验证、就绪状态，或带可访问提示的持久红色重试操作。嵌入 Web 界面的文案跟随应用内当前语言；原生弹窗使用 Desktop 壳语言。侧栏收起时，顶部展开按钮显示圆点。连接状态优先展示。选择可用版本即开始下载。准备成功后自动打开壳拥有的重启确认；关闭后保留就绪状态，不重复弹窗。选择就绪入口可再次打开确认。运行中的 agent、排队输入，以及运行中或停止中的后台任务都会在该确认中触发中断警告。仅有 API 请求不会触发警告。用户批准后，Host 锁定新请求，等待已接收的请求结束，再检查任务，包括已接收写操作创建的工作。等待超过控制请求截止时间时，拒绝安装并解除准入锁。任务状态未知、未获中断授权的新任务，或未成功完成正常收尾，都会阻止安装。常规退出先按"关闭窗口与退出"一节所述询问可中断的工作，再在停止 Host 前隐藏产品窗口，在收尾期间忽略新的聚焦请求，且从不安装更新。下次启动通过已有的启动与恢复流程校准版本绑定的运行时。

若任务收尾失败但已确认 Host 退出，安装会被拒绝，壳会在允许再次确认重启前恢复当前版本的 Host。Host 正常停止后的安装器启动失败使用同一恢复路径。替代 Host 启动并完成认证后，壳重新加载原有应用地址，让 Web 页面获取当前端口、Cookie 和启动注入数据；页面加载失败时打开原生致命故障恢复弹窗。未确认进程退出时，绝不允许启动替代 Host。已下载目标保留以供重试。Host 恢复失败打开原生致命故障恢复弹窗。

已确认 Host 退出但任务未成功收尾时，更新弹窗展示本地化恢复提示。两种语言都根据类型化的准备失败原因选择提示，翻译文案变化不会改变失败分类。“查看技术详情”默认折叠，仅展示退出状态、信号、关闭确认和截止时间事实，不展示插件 stderr。展开详情既不重试，也不授权安装。

### 本地 updater 验证

常规更新 HTTP 请求具有逐连接的无活动截止时间：`60000` 毫秒内未收到响应头或后续响应字节会使操作失败。`DSH_DESKTOP_UPDATE_HTTP_IDLE_TIMEOUT_MS` 接受 `1000` 至 `2147483647` 的整数进行调整；活跃下载没有总时长限制。下载失败保留重试提示，并要求用户再次操作。

在已安装工作区依赖的 Windows 上，从仓库根目录运行：

```sh
node apps/desktop/node_modules/pnpm/bin/pnpm.mjs --dir apps/desktop run test:updates:local
```

此命令构建 Desktop 壳，让其协调器通过真实 Electron HTTP 请求和 `NsisUpdater` 访问私有回环服务器。它验证用户授权的完整下载、SHA-512 拒绝、显式重试、并发请求合并、清单替换和安装交接。成功时打印 `LOCAL_UPDATER_RESULT` 并以零退出码结束；功能失败时返回非零退出码。每次调用独占随机端口和临时用户数据／缓存目录，关闭监听器、等待 Electron 退出，并移除临时文件。报告和可用截图保存在唯一的 `.desktop-build/qualification/local-updater-*` 目录中。截图失败单独记录，绝不当作视觉验收通过。不需要 COS 或签名凭据。

下载内容是不可执行的测试字节，安装调用仅记录而不执行。测试替换浏览器打开与剪贴板写入，避免外部导航和剪贴板修改。它不启动完整产品工作区，不验证真实安装器或重启，不验证发布者签名，也不覆盖差分更新或 macOS。停滞的清单请求和负载传输会执行真实截止时间及恢复。真实常规弹窗验证隔离预加载、卡片尺寸、未施加模糊的父页面、取消、任务警告选项与显式安装批准；账户行组件测试另行提供证据。[本地验证决策](../../.agents/notes/implemented/testing/2026-09-10-desktop-local-updater-qualification.zh.md)和[验证记录](tests/README.zh.md)保留这些限制；生产发布要求保持不变。

## 底层开发覆盖项

未打包的 Electron 进程使用应用目录下的 `.desktop-build/development/project` 作为开发项目。`DSH_DESKTOP_PNPM_ENTRY` 和 `DSH_DESKTOP_DSH_DIR` 是带应用路径默认值的可选覆盖项。每次未打包启动都必须设置 `DSH_DESKTOP_PRIMARY_RUNTIME_DIR`：开发启动器（`dev:desktop`、`start:desktop` 及工作区更新验证运行器）会把它设置为自己已准备目标的 primary-runtime 目录；缺少该变量的启动会以致命启动对话框失败。启动器必须设置它，因为壳无法从 `process.arch` 推导该目录：构建目标将 Windows 固定为 x64，而宿主可能是 arm64。打包应用会忽略这些变量，从 `process.resourcesPath` 解析签名资源，并使用受管 Desktop profile。

## 已知限制

- 在配置签名证书前，安装包均未签名（见[启用签名](#enabling-signing)）；跨上一版本的已安装升级验证仍需要真实安装。
- 依赖的生命周期脚本遵循 pnpm 的构建权限；Desktop 不提供单独的审批对话框。
- 已打包的 Desktop 及其安装的 `dsh` 命令默认把 `DSH_HOME` 设为 `~/.hallucodex`；npm 安装的 dsh 只有使用相同的 `DSH_HOME` 时才与 Desktop 共享会话、设置、凭据、工作区和存储，而可执行包、插件激活和锁文件始终彼此隔离。
- 在 Electron win32-arm64 宿主上，未打包启动现在可以成功，但载荷仍为 x64：`packages/skill/tool-workspace-dependencies/src/index.ts` 的架构校验会把载荷记录的架构与宿主 `process.arch` 比较，因此 `load_workspace_dependencies` 工具仍可能拒绝 primary runtime。

仅向应用提供的 `dshOnboarding.hasApiKey()` preload 方法始终返回 `false`，因为模型访问来自 HalluCodex 账号，而不是提供方 API Key。`dshOnboarding.setActive(active)` 在激活期间把主窗口最小宽度从 520 像素提高到 960 像素，并加宽更窄的窗口。只有受管理的应用主 frame 可以调用它们。

## 开发备注

上线前 CDN 与容量决策见[桌面更新提案](../../.agents/notes/proposed/feature/2026-09-08-desktop-update-policy-and-installation.zh.md#cdn-and-capacity-qualification)。

<a id="linux-packages"></a>

## Linux 安装包

Linux x64 安装包为 AppImage 和 deb。`package:linux:x64`、`package:linux:x64:dir` 和 `check:package:linux:x64` 选择原生 x64 主机及按目标隔离的资源；发布工作流在 `ubuntu-24.04` 上构建它们。Linux arm64 选择器和载荷路径已经提供，但没有记录 arm64 桌面运行时验收。

Linux 通道读取 `.env.linux`（复制[模板](.env.linux.example)），或在设置 `DSH_DESKTOP_PACKAGE_SETTINGS=environment` 时从自身环境读取同一组字段：应用标识、`Name <email>` 形式的公开维护者联系方式和 HTTPS 项目页面。发布工作流使用 `com.hallucodex.desktop`、`AkumaRealLabs <AkumaRealLabs@users.noreply.github.com>` 和本仓库页面。HalluCodex 是产品名称，`hallucodex` 是其包名和可执行文件名。Linux 使用独立的可执行文件、包名和桌面条目；与其他打包平台一样，默认数据目录为 `~/.hallucodex`，显式设置 `DSH_HOME` 仍是操作者覆盖项。与其他平台相同，它不注册 URL scheme。

AppImage 和 deb 启动时不添加禁用沙箱的参数。AppImage 使用应用自有 AppRun，组装后验证其解包字节，且启动器拒绝以 root 运行。应用以普通用户身份运行。主机没有可用 Chromium 沙箱支持时，验收应当失败；不要通过以 root 运行应用或禁用沙箱绕过问题。构建产物时，现有打包冒烟序列检查原生 Node/Python 载荷、可执行位、ASAR 解包库和 Host。

Linux 安装包通过 `latest-linux.yml` 从同一 GitHub Releases 更新源读取更新，该文件列出 AppImage 与 deb 及其 SHA-512；AppImage 内嵌自己的 blockmap。只有运行中的 AppImage 会原地安装更新；deb 安装显示更新日志并打开 Release 页面。两种格式都不带发布者签名，因此摘要能发现损坏的下载，但不能验证发布者身份。

已打包运行时冒烟检查会在目标 Electron 下运行内置 sharp。在 Ubuntu 24.04 主机上该检查通过；在系统库比 sharp 内置 libvips 所带版本更新的主机上（已在 CachyOS 上观察到），Electron 通过 sharp 解码 PNG 时崩溃，打包随之停止。请像发布工作流一样在 Ubuntu 24.04 上构建 Linux 安装包；在这类发行版上，同一冲突也可能影响已打包应用。

发行验收仍需实际构建 AppImage/deb，在干净目标发行版和用户机器上验证：glibc 基线和系统库、FUSE 与解包启动、X11/Wayland、GPU/字体/对话框、沙箱、安全密钥库及锁定状态、登录回调、任务执行、休眠恢复、N-1 升级、更新中断或磁盘耗尽、篡改和错误签名、数据保留及卸载范围。确定性配置测试和记录的 Linux 桌面条目不能代替这些证据。

独立的 [HalluCodex 账号模块](hallucodex/README.zh.md)说明原生授权、模型路由及剩余集成工作。

若要在没有 deb 发布者元数据时构建本地未签名 AppImage，使用 `pnpm run package:linux:x64:dev`。其显式 `--development-appimage` 模式仅在 `unsigned-artifacts` 中生成 AppImage，为文件名添加 `-dev-unsigned`，且不写入发行记录、更新元数据或 `app-update.yml`。普通 AppImage/deb 打包仍要求完整的 Linux 包元数据。

打包后的 Office kit 与 WASM/原生引擎模块从完整的 ASAR 解包目录解析，使缺失包探测和 worker 资源使用物理文件系统；缺少解包文件仍会导致验证失败。
