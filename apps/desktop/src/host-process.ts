/** Electron Node-mode child lifecycle for the shared Web application. */

import { spawn, type ChildProcess } from 'node:child_process'
import { DesktopParentAuthentication } from './parent-authentication.ts'
import { join } from 'node:path'
import { z } from 'zod'
import type { HalluCodexCapacityRequest, HalluCodexHostConfiguration } from '@deepseek-ai/dsh-desktop-host/hallucodex'
import { parseModelCapacityOverride, type ModelCapacityOverride } from './hallucodex/model-capacity.ts'
import { desktopNodeEnvironment } from './node-environment.ts'
import { parsePluginOperationRecord, type PluginOperationRecord, type PluginOperationRunId } from '@deepseek-ai/dsh-plugin-manager/diagnostic'

interface ReadyEvent {
  readonly type: 'ready'
  readonly url: string
  readonly injections?: readonly unknown[] | undefined
}

interface FatalEvent {
  readonly type: 'fatal'
  readonly message: string
  /** The Host's complete inspected error: stack, enumerable properties, cause chain. */
  readonly diagnostic?: string
}

type DesktopHostEvent = { readonly type: 'hallucodex-ready' } | ReadyEvent | FatalEvent | {
  readonly type: 'starting'
  readonly runId: PluginOperationRunId
} | { readonly type: 'shutdown-complete' } | {
  readonly type: 'file-drag-resource'
  readonly requestId: number
  readonly resource: { readonly path: string; readonly sha256: string; readonly size: number } | null
  readonly error?: string
} | {
  readonly type: 'update-tasks'
  readonly requestId: number
  readonly active: boolean
  readonly error?: string
} | {
  readonly type: 'quit-inspection'
  readonly requestId: number
  readonly activeTasks: boolean
  readonly scheduledTasks: boolean
  readonly error?: string
} | HalluCodexCapacityRequest

/** Correlated answer to one shell control request. */
type DesktopHostControlResponse = Extract<DesktopHostEvent, { readonly requestId: number }>

/** What quitting now would affect, as reported by the Host. */
export interface DesktopQuitInspection {
  readonly activeTasks: boolean
  readonly scheduledTasks: boolean
}

/** Quit inspection deadline; a slower Host counts as unknown work and the shell asks before quitting. */
export const QUIT_INSPECTION_DEADLINE_MS = 2_000

const MAX_HOST_DIAGNOSTIC_CHARS = 64 * 1024
const runIdSchema = z.uuid()

function isOwnedHostUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:')
      && url.hostname === '127.0.0.1' && url.username === '' && url.password === ''
      && url.pathname === '/' && url.search === '' && url.hash === ''
  } catch (_invalidUrl) {
    return false
  }
}

const isCount = (value: unknown): boolean => value === null || typeof value === 'number'

function isDesktopHostEvent(message: unknown): message is DesktopHostEvent {
  if (typeof message !== 'object' || message === null || !('type' in message)) return false
  const candidate = message as Record<string, unknown>
  switch (candidate.type) {
    case 'starting':
      return runIdSchema.safeParse(candidate.runId).success
    case 'hallucodex-ready':
    case 'shutdown-complete':
      return true
    case 'hallucodex-set-capacity':
      return Number.isSafeInteger(candidate.requestId) && typeof candidate.model === 'string'
        && isCount(candidate.contextWindow) && isCount(candidate.maxOutputTokens)
    case 'ready':
      return isOwnedHostUrl(candidate.url)
    case 'fatal':
      return typeof candidate.message === 'string' && (candidate.diagnostic === undefined || typeof candidate.diagnostic === 'string')
    case 'update-tasks':
      return Number.isSafeInteger(candidate.requestId) && typeof candidate.active === 'boolean'
        && (candidate.error === undefined || typeof candidate.error === 'string')
    case 'file-drag-resource': {
      const resource = candidate.resource
      return Number.isSafeInteger(candidate.requestId) && (candidate.error === undefined || typeof candidate.error === 'string')
        && (resource === null || (typeof resource === 'object' && 'path' in resource && typeof resource.path === 'string'
          && 'sha256' in resource && typeof resource.sha256 === 'string' && /^[a-f0-9]{64}$/u.test(resource.sha256)
          && 'size' in resource && typeof resource.size === 'number' && Number.isSafeInteger(resource.size) && resource.size >= 0))
    }
    case 'quit-inspection':
      return Number.isSafeInteger(candidate.requestId) && typeof candidate.activeTasks === 'boolean'
        && typeof candidate.scheduledTasks === 'boolean' && (candidate.error === undefined || typeof candidate.error === 'string')
    default:
      return false
  }
}

