import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

function evaluateRunsOn(selector: unknown, context: Record<string, unknown>): unknown {
  if (typeof selector !== 'string') throw new TypeError('Runner selector must be a string')
  return runInNewContext(selector.trim().slice(3, -2), context, { timeout: 1000 })
}

const root = resolve(import.meta.dirname, '..')
const runnerPrivatePnpmDestination = /^\$\{\{ runner\.temp \}\}\/setup-pnpm-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}$/
const nativeWindowsPnpmDestination = '${{ runner.temp }}/setup-pnpm-js-${{ github.run_id }}-${{ github.run_attempt }}-${{ github.job }}'

describe('CI workflow', () => {
  it('keeps at most sixteen worker jobs active across PR workflows', () => {
    const ci = loadWorkflow('.github/workflows/ci.yml')
    const ciWindows = loadWorkflow('.github/workflows/ci-windows.yml')
    const compatibility = workflowJob(ci, 'node-compat')
    if (!isRecord(ci.jobs)
      || !isRecord(ciWindows.jobs)
      || !isRecord(compatibility.strategy)) {
      throw new TypeError('CI and CI Windows must define jobs and compatibility scheduling')
    }
    const compatibilityLimit = compatibility.strategy['max-parallel']
    if (typeof compatibilityLimit !== 'number') {
      throw new TypeError('CI requires a numeric compatibility limit')
    }
    expect(Number.isInteger(compatibilityLimit)).toBe(true)
    expect(compatibilityLimit).toBeGreaterThan(0)
    expect(compatibility.strategy).toMatchObject({
      'fail-fast': false,
      matrix: { include: [{ node: '24.22.3' }, { node: 26 }] },
    })
    expect(workflowJob(ci, 'all-checks-passed').needs).toContain('node-compat')
    // The web snapshot shards are the only other matrix: one job, one runner per shard.
    const webSnapshot = workflowJob(ci, 'node-24-web-snapshot')
    expect(webSnapshot.strategy).toEqual({ 'fail-fast': false, matrix: { shard: [1, 2] } })
    const webSnapshotShards = isRecord(webSnapshot.strategy) && isRecord(webSnapshot.strategy.matrix)
      && Array.isArray(webSnapshot.strategy.matrix.shard) ? webSnapshot.strategy.matrix.shard.length : 0
    // Coverage runs two instrumented file shards as one matrix; its report job
    // starts only after both finish.
    const coverage = workflowJob(ci, 'node-24-coverage')
    expect(coverage.strategy).toEqual({ 'fail-fast': false, matrix: { shard: [1, 2] } })
    expect(coverage.name).toBe('node 24 / coverage ${{ matrix.shard }}/2')
    const coverageLanes = isRecord(coverage.strategy) && isRecord(coverage.strategy.matrix)
      && Array.isArray(coverage.strategy.matrix.shard) ? coverage.strategy.matrix.shard.length : 0
    expect(coverageLanes).toBe(2)
    expect(workflowJob(ci, 'node-24-coverage-report').needs).toBe('node-24-coverage')
    // The merge is CPU- and heap-bound; it runs on 8-vCPU Blacksmith or hosted Ubuntu in this fork.
    const reportRunner = String(workflowJob(ci, 'node-24-coverage-report')['runs-on'])
    expect(reportRunner).toContain("'blacksmith-8vcpu-ubuntu-2404'")
    expect(reportRunner).toContain("'ubuntu-24.04'")
    // The two benchmark phases run as one matrix; their report job renders after them.
    const bench = workflowJob(ci, 'node-24-bench')
    expect(bench.strategy).toEqual({
      'fail-fast': false,
      matrix: { include: [{ shard: 1, phase: 'first' }, { shard: 2, phase: 'last' }] },
    })
    const benchPhases = isRecord(bench.strategy) && isRecord(bench.strategy.matrix)
      && Array.isArray(bench.strategy.matrix.include) ? bench.strategy.matrix.include.length : 0
    expect(workflowJob(ci, 'node-24-bench-report').needs).toBe('node-24-bench')
    const ordinaryJobs = Object.entries(ci.jobs)
      .filter(([name]) => !['node-compat', 'all-checks-passed', 'node-24-web-snapshot', 'node-24-coverage', 'node-24-coverage-report', 'node-24-bench', 'node-24-bench-report'].includes(name))
    for (const [name, job] of ordinaryJobs) {
      if (!isRecord(job)) throw new TypeError(`${name} must define a job`)
      expect(job).not.toHaveProperty('strategy')
      expect(job).not.toHaveProperty('uses')
    }
    expect(ordinaryJobs.map(([name]) => name)).toContain('python-sdk')
    expect(Object.keys(ciWindows.jobs)).not.toContain('python-runtime')
    const windowsJobs = Object.entries(ciWindows.jobs)
      .filter(([name]) => !['windows-checks-passed'].includes(name))
    for (const [name, job] of windowsJobs) {
      if (!isRecord(job)) throw new TypeError(`${name} must define a job`)
      expect(job).not.toHaveProperty('strategy')
      expect(job).not.toHaveProperty('uses')
    }
    const linuxActive = ordinaryJobs.length + webSnapshotShards + coverageLanes + benchPhases
    expect(linuxActive + compatibilityLimit + windowsJobs.length).toBeLessThanOrEqual(16)
  })

  it('orders the manually dispatched Python runtime builder after its plan and SDK wheel', () => {
    const builder = loadWorkflow('.github/workflows/build-exe-for-python-sdk.yml')
    if (!isRecord(builder.jobs)) throw new TypeError('Python runtime builder must define jobs')
    expect(Object.keys(builder.jobs).sort()).toEqual(['build', 'plan', 'sdk-wheel'])
    const plan = workflowJob(builder, 'plan')
    const wheel = workflowJob(builder, 'sdk-wheel')
    const build = workflowJob(builder, 'build')
    expect(plan.needs).toBeUndefined()
    expect(plan.strategy).toBeUndefined()
    expect(plan.uses).toBeUndefined()
    expect(wheel.needs).toBe('plan')
    expect(wheel.strategy).toBeUndefined()
    expect(wheel.uses).toBeUndefined()
    expect(build.needs).toEqual(['plan', 'sdk-wheel'])
    expect(build.uses).toBeUndefined()
    if (!isRecord(build.strategy)) throw new TypeError('Python runtime build must define its target matrix')
    expect(build.strategy.matrix).toEqual({ include: '${{ fromJSON(needs.plan.outputs.matrix) }}' })
  })

  it('keeps required PR verdicts covering Linux and Windows jobs', () => {
    const verdicts = [
      ['ci.yml', 'all-checks-passed'],
      ['ci-windows.yml', 'windows-checks-passed'],
    ] as const
    const blocking: string[] = []
    for (const [file, name] of verdicts) {
      const workflow = loadWorkflow('.github/workflows/' + file)
      const verdict = workflowJob(workflow, name)
      if (!isRecord(workflow.jobs) || !Array.isArray(verdict.needs)) {
        throw new TypeError(`${file} must define jobs and the ${name} verdict needs`)
      }
      const jobs = workflow.jobs
      expect(verdict.needs.every(id => typeof id === 'string' && id in jobs)).toBe(true)
      blocking.push(...(verdict.needs as string[]))
    }
    // A job the verdict does not list must be needed by one it lists: a failed
    // coverage shard skips its report job, and the verdict fails on a skip.
    const ci = loadWorkflow('.github/workflows/ci.yml')
    if (!isRecord(ci.jobs)) throw new TypeError('ci.yml must define jobs')
    const covered = new Set<string>()
    const visit = (id: string): void => {
      if (covered.has(id)) return
      covered.add(id)
      const needs = workflowJob(ci, id).needs
      for (const need of Array.isArray(needs) ? needs : typeof needs === 'string' ? [needs] : []) {
        if (typeof need === 'string') visit(need)
      }
    }
    for (const id of workflowJob(ci, 'all-checks-passed').needs as string[]) visit(id)
    // The benchmark report only renders results; node-24-bench owns the verdict.
    const bookkeeping = ['all-checks-passed', 'node-24-bench-report']
    expect(Object.keys(ci.jobs).filter(id => !bookkeeping.includes(id) && !covered.has(id))).toEqual([])
    expect(blocking).not.toContain('node-24-bench-report')
    expect(blocking).not.toContain('node-24-coverage')
    // Every blocking lane must contribute to a branch-protection verdict.
    expect(blocking.sort()).toEqual([
      'node-24',
      'node-24-bench',
      'node-24-build',
      'node-24-consumers',
      'node-24-coverage-report',
      'node-24-lint',
      'node-24-web-snapshot',
      'node-compat',
      'python-sdk',
      'windows-build',
      'windows-native-tests',
    ])
  })

  it('retains aggregate diagnostics in required builds', () => {
    for (const [file, name, command] of [
      ['ci.yml', 'node-24-build', 'pnpm run check:ci:build'],
      ['ci.yml', 'node-24-consumers', 'pnpm run check:ci:consumers-prebuilt'],
      ['ci.yml', 'node-24-web-snapshot', 'pnpm run check:ci:web-snapshot-prebuilt'],
      ['ci-windows.yml', 'windows-build', 'pnpm run check:ci:windows-blocking'],
    ] as const) {
      const job = workflowJob(loadWorkflow('.github/workflows/' + file), name)
      expect(job.steps).toContainEqual(expect.objectContaining({ run: command }))
    }
    const scripts = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
    const hostSteps = scripts.scripts['build:lib:host']!.split(' && ')
    expect(hostSteps[0]).toBe('tsx scripts/compile-referenced-projects.ts host-libraries')
    expect(hostSteps).toContain('node --max-old-space-size=8192 ./node_modules/typescript/bin/tsc -p tsconfig.host.json')
    expect(hostSteps.at(-1)).toBe('pnpm --filter @deepseek-ai/dsh-desktop run bundle')
    expect(scripts.scripts['build:lib:client']).toContain('tsc -b tsconfig.client.json')
    expect(scripts.scripts.typecheck).toBe('tsx scripts/build.ts --scope typecheck')
  })

  it('node-24-web-snapshot installs browsers over HTTPS archives while the build output downloads', () => {
    const jobName = 'node-24-web-snapshot'
    const job = workflowJob(loadWorkflow('.github/workflows/ci.yml'), jobName)
    if (!Array.isArray(job.steps)) throw new TypeError(`${jobName} must define steps`)
    const names = job.steps.map(step => isRecord(step) ? step.name : undefined)
    const order = ['Install dependencies and prepare bubblewrap', 'Use HTTPS for Ubuntu archives',
      'Start Playwright browser install', 'Download build output', 'Unpack build output',
      'Wait for Playwright browsers', 'Run web browser snapshot shard'].map(name => names.indexOf(name))
    expect(order).not.toContain(-1)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(isRecord(job.env) && 'DSH_CI_PLAYWRIGHT_INSTALL' in job.env).toBe(false)
    const start: unknown = job.steps.find(step => isRecord(step) && step.name === 'Start Playwright browser install')
    if (!isRecord(start) || !isRecord(start.env)) throw new TypeError('the Playwright install step must define env')
    expect(String(start.env.PLAYWRIGHT_INSTALL_MODE)).toContain("&& 'browsers' || 'with-deps'")
    expect(String(start.run)).toContain('exec playwright install "${deps[@]}" chromium webkit')
  })

  it('writes the web snapshot shard shares once for every shard', () => {
    const job = workflowJob(loadWorkflow('.github/workflows/ci.yml'), 'node-24-web-snapshot')
    expect(job.name).toBe('node 24 / web snapshots ${{ matrix.shard }}/2')
    expect(job.env).toMatchObject({ DSH_WEB_SNAPSHOT_SHARD: '${{ matrix.shard }}/2', DSH_WEB_SNAPSHOT_SHARD_SHARES: '0.54,0.46' })
  })

  it('builds the Linux Office runtime beside the consumer gates and fails on its status', () => {
    const job = workflowJob(loadWorkflow('.github/workflows/ci.yml'), 'node-24-consumers')
    if (!Array.isArray(job.steps)) throw new TypeError('node-24-consumers must define steps')
    const names = job.steps.map(step => isRecord(step) ? step.name : undefined)
    expect(names.slice(-3)).toEqual(['Start the Linux Office runtime build', 'Run compatibility, snapshot, and artifact gates', 'Wait for the Linux Office runtime'])
    expect(job.steps.at(-1)).toMatchObject({ if: "${{ !cancelled() && steps.office-runtime.outcome == 'success' }}" })
    const start: unknown = job.steps.at(-3)
    if (!isRecord(start)) throw new TypeError('the Office runtime step must be a mapping')
    expect(start.id).toBe('office-runtime')
    expect(String(start.run)).toContain('pnpm run prepare:primary-runtime --target linux-x64')
  })

  it('selects artifact builds only for PR release and API rehearsals', () => {
    const official = "${{ github.event_name == 'pull_request' && 'pnpm run build:artifacts --profile official' || 'pnpm run build:official' }}"
    const vendor = "${{ github.event_name == 'pull_request' && 'pnpm exec tsx scripts/compile-referenced-projects.ts host-libraries' || 'pnpm run build:lib:host' }}"
    for (const [file, jobName, expected] of [
      ['release.yml', 'pack', official],
      ['release-vendor.yml', 'pack', vendor],
      ['e2e.yml', 'e2e', official],
    ] as const) {
      const job = workflowJob(loadWorkflow('.github/workflows/' + file), jobName)
      if (!Array.isArray(job.steps)) throw new TypeError(`${jobName} must define steps`)
      const step = job.steps.filter(isRecord).find(candidate => typeof candidate.run === 'string'
        && (candidate.run.includes('build:artifacts') || candidate.run.includes('host-libraries')))
      expect(step?.run).toBe(expected)
      for (const event of ['pull_request', 'push', 'workflow_dispatch']) {
        const expression = expected.slice('${{ '.length, -' }}'.length)
        const selected: unknown = runInNewContext(expression, { github: { event_name: event } }, { timeout: 1000 })
        expect(selected).toBe(event === 'pull_request'
          ? file === 'release-vendor.yml'
            ? 'pnpm exec tsx scripts/compile-referenced-projects.ts host-libraries'
            : 'pnpm run build:artifacts --profile official'
          : file === 'release-vendor.yml' ? 'pnpm run build:lib:host' : 'pnpm run build:official')
      }
    }
  })

  it('selects PR artifact compilation inside the Python executable builder', () => {
    const job = workflowJob(loadWorkflow('.github/workflows/build-exe-for-python-sdk.yml'), 'build')
    if (!Array.isArray(job.steps)) throw new TypeError('Python runtime builder must define steps')
    const steps = job.steps.filter(isRecord)
    const execute = steps.find(step => step.name === 'Build single-exe')
    expect(steps.some(step => step.run === 'pnpm run build:artifacts')).toBe(false)
    expect(execute).toMatchObject({
      env: { DSH_BUILD_CLIENT_PROFILE: 'official' },
    })
    if (typeof execute?.run !== 'string') throw new TypeError('Python executable builder must define a command')
    const expression = [...execute.run.matchAll(/\$\{\{ ([^{}]+) \}\}/g)]
      .map(match => match[1]).find(value => value?.startsWith('inputs.ci'))
    expect(expression).toBe("inputs.ci && github.event_name == 'pull_request' && '--build-artifacts' || ''")
    if (expression === undefined) throw new TypeError('Python executable builder must select its build mode')
    for (const ci of [false, true]) {
      for (const event of ['pull_request', 'push', 'workflow_dispatch']) {
        const context = { inputs: { ci }, github: { event_name: event } }
        const selected: unknown = runInNewContext(expression, context, { timeout: 1000 })
        expect(selected).toBe(ci && event === 'pull_request' ? '--build-artifacts' : '')
      }
    }
  })

  it('prepares confinement before Node compatibility smokes', () => {
    const job = workflowJob(loadWorkflow('.github/workflows/ci.yml'), 'node-compat')
    if (!Array.isArray(job.steps)) throw new TypeError('Node compatibility job must define steps')
    const steps = job.steps.filter(isRecord)
    const preparation = steps.findIndex(step => step.run === 'bash scripts/prepare-ci-bubblewrap.sh')
    const smoke = steps.findIndex(step => step.run === 'pnpm run check:node-compat')
    expect(preparation).toBeGreaterThanOrEqual(0)
    expect(smoke).toBeGreaterThan(preparation)
    expect(steps[preparation]).not.toHaveProperty('continue-on-error', true)
  })

  it.each(['ci.yml', 'ci-master.yml', 'e2e.yml', 'release.yml', 'release-vendor.yml'])(
    '%s cancels superseded validation runs without crossing workflow or ref boundaries', (name) => {
      const workflow = loadWorkflow('.github/workflows/' + name)
      expect(workflow.concurrency).toEqual({
        group: '${{ github.workflow }}-${{ github.ref }}',
        'cancel-in-progress': true,
      })
    },
  )

  it('cancels reusable CI builds without cancelling release-owned builds', () => {
    const workflow = loadWorkflow('.github/workflows/build-exe-for-python-sdk.yml')
    expect(workflow.concurrency).toEqual({
      group: 'build-single-exe-${{ github.workflow }}-${{ github.ref }}',
      'cancel-in-progress': '${{ !inputs.release }}',
    })
  })

  it('does not cancel a desktop release once it starts publishing', () => {
    expect(loadWorkflow('.github/workflows/hallucodex-desktop-release.yml').concurrency).toMatchObject({ 'cancel-in-progress': false })
  })

  it('skips coverage-history uploads on cancellation but retains Wine cleanup', () => {
    const coverage = workflowJob(loadWorkflow('.github/workflows/ci-windows.yml'), 'windows-coverage')
    const wine = workflowJob(loadWorkflow('.github/workflows/ci-master.yml'), 'windows')
    expect(coverage.steps).toContainEqual(expect.objectContaining({
      name: 'Save coverage duration history', if: '${{ !cancelled() }}',
    }))
    expect(wine.steps).toContainEqual(expect.objectContaining({ name: 'Shut down wineserver', if: 'always()' }))
  })

  it('restores Linux coverage timings on the shards and saves the merged timings only from the report job', () => {
    const ci = loadWorkflow('.github/workflows/ci.yml')
    const prefix = "coverage-times-Linux-${{ runner.environment }}-${{ vars.DSH_CI_FAILOVER_LINUX || 'enterprise' }}-"
    const key = prefix + '${{ github.run_id }}-${{ github.run_attempt }}'
    const stepsOf = (jobName: string): Record<string, unknown>[] => {
      const job = workflowJob(ci, jobName)
      if (!Array.isArray(job.steps)) throw new TypeError(`${jobName} must define steps`)
      return job.steps.filter(isRecord)
    }
    const lanes = stepsOf('node-24-coverage')
    const restore = lanes.findIndex(step => step.name === 'Restore coverage duration history')
    expect(restore).toBeGreaterThan(lanes.findIndex(step => step.uses === 'actions/checkout@v7.0.1'))
    expect(lanes.findIndex(step => step.run === 'pnpm run check:ci:coverage-shard')).toBeGreaterThan(restore)
    expect(lanes[restore]).toMatchObject({
      uses: 'actions/cache/restore@v6.1.0',
      with: { path: '.coverage-times.json', key, 'restore-keys': `${prefix}\n` },
    })
    expect(lanes.filter(step => isRecord(step.with) && step.with.path === '.coverage-times.json' && step.uses === 'actions/cache/save@v6.1.0')).toEqual([])
    const report = stepsOf('node-24-coverage-report')
    const merge = report.findIndex(step => step.run === 'pnpm run test:coverage:merge-shards "$RUNNER_TEMP/coverage-shards"')
    expect(report[merge]).toMatchObject({ env: { NODE_OPTIONS: '--max-old-space-size=4096' } })
    expect(lanes.find(step => step.name === 'Upload coverage shard blobs')).toMatchObject({ with: { overwrite: true } })
    const save = report.findIndex(step => step.name === 'Save coverage duration history')
    expect(merge).toBeGreaterThan(report.findIndex(step => step.uses === 'actions/download-artifact@v8.0.1'))
    expect(save).toBeGreaterThan(merge)
    expect(report[save]).toMatchObject({
      uses: 'actions/cache/save@v6.1.0',
      if: '${{ !cancelled() }}',
      with: { path: '.coverage-times.json', key },
    })
  })

  it.each([
    ['windows-coverage', 'ci-windows.yml', 'Windows', 'WINDOWS', 'pnpm run check:ci:coverage'],
  ])('reuses %s coverage timings only within its platform and runner pool', (jobName, file, platform, variable, command) => {
    const job = workflowJob(loadWorkflow('.github/workflows/' + file), jobName)
    if (!Array.isArray(job.steps)) throw new TypeError(`${jobName} must define steps`)
    const steps = job.steps.filter(isRecord)
    const checkout = steps.findIndex(step => step.uses === 'actions/checkout@v7.0.1')
    const restore = steps.findIndex(step => step.name === 'Restore coverage duration history')
    const coverage = steps.findIndex(step => step.run === command)
    const save = steps.findIndex(step => step.name === 'Save coverage duration history')
    const prefix = `coverage-times-${platform}-\${{ runner.environment }}-\${{ vars.DSH_CI_FAILOVER_${variable} || 'enterprise' }}-`
    const key = prefix + '${{ github.run_id }}-${{ github.run_attempt }}'
    expect(checkout).toBeGreaterThanOrEqual(0)
    expect(restore).toBeGreaterThan(checkout)
    expect(coverage).toBeGreaterThan(restore)
    expect(save).toBeGreaterThan(coverage)
    expect(steps[restore]).toMatchObject({
      uses: 'actions/cache/restore@v6.1.0',
      with: { path: '.coverage-times.json', key, 'restore-keys': `${prefix}\n` },
    })
    expect(steps[save]).toMatchObject({
      uses: 'actions/cache/save@v6.1.0',
      if: '${{ !cancelled() }}',
      with: { path: '.coverage-times.json', key },
    })
  })

  it('isolates every pnpm action setup destination per runner', () => {
    const files = ['.github/workflows/ci.yml', '.github/workflows/ci-windows.yml', '.github/workflows/ci-master.yml']
    const setups: Array<{ jobName: string; step: unknown }> = []
    for (const file of files) {
      const workflow: unknown = yaml.load(readFileSync(resolve(root, file), 'utf8'))
      if (!isRecord(workflow) || !isRecord(workflow.jobs)) throw new TypeError(`${file} must define jobs`)
      for (const [jobName, job] of Object.entries(workflow.jobs)) {
        if (!isRecord(job) || !Array.isArray(job.steps)) continue
        for (const step of job.steps) {
          if (!isRecord(step) || typeof step.uses !== 'string' || !step.uses.startsWith('pnpm/action-setup@')) continue
          setups.push({ jobName, step })
        }
      }
    }

    expect(setups.length).toBeGreaterThan(0)
    for (const { jobName, step } of setups) {
      const stepDest = (step as { with?: { dest?: unknown } }).with?.dest
      if (jobName.startsWith('windows-')) {
        expect(stepDest, `${jobName} must use the native Windows pnpm destination`).toBe(nativeWindowsPnpmDestination)
        expect(step).not.toMatchObject({ with: { standalone: true } })
      } else {
        expect(typeof stepDest, `${jobName} must use a runner-and-run-private pnpm destination`).toBe('string')
        expect(stepDest as string).toMatch(runnerPrivatePnpmDestination)
      }
    }
  })

  it.each(['node-24', 'node-24-coverage', 'node-24-coverage-report', 'node-24-build', 'node-24-consumers', 'node-24-web-snapshot'])(
    '%s keeps tool and fixture temporary files under runner cleanup',
    (jobName) => {
      const job = workflowJob(loadWorkflow('.github/workflows/ci.yml'), jobName)
      if (!Array.isArray(job.steps)) throw new TypeError(`${jobName} must define steps`)
      expect(job.steps[0]).toEqual({
        name: 'Use runner-owned temporary storage',
        run: [
          'echo "TMPDIR=${{ runner.temp }}" >> "$GITHUB_ENV"',
          ...(jobName === 'node-24-web-snapshot'
            ? ['echo "PLAYWRIGHT_BROWSERS_PATH=${RUNNER_TEMP%/*}/ms-playwright" >> "$GITHUB_ENV"']
            : []),
          '',
        ].join('\n'),
      })
      if (jobName === 'node-24-web-snapshot') {
        const browserCache: unknown = job.steps.find(step => isRecord(step) && isRecord(step.with)
          && step.with.path === '${{ env.PLAYWRIGHT_BROWSERS_PATH }}')
        expect(browserCache).toMatchObject({ uses: 'actions/cache/restore@v6.1.0' })
      }
      const store: unknown = job.steps.find(step => isRecord(step) && step.name === 'Configure pnpm store path')
      expect(store).toMatchObject({
        run: [
          'store_root="$HOME/.local/share/pnpm/store"',
          'echo "PNPM_CONFIG_STORE_DIR=$store_root" >> "$GITHUB_ENV"',
          'store_path=$(PNPM_CONFIG_STORE_DIR="$store_root" pnpm store path --silent)',
          'echo "path=$store_path" >> "$GITHUB_OUTPUT"',
          '',
        ].join('\n'),
      })
      for (const step of job.steps) {
        if (isRecord(step) && isRecord(step.env)) {
          expect(step.env.TMPDIR).toBeUndefined()
          expect(step.env.npm_config_cache).toBeUndefined()
        }
      }
    },
  )

  it('isolates the python SDK exe pnpm setup destination per job', () => {
    const workflow: unknown = yaml.load(readFileSync(resolve(root, '.github/workflows/build-exe-for-python-sdk.yml'), 'utf8'))
    if (!isRecord(workflow) || !isRecord(workflow.jobs)) throw new TypeError('build-exe-for-python-sdk.yml must define jobs')
    const setups: Array<{ step: unknown }> = []
    for (const job of Object.values(workflow.jobs)) {
      if (!isRecord(job) || !Array.isArray(job.steps)) continue
      for (const step of job.steps) {
        if (!isRecord(step) || typeof step.uses !== 'string' || !step.uses.startsWith('pnpm/action-setup@')) continue
        setups.push({ step })
      }
    }
    expect(setups.length).toBeGreaterThan(0)
    for (const { step } of setups) {
      expect(step).toMatchObject({
        with: { dest: nativeWindowsPnpmDestination },
      })
    }
  })

  it('keeps split native Windows PR jobs with failover in their own workflow, plus a master-only standby', () => {
    const workflow = loadWorkflow('.github/workflows/ci.yml')
    const windowsWorkflow = loadWorkflow('.github/workflows/ci-windows.yml')
    const masterWorkflow = loadWorkflow('.github/workflows/ci-master.yml')
    if (!isRecord(workflow.jobs)
      || !isRecord(windowsWorkflow.jobs)
      || !isRecord(windowsWorkflow.jobs['windows-build'])
      || !isRecord(windowsWorkflow.jobs['windows-coverage'])
      || !isRecord(windowsWorkflow.jobs['windows-native-tests'])
      || !isRecord(windowsWorkflow.jobs['windows-checks-passed'])
      || !isRecord(workflow.jobs['node-24'])
      || !isRecord(workflow.jobs['node-24-coverage'])
      || !isRecord(workflow.jobs['node-24-lint'])
      || !isRecord(workflow.jobs['node-24-bench'])
      || !isRecord(workflow.jobs['node-24-consumers'])
      || !isRecord(workflow.jobs['node-compat'])
      || !isRecord(workflow.jobs['all-checks-passed'])
      || !isRecord(masterWorkflow.jobs)
      || !isRecord(masterWorkflow.jobs['serial-windows'])) {
      throw new TypeError('CI workflow must define node-24, node-24-coverage, node-24-lint, node-24-bench, node-24-consumers, node-compat, and all-checks-passed; CI Windows must define windows-build, windows-coverage, windows-native-tests, and windows-checks-passed; ci-master must define serial-windows')
    }

    const windowsBuild = windowsWorkflow.jobs['windows-build']
    const windowsCoverage = windowsWorkflow.jobs['windows-coverage']
    const windowsNativeTests = windowsWorkflow.jobs['windows-native-tests']
    const windowsAggregate = windowsWorkflow.jobs['windows-checks-passed']
    const serialWindows = masterWorkflow.jobs['serial-windows']
    const node24 = workflow.jobs['node-24']
    const node24Coverage = workflow.jobs['node-24-coverage']
    const node24Bench = workflow.jobs['node-24-bench']
    const node24Consumers = workflow.jobs['node-24-consumers']
    const nodeCompat = workflow.jobs['node-compat']
    const aggregate = workflow.jobs['all-checks-passed']
    if (!Array.isArray(aggregate.needs) || !Array.isArray(windowsAggregate.needs)) {
      throw new TypeError('CI and CI Windows aggregates must define needs')
    }
    expect(Object.keys(workflow.jobs).filter(name => name.startsWith('windows'))).toEqual([])
    // The split native jobs all resolve their pool through the Windows switch.
    for (const [jobName, job] of [['windows-build', windowsBuild], ['windows-coverage', windowsCoverage], ['windows-native-tests', windowsNativeTests]] as const) {
      expect(typeof job['runs-on']).toBe('string')
      expect(job['runs-on'], `${jobName} runs-on must use the Windows failover switch`).toContain('DSH_CI_FAILOVER_WINDOWS')
      expect(job['runs-on'], `${jobName} runs-on must not use the Linux failover switch`).not.toContain('DSH_CI_FAILOVER_LINUX')
      expect(job['runs-on']).toContain('self-hosted')
      expect(job['runs-on']).toContain('dsh-win-ci')
      expect(job['runs-on']).toContain("'windows-2025'")
      const cores = jobName === 'windows-native-tests' ? 2 : 16
      expect(evaluateRunsOn(job['runs-on'], { vars: { DSH_CI_FAILOVER_WINDOWS: 'blacksmith' } }))
        .toBe(`blacksmith-${cores}vcpu-windows-2025`)
      expect(job.if).toBe("github.event_name == 'pull_request'")
    }

    // windows-build runs the blocking build/site pair.
    expect(windowsBuild.name).toBe('windows node 24 / build & observational')
    const buildSteps = windowsBuild.steps as unknown[]
    const buildCommands = buildSteps.filter((step): step is Record<string, unknown> & { run: string } => (
      isRecord(step) && typeof step.run === 'string'
    ))
    expect(buildCommands.map(step => step.run)).toContain('pnpm run check:ci:windows-blocking')

    // Native Windows installs branch on the workspace filesystem:
    // clone (ReFS block clone) only on ReFS, plain install elsewhere. This
    // keeps the TS6231 store-path leak (see the Windows ReFS store note) out
    // of the self-hosted pool without forcing clone onto hosted NTFS, which
    // rejects copy-on-write. The branch must stay, or a hosted fallback would
    // fail installs with ERR_PNPM_LINKING_FAILED.
    for (const [jobName, job] of [['windows-build', windowsBuild], ['windows-coverage', windowsCoverage], ['windows-native-tests', windowsNativeTests]] as const) {
      const steps = job.steps as unknown[]
      const install = steps.find((step): step is Record<string, unknown> & { run: string } => (
        isRecord(step) && step.name === 'Install (immutable)' && typeof step.run === 'string'
      ))
      expect(install, `${jobName} must define the filesystem-branched install`).toBeDefined()
      expect(install!.run).toContain("$fs -eq 'ReFS'")
      expect(install!.run).toContain('--package-import-method=clone')
      expect(install!.run).toContain('corepack pnpm install')
      // The else branch must keep the plain hosted install as a distinct line
      // (not the corepack clone line, which contains the same substring);
      // dropping it or making both branches clone would force clone onto
      // NTFS, which rejects copy-on-write (ERR_PNPM_LINKING_FAILED). The
      // YAML folded block keeps the first statement on line 1 and folds the
      // rest with leading two-space indents.
      const installLines = install!.run.split('\n').map(line => line.trim())
      expect(installLines).toContain('} else {')
      expect(installLines.some(line => line === 'pnpm install --frozen-lockfile'), `${jobName} else branch must keep the plain hosted install`).toBe(true)
      // The ReFS branch must not use the interpolated empty-flag form, which
      // passes a stray "" positional argument to pnpm.
      expect(install!.run).not.toContain('$cloneFlag')
    }

    expect(windowsCoverage.name).toBe('windows node 24 / coverage')
    expect(windowsCoverage.env).toMatchObject({ DSH_COVERAGE_PARTITIONS: "${{ vars.DSH_CI_FAILOVER_WINDOWS == 'selfhosted' && github.event.pull_request.user.login != 'dependabot[bot]' && '4' || '' }}" })
    const coverageSteps = windowsCoverage.steps as unknown[]
    const coverageCommands = coverageSteps.filter((step): step is Record<string, unknown> & { run: string } => (
      isRecord(step) && typeof step.run === 'string'
    ))
    expect(coverageCommands.map(step => step.run)).toContain('pnpm run check:ci:coverage')
    // Windows coverage runs zero-build like the Linux lane: workspace imports
    // resolve to src through the tsconfig paths map, and the lib-consuming
    // suites (webworker-packer image-loadable, webworker-runtime
    // transform-corpus, client ui-trajectory client-bundle) self-skip on
    // unbuilt checkouts. The regex catches a regression spelled as
    // 'corepack pnpm run build' or folded into a multi-line run block, which
    // an exact string match would miss.
    expect(coverageCommands.every(step => !/\bpnpm\s+run\s+build(?:\s|$)/.test(step.run))).toBe(true)

    // windows-native-tests runs the Windows-specific specs.
    expect(windowsNativeTests.name).toBe('windows node 24 / native tests')
    const nativeTestSteps = windowsNativeTests.steps as unknown[]
    const nativeTestCommands = nativeTestSteps.filter((step): step is Record<string, unknown> & { run: string } => (
      isRecord(step) && typeof step.run === 'string'
    ))
    const nativeTestCommand = nativeTestCommands.map(step => step.run).join('\n')
    expect(nativeTestCommand).toContain('--no-file-parallelism')
    expect(nativeTestCommand).toContain('--testTimeout 90000')
    expect(nativeTestCommand).toContain('tool-pwsh/tests/loader.spec.ts')
    expect(nativeTestCommand).toContain('workflow-ptc.spec.ts')

    expect(windowsWorkflow.jobs['windows-observational']).toBeUndefined()
    expect(windowsBuild['continue-on-error']).not.toBe(true)
    const channelCheck = buildCommands.find(step => step.name === 'Verify Desktop updater dependency versions')
    expect(channelCheck).toMatchObject({ shell: 'pwsh' })
    expect(channelCheck?.['continue-on-error']).not.toBe(true)
    expect(channelCheck?.run).toContain('node apps/desktop/tests/updates/electron-updater/check-versions.mjs')
    expect(buildCommands.indexOf(channelCheck!))
      .toBeGreaterThan(buildCommands.findIndex(step => step.run === 'pnpm run check:ci:windows-blocking'))
    const observational = buildCommands.find(step => step.id === 'observational')
    expect(observational).toMatchObject({
      run: 'pnpm run check:ci:windows-observational-ready',
      shell: 'pwsh',
      'continue-on-error': true,
      'timeout-minutes': 15,
      env: {
        DSH_GATE_FAIL_FAST: '',
        DSH_PUBLINT_CONCURRENCY: "${{ vars.DSH_CI_FAILOVER_WINDOWS == 'selfhosted' && github.event.pull_request.user.login != 'dependabot[bot]' && '8' || '' }}",
      },
    })
    expect(observational?.if).toBeUndefined()
    expect(buildCommands.findIndex(step => step.id === 'observational'))
      .toBeGreaterThan(buildCommands.findIndex(step => step.run === 'pnpm run check:ci:windows-blocking'))
    const report = buildCommands.find(step => step.name === 'Report Windows observational failures')
    expect(report).toMatchObject({
      'continue-on-error': true,
      if: "steps.observational.outcome == 'failure'",
      shell: 'pwsh',
    })
    expect(report?.run).toContain('::warning::')
    expect(report?.run).toContain('Out-File -FilePath $env:GITHUB_STEP_SUMMARY -Encoding utf8 -Append')

    // serial-windows: master-only upstream standby, self-hosted, non-blocking, lives in ci-master.
    expect(serialWindows.if).toBe("github.repository == 'deepseek-harness/deepseek-harness' && github.event_name == 'push' && github.ref == 'refs/heads/master'")
    expect(serialWindows['runs-on']).toEqual(['self-hosted', 'dsh-win-ci', 'windows'])
    expect(serialWindows.name).toBe('serial / windows (self-hosted standby)')
    // Its store must share the ReFS workspace volume for clone; the install
    // must carry the same filesystem branch as the PR jobs.
    const serialSteps = serialWindows.steps as unknown[]
    const serialStore = serialSteps.find((step): step is Record<string, unknown> & { run: string } => (
      isRecord(step) && step.name === 'Configure persistent pnpm store' && typeof step.run === 'string'
    ))
    expect(serialStore).toBeDefined()
    expect(serialStore!.run).toContain('[IO.Path]::GetPathRoot($env:GITHUB_WORKSPACE)')
    expect(serialStore!.run).toContain("'.pnpm-store'")
    const serialInstall = serialSteps.find((step): step is Record<string, unknown> & { run: string } => (
      isRecord(step) && step.name === 'Install (immutable)' && typeof step.run === 'string'
    ))
    expect(serialInstall).toBeDefined()
    expect(serialInstall!.run).toContain("$fs -eq 'ReFS'")
    expect(serialInstall!.run).toContain('--package-import-method=clone')
    expect(serialInstall!.run).toContain('corepack pnpm install')
    // Distinct else-branch line, as for the PR jobs: the corepack clone line
    // contains the plain-install substring too.
    expect(serialInstall!.run.split('\n').map(line => line.trim())).toContain('} else {')
    expect(serialInstall!.run.split('\n').map(line => line.trim())).toContain('pnpm install --frozen-lockfile')
    expect(serialInstall!.run).not.toContain('$cloneFlag')
    // The unsharded reference runs the whole coverage inventory at the same
    // per-test budget the PR coverage lane grants; the default 5000ms times
    // out load-sensitive store scans (e.g. gen-third-party-notices).
    const serialGate = serialSteps.find((step): step is Record<string, unknown> & { env?: Record<string, unknown> } => (
      isRecord(step) && step.name === 'Run complete unsharded Windows gate inventory serially'
    ))
    expect(serialGate).toBeDefined()
    expect(serialGate!.env).toMatchObject({ DSH_COVERAGE_TEST_TIMEOUT_MS: '90000' })

    expect(aggregate.needs).not.toContain('windows')
    // windows-coverage is temporarily non-blocking while Windows ACP
    // half-close tests are stabilized; observational stays out too.
    expect(windowsAggregate.needs).toEqual(['windows-build', 'windows-native-tests'])
    expect(windowsAggregate.name).toBe('windows checks passed')
    expect(windowsAggregate['runs-on']).toBe(aggregate['runs-on'])
    expect(windowsAggregate.if).toBe(aggregate.if)
    // The benchmark lane is a required verdict input and runs alone so its
    // wall-clock budgets never share a runner with a concurrent aggregate.
    expect(aggregate.needs).toContain('node-24-bench')
    expect(node24Bench.name).toBe('node 24 / benchmarks ${{ matrix.shard }}/2')
    expect(node24Bench.env).toEqual({ DSH_BENCH_PHASE: '${{ matrix.phase }}' })
    expect(node24Bench.steps).toContainEqual({
      name: 'Install benchmark browser and hosted dependencies',
      run: 'pnpm --filter @deepseek-ai/dsh-benchmarks exec playwright install --with-deps chromium',
    })
    expect(JSON.stringify(node24Bench.steps)).not.toContain('DSH_CI_FAILOVER_LINUX')
    expect(node24Bench.steps).toContainEqual({
      name: 'Run performance benchmarks',
      env: { DSH_GATE_VERBOSE: '1' },
      run: 'pnpm run check:ci:bench-prebuilt',
    })
    expect(windowsAggregate.needs).not.toContain('serial-windows')

    // Linux failover is a separate switch: the three enterprise Linux workers
    // and the verdict job resolve their pool through DSH_CI_FAILOVER_LINUX,
    // never the Windows switch.
    for (const [jobName, job] of [['node-24', node24], ['node-24-coverage', node24Coverage], ['node-24-consumers', node24Consumers]] as const) {
      expect(typeof job['runs-on']).toBe('string')
      expect(job['runs-on'], `${jobName} runs-on must use the Linux failover switch`).toContain('DSH_CI_FAILOVER_LINUX')
      expect(job['runs-on'], `${jobName} runs-on must not use the Windows failover switch`).not.toContain('DSH_CI_FAILOVER_WINDOWS')
      expect(job['runs-on']).toContain('vm-backup')
      expect(evaluateRunsOn(job['runs-on'], { vars: { DSH_CI_FAILOVER_LINUX: 'blacksmith' } }))
        .toBe(`blacksmith-${jobName === 'node-24' ? 8 : 16}vcpu-ubuntu-2404`)
    }
    expect(aggregate['runs-on']).toContain('DSH_CI_FAILOVER_LINUX')
    expect(aggregate['runs-on']).not.toContain('DSH_CI_FAILOVER_WINDOWS')
    expect(aggregate['runs-on']).toContain('vm-backup')
    expect(aggregate['runs-on']).toContain('blacksmith-4vcpu-ubuntu-2404')

    // Evaluating the full selector, not just substring containment, proves the
    // blacksmith branch is standalone: it must not fall through to the
    // self-hosted pool when the two values are mutually exclusive.
    const selectors = {
      linux: node24['runs-on'] as string,
      linuxAggregate: aggregate['runs-on'] as string,
      windows: windowsBuild['runs-on'] as string,
    }
    const evaluate = (expression: string, vars: Record<string, string>, login = 'maintainer'): unknown => {
      return evaluateRunsOn(expression, {
        vars,
        fromJSON: JSON.parse,
        github: { event: { pull_request: { user: { login } } } },
      })
    }
    for (const [name, selector, variable, pool, hosted] of [
      ['linux gates', selectors.linux, 'DSH_CI_FAILOVER_LINUX', ['self-hosted', 'linux', 'x64', 'vm-backup'], 'ubuntu-24.04'],
      ['linux aggregate', selectors.linuxAggregate, 'DSH_CI_FAILOVER_LINUX', ['self-hosted', 'linux', 'x64', 'vm-backup'], 'ubuntu-latest'],
      ['windows lanes', selectors.windows, 'DSH_CI_FAILOVER_WINDOWS', ['self-hosted', 'dsh-win-ci', 'windows'], 'windows-2025'],
    ] as const) {
      expect(evaluate(selector, { [variable]: 'blacksmith' }), `${name} blacksmith value`).toMatch(/^blacksmith-/)
      expect(evaluate(selector, { [variable]: 'selfhosted' }), `${name} selfhosted value`).toEqual(pool)
      // The blacksmith branch must not capture the selfhosted pool, and the
      // dependabot exclusion applies to the pool, not to the blacksmith tier.
      expect(evaluate(selector, { [variable]: 'selfhosted' }, 'dependabot[bot]'), `${name} dependabot on selfhosted`).toBe(hosted)
      for (const mode of ['', 'hosted', 'unexpected']) {
        expect(evaluate(selector, { [variable]: mode }), `${name} default on ${mode}`).toBe(hosted)
      }
    }

    // The run-gates aggregate lanes stop at the first blocking gate failure so
    // a red aggregate does not keep burning runner time on the remaining
    // gates. Removing the flag silently reverts to running every independent
    // gate to completion.
    for (const [jobName, job] of [['node-24', node24], ['node-24-coverage', node24Coverage], ['node-24-consumers', node24Consumers], ['node-compat', nodeCompat]] as const) {
      expect(job.env, `${jobName} must enable fail-fast`).toMatchObject({ DSH_GATE_FAIL_FAST: '1' })
    }

    // The native Windows lanes with run-gates aggregates fail fast for the
    // same reason: a failing gate aborts the sibling gate instead of waiting
    // out the multi-minute instrumented coverage run.
    expect(windowsBuild.env, 'windows-build must enable fail-fast').toMatchObject({ DSH_GATE_FAIL_FAST: '1' })
    expect(windowsCoverage.env, 'windows-coverage must enable fail-fast').toMatchObject({ DSH_GATE_FAIL_FAST: '1' })

    // The observational lane stays complete: it is continue-on-error by design
    // and exists to collect as much Windows-native evidence per run as
    // possible, so the first failure must not truncate the rest.
    expect(observational?.env).toMatchObject({ DSH_GATE_FAIL_FAST: '' })
  })

  it('runs the darwin unit parity inventory at the coverage lanes\' test budget', () => {
    const coverage = workflowJob(loadWorkflow('.github/workflows/ci.yml'), 'node-24-coverage')
    if (!isRecord(coverage.env) || typeof coverage.env.DSH_COVERAGE_TEST_TIMEOUT_MS !== 'string') {
      throw new TypeError('node-24-coverage must grant DSH_COVERAGE_TEST_TIMEOUT_MS')
    }
    const sandboxWorkflow = loadWorkflow('.github/workflows/sandbox.yml')
    const unitDarwin = workflowJob(sandboxWorkflow, 'unit-darwin')
    if (!Array.isArray(unitDarwin.steps)) throw new TypeError('unit-darwin job must define steps')
    // The 25-minute darwin inventory runs weekly and on demand; master pushes keep only the e2e legs.
    expect(unitDarwin.if).toBe("github.event_name != 'push'")
    expect(isRecord(sandboxWorkflow.on) ? sandboxWorkflow.on.schedule : undefined).toEqual([{ cron: '0 18 * * 0' }])
    expect(workflowJob(sandboxWorkflow, 'sandbox-e2e').if).toBeUndefined()
    const unit = unitDarwin.steps.filter(isRecord).find(step => step.name === 'Unit tests (darwin parity)')
    // The whole unit inventory on a shared macos-latest runner pays the same
    // scheduling delay the coverage lanes absorb; the ci-unit aggregate is the
    // `pnpm run test` path that consumes the variable, and the value is the
    // coverage lane's so the two budget classes cannot drift apart.
    expect(unit).toMatchObject({
      run: 'pnpm run check:ci:unit',
      env: { DSH_COVERAGE_TEST_TIMEOUT_MS: coverage.env.DSH_COVERAGE_TEST_TIMEOUT_MS },
    })
  })

  it('gates standalone keyless blacksmith jobs and benchmark tiers on the failover variables', () => {
    const expectedFilenames = workflowJob(loadWorkflow('.github/workflows/expected-filenames.yml'), 'expected-filenames')
    const sandbox = workflowJob(loadWorkflow('.github/workflows/sandbox.yml'), 'sandbox-e2e')
    expect(expectedFilenames['runs-on']).toContain('DSH_CI_FAILOVER_LINUX')
    expect(expectedFilenames['runs-on']).toContain("== 'blacksmith'")
    expect(expectedFilenames['runs-on']).toContain('blacksmith-4vcpu-ubuntu-2404')
    expect(expectedFilenames['runs-on']).toContain("'ubuntu-latest'")
    expect(sandbox['runs-on']).toContain("matrix.runner == 'bwrap'")
    expect(sandbox['runs-on']).toContain('DSH_CI_FAILOVER_LINUX')
    expect(sandbox['runs-on']).toContain('blacksmith-4vcpu-ubuntu-2404')
    for (const name of ['larger-runner-benchmark', 'consolidated-runner-benchmark'] as const) {
      const benchmark = workflowJob(loadWorkflow('.github/workflows/ci-master.yml'), name)
      if (!isRecord(benchmark.strategy) || !isRecord(benchmark.strategy.matrix) || !Array.isArray(benchmark.strategy.matrix.include)) {
        throw new TypeError(`${name} must define a matrix include list`)
      }
      expect(benchmark['runs-on']).toContain('matrix.blacksmith')
      expect(benchmark['runs-on']).toContain('DSH_CI_FAILOVER_LINUX')
      expect(benchmark['runs-on']).toContain('DSH_CI_FAILOVER_WINDOWS')
      for (const row of benchmark.strategy.matrix.include as Array<Record<string, string>>) {
        expect(typeof row.blacksmith, `${name} ${row.cores}-core row must declare a blacksmith label`).toBe('string')
        if (row.cores === '64' || row.cores === '96') {
          expect(row.blacksmith, `${name} ${row.cores}-core row has no Blacksmith tier`).toBe('')
        } else {
          expect(row.blacksmith).toContain(`blacksmith-${row.cores}vcpu`)
        }
      }
    }
  })

  it('runs required benchmarks on a four-vCPU Blacksmith runner and falls back to hosted Linux', () => {
    const workflow = loadWorkflow('.github/workflows/ci.yml')
    const benchmark = workflowJob(workflow, 'node-24-bench')
    const aggregate = workflowJob(workflow, 'all-checks-passed')

    // The shared self-hosted pool is not an idle runner, so only the
    // Blacksmith leg moves the benchmarks off hosted Linux.
    expect(evaluateRunsOn(benchmark['runs-on'], { vars: { DSH_CI_FAILOVER_LINUX: 'blacksmith' } }))
      .toBe('blacksmith-4vcpu-ubuntu-2404')
    for (const mode of ['', 'selfhosted', 'unexpected']) {
      expect(evaluateRunsOn(benchmark['runs-on'], { vars: { DSH_CI_FAILOVER_LINUX: mode } })).toBe('ubuntu-24.04')
    }
    expect(JSON.stringify(benchmark.steps)).not.toContain('DSH_CI_FAILOVER_LINUX')
    expect(benchmark.if).toBe("github.event_name == 'pull_request'")
    expect(benchmark.needs).toBe('node-24-build')
    expect(benchmark['continue-on-error']).toBeUndefined()
    expect(aggregate.needs).toContain('node-24-bench')

    // The report job renders on a small hosted runner and installs nothing.
    const report = workflowJob(workflow, 'node-24-bench-report')
    expect(evaluateRunsOn(report['runs-on'], { vars: { DSH_CI_FAILOVER_LINUX: 'blacksmith' } }))
      .toBe('blacksmith-2vcpu-ubuntu-2404')
    for (const mode of ['', 'selfhosted', 'unexpected']) {
      expect(evaluateRunsOn(report['runs-on'], { vars: { DSH_CI_FAILOVER_LINUX: mode } })).toBe('ubuntu-latest')
    }
    expect(report.if).toBe("${{ !cancelled() && github.event_name == 'pull_request' }}")
    expect(JSON.stringify(report.steps)).not.toContain('pnpm install')
  })

  it('always restores the hosted benchmark pnpm cache', () => {
    const benchmark = workflowJob(loadWorkflow('.github/workflows/ci.yml'), 'node-24-bench')
    if (!Array.isArray(benchmark.steps)) throw new TypeError('benchmark job must define steps')
    const caches = benchmark.steps.filter(step => isRecord(step) && step.uses === 'actions/cache/restore@v6.1.0')

    expect(caches).toHaveLength(1)
    expect(caches[0]).not.toHaveProperty('if')
    expect(caches[0]).toMatchObject({
      with: {
        path: '${{ steps.pnpm-store.outputs.path }}',
        key: "${{ runner.os }}-node-${{ env.PRIMARY_NODE_VERSION }}-pnpm-${{ hashFiles('pnpm-lock.yaml') }}",
      },
    })
  })

  it('bounds each benchmark phase job to twenty minutes and runs it on the restored shared build', () => {
    const benchmark = workflowJob(loadWorkflow('.github/workflows/ci.yml'), 'node-24-bench')
    if (!Array.isArray(benchmark.steps)) throw new TypeError('benchmark job must define steps')
    const steps = benchmark.steps.filter(isRecord)
    const index = (name: string): number => steps.findIndex(step => step.name === name)

    expect(benchmark['timeout-minutes']).toBe(20)
    expect(benchmark.steps).toContainEqual({
      name: 'Run performance benchmarks',
      env: { DSH_GATE_VERBOSE: '1' },
      run: 'pnpm run check:ci:bench-prebuilt',
    })
    expect(steps[index('Download build output')]).toMatchObject({ uses: 'actions/download-artifact@v8.0.1', with: { name: 'build-output' } })
    expect(index('Download build output')).toBeGreaterThan(index('Install (immutable)'))
    expect(index('Unpack build output')).toBeGreaterThan(index('Download build output'))
    // A restored addon from another runner pool that does not load is rebuilt here.
    const addon = index('Rebuild the native addon if the restored one does not load')
    expect(addon).toBeGreaterThan(index('Unpack build output'))
    expect(index('Run performance benchmarks')).toBeGreaterThan(addon)
    expect(String(steps[addon]?.run)).toContain('process.dlopen({ exports: {} }, process.argv[1])')
    expect(String(steps[addon]?.run)).toContain('pnpm run build:native-system')
    expect(String(steps[index('Unpack build output')]?.run)).toContain('tar -xmf -')
  })

  it('uploads the results of each phase and publishes one scaled report even when a budget fails', () => {
    const workflow = loadWorkflow('.github/workflows/ci.yml')
    const benchmark = workflowJob(workflow, 'node-24-bench')
    const report = workflowJob(workflow, 'node-24-bench-report')
    if (!Array.isArray(benchmark.steps) || !Array.isArray(report.steps)) throw new TypeError('benchmark jobs must define steps')

    expect(benchmark.steps).toContainEqual({
      name: 'Upload benchmark results',
      if: '${{ !cancelled() }}',
      uses: 'actions/upload-artifact@v7.0.1',
      with: {
        name: 'benchmark-results-${{ matrix.shard }}',
        path: 'benchmarks/.dsh-report/',
        'include-hidden-files': true,
        'if-no-files-found': 'warn',
        'retention-days': 7,
        overwrite: true,
      },
    })
    const uploadIndex = benchmark.steps.findIndex(step => isRecord(step) && step.name === 'Upload benchmark results')
    const benchmarkIndex = benchmark.steps.findIndex(step => isRecord(step) && step.name === 'Run performance benchmarks')
    expect(uploadIndex).toBeGreaterThan(benchmarkIndex)

    const steps = report.steps.filter(isRecord)
    const download = steps.findIndex(step => step.name === 'Download benchmark results')
    const render = steps.findIndex(step => step.name === 'Render scaled benchmark report')
    const publish = steps.findIndex(step => step.name === 'Upload scaled benchmark report')
    expect(steps[download]).toMatchObject({ with: { pattern: 'benchmark-results-*' } })
    expect(String(steps[render]?.run)).toContain('node scripts/render-benchmark-report.ts benchmarks/.dsh-report')
    expect(render).toBeGreaterThan(download)
    expect(publish).toBeGreaterThan(render)
    expect(steps[publish]).toEqual({
      name: 'Upload scaled benchmark report',
      if: '${{ !cancelled() }}',
      uses: 'actions/upload-artifact@v7.0.1',
      with: {
        name: 'benchmark-report',
        path: 'benchmarks/.dsh-report/',
        'include-hidden-files': true,
        'if-no-files-found': 'warn',
        'retention-days': 7,
      },
    })
  })

  it('splits both Wine TypeScript faces and retains their aggregate heap budgets', () => {
    const wineGates = readFileSync(resolve(root, 'scripts/wine-windows-gates.sh'), 'utf8')

    const references = wineGates.indexOf(
      'wine_node "$scratch/logs/host-references.log" --import tsx/esm scripts/compile-referenced-projects.ts host',
    )
    const aggregate = wineGates.indexOf(
      'wine_node "$scratch/logs/host-tsc.log" --max-old-space-size=8192 "$tsc_js" -p tsconfig.host.json --pretty false',
    )
    const metadata = wineGates.indexOf('wine_node "$scratch/logs/host-typert.log" --import tsx/esm scripts/generate-typert.ts')
    expect(metadata).toBeGreaterThan(-1)
    expect(references).toBeGreaterThan(metadata)
    expect(aggregate).toBeGreaterThan(references)
    expect(wineGates).not.toContain('-b tsconfig.host.json')
    const clientReferences = wineGates.indexOf('wine_node "$scratch/logs/client-references.log" --import tsx/esm scripts/compile-referenced-projects.ts client')
    const clientAggregate = wineGates.indexOf('wine_node "$scratch/logs/client-tsc.log" --max-old-space-size=8192 "$tsc_js" -p tsconfig.client.json --pretty false')
    expect(clientReferences).toBeGreaterThan(aggregate)
    expect(clientAggregate).toBeGreaterThan(clientReferences)
    expect(wineGates).not.toContain('-b tsconfig.client.json')
    expect(wineGates).toContain('  "$scratch/logs/client-references.log" \\')
  })

  it('runs only Wine for its manual suite and retains master-push scheduling', () => {
    const master = loadWorkflow('.github/workflows/ci-master.yml')
    if (!isRecord(master.on) || !isRecord(master.on.workflow_dispatch)
      || !isRecord(master.on.workflow_dispatch.inputs) || !isRecord(master.on.workflow_dispatch.inputs.suite)
      || !isRecord(master.jobs)) throw new TypeError('CI master must define manual suites and jobs')
    expect(master.on.workflow_dispatch.inputs.suite.options).toEqual([
      'larger-runner-benchmark', 'consolidated-runner-benchmark', 'ssh-helper', 'wine',
    ])
    const wine = workflowJob(master, 'windows')
    if (typeof wine.if !== 'string') throw new TypeError('Wine must define a trigger condition')
    for (const [event, ref, suite, expected] of [
      ['push', 'refs/heads/master', '', true],
      ['push', 'refs/heads/topic', '', false],
      ['pull_request', 'refs/pull/42/merge', 'wine', false],
      ['workflow_dispatch', 'refs/heads/topic', 'wine', true],
      ['workflow_dispatch', 'refs/tags/dsh-v0.2.2-alpha.2', 'wine', true],
      ['workflow_dispatch', 'refs/heads/topic', 'ssh-helper', false],
      ['workflow_dispatch', 'refs/heads/topic', 'larger-runner-benchmark', false],
      ['workflow_dispatch', 'refs/heads/topic', 'consolidated-runner-benchmark', false],
    ] as const) {
      expect(runInNewContext(wine.if, { github: { event_name: event, ref }, inputs: { suite } }, { timeout: 1000 })).toBe(expected)
    }
    const enabled = Object.entries(master.jobs).filter(([, job]) => {
      if (!isRecord(job)) throw new TypeError('CI master jobs must be objects')
      if (typeof job.if === 'boolean') return job.if
      if (typeof job.if !== 'string') throw new TypeError('CI master jobs must define trigger conditions')
      return runInNewContext(job.if, { github: { event_name: 'workflow_dispatch', ref: 'refs/heads/topic' }, inputs: { suite: 'wine' } }, { timeout: 1000 }) === true
    }).map(([name]) => name)
    expect(enabled).toEqual(['windows'])
  })

  it('cancels superseded master runs without changing the post-merge job inventory', () => {
    const workflow = loadWorkflow('.github/workflows/ci-master.yml')
    const prWorkflow = loadWorkflow('.github/workflows/ci.yml')
    if (!isRecord(workflow.jobs) || !isRecord(workflow.concurrency)) {
      throw new TypeError('ci-master workflow must define jobs and a workflow-level concurrency block')
    }
    if (!isRecord(prWorkflow.jobs)) {
      throw new TypeError('ci workflow must define jobs')
    }

    expect(workflow.concurrency).toEqual({
      group: '${{ github.workflow }}-${{ github.ref }}',
      'cancel-in-progress': true,
    })
    expect(prWorkflow.concurrency).toEqual(workflow.concurrency)

    // The exact event sets are what keep master-only jobs out of the PR check
    // panel: ci-master triggers only on push(master) + workflow_dispatch and
    // never on pull_request; ci.yml is exactly pull_request-only. Assert the
    // full sets so losing the wrong event, or gaining an extra one, fails.
    if (!isRecord(workflow.on) || !isRecord(prWorkflow.on)) {
      throw new TypeError('both CI workflows must define on')
    }
    expect(Object.keys(workflow.on).sort()).toEqual(['push', 'workflow_dispatch'])
    expect(Object.keys(prWorkflow.on)).toEqual(['pull_request'])
    const windowsWorkflow = loadWorkflow('.github/workflows/ci-windows.yml')
    if (!isRecord(windowsWorkflow.on)) throw new TypeError('CI Windows workflow must define on')
    expect(Object.keys(windowsWorkflow.on)).toEqual(['pull_request'])
    expect(windowsWorkflow.concurrency).toEqual(workflow.concurrency)
    // Duplicated env must not drift: a Node bump on one lane only would run
    // Linux and Windows against different versions.
    expect(windowsWorkflow.env).toEqual(prWorkflow.env)

    // Drills share the parent run’s supersession policy.
    for (const name of ['serial-linux-selfhosted', 'serial-windows']) {
      const job = workflow.jobs[name]
      if (!isRecord(job)) throw new TypeError(`${name} must be defined`)
      expect(job.concurrency).toBeUndefined()
      // Standby drills remain post-merge upstream work, but share run cancellation.
      expect(job.if).toBe("github.repository == 'deepseek-harness/deepseek-harness' && github.event_name == 'push' && github.ref == 'refs/heads/master'")
    }

    // Pin the post-merge runtime, Wine, and standby inventory.
    const NOT_PUSH_REACHABLE = new Set([
      "github.event_name == 'workflow_dispatch' && inputs.suite == 'larger-runner-benchmark'",
      "github.event_name == 'workflow_dispatch' && inputs.suite == 'consolidated-runner-benchmark'",
      "github.event_name == 'workflow_dispatch' && inputs.suite == 'ssh-helper'",
    ])
    const pushReachable = Object.entries(workflow.jobs)
      .filter(([, job]) => {
        if (!isRecord(job)) return false
        if (job.if === undefined) return true // unconditional: runs on every event
        if (job.if === false) return false // `if: false` parses as a boolean
        if (typeof job.if !== 'string') return true // unrecognized shape: surface it
        return !NOT_PUSH_REACHABLE.has(job.if.trim())
      })
      .map(([name]) => name)
      .sort()
    expect(pushReachable).toEqual(['serial-linux-selfhosted', 'serial-windows', 'windows'])

    // Manual benchmarks retain their bounded fan-out.
    for (const name of ['larger-runner-benchmark', 'consolidated-runner-benchmark']) {
      const job = workflow.jobs[name]
      if (!isRecord(job) || !isRecord(job.strategy)) {
        throw new TypeError(`${name} must define a matrix strategy`)
      }
      expect(job.strategy['max-parallel']).toBe(12)
      expect(job['timeout-minutes']).toBe(15)
    }
  })

  it('redirects the Node compile cache to the data-volume runner temp before the first pnpm call', () => {
    const prWorkflow = loadWorkflow('.github/workflows/ci.yml')
    const masterWorkflow = loadWorkflow('.github/workflows/ci-master.yml')
    const redirectLanes = [
      [prWorkflow, 'node-24'],
      [prWorkflow, 'node-24-coverage'],
      [prWorkflow, 'node-24-coverage-report'],
      [prWorkflow, 'node-24-build'],
      [prWorkflow, 'node-24-consumers'],
      [prWorkflow, 'node-24-web-snapshot'],
      [masterWorkflow, 'serial-linux-selfhosted'],
    ] as const
    for (const [workflow, jobKey] of redirectLanes) {
      const job = workflowJob(workflow, jobKey)
      if (!Array.isArray(job.steps)) throw new TypeError(`${jobKey} must define steps`)
      const redirectStepIndex = job.steps.findIndex((step): step is Record<string, unknown> & { run: string } => (
        isRecord(step) && typeof step.run === 'string'
          && step.run.includes('NODE_COMPILE_CACHE=${{ runner.temp }}/node-compile-cache')
          && step.run.includes('"$GITHUB_ENV"')
      ))
      // Removing this injection would send every pnpm call in the lane (setup,
      // store-path probe, install, and the gate) back to the root partition's
      // /tmp; rationale in
      // .github/workflows/ci.yml.
      expect(redirectStepIndex, `${jobKey} must inject NODE_COMPILE_CACHE into GITHUB_ENV`).toBeGreaterThan(-1)
      const pnpmSetupIndex = job.steps.findIndex((step): step is Record<string, unknown> & { uses: string } => (
        isRecord(step) && typeof step.uses === 'string' && step.uses.includes('pnpm/action-setup')
      ))
      expect(pnpmSetupIndex, `${jobKey} must run pnpm/action-setup`).toBeGreaterThan(-1)
      expect(redirectStepIndex, `${jobKey} must redirect before pnpm/action-setup runs pnpm`).toBeLessThan(pnpmSetupIndex)
    }
  })

  it('keeps supported LSP source under native Windows coverage', () => {
    const config = readFileSync(resolve(root, 'vitest.config.ts'), 'utf8')

    expect(config).not.toContain('packages/lsp/lsp-stdio/src/connection.ts')
    expect(config).not.toContain('packages/lsp/lsp-stdio/src/index.ts')
    expect(config).not.toContain('packages/lsp/lsp-stdio/src/instance.ts')
  })

  it('builds Python runtime carriers only for an explicit manual dispatch', () => {
    for (const name of ['ci.yml', 'ci-windows.yml', 'ci-master.yml']) {
      const workflow = loadWorkflow('.github/workflows/' + name)
      if (!isRecord(workflow.jobs)) throw new TypeError(`${name} must define jobs`)
      expect(Object.values(workflow.jobs)).not.toContainEqual(expect.objectContaining({ uses: './.github/workflows/build-exe-for-python-sdk.yml' }))
    }
    expect(workflowJob(loadWorkflow('.github/workflows/ci.yml'), 'all-checks-passed').needs).not.toContain('python-runtime')
    expect(workflowEvent(loadWorkflow('.github/workflows/build-exe-for-python-sdk.yml'), 'workflow_dispatch')).toBeDefined()
  })

  it('builds SSH executables only for explicit manual or release requests', () => {
    const ci = loadWorkflow('.github/workflows/ci.yml')
    if (!isRecord(ci.jobs)) throw new Error('PR CI must define jobs')
    expect(Object.values(ci.jobs)).not.toContainEqual(expect.objectContaining({ uses: './.github/workflows/build-exe-for-ssh-helper.yml' }))
    expect(workflowJob(ci, 'all-checks-passed').needs).not.toContain('ssh-helper')
    const master = workflowJob(loadWorkflow('.github/workflows/ci-master.yml'), 'ssh-helper')
    if (typeof master.if !== 'string') throw new Error('SSH manual caller must define its trigger condition')
    for (const [event, suite, expected] of [
      ['push', 'ssh-helper', false], ['pull_request', 'ssh-helper', false],
      ['workflow_dispatch', 'larger-runner-benchmark', false], ['workflow_dispatch', 'ssh-helper', true],
    ] as const) {
      expect(runInNewContext(master.if, { github: { event_name: event, ref: 'refs/heads/master' }, inputs: { suite } }, { timeout: 1000 })).toBe(expected)
    }
    expect(master.with).toEqual({ targets: 'node24-linux-x64,node24-linux-arm64,node24-macos-arm64,node24-macos-x64' })
    const workflow = loadWorkflow('.github/workflows/build-exe-for-ssh-helper.yml')
    if (!isRecord(workflow.on)) throw new Error('SSH builder must define triggers')
    expect(Object.keys(workflow.on).sort()).toEqual(['workflow_call', 'workflow_dispatch'])
  })

  it('requires SSH helper acceptance before uploading artifacts', () => {
    const workflow = loadWorkflow('.github/workflows/build-exe-for-ssh-helper.yml')
    const build = workflowJob(workflow, 'build')
    if (!Array.isArray(build.steps)) throw new Error('SSH build must define its verification steps')
    const steps = build.steps.filter(isRecord)
    const artifact = steps.findIndex(step => String(step.run).includes('scripts/verify-ssh-helper-artifact.ts'))
    const transport = steps.findIndex(step => String(step.run).includes('scripts/verify-ssh-helper-ssh.ts'))
    const landlock = steps.findIndex(step => String(step.run).includes('--backend=landlock-run'))
    const upload = steps.findIndex(step => String(step.uses).startsWith('actions/upload-artifact@'))
    expect(artifact).toBeGreaterThan(-1)
    expect(landlock).toBeGreaterThan(artifact)
    expect(transport).toBeGreaterThan(artifact)
    expect(upload).toBeGreaterThan(transport)
    for (const index of [artifact, transport, landlock, upload]) expect(steps[index]).not.toHaveProperty('continue-on-error', true)
  })

  it('validates the SSH native matrix before allocating runners', () => {
    const plan = workflowJob(loadWorkflow('.github/workflows/build-exe-for-ssh-helper.yml'), 'plan')
    const source = nodeStepSource(plan, 'targets')
    const evaluate = (requested: string): unknown => {
      let output = ''
      runInNewContext(source, {
        process: { env: { REQUESTED_TARGETS: requested, GITHUB_OUTPUT: 'output' } },
        appendFileSync: (_path: string, text: string) => { output += text },
      }, { timeout: 1000 })
      return JSON.parse(output.slice('matrix='.length))
    }
    expect(evaluate('')).toHaveLength(4)
    expect(evaluate('node24-linux-arm64')).toEqual([{ target: 'node24-linux-arm64', runner: 'ubuntu-24.04-arm' }])
    for (const invalid of ['node24-linux-arm64,node24-linux-arm64', 'node24-win-x64', 'node24-linux-x64,', ' ']) {
      expect(() => evaluate(invalid)).toThrow('Invalid or duplicate')
    }
  })

  it('keeps every Vitest project process-isolated on native Windows', () => {
    const config = readFileSync(resolve(root, 'vitest.config.ts'), 'utf8')

    expect(config).not.toContain("pool: process.platform === 'win32' ? 'threads' : 'forks'")
    expect(config.match(/pool: 'forks'/g)).toHaveLength(2)
  })

  it('applies the lane test budget inside every Vitest project', () => {
    // Each inline project spreads coverageTestTimeoutOptions, the only route
    // for DSH_COVERAGE_TEST_TIMEOUT_MS into projects; the behavior itself is
    // pinned by scripts/lane-test-budget.spec.ts.
    const config = readFileSync(resolve(root, 'vitest.config.ts'), 'utf8')

    expect(config).toContain('const laneTestBudget = coverageTestTimeoutOptions(process.env[COVERAGE_TEST_TIMEOUT_ENV])')
    expect(config.match(/^ {10}\.\.\.laneTestBudget,$/gm)).toHaveLength(2)
  })
})

