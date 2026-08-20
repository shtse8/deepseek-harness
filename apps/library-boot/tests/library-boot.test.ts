import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ReactLoopAgent } from '../../../packages/core/agent-loop/src/agent.ts'
import { MockAdapter, textResponse, toolCallResponse } from '../../../packages/core/agent-loop/tests/mock-adapter.ts'
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
    expect(html.includes('<textarea')).toBe(true)
    expect(html.includes('/api/turn')).toBe(true)
    expect(html.includes('__ModuleLoader__')).toBe(false)
    expect(html.includes('Failed to load plugins')).toBe(false)

    const api = await fetch(`${host.url}/api/library-boot`)
    expect(api.ok).toBe(true)
    const body = await api.json() as {
      surface: string
      dsh: boolean
      chat: boolean
      turn: string
      spine: { agentLoop: { status: string; id: string }; tools: { bash: string } }
    }
    expect(body.surface).toBe('deepseek-harness-library-boot')
    expect(body.dsh).toBe(true)
    expect(body.spine.agentLoop.status).toBe(host.spine.agentLoop.status)
    expect(body.spine.agentLoop.id).toBe(host.spine.agentLoop.id)
    expect(body.spine.tools.bash).toBe(bash.name)
    expect(body.chat).toBe(true)
    expect(body.turn).toBe('/api/turn')
  } finally {
    await host.close()
  }
})

test('POST /api/turn drives ReactLoopAgent to an assistant reply', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-library-boot-turn-'))
  const adapter = new MockAdapter([textResponse('library-boot-reply')])
  const host = await startLibraryHost({ port: 0, home, host: '127.0.0.1', adapter })
  try {
    const empty = await fetch(`${host.url}/api/turn`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: '   ' }),
    })
    expect(empty.status).toBe(400)

    const res = await fetch(`${host.url}/api/turn`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ prompt: 'hello' }),
    })
    expect(res.ok).toBe(true)
    const body = await res.json() as {
      ok: boolean
      status: string
      messages: { role: string; text: string }[]
    }
    expect(body.ok).toBe(true)
    expect(body.status).toBe('idle')
    expect(body.messages.some(line => line.role === 'user' && line.text === 'hello')).toBe(true)
    expect(body.messages.some(line => line.role === 'assistant' && line.text.includes('library-boot-reply'))).toBe(true)
    expect(host.spine.agentLoop.status).toBe('idle')

    const page = await (await fetch(host.url)).text()
    expect(page.includes('library-boot-reply')).toBe(true)
    expect(page.includes('__ModuleLoader__')).toBe(false)
  } finally {
    await host.close()
  }
})

test('POST /api/turn executes the library bash tool', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-library-boot-bash-'))
  const adapter = new MockAdapter([
    toolCallResponse('call-bash', 'bash', { command: 'printf library-boot', description: 'echo marker' }),
    textResponse('ran bash'),
  ])
  const host = await startLibraryHost({ port: 0, home, host: '127.0.0.1', adapter })
  try {
    const res = await fetch(`${host.url}/api/turn`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ prompt: 'run the marker' }),
    })
    expect(res.ok).toBe(true)
    const body = await res.json() as { messages: { role: string; text: string }[] }
    expect(body.messages.some(line => line.role === 'tool' && line.text.includes('library-boot'))).toBe(true)
    expect(body.messages.some(line => line.role === 'assistant' && line.text.includes('ran bash'))).toBe(true)
  } finally {
    await host.close()
  }
})
