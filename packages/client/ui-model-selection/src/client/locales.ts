/**
 * `model` namespace dictionaries.
 *
 * `trigger.selectAria` intentionally matches `trigger.fallback` but remains a
 * separate key: the visible fallback label and the accessible name of
 * an unset trigger are free to diverge per locale, and folding it into
 * `trigger.aria` would announce the degenerate "Select model, current Select
 * model".
 */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'provider.account': 'DeepSeek 账号',
  'command.label': '模型',
  'command.description': '选择本会话使用的模型',
  'option.loadError': '目录加载失败：{message}',
  'trigger.fallback': '请选择模型',
  'trigger.loading': '正在加载模型…',
  'trigger.selectAria': '请选择模型',
  'trigger.aria': '选择模型，当前 {model}',
  'trigger.ariaEffort': '选择模型，当前 {model}，推理等级 {effort}',
  'trigger.unavailable': '不可用',
  'trigger.ariaUnavailable': '选择模型，当前 {model} 不可用',
  'menu.aria': '模型与推理等级',
  'menu.model': '模型',
  'menu.effort': '推理等级',
  'menu.capacity': '上下文',
  'capacity.value': '{context} · 输出 {output}',
  'capacity.title': '上下文 · {model}',
  'capacity.back': '返回',
  'capacity.context': '上下文窗口',
  'capacity.output': '最大输出',
  'capacity.automatic': '自动：{value}',
  'capacity.automaticUnknown': '自动',
  'capacity.source': '当前上下文来自{context}，输出来自{output}。对所有对话生效。',
  'capacity.source.user': '你的设置',
  'capacity.source.provider': '服务端',
  'capacity.source.catalog': '内置模型目录',
  'capacity.source.default': '默认值',
  'capacity.save': '保存',
  'capacity.reset': '恢复自动',
  'capacity.invalid': '请填写正整数，且最大输出不超过上下文窗口。',
  'capacity.failed': '保存失败：{message}',
  'effort.providerDefault': 'Default',
  'status.loading': '正在刷新模型列表…',
  'error.action': '模型操作失败：{message}',
  'error.sessionInUse': '当前会话已被占用，可能是其他正在运行的 HalluCodex 导致的（如其他 dsh web、桌面端），请退出其他正在运行的 HalluCodex 后重试。',
  'action.reload': '重新加载',
  'warning.groupLoad': '{name} 加载失败：{message}',
  'search.placeholder': '搜索模型…',
  'search.clear': '清除搜索',
  'search.empty': '没有匹配的模型。',
  'empty.models': '没有可用的模型。',
  'empty.efforts': '当前模型未提供推理等级。',
} satisfies Record<string, string>

/** The model namespace key union. */
export type ModelKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'provider.account': 'DeepSeek Account',
  'command.label': 'Model',
  'command.description': 'Select the model for this conversation',
  'option.loadError': 'Catalog failed to load: {message}',
  'trigger.fallback': 'Select model',
  'trigger.loading': 'Loading models…',
  'trigger.selectAria': 'Select model',
  'trigger.aria': 'Select model, current {model}',
  'trigger.ariaEffort': 'Select model, current {model}, reasoning effort {effort}',
  'trigger.unavailable': 'Unavailable',
  'trigger.ariaUnavailable': 'Select model, current {model} is unavailable',
  'menu.aria': 'Model and reasoning effort',
  'menu.model': 'Model',
  'menu.effort': 'Effort',
  'menu.capacity': 'Context',
  'capacity.value': '{context} · output {output}',
  'capacity.title': 'Context · {model}',
  'capacity.back': 'Back',
  'capacity.context': 'Context window',
  'capacity.output': 'Max output',
  'capacity.automatic': 'Auto: {value}',
  'capacity.automaticUnknown': 'Auto',
  'capacity.source': 'Context currently comes from {context} and output from {output}. Applies to every conversation.',
  'capacity.source.user': 'your setting',
  'capacity.source.provider': 'the server',
  'capacity.source.catalog': 'the built-in model catalog',
  'capacity.source.default': 'the default',
  'capacity.save': 'Save',
  'capacity.reset': 'Restore auto',
  'capacity.invalid': 'Enter positive whole numbers, with max output not above the context window.',
  'capacity.failed': 'Could not save: {message}',
  'effort.providerDefault': 'Default',
  'status.loading': 'Refreshing model list…',
  'error.action': 'Model operation failed: {message}',
  'error.sessionInUse': 'This session is already in use, possibly by another running HalluCodex instance (such as dsh web or the desktop app). Quit other running HalluCodex instances and try again.',
  'action.reload': 'Reload',
  'warning.groupLoad': '{name} failed to load: {message}',
  'search.placeholder': 'Search models…',
  'search.clear': 'Clear search',
  'search.empty': 'No matching models.',
  'empty.models': 'No models available.',
  'empty.efforts': 'This model provides no reasoning effort levels.',
} satisfies Record<ModelKey, string>
