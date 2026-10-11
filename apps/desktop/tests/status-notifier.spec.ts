import { afterEach, expect, it, vi } from 'vitest'
import { statusNotifierHostRegistered } from '../src/status-notifier.ts'

const bus = vi.hoisted(() => ({
  answers: new Map<string, string | Error>(),
  calls: [] as string[],
}))

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  const { promisify } = await import('node:util')
  const invoke = async (file: string, args: string[]) => {
    const call = [file, ...args].join(' ')
    bus.calls.push(call)
    const answer = bus.answers.get(call) ?? Object.assign(new Error(`spawn ${file} ENOENT`), { code: 'ENOENT' })
    if (answer instanceof Error) throw answer
    return { stdout: answer, stderr: '' }
  }
  return { ...actual, execFile: Object.assign(vi.fn(), { [promisify.custom]: invoke }) }
})

const GDBUS_OWNER = 'gdbus call --session --dest org.freedesktop.DBus --object-path /org/freedesktop/DBus'
  + ' --method org.freedesktop.DBus.NameHasOwner org.kde.StatusNotifierWatcher'
const GDBUS_HOST = 'gdbus call --session --dest org.kde.StatusNotifierWatcher --object-path /StatusNotifierWatcher'
  + ' --method org.freedesktop.DBus.Properties.Get org.kde.StatusNotifierWatcher IsStatusNotifierHostRegistered'
const BUSCTL_OWNER = 'busctl --user call org.freedesktop.DBus /org/freedesktop/DBus org.freedesktop.DBus'
  + ' NameHasOwner s org.kde.StatusNotifierWatcher'
const BUSCTL_HOST = 'busctl --user get-property org.kde.StatusNotifierWatcher /StatusNotifierWatcher'
  + ' org.kde.StatusNotifierWatcher IsStatusNotifierHostRegistered'

afterEach(() => { bus.answers.clear(); bus.calls.length = 0; vi.restoreAllMocks() })

it('reports a registered host when the watcher is owned and says so', async () => {
  bus.answers.set(GDBUS_OWNER, '(true,)\n').set(GDBUS_HOST, '(<true>,)\n')
  await expect(statusNotifierHostRegistered()).resolves.toBe(true)
  expect(bus.calls).toEqual([GDBUS_OWNER, GDBUS_HOST])
})

it('reports no host without asking a watcher that has no owner', async () => {
  bus.answers.set(GDBUS_OWNER, '(false,)\n')
  await expect(statusNotifierHostRegistered()).resolves.toBe(false)
  expect(bus.calls).toEqual([GDBUS_OWNER])
})

it('reports no host when the owned watcher has none registered', async () => {
  bus.answers.set(GDBUS_OWNER, '(true,)\n').set(GDBUS_HOST, '(<false>,)\n')
  await expect(statusNotifierHostRegistered()).resolves.toBe(false)
})

it('reports no host when the owned watcher cannot answer, without asking another client', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  bus.answers.set(GDBUS_OWNER, '(true,)\n').set(GDBUS_HOST, new Error('GDBus.Error:org.freedesktop.DBus.Error.UnknownProperty'))
  await expect(statusNotifierHostRegistered()).resolves.toBe(false)
  expect(bus.calls).toEqual([GDBUS_OWNER, GDBUS_HOST])
  expect(warn).toHaveBeenCalledOnce()
})

it('asks busctl when gdbus cannot query the bus', async () => {
  bus.answers.set(BUSCTL_OWNER, 'b true\n').set(BUSCTL_HOST, 'b true\n')
  await expect(statusNotifierHostRegistered()).resolves.toBe(true)
  expect(bus.calls).toEqual([GDBUS_OWNER, BUSCTL_OWNER, BUSCTL_HOST])
})

it('reports no host and warns once when no client can query the bus', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  await expect(statusNotifierHostRegistered()).resolves.toBe(false)
  expect(bus.calls).toEqual([GDBUS_OWNER, BUSCTL_OWNER])
  expect(warn).toHaveBeenCalledOnce()
})