async function exitsWithin(exit: Promise<void>, milliseconds: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => { resolve(false) }, milliseconds)
    timer.unref()
  })
  try {
    return await Promise.race([exit.then(() => true), timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** Host readiness plus the parent-owned credential used only by the main process. */
export interface DesktopHostReady {
  readonly url: string
  readonly injections?: readonly unknown[] | undefined
  /** Cookie header for the owned Host; synthesized locally and never received from the renderer. */
  readonly authenticationCookie: string
}

/** The child has exited, but task teardown did not finish successfully. */
export class DesktopHostUncleanExitError extends Error {}

/**
 * A Host failure reported over IPC before the process exited. `message` is what
 * the Host chose to show; `diagnostic` is its complete inspected error, kept
 * separately so a crash report can print it verbatim instead of a string escaped
 * inside another error's properties.
 */
export class DesktopHostFatalError extends Error {
  readonly #diagnostic: string | undefined

  /**
   * @param message - The Host's failure message.
   * @param diagnostic - The Host's inspected error, when the Host supplied one.
   */
  constructor(message: string, diagnostic: string | undefined) {
    super(message)
    this.#diagnostic = diagnostic
  }

  /** The Host's inspected error; a getter so `util.inspect` of this error does not repeat it as an escaped property. */
  get diagnostic(): string | undefined { return this.#diagnostic }
}

/** One Web backend running under the Electron executable in Node mode. */
export class DesktopHostProcess {
  readonly #authentication = new DesktopParentAuthentication()
  private runId: PluginOperationRunId | undefined
  private child: ChildProcess | undefined
  private readyResolve!: (ready: DesktopHostReady) => void
  private readyReject!: (error: Error) => void
  private readonly readyPromise = new Promise<DesktopHostReady>((resolve, reject) => {
    this.readyResolve = resolve
    this.readyReject = reject
  })
  private exitPromise: Promise<void> | undefined
  private stderr = ''
  private failureReported = false
  private stopping = false
  private shutdownCompleted = false
  private nativeConfigurationReady = false
  private nextControlId = 1
  private readonly controlRequests = new Map<number, {
    resolve: (response: DesktopHostControlResponse) => void
    reject: (error: Error) => void
  }>()

  /**
   * @param node - Absolute Electron executable in Node mode.
   * @param runtimeDir - Immutable packages carried by the current application.
   * @param projectDir - Desktop plugin profile and child working directory.
   * @param inspectPort - Optional loopback inspector port for workspace development.
   * @param environment - Environment inherited by the Host and its plugin subprocesses.
   * @param onFailure - Receives the first unexpected child failure, including after readiness.
   * @param primaryRuntime - Optional bundled dependency payload; the Host exposes it to its profile as `DSH_PRIMARY_RUNTIME`.
   * @param packageManager - Bundled pnpm entry and Node launcher directory, scoped to package operations.
   * @param nativeConfiguration - Initial HalluCodex configuration delivered when the Host requests it.
   * @param saveHalluCodexCapacity - Saves the user's capacities of one model and publishes the configuration that applies
   *   them; the Host receives the answer after that configuration. Without it every request is refused.
   * @param onPluginOperation - Optional diagnostic sink; malformed records are ignored without failing the Host.
   */
  constructor(
    private readonly node: string,
    private readonly runtimeDir: string,
    private readonly projectDir: string,
    private readonly inspectPort?: number,
    private readonly environment: NodeJS.ProcessEnv = process.env,
    private readonly onFailure?: (error: Error) => void,
    private readonly primaryRuntime?: string,
    private readonly packageManager?: { readonly pnpm: string; readonly nodeBin: string },
    private nativeConfiguration?: HalluCodexHostConfiguration,
    private readonly saveHalluCodexCapacity?: (model: string, capacity: ModelCapacityOverride) => Promise<void>,
    private readonly onPluginOperation?: (record: PluginOperationRecord) => void,
  ) {}

  /**
   * Start this child once and await its Web application URL.
   * @returns Ready facts supplied by the child after application startup.
   */
  async start(): Promise<DesktopHostReady> {
    if (this.child !== undefined) return this.readyPromise
    const entry = join(this.runtimeDir, 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'index.js')
    const child = spawn(this.node, [
      '--expose-internals',
      ...(this.inspectPort === undefined ? [] : [`--inspect=127.0.0.1:${String(this.inspectPort)}`]),
      entry,
      this.runtimeDir,
      this.projectDir,
      // Empty asks the Host for the payload beside its runtime directory, so that layout has one owner.
      this.primaryRuntime ?? '',
      ...this.packageManager === undefined ? [] : [this.packageManager.pnpm, this.packageManager.nodeBin],
    ], {
      cwd: this.projectDir,
      env: desktopNodeEnvironment(this.node, undefined, this.environment),
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })
    this.child = child
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => { this.stderr = (this.stderr + chunk).slice(-MAX_HOST_DIAGNOSTIC_CHARS) })
    child.stdout?.pipe(process.stdout)
    child.on('message', (message: unknown) => {
      if (typeof message === 'object' && message !== null && 'type' in message && message.type === 'plugin-operation') {
        const record = 'record' in message ? parsePluginOperationRecord(message.record) : undefined
        if (record !== undefined && record.runId === this.runId) {
          try { this.onPluginOperation?.(record) }
          catch (_error) {
            // Diagnostic persistence cannot invalidate the Host's business IPC channel.
            console.error('desktop plugin operation diagnostic sink failed')
          }
        }
        return
      }
      if (!isDesktopHostEvent(message)) {
        this.fail(new Error('dsh desktop host sent an invalid IPC event'))
        child.kill('SIGTERM')
        return
      }
      if (message.type === 'starting') {
        if (this.runId === undefined && !this.failureReported && !this.stopping) {
          this.runId = message.runId
          void this.#authentication.deliver(child).catch((error: unknown) => {
            this.fail(error instanceof Error ? error : new Error(String(error)))
            child.kill('SIGTERM')
          })
        }
      }
      else if (message.type === 'hallucodex-ready') {
        if (!this.nativeConfiguration) { this.fail(new Error('hallucodex Host: unexpected configuration request')); child.kill('SIGTERM'); return }
        this.nativeConfigurationReady = true
        this.publishHalluCodex(this.nativeConfiguration)
      }
      else if (message.type === 'hallucodex-set-capacity') this.setHalluCodexCapacity(child, message)
      else if (message.type === 'ready') {
        void this.#authentication.readyCookie().then((authenticationCookie) => {
          if (this.failureReported || this.stopping) return
          this.readyResolve({ url: message.url, injections: message.injections, authenticationCookie })
        }, (error: unknown) => {
          this.fail(error instanceof Error ? error : new Error(String(error)))
          child.kill('SIGTERM')
        })
      }
      else if (message.type === 'shutdown-complete') {
        if (this.stopping) this.shutdownCompleted = true
        else this.fail(new Error('dsh desktop host acknowledged an unrequested shutdown'))
      }
      else if (message.type === 'fatal') this.fail(new DesktopHostFatalError(message.message, message.diagnostic))
      else {
        const request = this.controlRequests.get(message.requestId)
        if (message.error === undefined) request?.resolve(message)
        else request?.reject(new Error(message.error))
      }
    })
    child.once('error', (error) => { this.fail(error) })
    this.exitPromise = new Promise<void>((resolve) => {
      child.once('close', (code) => {
        const suffix = this.stderr.trim() === '' ? '' : `: ${this.stderr.trim()}`
        if (code !== 0 && code !== null) this.fail(new Error(`dsh desktop host exited with ${String(code)}${suffix}`))
        else this.fail(new Error(`dsh desktop host stopped${suffix}`))
        resolve()
      })
    })
    return this.readyPromise
  }

  /**
   * Publish account-scoped model metadata and the private local relay capability over Node IPC only.
   * @param configuration - native configuration; no upstream account credential is accepted.
   */
  publishHalluCodex(configuration: HalluCodexHostConfiguration): void {
    this.nativeConfiguration = configuration
    if (this.nativeConfigurationReady && this.child?.connected && !this.stopping) {
      this.child.send(configuration, (error) => { if (error !== null) this.fail(new Error('hallucodex Host: configuration delivery failed')) })
    }
  }

  private setHalluCodexCapacity(child: ChildProcess, request: HalluCodexCapacityRequest): void {
    const answer = (error?: string) => {
      if (!child.connected) return
      child.send({ type: 'hallucodex-set-capacity', requestId: request.requestId, ...error === undefined ? {} : { error } }, (sendError) => {
        if (sendError !== null) console.error(sendError)
      })
    }
    void (async () => {
      if (this.saveHalluCodexCapacity === undefined) throw new Error('hallucodex: model capacities are unavailable')
      const capacity = parseModelCapacityOverride({ contextWindow: request.contextWindow, maxOutputTokens: request.maxOutputTokens })
      await this.saveHalluCodexCapacity(request.model, capacity)
    })().then(() => { answer() }, (error: unknown) => { answer(error instanceof Error ? error.message : String(error)) })
  }

  /**
   * Inspect active work or lock request admission for update handoff.
   * @param action - Read-only inspection, admission lock, or recovery unlock.
   * @returns Whether live tasks would be affected. Locking drains admitted API requests before inspecting tasks;
   * an unanswered drain fails at the control-request deadline without authorizing installation.
   */
  async updateTasks(action: 'inspect' | 'lock' | 'unlock'): Promise<boolean> {
    const response = await this.control({ type: 'update-tasks', action }, 10_000, 'desktop update: task inspection timed out', 'desktop update')
    if (response.type !== 'update-tasks') throw new Error('desktop update: Host answered with a different control response')
    return response.active
  }

  /**
   * Ask the Host what quitting now would interrupt.
   * @returns Active tasks and armed scheduled reminders; rejects when the Host is unavailable or misses
   * {@link QUIT_INSPECTION_DEADLINE_MS}, and the shell then asks before quitting.
   */
  async inspectQuit(): Promise<DesktopQuitInspection> {
    const response = await this.control({ type: 'quit-inspection' }, QUIT_INSPECTION_DEADLINE_MS, 'desktop quit: inspection timed out', 'desktop quit')
    if (response.type !== 'quit-inspection') throw new Error('desktop quit: Host answered with a different control response')
    return { activeTasks: response.activeTasks, scheduledTasks: response.scheduledTasks }
  }

  /**
   * @param address - Session-scoped file reference.
   * @param signal - preparation cancellation.
   * @returns privately authorized local resource, or null when nonlocal.
   */
  async resolveDragResource(address: string, signal?: AbortSignal): Promise<
    { readonly path: string; readonly sha256: string; readonly size: number } | null
  > {
    const response = await this.control({ type: 'file-drag-resource', address }, 12_000, 'File drag authorization timed out', 'file drag', signal)
    if (response.type !== 'file-drag-resource') throw new Error('Host returned a different control response')
    return response.resource
  }

  private async control(
    request: { readonly type: 'update-tasks'; readonly action: 'inspect' | 'lock' | 'unlock' } | { readonly type: 'quit-inspection' }
      | { readonly type: 'file-drag-resource'; readonly address: string },
    deadlineMs: number, deadlineMessage: string, operation: string, signal?: AbortSignal,
  ): Promise<DesktopHostControlResponse> {
    const child = this.child
    if (child === undefined || !child.connected || this.failureReported || this.stopping) {
      throw new Error(`${operation}: Host is unavailable`)
    }
    signal?.throwIfAborted()
    const requestId = this.nextControlId++
    let timer: ReturnType<typeof setTimeout> | undefined
    const abort = (): void => {
      if (request.type === 'file-drag-resource' && child.connected) child.send({ type: 'file-drag-cancel', requestId }, (_error) => {
        // The request still rejects locally if the Host has disconnected.
      })
      const reason: unknown = signal?.reason
      this.controlRequests.get(requestId)?.reject(reason instanceof Error ? reason : new Error(deadlineMessage))
    }
    try {
      return await new Promise<DesktopHostControlResponse>((resolve, reject) => {
        this.controlRequests.set(requestId, { resolve, reject })
        timer = setTimeout(abort, deadlineMs)
        signal?.addEventListener('abort', abort, { once: true })
        child.send({ ...request, requestId }, (error) => { if (error !== null) reject(error) })
      })
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      this.controlRequests.delete(requestId)
    }
  }

  /**
   * Request teardown and await child exit, escalating termination when needed.
   * @param requireGraceful - Reject update handoff after forced termination or unsuccessful child exit.
   * @returns Completion of owned process teardown. DesktopHostUncleanExitError confirms exit but refuses installation;
   * other failures do not confirm exit.
   */
  async stop(requireGraceful = false): Promise<void> {
    const child = this.child
    if (child === undefined) return
    this.stopping = true
    if (child.connected) child.send({ type: 'shutdown' }, (error) => { if (error !== null) this.fail(error) })
    const exited = this.exitPromise ?? Promise.resolve()
    const graceful = await exitsWithin(exited, 10_000)
    if (!graceful) child.kill('SIGTERM')
    if (!await exitsWithin(exited, 5_000)) {
      child.kill('SIGKILL')
      if (!await exitsWithin(exited, 5_000)) {
        throw new Error('dsh desktop host did not exit after SIGKILL')
      }
    }
    this.child = undefined
    if (requireGraceful && (!graceful || child.exitCode !== 0 || !this.shutdownCompleted)) {
      // This diagnostic reaches expandable UI; arbitrary plugin stderr can contain credentials.
      throw new DesktopHostUncleanExitError(`desktop update: Host did not complete graceful task teardown (exit ${String(child.exitCode)}, signal ${String(child.signalCode)}, shutdown acknowledged ${String(this.shutdownCompleted)}, graceful deadline exceeded ${String(!graceful)})`)
    }
  }

  private fail(error: Error): void {
    if (this.runId !== undefined) Object.assign(error, { hostRunId: this.runId })
    this.readyReject(error)
    for (const request of this.controlRequests.values()) request.reject(error)
    this.controlRequests.clear()
    if (!this.failureReported && !this.stopping) {
      this.failureReported = true
      try { this.onFailure?.(error) } catch (listenerError) {
        console.error('desktop host failure listener failed', listenerError)
      }
    }
  }
}