describe('Runtime and LLM e2e Blacksmith routing', () => {
  it('routes DeepSeek e2e only through the Linux Blacksmith switch', () => {
    const job = workflowJob(loadWorkflow('.github/workflows/e2e.yml'), 'e2e')
    for (const mode of ['', 'selfhosted', 'unexpected', 'blacksmith']) {
      expect(evaluateRunsOn(job['runs-on'], { vars: { DSH_CI_FAILOVER_LINUX: mode, DSH_CI_FAILOVER_WINDOWS: 'blacksmith' } }))
        .toBe(mode === 'blacksmith' ? 'blacksmith-4vcpu-ubuntu-2404' : 'ubuntu-latest')
    }
  })

  it('keeps native release and dispatch builders hosted while routing x64 CI by platform', () => {
    const workflow = loadWorkflow('.github/workflows/build-exe-for-python-sdk.yml')
    const build = workflowJob(workflow, 'build')
    for (const [target, runner, variable, blacksmith, releaseRunner] of [
      ['node24-linux-x64', 'ubuntu-latest', 'DSH_CI_FAILOVER_LINUX', 'blacksmith-2vcpu-ubuntu-2404', 'ubuntu-latest'],
      ['node24-win-x64', 'windows-2025', 'DSH_CI_FAILOVER_WINDOWS', 'blacksmith-2vcpu-windows-2025', 'windows-2025'],
      ['node24-linux-arm64', 'ubuntu-24.04-arm', 'DSH_CI_FAILOVER_LINUX', 'ubuntu-24.04-arm', 'ubuntu-24.04-arm'],
      ['node24-macos-arm64', 'macos-latest', 'DSH_CI_FAILOVER_LINUX', 'macos-latest', 'macos-15-xlarge'],
      ['node24-macos-x64', 'macos-15-intel', 'DSH_CI_FAILOVER_LINUX', 'macos-15-intel', 'macos-15-large'],
    ] as const) {
      for (const ci of [false, true]) {
        for (const release of [false, true]) {
          for (const mode of ['', 'selfhosted', 'unexpected', 'blacksmith']) {
            const vars = { DSH_CI_FAILOVER_LINUX: 'blacksmith', DSH_CI_FAILOVER_WINDOWS: 'blacksmith', [variable]: mode }
            expect(evaluateRunsOn(build['runs-on'], { inputs: { ci, release }, vars, matrix: { target, runner } }), `${target} ci=${ci} release=${release} mode=${mode}`)
              .toBe(release ? releaseRunner : ci && mode === 'blacksmith' ? blacksmith : runner)
          }
        }
      }
    }
  })

  it.each(['plan', 'sdk-wheel'])('routes runtime %s only for non-release CI', (name) => {
    const job = workflowJob(loadWorkflow('.github/workflows/build-exe-for-python-sdk.yml'), name)
    for (const ci of [false, true]) {
      for (const release of [false, true]) {
        for (const mode of ['', 'selfhosted', 'unexpected', 'blacksmith']) {
          expect(evaluateRunsOn(job['runs-on'], { inputs: { ci, release }, vars: { DSH_CI_FAILOVER_LINUX: mode } }))
            .toBe(ci && !release && mode === 'blacksmith' ? 'blacksmith-4vcpu-ubuntu-2404' : 'ubuntu-latest')
        }
      }
    }
  })
})

