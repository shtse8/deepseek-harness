import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ReactLoopAgent } from '../../../packages/core/agent-loop/src/agent.ts'
import { DeepSeekAdapter } from '../../../packages/llm/llm-deepseek/src/adapter.ts'
import { createLibraryBashTool, startLibraryHost } from '../src/boot.ts'

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
    expect(host.port).not.toBe(3080)
    expect(host.spine.agentLoop).toBeInstanceOf(ReactLoopAgent)
    expect(host.spine.agentLoop.status).toBe('idle')
    expect(host.spine.agentLoop.id).toBe(host.spine.agentLoop.session.id)
    expect(host.spine.modelAdapter).toBeInstanceOf(DeepSeekAdapter)
    expect(host.spine.sessionLog.artifact.endsWith('session.jsonl')).toBe(true)

    const bash = host.spine.tools.bash
    expect(createLibraryBashTool().name).toBe(bash.name)
    expect(bash.name).toBe('bash')
    expect(typeof bash.execute).toBe('function')
    expect(bash.parameters).toBeDefined()
    const ran = await bash.execute(
      { command: 'printf library-boot', description: 'echo marker' },
      {
        callId: 'library-boot-call',
        rootCallId: 'library-boot-call',
        name: bash.name,
        arguments: { command: 'printf library-boot', description: 'echo marker' },
        signal: AbortSignal.timeout(5_000),
        token: {},
        deferContext: () => undefined,
        concludeTurn: () => undefined,
      } as never,
    )
    expect(ran).toEqual({ exitCode: 0, stdout: 'library-boot', stderr: '' })

    const ui = await fetch(host.url)
    expect(ui.ok).toBe(true)
    const html = await ui.text()
    expect(html.includes('DeepSeek Harness')).toBe(true)
    expect(html.includes('library-boot')).toBe(true)
    expect(html.includes('__ModuleLoader__')).toBe(false)
    expect(html.includes('Failed to load plugins')).toBe(false)

    const api = await fetch(`${host.url}/api/library-boot`)
    expect(api.ok).toBe(true)
    const body = await api.json() as {
      surface: string
      dsh: boolean
      spine: { agentLoop: { status: string; id: string }; tools: { bash: string } }
    }
    expect(body.surface).toBe('deepseek-harness-library-boot')
    expect(body.dsh).toBe(true)
    expect(body.spine.agentLoop.status).toBe(host.spine.agentLoop.status)
    expect(body.spine.agentLoop.id).toBe(host.spine.agentLoop.id)
    expect(body.spine.tools.bash).toBe(bash.name)
  } finally {
    await host.close()
  }
})
