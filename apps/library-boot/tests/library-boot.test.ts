import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startLibraryHost } from '../src/boot.ts'

const BOOT_SRC = fileURLToPath(new URL('../src/boot.ts', import.meta.url))
const CLI_SRC = fileURLToPath(new URL('../src/cli.ts', import.meta.url))

test('library-boot source does not apply a Cordis profile plugin tree', () => {
  const boot = readFileSync(BOOT_SRC, 'utf8')
  const cli = readFileSync(CLI_SRC, 'utf8')
  for (const marker of [
    'dsh.profile.bundles',
    'cordis.patch.yml',
    'cordis:include',
    'cordis-plugin-loader',
    'cordis-plugin-include',
    'dsh-app-boot',
    'loadProfile',
    'profile-boot',
  ]) {
    expect(boot.includes(marker)).toBe(false)
    expect(cli.includes(marker)).toBe(false)
  }
  expect(cli.includes('startLibraryHost')).toBe(true)
})

test('startLibraryHost constructs spine libraries and serves the harness surface', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-library-boot-'))
  const host = await startLibraryHost({ port: 0, home, host: '127.0.0.1' })
  try {
    expect(host.usedCordisLoader).toBe(false)
    expect(host.usedProfileBundles).toBe(false)
    expect(host.port).not.toBe(3080)
    expect(host.spine.agentLoop.className).toBe('ReactLoopAgent')
    expect(host.spine.tools.bashToolName).toBe('tool-bash')
    expect(typeof host.spine.tools.defineTool).toBe('function')
    expect(host.spine.modelAdapter.constructor.name).toBe('DeepSeekAdapter')
    expect(host.spine.sessionLog.artifact.includes('session.jsonl')).toBe(true)

    const ui = await fetch(host.url)
    expect(ui.ok).toBe(true)
    const html = await ui.text()
    expect(html.includes('DeepSeek Harness')).toBe(true)

    const api = await fetch(`${host.url}/api/library-boot`)
    expect(api.ok).toBe(true)
    const body = await api.json() as { surface: string; dsh: boolean; usedCordisLoader: boolean }
    expect(body.surface).toBe('deepseek-harness-library-boot')
    expect(body.dsh).toBe(true)
    expect(body.usedCordisLoader).toBe(false)
  } finally {
    await host.close()
  }
})