describe('bubblewrap preparation script', () => {
  it('pins bubblewrap to a recorded Launchpad build and excludes Ubuntu pool downloads', () => {
    const script = readFileSync(resolve(root, 'scripts/prepare-ci-bubblewrap.sh'), 'utf8')
    const url = /^readonly BUBBLEWRAP_URL="([^"]+)"$/mu.exec(script)?.[1]

    expect(url).toMatch(
      /^https:\/\/launchpad\.net\/ubuntu\/\+source\/bubblewrap\/[^/]+\/\+build\/\d+\/\+files\/bubblewrap_[^/]+_amd64\.deb$/u,
    )
    // Ubuntu removes superseded versions from its live package pool.
    expect(script).not.toMatch(/https?:\/\/[^/'"\s]+\/ubuntu(?:-ports)?\/pool\//u)
  })

  it('verifies the archive against the pinned digest', () => {
    const script = readFileSync(resolve(root, 'scripts/prepare-ci-bubblewrap.sh'), 'utf8')

    expect(script).toMatch(/^readonly BUBBLEWRAP_SHA256='[0-9a-f]{64}'$/mu)
    expect(script).toContain('acquire_verified_archive "$BUBBLEWRAP_URL" "$BUBBLEWRAP_SHA256" "$archive"')
  })

  // Ephemeral runners share a `~` layout: GitHub-hosted runners and Blacksmith
  // (whose runners register as self-hosted but keep /home/runner as HOME). The
  // in-house `vm-backup` pool keeps `~/.cache` on a different, persistent
  // layout, so lanes that can select it must not restore or save this cache.
  // `ci-master.yml` prepares bubblewrap only on lanes that can select the
  // persistent runners, and the manual benchmark matrix includes their 64/96-core
  // rows, so neither carries cache steps.
  const hostedOnly = "vars.DSH_CI_FAILOVER_LINUX != 'selfhosted' || github.event.pull_request.user.login == 'dependabot[bot]'"
  const cachedJobs = new Map<string, string | undefined>([
    ['ci.yml:node-24-coverage', hostedOnly],
    ['ci.yml:node-24-consumers', hostedOnly],
    ['ci.yml:node-24-web-snapshot', hostedOnly],
    ['ci.yml:node-compat', hostedOnly],
    ['e2e.yml:e2e', undefined],
  ])

  it.each(['ci.yml', 'ci-master.yml', 'e2e.yml'])(
    '%s caches the verified archive only on the lanes that run on ephemeral runners',
    (name) => {
      const script = readFileSync(resolve(root, 'scripts/prepare-ci-bubblewrap.sh'), 'utf8')
      expect(script).toContain('readonly BUBBLEWRAP_CACHE_DIR="${HOME}/.cache/dsh-ci/bubblewrap"')
      const cache = {
        path: '~/.cache/dsh-ci/bubblewrap',
        key: "bubblewrap-${{ runner.os }}-${{ runner.arch }}-${{ hashFiles('scripts/prepare-ci-bubblewrap.sh') }}",
      }
      const workflow = loadWorkflow('.github/workflows/' + name)
      if (!isRecord(workflow.jobs)) throw new TypeError(`${name} must define jobs`)

      let preparations = 0
      for (const [jobName, job] of Object.entries(workflow.jobs)) {
        if (!isRecord(job) || !Array.isArray(job.steps)) continue
        const steps = job.steps.filter(isRecord)
        const preparation = steps.findIndex(step =>
          typeof step.run === 'string' && step.run.includes('bash scripts/prepare-ci-bubblewrap.sh'))
        if (preparation < 0) continue
        preparations += 1
        const key = `${name}:${jobName}`
        if (!cachedJobs.has(key)) {
          expect(
            steps.filter(step => typeof step.uses === 'string' && step.uses.startsWith('actions/cache/')),
            key,
          ).toEqual([])
          continue
        }
        const guard = cachedJobs.get(key)
        const cacheHit = "steps.bubblewrap-cache.outputs.cache-hit != 'true'"
        expect(steps[preparation - 1]).toEqual({
          name: 'Restore verified bubblewrap archive',
          id: 'bubblewrap-cache',
          ...(guard === undefined ? {} : { if: guard }),
          uses: 'actions/cache/restore@v6.1.0',
          with: cache,
        })
        expect(steps[preparation + 1]).toEqual({
          name: 'Save verified bubblewrap archive',
          if: guard === undefined ? cacheHit : `(${guard}) && ${cacheHit}`,
          uses: 'actions/cache/save@v6.1.0',
          with: cache,
        })
      }
      expect(preparations).toBeGreaterThan(0)
    },
  )
})

