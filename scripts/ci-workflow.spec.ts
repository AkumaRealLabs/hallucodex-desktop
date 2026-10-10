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
  it('keeps at most ten worker jobs active while runtime targets follow the SDK suite', () => {
    const ci = loadWorkflow('.github/workflows/ci.yml')
    const compatibility = workflowJob(ci, 'node-compat')
    const runtime = workflowJob(ci, 'python-runtime')
    if (!isRecord(ci.jobs) || !isRecord(compatibility.strategy) || !isRecord(runtime.with)) {
      throw new TypeError('CI must define jobs, compatibility scheduling, and runtime inputs')
    }
    const compatibilityLimit = compatibility.strategy['max-parallel']
    const targets = runtime.with.targets
    if (typeof compatibilityLimit !== 'number' || typeof targets !== 'string') {
      throw new TypeError('CI requires a numeric compatibility limit and explicit runtime targets')
    }
    expect(Number.isInteger(compatibilityLimit)).toBe(true)
    expect(compatibilityLimit).toBeGreaterThan(0)
    expect(compatibility.strategy).toMatchObject({
      'fail-fast': false,
      matrix: { include: [{ node: '22.19' }, { node: '24.9' }, { node: 26 }] },
    })
    expect(workflowJob(ci, 'all-checks-passed').needs).toContain('node-compat')
    const ordinaryJobs = Object.entries(ci.jobs)
      .filter(([name]) => !['node-compat', 'python-runtime', 'all-checks-passed'].includes(name))
    for (const [name, job] of ordinaryJobs) {
      if (!isRecord(job)) throw new TypeError(`${name} must define a job`)
      expect(job).not.toHaveProperty('strategy')
      expect(job).not.toHaveProperty('uses')
    }
    expect(ordinaryJobs.map(([name]) => name)).toContain('python-sdk')
    expect(runtime.needs).toBe('python-sdk')
    expect(runtime.strategy).toBeUndefined()
    expect(runtime.with).toMatchObject({ targets: 'node24-linux-x64,node24-win-x64' })
    expect(runtime.uses).toBe('./.github/workflows/build-exe-for-python-sdk.yml')

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

    const beforeSdk = ordinaryJobs.length + compatibilityLimit
    const afterSdk = ordinaryJobs.length - 1 + compatibilityLimit + Math.max(1, targets.split(',').length)
    expect(beforeSdk).toBeLessThanOrEqual(10)
    expect(afterSdk).toBeLessThanOrEqual(10)
  })

  it('retains aggregate diagnostics in required builds', () => {
    const ci = loadWorkflow('.github/workflows/ci.yml')
    for (const [name, command] of [
      ['node-24-consumers', 'pnpm run check:ci:consumers'],
      ['windows-build', 'pnpm run check:ci:windows-blocking'],
    ] as const) {
      const job = workflowJob(ci, name)
      expect(job.steps).toContainEqual(expect.objectContaining({ run: command }))
    }
    const scripts = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
    expect(scripts.scripts['build:lib:host']).toContain('tsc -b tsconfig.host.json')
    expect(scripts.scripts['build:lib:client']).toContain('tsc -b tsconfig.client.json')
    expect(scripts.scripts.typecheck).toBe('npm run build:lib:host && npm run typecheck:contracts-ready')
  })

  it('selects artifact builds only for PR release and API rehearsals', () => {
    const official = "${{ github.event_name == 'pull_request' && 'pnpm run build --artifacts-only --profile official' || 'pnpm run build:official' }}"
    const vendor = "${{ github.event_name == 'pull_request' && 'pnpm exec tsx scripts/compile-referenced-projects.ts host-libraries' || 'pnpm run build:lib:host' }}"
    for (const [file, jobName, expected] of [
      ['release.yml', 'pack', official],
      ['release-vendor.yml', 'pack', vendor],
      ['e2e.yml', 'e2e', official],
    ] as const) {
      const job = workflowJob(loadWorkflow('.github/workflows/' + file), jobName)
      if (!Array.isArray(job.steps)) throw new TypeError(`${jobName} must define steps`)
      const step = job.steps.filter(isRecord).find(candidate => typeof candidate.run === 'string'
        && (candidate.run.includes('--artifacts-only') || candidate.run.includes('host-libraries')))
      expect(step?.run).toBe(expected)
      for (const event of ['pull_request', 'push', 'workflow_dispatch']) {
        const expression = expected.slice('${{ '.length, -' }}'.length)
        const selected: unknown = runInNewContext(expression, { github: { event_name: event } }, { timeout: 1000 })
        expect(selected).toBe(event === 'pull_request'
          ? file === 'release-vendor.yml'
            ? 'pnpm exec tsx scripts/compile-referenced-projects.ts host-libraries'
            : 'pnpm run build --artifacts-only --profile official'
          : file === 'release-vendor.yml' ? 'pnpm run build:lib:host' : 'pnpm run build:official')
      }
    }
  })

  it('selects PR artifact compilation inside the Python executable builder', () => {
    const job = workflowJob(loadWorkflow('.github/workflows/build-exe-for-python-sdk.yml'), 'build')
    if (!Array.isArray(job.steps)) throw new TypeError('Python runtime builder must define steps')
    const steps = job.steps.filter(isRecord)
    const execute = steps.find(step => step.name === 'Build single-exe')
    expect(steps.some(step => step.run === 'pnpm run build --artifacts-only')).toBe(false)
    expect(execute).toMatchObject({
      env: { DSH_BUILD_CLIENT_PROFILE: 'official' },
    })
    if (typeof execute?.run !== 'string') throw new TypeError('Python executable builder must define a command')
    const expression = [...execute.run.matchAll(/\$\{\{ ([^{}]+) \}\}/g)]
      .map(match => match[1]).find(value => value?.startsWith('inputs.ci'))
    expect(expression).toBe("inputs.ci && github.event_name == 'pull_request' && '--artifacts-only' || ''")
    if (expression === undefined) throw new TypeError('Python executable builder must select its build mode')
    for (const ci of [false, true]) {
      for (const event of ['pull_request', 'push', 'workflow_dispatch']) {
        const context = { inputs: { ci }, github: { event_name: event } }
        const selected: unknown = runInNewContext(expression, context, { timeout: 1000 })
        expect(selected).toBe(ci && event === 'pull_request' ? '--artifacts-only' : '')
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
    const coverage = workflowJob(loadWorkflow('.github/workflows/ci.yml'), 'windows-coverage')
    const wine = workflowJob(loadWorkflow('.github/workflows/ci-master.yml'), 'windows')
    expect(coverage.steps).toContainEqual(expect.objectContaining({
      name: 'Save coverage duration history', if: '${{ !cancelled() }}',
    }))
    expect(wine.steps).toContainEqual(expect.objectContaining({ name: 'Shut down wineserver', if: 'always()' }))
  })

  it.each([
    ['node-24-coverage', 'Linux', 'LINUX', 'pnpm run check:ci:coverage'],
    ['windows-coverage', 'Windows', 'WINDOWS', 'pnpm run check:ci:coverage'],
  ])('reuses %s coverage timings only within its platform and runner pool', (jobName, platform, variable, command) => {
    const job = workflowJob(loadWorkflow('.github/workflows/ci.yml'), jobName)
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
    const files = ['.github/workflows/ci.yml', '.github/workflows/ci-master.yml']
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

  it.each(['node-24', 'node-24-coverage', 'node-24-consumers'])(
    '%s keeps tool and fixture temporary files under runner cleanup',
    (jobName) => {
      const job = workflowJob(loadWorkflow('.github/workflows/ci.yml'), jobName)
      if (!Array.isArray(job.steps)) throw new TypeError(`${jobName} must define steps`)
      expect(job.steps[0]).toEqual({
        name: 'Use runner-owned temporary storage',
        run: [
          'echo "TMPDIR=${{ runner.temp }}" >> "$GITHUB_ENV"',
          ...(jobName === 'node-24-consumers'
            ? ['echo "PLAYWRIGHT_BROWSERS_PATH=${RUNNER_TEMP%/*}/ms-playwright" >> "$GITHUB_ENV"']
            : []),
          '',
        ].join('\n'),
      })
      if (jobName === 'node-24-consumers') {
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

  it('keeps split native Windows PR jobs with failover, plus a master-only standby', () => {
    const workflow = loadWorkflow('.github/workflows/ci.yml')
    const masterWorkflow = loadWorkflow('.github/workflows/ci-master.yml')
    if (!isRecord(workflow.jobs)
      || !isRecord(workflow.jobs['windows-build'])
      || !isRecord(workflow.jobs['windows-coverage'])
      || !isRecord(workflow.jobs['windows-native-tests'])
      || !isRecord(workflow.jobs['node-24'])
      || !isRecord(workflow.jobs['node-24-coverage'])
      || !isRecord(workflow.jobs['node-24-bench'])
      || !isRecord(workflow.jobs['node-24-consumers'])
      || !isRecord(workflow.jobs['node-compat'])
      || !isRecord(workflow.jobs['all-checks-passed'])
      || !isRecord(masterWorkflow.jobs)
      || !isRecord(masterWorkflow.jobs['serial-windows'])) {
      throw new TypeError('CI workflow must define windows-build, windows-coverage, windows-native-tests, node-24, node-24-coverage, node-24-bench, node-24-consumers, node-compat, and all-checks-passed; ci-master must define serial-windows')
    }

    const windowsBuild = workflow.jobs['windows-build']
    const windowsCoverage = workflow.jobs['windows-coverage']
    const windowsNativeTests = workflow.jobs['windows-native-tests']
    const serialWindows = masterWorkflow.jobs['serial-windows']
    const node24 = workflow.jobs['node-24']
    const node24Coverage = workflow.jobs['node-24-coverage']
    const node24Bench = workflow.jobs['node-24-bench']
    const node24Consumers = workflow.jobs['node-24-consumers']
    const nodeCompat = workflow.jobs['node-compat']
    const aggregate = workflow.jobs['all-checks-passed']
    if (!Array.isArray(aggregate.needs)) {
      throw new TypeError('CI aggregate must define needs')
    }
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

    expect(workflow.jobs['windows-observational']).toBeUndefined()
    expect(windowsBuild['continue-on-error']).not.toBe(true)
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

    // windows-coverage is temporarily non-blocking while Windows ACP
    // half-close tests are stabilized; observational stays out too.
    expect(aggregate.needs).not.toContain('windows')
    expect(aggregate.needs).toContain('windows-build')
    // The benchmark lane is a required verdict input and runs alone so its
    // wall-clock budgets never share a runner with a concurrent aggregate.
    expect(aggregate.needs).toContain('node-24-bench')
    expect(node24Bench.name).toBe('node 24 / benchmarks')
    expect(node24Bench.env).toBeUndefined()
    expect(node24Bench.steps).toContainEqual({
      name: 'Install benchmark browser and hosted dependencies',
      run: 'pnpm --filter @deepseek-ai/dsh-benchmarks exec playwright install --with-deps chromium',
    })
    expect(JSON.stringify(node24Bench.steps)).not.toContain('DSH_CI_FAILOVER_LINUX')
    expect(node24Bench.steps).toContainEqual({
      name: 'Run performance benchmarks',
      env: { DSH_GATE_VERBOSE: '1' },
      run: 'pnpm run check:ci:bench',
    })
    expect(aggregate.needs).not.toContain('windows-coverage')
    expect(aggregate.needs).toContain('windows-native-tests')
    expect(aggregate.needs).not.toContain('windows-observational')
    expect(aggregate.needs).not.toContain('serial-windows')

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

  it('runs required benchmarks on standard hosted Linux independently of failover', () => {
    const workflow = loadWorkflow('.github/workflows/ci.yml')
    const benchmark = workflowJob(workflow, 'node-24-bench')
    const aggregate = workflowJob(workflow, 'all-checks-passed')

    expect(benchmark['runs-on']).toBe('ubuntu-24.04')
    expect(benchmark.if).toBe("github.event_name == 'pull_request'")
    expect(benchmark.needs).toBeUndefined()
    expect(benchmark['continue-on-error']).toBeUndefined()
    expect(benchmark.env).toBeUndefined()
    expect(aggregate.needs).toContain('node-24-bench')
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

  it('bounds the complete benchmark job to twenty minutes', () => {
    const benchmark = workflowJob(loadWorkflow('.github/workflows/ci.yml'), 'node-24-bench')

    expect(benchmark['timeout-minutes']).toBe(20)
    expect(benchmark.steps).toContainEqual({
      name: 'Run performance benchmarks',
      env: { DSH_GATE_VERBOSE: '1' },
      run: 'pnpm run check:ci:bench',
    })
  })

  it('publishes the scaled benchmark report even when a budget fails', () => {
    const benchmark = workflowJob(loadWorkflow('.github/workflows/ci.yml'), 'node-24-bench')
    if (!Array.isArray(benchmark.steps)) throw new TypeError('benchmark job must define steps')

    expect(benchmark.steps).toContainEqual({
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

    const uploadIndex = benchmark.steps.findIndex(step => isRecord(step) && step.name === 'Upload scaled benchmark report')
    const benchmarkIndex = benchmark.steps.findIndex(step => isRecord(step) && step.name === 'Run performance benchmarks')
    expect(uploadIndex).toBeGreaterThan(benchmarkIndex)
  })

  it('gives the Wine Host TypeScript compile the repository heap budget', () => {
    const wineGates = readFileSync(resolve(root, 'scripts/wine-windows-gates.sh'), 'utf8')

    expect(wineGates).toContain(
      'wine_node "$scratch/logs/host-tsc.log" --max-old-space-size=4096 "$tsc_js" -b tsconfig.host.json --pretty false',
    )
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
      [prWorkflow, 'node-24-consumers'],
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

  it('requires release-shaped Python runtime validation on Linux and Windows x64', () => {
    const workflow = loadWorkflow('.github/workflows/ci.yml')
    const pythonRuntime = workflowJob(workflow, 'python-runtime')
    const aggregate = workflowJob(workflow, 'all-checks-passed')
    if (!Array.isArray(aggregate.needs)) {
      throw new TypeError('CI aggregate must define required job dependencies')
    }

    expect(pythonRuntime).toMatchObject({
      if: "github.event_name == 'pull_request'",
      name: 'python runtime / release-shaped matrix',
      uses: './.github/workflows/build-exe-for-python-sdk.yml',
      with: {
        targets: 'node24-linux-x64,node24-win-x64',
        ci: true,
      },
    })
    expect(aggregate.needs).toContain('python-runtime')
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
    for (const [target, runner, variable, blacksmith] of [
      ['node24-linux-x64', 'ubuntu-latest', 'DSH_CI_FAILOVER_LINUX', 'blacksmith-2vcpu-ubuntu-2404'],
      ['node24-win-x64', 'windows-2025', 'DSH_CI_FAILOVER_WINDOWS', 'blacksmith-2vcpu-windows-2025'],
      ['node24-linux-arm64', 'ubuntu-24.04-arm', 'DSH_CI_FAILOVER_LINUX', 'ubuntu-24.04-arm'],
      ['node24-macos-arm64', 'macos-latest', 'DSH_CI_FAILOVER_LINUX', 'macos-latest'],
      ['node24-macos-x64', 'macos-15-intel', 'DSH_CI_FAILOVER_LINUX', 'macos-15-intel'],
    ] as const) {
      for (const ci of [false, true]) {
        for (const release of [false, true]) {
          for (const mode of ['', 'selfhosted', 'unexpected', 'blacksmith']) {
            const vars = { DSH_CI_FAILOVER_LINUX: 'blacksmith', DSH_CI_FAILOVER_WINDOWS: 'blacksmith', [variable]: mode }
            expect(evaluateRunsOn(build['runs-on'], { inputs: { ci, release }, vars, matrix: { target, runner } }), `${target} ci=${ci} release=${release} mode=${mode}`)
              .toBe(ci && !release && mode === 'blacksmith' ? blacksmith : runner)
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

  it('keeps reusable Python CI keyless unless a manual caller explicitly opts in', () => {
    for (const name of ['ci.yml']) {
      const caller = workflowJob(loadWorkflow('.github/workflows/' + name), 'python-runtime')
      expect(caller.secrets).toBeUndefined()
      expect(caller.with).not.toHaveProperty('live_api')
      expect(JSON.stringify(caller)).not.toContain('secrets.')
    }
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
    expect(step).toMatchObject({ env: { DSH_E2E_MAX_WORKERS: 4 } })
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
    expect(commands).toContain('pnpm run verify-package-dependencies')
    expect(commands).toContain('pnpm run verify-npm-install-layout')
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

  it('runs only for hallucodex-v tags or a manual tag, never for upstream dsh-v tags', () => {
    expect(Object.keys(workflow.on as Record<string, unknown>)).toEqual(['push', 'workflow_dispatch'])
    expect(workflow.on).toMatchObject({
      push: { tags: ['hallucodex-v*'] },
      workflow_dispatch: { inputs: { tag: { required: true, type: 'string' } } },
    })
    expect(JSON.stringify(workflow.on)).not.toContain('dsh-v')
    expect(Object.keys(workflow.jobs as Record<string, unknown>)).toEqual(['prepare', 'package', 'release'])
  })

  it('validates the tag and changelog section before building', () => {
    expect(runs('prepare')).toContain('desktop-release-notes.mjs version "$TAG"')
    expect(runs('prepare')).toContain('--changelog CHANGELOG.md')
    expect(workflowJob(workflow, 'package').needs).toBe('prepare')
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
