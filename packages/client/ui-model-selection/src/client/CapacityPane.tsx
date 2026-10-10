/**
 * CapacityPane: the composer model menu's context pane for the selected model. It edits the user's context window and
 * output limit, which apply to every Session. An empty field follows the automatic value its placeholder shows; Save
 * sends both fields and Restore auto clears both. A rejected save stays in the pane with its error, and a successful
 * one returns to the root pane, whose row already shows the reloaded catalog values.
 */
import { useState, type FormEvent } from 'react'
import clsx from 'clsx'
import type { ModelCapacity, ModelCapacitySource } from '@deepseek-ai/dsh-api-remotes/client'
import { Button, IconChevronLeftOutlineRegular, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { ModelKey } from './locales.ts'
import type { ModelSelectInjected } from './slots.ts'
import css from './ModelSelect.module.css'

const SOURCE_KEYS = {
  user: 'capacity.source.user',
  provider: 'capacity.source.provider',
  catalog: 'capacity.source.catalog',
  default: 'capacity.source.default',
} as const satisfies Record<ModelCapacitySource, ModelKey>

// Token counts read as K and M in every locale of this menu, as model vendors publish them.
const compact = (value: number): string =>
  new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: value >= 1_000_000 ? 1 : 0 }).format(value)

/**
 * Summarize a model's effective capacities for the root row.
 * @param capacity - capacities from the catalog.
 * @param t - the model namespace translator.
 * @returns the compact summary, or undefined when no source supplies both values.
 */
export function capacitySummary(capacity: ModelCapacity, t: TranslateNS<'model'>): string | undefined {
  if (capacity.contextWindow === undefined || capacity.maxOutputTokens === undefined) return undefined
  return t('capacity.value', { context: compact(capacity.contextWindow), output: compact(capacity.maxOutputTokens) })
}

/**
 * Read one field; grouping separators are ignored.
 * @param text - the field's text.
 * @returns null for an empty field, the positive count, or undefined when the text is not one.
 */
function tokenCount(text: string): number | null | undefined {
  const digits = text.replaceAll(/[\s,_]/g, '')
  if (digits === '') return null
  if (!/^\d+$/.test(digits)) return undefined
  const value = Number(digits)
  return Number.isSafeInteger(value) && value > 0 ? value : undefined
}

/**
 * Render the context pane.
 * @param props.provider - provider route of the selected model.
 * @param props.model - selected model id.
 * @param props.name - selected model display name.
 * @param props.capacity - the model's capacities from the catalog.
 * @param props.setCapacity - the seat's save operation.
 * @param props.onBack - return to the root pane.
 * @param props.t - the model namespace translator.
 * @returns the pane's form.
 */
export function CapacityPane({ provider, model, name, capacity, setCapacity, onBack, t }: {
  provider: string
  model: string
  name: string
  capacity: ModelCapacity
  setCapacity: ModelSelectInjected['setCapacity']
  onBack: () => void
  t: TranslateNS<'model'>
}) {
  const [context, setContext] = useState(capacity.contextSource === 'user' ? String(capacity.contextWindow) : '')
  const [output, setOutput] = useState(capacity.outputSource === 'user' ? String(capacity.maxOutputTokens) : '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const custom = capacity.contextSource === 'user' || capacity.outputSource === 'user'
  const automatic = (value: number | undefined): string => value === undefined
    ? t('capacity.automaticUnknown')
    : t('capacity.automatic', { value: value.toLocaleString() })

  const save = (contextWindow: number | null, maxOutputTokens: number | null): void => {
    setSaving(true)
    setError(null)
    void setCapacity({ provider, model, contextWindow, maxOutputTokens }).then((result) => {
      setSaving(false)
      if (result === undefined) return
      if (result.ok) { onBack(); return }
      setError(result.error.code === 'session/model-capacity-invalid'
        ? t('capacity.invalid')
        : t('capacity.failed', { message: `${result.error.code}: ${result.error.message}` }))
    })
  }

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (saving) return
    const contextWindow = tokenCount(context)
    const maxOutputTokens = tokenCount(output)
    if (contextWindow === undefined || maxOutputTokens === undefined
      || (contextWindow !== null && maxOutputTokens !== null && maxOutputTokens > contextWindow)) {
      setError(t('capacity.invalid'))
      return
    }
    save(contextWindow, maxOutputTokens)
  }

  const title = t('capacity.title', { model: name })
  return (
    <form className={css.capacity} aria-label={title} aria-busy={saving} onSubmit={submit}>
      <div className={css.capacityHeader}>
        <button type="button" className={css.capacityBack} aria-label={t('capacity.back')} onClick={onBack}>
          <IconChevronLeftOutlineRegular />
        </button>
        <span className={css.capacityTitle} title={title}>{title}</span>
      </div>
      <label className={css.capacityField}>
        <span>{t('capacity.context')}</span>
        <Input
          className={clsx(css.capacityInput)}
          inputMode="numeric"
          value={context}
          placeholder={automatic(capacity.automaticContextWindow)}
          readOnly={saving}
          onChange={(event) => { setContext(event.target.value); setError(null) }}
        />
      </label>
      <label className={css.capacityField}>
        <span>{t('capacity.output')}</span>
        <Input
          className={clsx(css.capacityInput)}
          inputMode="numeric"
          value={output}
          placeholder={automatic(capacity.automaticMaxOutputTokens)}
          readOnly={saving}
          onChange={(event) => { setOutput(event.target.value); setError(null) }}
        />
      </label>
      {capacity.contextSource !== undefined && capacity.outputSource !== undefined && (
        <p className={css.capacitySource}>
          {t('capacity.source', { context: t(SOURCE_KEYS[capacity.contextSource]), output: t(SOURCE_KEYS[capacity.outputSource]) })}
        </p>
      )}
      {error !== null && <div className={css.error} role="alert">{error}</div>}
      <div className={css.capacityActions}>
        {custom && (
          <Button size="sm" variant="ghost" disabled={saving} onClick={() => { save(null, null) }}>{t('capacity.reset')}</Button>
        )}
        <Button size="sm" variant="primary" type="submit" disabled={saving}>{t('capacity.save')}</Button>
      </div>
    </form>
  )
}