describe('DeepSeek e2e workflow', () => {
  it('requires a manual event and explicit live API opt-in', () => {
    const workflow = loadWorkflow('.github/workflows/e2e.yml')
    const dispatch = workflowEvent(workflow, 'workflow_dispatch')
    const e2e = workflowJob(workflow, 'e2e')
    expect(Object.keys(workflow.on as Record<string, unknown>)).toEqual(['workflow_dispatch'])
    expect(dispatch.inputs).toMatchObject({ live_api: { type: 'boolean', default: false } })
    for (const event of ['push', 'pull_request', 'schedule', 'workflow_call', 'workflow_dispatch']) {
      for (const liveApi of [undefined, false, true]) {
        const enabled: unknown = runInNewContext(String(e2e.if), {
          github: { event_name: event }, inputs: { live_api: liveApi },
        }, { timeout: 1000 })
        expect(enabled).toBe(event === 'workflow_dispatch' && liveApi === true)
      }
    }
  })

  it('keeps the Python runtime builder keyless unless a manual dispatch explicitly opts in', () => {
    const workflow = loadWorkflow('.github/workflows/build-exe-for-python-sdk.yml')
    for (const event of ['workflow_call', 'workflow_dispatch']) {
      expect(workflowEvent(workflow, event).inputs).toMatchObject({ live_api: { type: 'boolean', default: false } })
    }
    const build = workflowJob(workflow, 'build')
    if (!Array.isArray(build.steps)) throw new TypeError('Python runtime build must define steps')
    const secretSteps = build.steps.filter(isRecord).filter(step => JSON.stringify(step).includes('secrets.DEEPSEEK_API_KEY_EXTERNAL'))
    expect(secretSteps).toHaveLength(4)
    for (const step of secretSteps) {
      for (const event of ['push', 'pull_request', 'schedule', 'workflow_call', 'workflow_dispatch']) {
        for (const liveApi of [undefined, false, true]) {
          for (const os of ['Linux', 'Windows']) {
            const enabled: unknown = runInNewContext(String(step.if), {
              github: { event_name: event }, inputs: { ci: true, live_api: liveApi }, runner: { os },
            }, { timeout: 1000 })
            const matchingOs = String(step.name).includes('(Windows)') === (os === 'Windows')
            expect(enabled).toBe(event === 'workflow_dispatch' && liveApi === true && matchingOs)
          }
        }
      }
    }
  })

  it('carries no upstream publication, preview, or repository-bot workflow', () => {
    for (const file of ['build-preview-cloudflare.yml', 'docs-pages.yml', 'issue-lifecycle.yml', 'issue-policy.yml',
      'node-addon-system-release.yml', 'publish-ssh-helper.yml', 'python-release.yml', 'release-publish.yml',
      'release-vendor-publish.yml', 'weighted-approval.yml', 'weighted-approval-review-event.yml', 'windows-package.yml']) {
      expect(existsSync(resolve(root, '.github/workflows', file)), file).toBe(false)
    }
  })

  it('keeps upstream self-hosted standbys from queueing in this fork', () => {
    const workflow = loadWorkflow('.github/workflows/ci-master.yml')
    for (const name of ['serial-linux-selfhosted', 'serial-windows']) {
      const job = workflowJob(workflow, name)
      for (const repository of ['AkumaRealLabs/hallucodex-desktop', 'deepseek-harness/deepseek-harness']) {
        const enabled: unknown = runInNewContext(String(job.if), {
          github: { repository, event_name: 'push', ref: 'refs/heads/master' },
        }, { timeout: 1000 })
        expect(enabled, `${name} in ${repository}`).toBe(repository === 'deepseek-harness/deepseek-harness')
      }
    }
  })

  it('prepares bubblewrap from the pinned payload without a package transaction', () => {
    const workflow = loadWorkflow('.github/workflows/e2e.yml')
    const e2e = workflowJob(workflow, 'e2e')
    if (!Array.isArray(e2e.steps)) throw new TypeError('DeepSeek e2e workflow must define steps')

    const steps = e2e.steps.filter(isRecord)
    expect(steps.find(step => step.name === 'Prepare bubblewrap (unrestrict userns)')).toMatchObject({
      run: 'bash scripts/prepare-ci-bubblewrap.sh',
    })
    expect(JSON.stringify(steps)).not.toContain('apt-get')
  })

  it('bounds profile subprocess fan-out to the tested e2e default', () => {
    const workflow = loadWorkflow('.github/workflows/e2e.yml')
    const e2e = workflowJob(workflow, 'e2e')
    if (!Array.isArray(e2e.steps)) throw new TypeError('DeepSeek e2e workflow must define steps')

    const step = e2e.steps.filter(isRecord).find(candidate => candidate.name === 'E2E tests (real DeepSeek API)')
    expect(step).toMatchObject({ env: { DSH_E2E_MAX_WORKERS: 6 } })
  })
})

