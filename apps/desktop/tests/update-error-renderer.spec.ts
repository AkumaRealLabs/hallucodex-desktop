import { readFileSync } from 'node:fs'
import { runInContext } from 'node:vm'
import { JSDOM } from 'jsdom'
import { expect, it, onTestFinished, vi } from 'vitest'
import { resolveDesktopLocale } from '../src/locale.ts'
import type { UpdateDialogApi, UpdateDialogView } from '../src/update-dialog.ts'

function page(name: string) {
  const dom = new JSDOM(readFileSync(new URL(`../renderer/${name}.html`, import.meta.url), 'utf8'), { runScripts: 'outside-only' })
  onTestFinished(() => {
    dom.window.dispatchEvent(new dom.window.Event('pagehide'))
    dom.window.close()
  })
  const document = dom.window.document
  const element = (id: string): HTMLElement => {
    const result = document.getElementById(id)
    if (result === null) throw new Error(`Missing update element: ${id}`)
    return result
  }
  const run = (): void => { runInContext(readFileSync(new URL(`../renderer/${name}.js`, import.meta.url), 'utf8'), dom.getInternalVMContext()) }
  return { dom, document, element, run }
}

it('shows release notes as text in a scrollable, keyboard-reachable block and hides an empty one', async () => {
  const p = page('update-dialog')
  const locale = resolveDesktopLocale('zh-CN')
  const view: UpdateDialogView = { revision: 1, locale: locale.id, title: locale.messages.updateCheckTitle,
    message: locale.messages.updateAvailable.replace('{version}', '0.2.0'), detail: locale.messages.updateDetail,
    buttons: [locale.messages.updateDownload], cancelId: 1, closeLabel: locale.messages.updateClose,
    technicalDetails: '', technicalDetailsLabel: locale.messages.updateTechnicalDetails,
    releaseNotes: '0.2.0\n• <b>侧栏</b>账号入口', releaseNotesLabel: locale.messages.updateReleaseNotes }
  let publish!: (state: UpdateDialogView | null) => void
  const api: UpdateDialogApi = {
    status: async () => view, respond: vi.fn(async () => {}), subscribe: (listener) => { publish = listener; return () => {} },
  }
  Object.defineProperty(p.dom.window, 'dshUpdateDialog', { value: api })
  p.run()
  await expect.poll(() => p.element('dialog').hidden).toBe(false)
  expect(p.element('release-notes').hidden).toBe(false)
  expect(p.element('release-notes-label').textContent).toBe('更新内容')
  expect(p.element('release-notes-content').childElementCount).toBe(0)
  expect(p.element('release-notes-content').textContent).toBe(view.releaseNotes)
  expect(p.element('dialog').classList.contains('with-release-notes')).toBe(true)
  p.document.dispatchEvent(new p.dom.window.KeyboardEvent('keydown', { key: 'Tab', cancelable: true }))
  p.document.dispatchEvent(new p.dom.window.KeyboardEvent('keydown', { key: 'Tab', cancelable: true }))
  expect(p.document.activeElement?.id).toBe('release-notes-content')
  publish({ ...view, revision: 2, releaseNotes: '' })
  expect(p.element('release-notes').hidden).toBe(true)
  expect(p.element('dialog').classList.contains('with-release-notes')).toBe(false)
})

it.each(['en', 'zh-CN'])('keeps ordinary diagnostics folded, text-only, and keyboard-accessible: %s', async (language) => {
  const p = page('update-dialog')
  const locale = resolveDesktopLocale(language)
  const state: UpdateDialogView = { revision: 1, locale: locale.id, title: locale.messages.updateFailedTitle,
    message: locale.messages.updateStopFailed, detail: '', buttons: [locale.messages.updateAcknowledge], cancelId: 0,
    closeLabel: locale.messages.updateClose, technicalDetailsLabel: locale.messages.updateTechnicalDetails,
    technicalDetails: '<img src=x onerror="window.compromised=true">\nexit 0; shutdown acknowledged false',
    releaseNotes: '', releaseNotesLabel: locale.messages.updateReleaseNotes }
  const respond = vi.fn(async () => {})
  let publish!: (view: UpdateDialogView | null) => void
  const api: UpdateDialogApi = { status: async () => state, respond, subscribe: (listener) => { publish = listener; return () => {} } }
  Object.defineProperty(p.dom.window, 'dshUpdateDialog', { value: api })
  p.run()
  await expect.poll(() => p.element('dialog').hidden).toBe(false)
  const disclosure = p.element('technical-details') as HTMLDetailsElement
  expect(disclosure.hidden).toBe(false)
  expect(disclosure.open).toBe(false)
  expect(p.element('title').textContent).toBe(locale.messages.updateStopFailed)
  expect(p.element('detail').textContent).toBe('')
  expect(p.element('technical-details-content').childElementCount).toBe(0)
  expect(p.element('technical-details-content').textContent).toBe(state.technicalDetails)
  const tab = () => p.document.dispatchEvent(new p.dom.window.KeyboardEvent('keydown', { key: 'Tab', cancelable: true }))
  tab()
  expect(p.document.activeElement?.id).toBe('close')
  tab()
  expect(p.document.activeElement?.id).toBe('technical-details-label')
  p.element('technical-details-label').click()
  expect(disclosure.open).toBe(true)
  tab()
  expect(p.document.activeElement?.id).toBe('technical-details-content')
  p.element('technical-details-label').click()
  expect(disclosure.open).toBe(false)
  expect(respond).not.toHaveBeenCalled()
  p.document.dispatchEvent(new p.dom.window.KeyboardEvent('keydown', { key: 'Escape', cancelable: true }))
  expect(respond).toHaveBeenCalledWith(1, 0)
  const backdrop = p.document.body
  const dialog = p.element('dialog')
  dialog.scrollTop = 170
  publish({ ...state, revision: 2, message: locale.messages.updateChecking, technicalDetails: '', buttons: ['OK'] })
  expect(p.document.body).toBe(backdrop)
  expect(p.element('dialog')).toBe(dialog)
  expect(dialog.scrollTop).toBe(0)
  expect(backdrop.classList.contains('visible')).toBe(true)
  expect(p.element('actions').childElementCount).toBe(1)
  expect(disclosure.open).toBe(false)
  expect(p.document.activeElement).toBe(dialog)
  dialog.scrollTop = 80
  publish(state)
  expect(dialog.scrollTop).toBe(80)
  expect(p.element('title').textContent).toBe(locale.messages.updateChecking)
  publish(null)
  expect(backdrop.classList.contains('visible')).toBe(false)
})
