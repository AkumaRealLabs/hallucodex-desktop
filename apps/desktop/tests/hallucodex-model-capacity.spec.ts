import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import {
  MAX_MODEL_CAPACITY, ModelCapacitySettings, parseModelCapacityOverride, readModelCapacities,
} from '../src/hallucodex/model-capacity.ts'

async function settingsFile(): Promise<{ root: string; file: string }> {
  const root = await mkdtemp(join(tmpdir(), 'hallucodex-capacity-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  return { root, file: join(root, 'hallucodex-model-capacity.json') }
}

describe('model capacities set by the user', () => {
  it('accepts positive token counts and leaves cleared fields automatic', () => {
    expect(parseModelCapacityOverride({ contextWindow: 200_000, maxOutputTokens: 32_000 }))
      .toEqual({ contextWindow: 200_000, maxOutputTokens: 32_000 })
    expect(parseModelCapacityOverride({ contextWindow: null, maxOutputTokens: 4096 })).toEqual({ maxOutputTokens: 4096 })
    expect(parseModelCapacityOverride({ contextWindow: MAX_MODEL_CAPACITY })).toEqual({ contextWindow: MAX_MODEL_CAPACITY })
    expect(parseModelCapacityOverride({})).toEqual({})
    for (const value of [
      null, [], 'x', { contextWindow: 0 }, { contextWindow: -1 }, { contextWindow: 1.5 }, { contextWindow: '1000' },
      { maxOutputTokens: MAX_MODEL_CAPACITY + 1 }, { contextWindow: 8192, maxOutputTokens: 8193 },
    ]) expect(() => parseModelCapacityOverride(value)).toThrow('invalid model capacity')
  })

  it('keeps each server\'s capacities across restarts and restores automatic values when cleared', async () => {
    const { file } = await settingsFile()
    expect(ModelCapacitySettings.load(file).get('https://api.hallucodex.com').size).toBe(0)
    const settings = ModelCapacitySettings.load(file)
    await settings.set('https://api.hallucodex.com', 'gpt-5.1', { contextWindow: 300_000 })
    await settings.set('http://localhost:3000', 'gpt-5.1', { maxOutputTokens: 4096 })
    const reloaded = ModelCapacitySettings.load(file)
    expect([...reloaded.get('https://api.hallucodex.com')]).toEqual([['gpt-5.1', { contextWindow: 300_000 }]])
    expect([...reloaded.get('http://localhost:3000')]).toEqual([['gpt-5.1', { maxOutputTokens: 4096 }]])
    if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600)
    await reloaded.set('http://localhost:3000', 'gpt-5.1', {})
    expect(reloaded.get('http://localhost:3000').size).toBe(0)
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
      version: 1, servers: { 'https://api.hallucodex.com': { 'gpt-5.1': { contextWindow: 300_000 } } },
    })
  })

  it('applies concurrent changes in call order without losing either', async () => {
    const { file } = await settingsFile()
    const settings = ModelCapacitySettings.load(file)
    await Promise.all([
      settings.set('https://api.hallucodex.com', 'gpt-5.1', { contextWindow: 300_000 }),
      settings.set('https://api.hallucodex.com', 'glm-5.3', { maxOutputTokens: 64_000 }),
      settings.set('https://api.hallucodex.com', 'gpt-5.1', { contextWindow: 250_000 }),
    ])
    expect([...ModelCapacitySettings.load(file).get('https://api.hallucodex.com')]).toEqual([
      ['gpt-5.1', { contextWindow: 250_000 }], ['glm-5.3', { maxOutputTokens: 64_000 }],
    ])
  })

  it('applies nothing when saving fails and still runs later changes', async () => {
    const { root } = await settingsFile()
    const blocked = join(root, 'blocked')
    await writeFile(blocked, '')
    const settings = new ModelCapacitySettings(join(blocked, 'capacity.json'))
    await expect(settings.set('https://api.hallucodex.com', 'gpt-5.1', { contextWindow: 300_000 })).rejects.toThrow()
    expect(settings.get('https://api.hallucodex.com').size).toBe(0)
    await rm(blocked)
    await settings.set('https://api.hallucodex.com', 'glm-5.3', { maxOutputTokens: 64_000 })
    expect([...settings.get('https://api.hallucodex.com')]).toEqual([['glm-5.3', { maxOutputTokens: 64_000 }]])
  })

  it('reads a missing or damaged file as empty and skips invalid servers and models', async () => {
    const { file } = await settingsFile()
    expect(readModelCapacities(file).size).toBe(0)
    await writeFile(file, '{"servers":')
    expect(readModelCapacities(file).size).toBe(0)
    await writeFile(file, '{"servers":[1]}')
    expect(readModelCapacities(file).size).toBe(0)
    await writeFile(file, JSON.stringify({ version: 1, servers: {
      'HTTPS://API.HalluCodex.com/': { 'gpt-5.1': { contextWindow: 300_000 }, 'bad': { contextWindow: 0 }, 'empty': {} },
      'https://example.com/v1': { 'gpt-5.1': { contextWindow: 300_000 } },
      'http://localhost:3000': 'x',
      'http://localhost:4000': { only: { maxOutputTokens: 9, contextWindow: 8 } },
    } }))
    expect([...readModelCapacities(file)].map(([origin, models]) => [origin, [...models]])).toEqual([
      ['https://api.hallucodex.com', [['gpt-5.1', { contextWindow: 300_000 }]]],
    ])
  })
})