describe('Python release workflows', () => {
  it('exposes the native wheel builder to the release caller with normalized versions', () => {
    const workflow = loadWorkflow('.github/workflows/build-exe-for-python-sdk.yml')
    expect(Object.keys(workflow.on as Record<string, unknown>).sort()).toEqual(['workflow_call', 'workflow_dispatch'])
    const call = workflowEvent(workflow, 'workflow_call')
    const plan = workflowJob(workflow, 'plan')
    const build = workflowJob(workflow, 'build')
    if (!isRecord(call.inputs) || !isRecord(call.secrets) || !Array.isArray(plan.steps) || !Array.isArray(build.steps)) {
      throw new TypeError('Python wheel builder must define workflow_call inputs and plan steps')
    }

    const buildSteps: unknown[] = build.steps
    const manylinuxAddon = buildSteps.find(step => isRecord(step) && step.name === 'Rebuild Linux node-pty against manylinux 2.28')
    const macosCheck = buildSteps.find(step => isRecord(step) && step.name === 'Check macOS payload architecture and deployment target')
    const manylinuxSmoke = buildSteps.find(step => isRecord(step) && step.name === 'Run wheel in a manylinux 2.28 container')
    const cleanVenvPosix = buildSteps.find(step => isRecord(step) && step.name === 'Install local SDK and runtime wheels into a clean venv (POSIX)')
    const cleanVenvWindows = buildSteps.find(step => isRecord(step) && step.name === 'Install local SDK and runtime wheels into a clean venv (Windows)')
    const installedKeylessPosix = buildSteps.find(step => isRecord(step) && step.name === 'Run installed-wheel keyless black-box tests (POSIX)')
    const installedKeylessWindows = buildSteps.find(step => isRecord(step) && step.name === 'Run installed-wheel keyless black-box tests (Windows)')
    const realApiPreflightPosix = buildSteps.find(step => isRecord(step) && step.name === 'Preflight installed-wheel real API test (POSIX)')
    const realApiPreflightWindows = buildSteps.find(step => isRecord(step) && step.name === 'Preflight installed-wheel real API test (Windows)')
    const installedRealApiPosix = buildSteps.find(step => isRecord(step) && step.name === 'Run installed-wheel real API black-box test (POSIX)')
    const installedRealApiWindows = buildSteps.find(step => isRecord(step) && step.name === 'Run installed-wheel real API black-box test (Windows)')
    if (!isRecord(macosCheck) || typeof macosCheck.run !== 'string'
      || !isRecord(cleanVenvPosix) || !isRecord(cleanVenvWindows)
      || !isRecord(installedKeylessPosix) || !isRecord(installedKeylessWindows)
      || !isRecord(realApiPreflightPosix) || !isRecord(realApiPreflightWindows)
      || !isRecord(installedRealApiPosix) || !isRecord(installedRealApiWindows)) {
      throw new TypeError('Python wheel builder must define native POSIX and Windows installed-wheel steps')
    }
    expect(call.inputs).toHaveProperty('targets')
    expect(call.inputs).toMatchObject({
      ci: { type: 'boolean', default: false },
      release: { type: 'boolean', default: false },
    })
    expect(call.secrets).toMatchObject({
      DEEPSEEK_API_KEY_EXTERNAL: { required: false },
    })
    expect(workflow.concurrency).toMatchObject({
      group: 'build-single-exe-${{ github.workflow }}-${{ github.ref }}',
    })
    expect(build.defaults).toBeUndefined()
    expect(plan.if).toContain('inputs.ci')
    expect(plan.if).toContain('inputs.release')
    expect(JSON.stringify(plan.steps)).toContain('pep440_version')
    const workflowJson = JSON.stringify(workflow)
    expect(workflowJson).toContain('macosx_14_0_arm64')
    expect(workflowJson).toContain('macosx_14_0_x86_64')
    expect(workflowJson).toContain('node24-macos-x64')
    expect(workflowJson).toContain('macos-15-intel')
    expect(workflowJson).toContain('win_amd64')
    expect(workflowJson).toContain('node24-win-x64')
    expect(workflowJson).toContain('windows-2025')
    expect(workflowJson).toContain('dist-python/$SDK_WHEEL')
    expect(workflowJson).toContain('dist-python/$RUNTIME_WHEEL')
    expect(workflowJson).toContain('/work/dist-python/$SDK_WHEEL')
    expect(workflowJson).toContain('/work/dist-python/$RUNTIME_WHEEL')
    expect(workflowJson).not.toContain('--find-links dist-python')
    expect(workflowJson).not.toContain('--find-links /work/dist-python')
    expect(workflowJson).not.toContain('cygpath')
    expect(manylinuxAddon).toMatchObject({ if: "runner.os == 'Linux'" })
    expect(JSON.stringify(manylinuxAddon)).toContain('manylinux_2_28_x86_64')
    expect(JSON.stringify(manylinuxAddon)).toContain('manylinux_2_28_aarch64')
    expect(JSON.stringify(manylinuxAddon)).toContain('npm_config_build_from_source=true pnpm --config.verifyDepsBeforeRun=false run install')
    expect(JSON.stringify(manylinuxAddon)).toContain('pnpm_setup_root')
    expect(JSON.stringify(manylinuxAddon)).toContain('$pnpm_setup_root:$pnpm_setup_root:ro')
    expect(JSON.stringify(manylinuxAddon)).toContain('node-pty-glibc-versions.txt')
    expect(JSON.stringify(manylinuxAddon)).toContain('le 2.28')
    expect(macosCheck).toMatchObject({ if: "runner.os == 'macOS'" })
    expect(macosCheck.run).toContain('scripts/check-macos-deployment-target.py')
    expect(macosCheck.run).toContain('lipo "$payload" -verify_arch')
    expect(macosCheck.run).toContain('$EXE-rg')
    expect(macosCheck.run).toContain('$EXE-spawn-helper')
    expect(JSON.stringify(installedKeylessPosix)).toContain('--scenario all')
    expect(JSON.stringify(installedKeylessPosix)).toContain('env -u PYTHONPATH')
    expect(JSON.stringify(installedKeylessWindows)).toContain('--scenario all --installed-wheel')
    expect(installedKeylessWindows).toMatchObject({ if: "runner.os == 'Windows'", shell: 'pwsh' })
    expect(cleanVenvWindows).toMatchObject({ if: "runner.os == 'Windows'", shell: 'pwsh' })
    expect(JSON.stringify(cleanVenvWindows)).toContain('Scripts\\\\python.exe')
    expect(realApiPreflightPosix).toMatchObject({
      env: { DEEPSEEK_API_KEY: '${{ secrets.DEEPSEEK_API_KEY_EXTERNAL }}' },
    })
    expect(String(realApiPreflightPosix.if)).toContain("github.event_name == 'workflow_dispatch'")
    expect(String(realApiPreflightPosix.if)).toContain('inputs.live_api == true')
    expect(realApiPreflightWindows).toMatchObject({ shell: 'pwsh' })
    for (const step of [installedRealApiPosix, installedRealApiWindows]) {
      expect(step).toMatchObject({
        env: {
          DEEPSEEK_API_KEY: '${{ secrets.DEEPSEEK_API_KEY_EXTERNAL }}',
          DEEPSEEK_BASE_URL: 'https://api.deepseek.com/anthropic',
        },
      })
    }
    expect(JSON.stringify(installedRealApiPosix)).toContain('--scenario sdk-live')
    expect(JSON.stringify(installedRealApiPosix)).toContain('-u DSH_RUNTIME_MODE')
    expect(installedRealApiWindows).toMatchObject({ shell: 'pwsh' })
    expect(JSON.stringify(installedRealApiWindows)).toContain('--scenario sdk-live --installed-wheel')
    expect(manylinuxSmoke).toMatchObject({ if: "runner.os == 'Linux'" })
    expect(JSON.stringify(manylinuxSmoke)).toContain('-e DSH_TELEMETRY_DISABLED')
  })

  it.each([
    ['POSIX', 'posix', "runner.os != 'Windows'"],
    ['Windows', 'windows', "runner.os == 'Windows'"],
  ])('runs native command regressions through the installed %s wheels', (platform, suffix, condition) => {
    const build = workflowJob(loadWorkflow('.github/workflows/build-exe-for-python-sdk.yml'), 'build')
    if (!Array.isArray(build.steps)) throw new TypeError('Python wheel builder must define steps')
    const steps = build.steps.filter(isRecord)
    const installIndex = steps.findIndex(step => step.id === `smoke-venv-${suffix}`)
    const testIndex = steps.findIndex(step => step.name === `Run installed-wheel native command tests (${platform})`)
    expect(installIndex).toBeGreaterThanOrEqual(0)
    expect(testIndex).toBeGreaterThan(installIndex)
    const install = steps[installIndex]
    const test = steps[testIndex]
    expect(install?.run).toContain('pytest>=8.0')
    expect(test).toMatchObject({ if: condition })
    expect(test).not.toHaveProperty('continue-on-error')
    expect(test?.run).toContain(`"\${{ steps.smoke-venv-${suffix}.outputs.python }}" -I`)
    expect(test?.run).toContain('run_installed_commands.py')
    if (platform === 'Windows') {
      expect(test).toHaveProperty('shell', 'pwsh')
      expect(test?.run).toContain('if ($LASTEXITCODE -ne 0) { throw')
    }
  })

  it('uses the shared macOS deployment-target check in GitLab', () => {
    const workflow = loadWorkflow('.gitlab-ci.yml')
    const runtimeWheel = workflow['.runtime-wheel']
    if (!isRecord(runtimeWheel) || !Array.isArray(runtimeWheel.script)) {
      throw new TypeError('GitLab CI must define the runtime wheel script')
    }
    const runtimeScript: unknown[] = runtimeWheel.script
    const macosCheck = runtimeScript.find(
      step => typeof step === 'string' && step.includes('${PLATFORM#macos-}'),
    )
    if (typeof macosCheck !== 'string') {
      throw new TypeError('GitLab CI must check the macOS deployment target')
    }

    expect(macosCheck).toContain('scripts/check-macos-deployment-target.py')
    expect(macosCheck).toContain('lipo "$payload" -verify_arch')
    expect(macosCheck).toContain('"$EXE" "$EXE-rg" "$EXE-spawn-helper"')
  })

  it('builds the macOS x64 wheel on the matching GitLab runner', () => {
    const workflow = loadWorkflow('.gitlab-ci.yml')
    const macosX64 = workflow['runtime-macos-x64']
    const publish = workflow['publish-python']
    if (!isRecord(macosX64) || !isRecord(publish) || !Array.isArray(publish.needs)) {
      throw new TypeError('GitLab CI must define the macOS x64 runtime and publication jobs')
    }

    expect(macosX64.tags).toEqual(['macos-x64'])
    expect(macosX64.variables).toMatchObject({ PKG_TARGET: 'node24-macos-x64', PLATFORM: 'macos-x64' })
    expect(publish.needs).toContainEqual({ job: 'runtime-macos-x64', artifacts: true })
    expect(JSON.stringify(publish.script)).toContain('macosx_14_0_x86_64.whl')
  })

  it('builds and black-box tests the Windows x64 wheel in GitLab', () => {
    const workflow = loadWorkflow('.gitlab-ci.yml')
    const windows = workflow['runtime-windows-x64']
    const publish = workflow['publish-python']
    if (!isRecord(windows) || !Array.isArray(windows.before_script) || !Array.isArray(windows.script)
      || !isRecord(publish) || !Array.isArray(publish.needs)) {
      throw new TypeError('GitLab CI must define the Windows runtime and aggregate publication jobs')
    }

    expect(windows.tags).toEqual(['windows-x64'])
    expect(windows.variables).toMatchObject({ PKG_TARGET: 'node24-win-x64', PLATFORM: 'win-x64' })
    expect(JSON.stringify(windows.before_script)).toContain('.ci-python\\\\Scripts')
    expect(JSON.stringify(windows.before_script)).toContain('[IO.Path]::PathSeparator')
    expect(JSON.stringify(windows.script)).toContain('win_amd64.whl')
    expect(JSON.stringify(windows.script)).toContain('--scenario all --installed-wheel')
    expect(publish.needs).toContainEqual({ job: 'runtime-windows-x64', artifacts: true })
  })
})

describe('Review ownership scripts', () => {
  it('keeps the production blame scoring tests in the Python SDK job', () => {
    const pythonJob = workflowJob(loadWorkflow('.github/workflows/ci.yml'), 'python-sdk')
    expect(pythonJob.steps).toContainEqual({
      name: 'Test production blame scoring',
      run: "uv run --python 3.10 --with-requirements .github/review-ownership/requirements.txt python -m unittest discover -s .github/review-ownership -p 'test_*.py'",
    })
  })
})

describe('npm release workflows', () => {
  it('keeps credential-free pack verification in the PR workflows', () => {
    // pack stays in the PR/master release workflows so a PR proves the set packs; nothing here publishes.
    for (const file of ['release.yml', 'release-vendor.yml']) {
      const workflow = loadWorkflow(`.github/workflows/${file}`)
      if (!isRecord(workflow.jobs)) throw new TypeError(`${file} must define jobs`)
      expect(Object.keys(workflow.jobs).sort()).toEqual(file === 'release.yml' ? ['dependencies', 'pack'] : ['pack'])
      expect(JSON.stringify(workflow)).not.toMatch(/secrets\.|release:publish/u)
    }
  })

  it('runs dependency policy and npm layout checks in the DSH release workflow', () => {
    const workflow = loadWorkflow('.github/workflows/release.yml')
    const dependencies = workflowJob(workflow, 'dependencies')
    if (!isRecord(workflow.on) || !Array.isArray(dependencies.steps)) {
      throw new TypeError('DSH release workflow must define triggers and dependency steps')
    }
    const commands = dependencies.steps.flatMap(step =>
      isRecord(step) && typeof step.run === 'string' ? [step.run] : [])

    expect(Object.keys(workflow.on).sort()).toEqual(['pull_request', 'push', 'workflow_dispatch'])
    // Both verifications run from one step so the lane pays their longer half.
    const combined = commands.find(command => command.includes('verify-package-dependencies'))
    expect(combined).toContain('verify-npm-install-layout')
    expect(combined).toContain('wait "$dependencies_pid"')
    expect(commands).not.toContain('pnpm run verify-package-dependencies')
    expect(commands).not.toContain('pnpm run verify-npm-install-layout')
    expect(String(dependencies['runs-on'])).toContain('blacksmith-4vcpu-ubuntu-2404')
  })
})

describe('HalluCodex desktop release workflow', () => {
  const workflow = loadWorkflow('.github/workflows/hallucodex-desktop-release.yml')
  const steps = (name: string): Record<string, unknown>[] => {
    const job = workflowJob(workflow, name)
    if (!Array.isArray(job.steps)) throw new TypeError(`${name} must define steps`)
    return job.steps.filter(isRecord)
  }
  const runs = (name: string): string => steps(name).map(step => typeof step.run === 'string' ? step.run : '').join('\n')

  it('runs for hallucodex-v tags or manual tag/build_version inputs, never for upstream dsh-v tags', () => {
    expect(Object.keys(workflow.on as Record<string, unknown>)).toEqual(['push', 'workflow_dispatch'])
    expect(workflow.on).toMatchObject({
      push: { tags: ['hallucodex-v*'] },
      workflow_dispatch: {
        inputs: {
          tag: { required: false, type: 'string' },
          build_version: { required: false, type: 'string' },
        },
      },
    })
    expect(JSON.stringify(workflow.on)).not.toContain('dsh-v')
    expect(Object.keys(workflow.jobs as Record<string, unknown>)).toEqual(['prepare', 'package', 'release'])
    expect(workflow.concurrency).toMatchObject({ 'cancel-in-progress': false })
    expect(String((workflow.concurrency as Record<string, unknown>).group)).toContain('github.run_id')
  })

  it('validates mutually exclusive tag/build_version inputs and skips changelog and release in build-only mode', () => {
    const prepare = workflowJob(workflow, 'prepare')
    expect(prepare.outputs).toMatchObject({
      ref: '${{ steps.release.outputs.ref }}',
      tag: '${{ steps.release.outputs.tag }}',
      version: '${{ steps.release.outputs.version }}',
      prerelease: '${{ steps.release.outputs.prerelease }}',
    })
    expect(runs('prepare')).toContain('Provide either tag or build_version, not both.')
    expect(runs('prepare')).toContain('desktop-release-notes.mjs version "hallucodex-v$BUILD_VERSION"')
    expect(runs('prepare')).toContain('desktop-release-notes.mjs version "$TAG"')
    expect(runs('prepare')).toContain('--changelog CHANGELOG.md')
    expect(workflowJob(workflow, 'package').needs).toBe('prepare')
    const checkout = steps('package').find(step => typeof step.uses === 'string' && step.uses.startsWith('actions/checkout@'))
    expect(checkout).toMatchObject({ with: { ref: '${{ needs.prepare.outputs.ref }}' } })
    expect(workflowJob(workflow, 'release').if).toBe("${{ needs.prepare.outputs.tag != '' }}")
  })

  it('packages unsigned installers on hosted runners for every desktop target with the tag version', () => {
    const job = workflowJob(workflow, 'package')
    const strategy = job.strategy
    if (!isRecord(strategy) || !isRecord(strategy.matrix) || !Array.isArray(strategy.matrix.include)) {
      throw new TypeError('package must define a matrix')
    }
    expect(strategy.matrix.include.map(entry => isRecord(entry) ? [entry.target, entry.runner, entry.command] : [])).toEqual([
      ['win-x64', 'windows-2025', 'package:win:x64:unsigned'],
      ['mac-arm64', 'macos-15', 'package:mac:arm64:unsigned'],
      ['mac-x64', 'macos-15-intel', 'package:mac:x64:unsigned'],
      ['linux-x64', 'ubuntu-24.04', 'package:linux:x64'],
    ])
    expect(job.env).toMatchObject({
      VERSION: '${{ needs.prepare.outputs.version }}',
      DSH_DESKTOP_PACKAGE_SETTINGS: 'environment',
      DSH_DESKTOP_APP_ID: 'com.hallucodex.desktop',
      DSH_DESKTOP_LINUX_HOMEPAGE: 'https://github.com/AkumaRealLabs/hallucodex-desktop',
    })
    expect(runs('package')).toContain('pnpm --dir apps/desktop run "${{ matrix.command }}" --build-version "$VERSION"')
    expect(runs('package')).toContain('pnpm install --frozen-lockfile')
    expect(runs('package')).toContain('collect-release-assets.mjs --version "$VERSION"')
  })

  it('grants write access only to the job that creates the release, without repository secrets', () => {
    expect(workflow.permissions).toEqual({ contents: 'read' })
    expect(workflowJob(workflow, 'release').permissions).toEqual({ contents: 'write' })
    for (const name of ['prepare', 'package']) expect(workflowJob(workflow, name)).not.toHaveProperty('permissions')
    expect(JSON.stringify(workflow)).not.toContain('secrets.')
  })

  it('publishes collected installers, update metadata, and checksums with the changelog notes', () => {
    const release = runs('release')
    expect(release).toContain('collect-release-assets.mjs --version "$VERSION"')
    expect(release).toContain('desktop-release-notes.mjs notes --version "$VERSION"')
    expect(release).toContain('if [ "$PRERELEASE" = true ]; then flags+=(--prerelease); fi')
    expect(release).toContain('gh release create "$TAG" dist/release/*')
    expect(release).toContain('--notes-file dist/release-notes.md')
    expect(workflowJob(workflow, 'release').needs).toEqual(['prepare', 'package'])
  })
})

describe('Git hooks', () => {
  it('leaves frozen Agent Note sidecars to the archive verifier', () => {
    const lefthook = loadWorkflow('lefthook.yml')

    for (const hookName of ['pre-commit', 'pre-merge-commit']) {
      const hook = lefthook[hookName]
      if (!isRecord(hook) || !Array.isArray(hook.jobs)) {
        throw new TypeError(`lefthook must define ${hookName} jobs`)
      }
      const pairing: unknown = hook.jobs.find(
        (job: unknown) => isRecord(job) && job.name === 'translation pairing (staged records)',
      )

      expect(pairing).toMatchObject({ exclude: ['.agents/notes/archived/**'] })
    }
  })
})

function loadWorkflow(path: string): Record<string, unknown> {
  const workflow: unknown = yaml.load(readFileSync(resolve(root, path), 'utf8'))
  if (!isRecord(workflow)) throw new TypeError(`${path} must define a workflow`)
  return workflow
}

function nodeStepSource(job: Record<string, unknown>, id: string): string {
  if (!Array.isArray(job.steps)) throw new Error('Node workflow job must define steps')
  const step: unknown = job.steps.find(value => isRecord(value) && value.id === id)
  if (!isRecord(step) || typeof step.run !== 'string') throw new Error(`Missing Node workflow step: ${id}`)
  const source = step.run.split("<<'JS'\n")[1]?.split('\nJS')[0]?.replace(/^import .*;\n/gm, '')
  if (source === undefined) throw new Error(`Workflow step ${id} must contain an executable Node script`)
  return source
}

function workflowEvent(workflow: Record<string, unknown>, event: string): Record<string, unknown> {
  if (!isRecord(workflow.on) || !isRecord(workflow.on[event])) {
    throw new TypeError(`workflow must define the ${event} event`)
  }
  return workflow.on[event]
}

function workflowJob(workflow: Record<string, unknown>, job: string): Record<string, unknown> {
  if (!isRecord(workflow.jobs) || !isRecord(workflow.jobs[job])) {
    throw new TypeError(`workflow must define the ${job} job`)
  }
  return workflow.jobs[job]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
