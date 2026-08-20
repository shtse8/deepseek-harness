/**
 * Library-boot host: construct the harness spine as ordinary modules
 * (agent loop, tools, session JSONL format, DeepSeek adapter, HTTP)
 * without walking the profile-bundle loader or patch-tree discovery.
 */
import { execFile } from 'node:child_process'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { promisify } from 'node:util'
import { Context } from '../../../vendor/cordis/src/index.ts'
import { serveStatic } from '../../../packages/host/frontend-static/src/index.ts'
import { DeepSeekAdapter } from '../../../packages/llm/llm-deepseek/src/adapter.ts'
import LlmRuntime, { createUserMessage, type LlmAdapter } from '../../../packages/llm/llm/src/index.ts'
import { resolveRetryPolicy } from '../../../packages/llm/llm/src/retry-policy.ts'
import { credentialRef } from '../../../packages/credentials/credentials/src/index.ts'
import { getOrCreateAnonymousUserId } from '../../../packages/identity/anonymous-user-id/src/index.ts'
import { toHeaderLine, sessionDir, logPath } from '../../../packages/session/session-persistence-jsonl/src/format.ts'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId } from '../../../packages/core/session/src/index.ts'
import type { Session } from '../../../packages/core/session/src/index.ts'
import SystemPrompt from '../../../packages/core/system-prompt/src/index.ts'
import ToolRuntime from '../../../packages/core/tools/src/index.ts'
import AgentRegistry from '../../../packages/core/agent/src/index.ts'
import AgentLoop from '../../../packages/core/agent-loop/src/index.ts'
import { ReactLoopAgent } from '../../../packages/core/agent-loop/src/agent.ts'
import { defineTool } from '../../../packages/core/tools/src/schema.ts'
import type { ToolDefinition } from '../../../packages/core/tools/src/index.ts'

const LIVE_PORT = 3080
const PROVIDER = 'deepseek-official'
const MODEL = 'deepseek-v4-flash'
const API_KEY_ENV = 'DEEPSEEK_API_KEY'
const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const PERSONA = [
  'You are DeepSeek Harness on the library-boot host (Bun).',
  'You have the bash tool. Work in {{cwd}}.',
  'Be concise. Use bash when a command is the shortest truthful answer.',
].join(' ')

export interface LibraryChatLine {
  role: 'user' | 'assistant' | 'tool' | 'error'
  text: string
}

export interface LibraryBootOptions {
  /** Listen port. Must not be 3080. 0 lets the OS assign. */
  port: number
  /** Isolated harness home (must not be ~/.dsh). */
  home: string
  /** Absolute path to the shipped SPA index.html. */
  distIndex?: string
  /** Bind host. */
  host?: '127.0.0.1'
  /** Injected adapter (tests). Default is DeepSeekAdapter. */
  adapter?: LlmAdapter
  /** Absolute workspace for the session; defaults to `home`. */
  cwd?: string
}

export interface LibraryHost {
  port: number
  url: string
  close: () => Promise<void>
  usedCordisLoader: false
  usedProfileBundles: false
  spine: {
    agentLoop: ReactLoopAgent
    tools: { bash: ToolDefinition }
    sessionLog: { root: string; artifact: string }
    modelAdapter: LlmAdapter
    http: Server
  }
}

const execFileAsync = promisify(execFile)

/** Library bash tool: `defineTool` from dsh-tools, registered on `ctx.tools`. */
export function createLibraryBashTool(): ToolDefinition {
  return defineTool({
    name: 'bash',
    description: 'Run a bash command in the library-boot host.',
    parameters: {
      command: { type: 'string', required: true, description: 'The bash command to execute.' },
      description: { type: 'string', required: true, description: 'Short description of the command.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          exitCode: { type: 'integer', required: true },
          stdout: { type: 'string', required: true },
          stderr: { type: 'string', required: true },
        },
      },
      render(_args, value) {
        return [{ type: 'text', text: JSON.stringify(value) }]
      },
    },
    async execute(args) {
      try {
        const result = await execFileAsync('bash', ['-lc', args.command], {
          encoding: 'utf8',
          timeout: 10_000,
          maxBuffer: 1024 * 1024,
        })
        return { exitCode: 0, stdout: result.stdout, stderr: result.stderr }
      } catch (error: unknown) {
        const failed = error as { code?: number; stdout?: string; stderr?: string; message?: string }
        return {
          exitCode: typeof failed.code === 'number' ? failed.code : 1,
          stdout: failed.stdout ?? '',
          stderr: failed.stderr ?? failed.message ?? String(error),
        }
      }
    },
  })
}

export function resolveFrontendDistIndex(): string {
  const fromEnv = process.env.DSH_FRONTEND_DIST
  const candidates = [
    fromEnv,
    join(REPO_ROOT, 'apps/web/dist/index.html'),
    join(homedir(), '.bun/install/global/node_modules/@deepseek-ai/dsh-web-frontend/dist/index.html'),
  ]
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate
  }
  throw new Error('library-boot: no shipped frontend dist/index.html found')
}

function assertNotLivePort(port: number): void {
  if (port === LIVE_PORT) {
    throw new Error(`library-boot refuses port ${LIVE_PORT} (live Node dsh)`)
  }
}

function assertIsolatedHome(home: string): void {
  const live = join(homedir(), '.dsh')
  if (home === live || home.startsWith(live + '/')) {
    throw new Error('library-boot refuses ~/.dsh (live roster)')
  }
}

function readHomeSecret(home: string, envName: string): string | undefined {
  const fromEnv = process.env[envName]
  if (fromEnv) return fromEnv
  const file = join(home, '.credentials.yaml')
  if (!existsSync(file)) return undefined
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const prefix = `${envName}:`
    if (!line.startsWith(prefix)) continue
    let value = line.slice(prefix.length).trim()
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    return value || undefined
  }
  return undefined
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function textOf(content: readonly { type: string; text?: string }[]): string {
  return content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('')
}

export function libraryTranscript(session: Session): LibraryChatLine[] {
  const lines: LibraryChatLine[] = []
  for (const event of session.events) {
    if (event.type === 'user/message') {
      const source = event.data.source
      if (source.kind !== 'user') continue
      const text = textOf(event.data.content)
      if (text !== '') lines.push({ role: 'user', text })
      continue
    }
    if (event.type === 'assistant/message') {
      const content = event.data.message.content
      const text = textOf(content)
      if (text !== '') lines.push({ role: 'assistant', text })
      for (const block of content) {
        if (block.type !== 'tool-call') continue
        lines.push({ role: 'tool', text: `${block.name} ${block.arguments}` })
      }
      continue
    }
    if (event.type === 'tool/result') {
      const text = textOf(event.data.message.content)
      if (text !== '') lines.push({ role: 'tool', text })
      continue
    }
    if (event.type === 'turn/end' && event.data.reason.kind === 'error') {
      const failure = event.data.reason.error
      lines.push({ role: 'error', text: `${failure.code}: ${failure.message}` })
    }
  }
  return lines
}

function renderLibraryBootPage(input: {
  status: string
  sessionId: string
  adapter: string
  hasApiKey: boolean
  messages: LibraryChatLine[]
}): string {
  const messages = input.messages.length === 0
    ? '<p class="empty">Send a message to start. This page does not load the plugin SPA.</p>'
    : input.messages.map((line) => (
      `<article data-role="${line.role}"><h2>${line.role}</h2><pre>${escapeHtml(line.text)}</pre></article>`
    )).join('')
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>DeepSeek Harness</title>
  <style>
    :root { color-scheme: dark; --bg: #111; --panel: #1a1a1a; --fg: #eee; --muted: #9a9a9a; --line: #2a2a2a; --accent: #8ec8ff; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: flex; flex-direction: column; font: 16px/1.45 ui-sans-serif, system-ui, sans-serif; background: var(--bg); color: var(--fg); }
    header, footer { padding: 0.85rem 1.25rem; border-bottom: 1px solid var(--line); color: var(--muted); font-size: 0.85rem; }
    footer { border-bottom: 0; border-top: 1px solid var(--line); }
    header strong { color: var(--fg); font-weight: 600; }
    #log { flex: 1; overflow: auto; padding: 1.25rem; display: grid; gap: 0.85rem; align-content: start; }
    article { background: var(--panel); border: 1px solid var(--line); border-radius: 0.6rem; padding: 0.75rem 0.9rem; }
    article h2 { margin: 0 0 0.35rem; font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); }
    article[data-role="user"] { border-color: #355; }
    article[data-role="assistant"] { border-color: #353; }
    article[data-role="error"] { border-color: #633; }
    pre { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font: 13px/1.45 ui-monospace, monospace; }
    .empty { color: var(--muted); }
    form { display: grid; grid-template-columns: 1fr auto; gap: 0.6rem; padding: 0.85rem 1.25rem 1.25rem; }
    textarea { resize: vertical; min-height: 4.5rem; padding: 0.7rem 0.8rem; border-radius: 0.5rem; border: 1px solid var(--line); background: var(--panel); color: var(--fg); font: inherit; }
    button { padding: 0.7rem 1.1rem; border-radius: 0.5rem; border: 0; background: var(--accent); color: #111; font-weight: 600; cursor: pointer; }
    button:disabled { opacity: 0.55; cursor: wait; }
    a { color: var(--accent); }
    code { font: 13px/1.4 ui-monospace, monospace; }
  </style>
</head>
<body>
  <header>
    <strong>DeepSeek Harness</strong>
    · library-boot (Bun)
    · ${escapeHtml(input.status)}
    · ${escapeHtml(input.sessionId)}
    · ${escapeHtml(input.adapter)} / ${MODEL}
    · bash
    · key ${input.hasApiKey ? 'present' : 'missing'}
  </header>
  <div id="log">${messages}</div>
  <form id="turn-form" method="post" action="/api/turn">
    <textarea name="prompt" required placeholder="Message"></textarea>
    <button type="submit">Send</button>
  </form>
  <footer>
    POST <a href="/api/turn"><code>/api/turn</code></a>
    · <a href="/api/library-boot"><code>/api/library-boot</code></a>
    · no client plugin graph
  </footer>
  <script>
    const form = document.getElementById('turn-form')
    const log = document.getElementById('log')
    const button = form.querySelector('button')
    const field = form.querySelector('textarea')
    const render = (messages) => {
      if (!messages.length) {
        log.innerHTML = '<p class="empty">Send a message to start. This page does not load the plugin SPA.</p>'
        return
      }
      log.replaceChildren()
      for (const line of messages) {
        const article = document.createElement('article')
        article.dataset.role = line.role
        const title = document.createElement('h2')
        title.textContent = line.role
        const body = document.createElement('pre')
        body.textContent = line.text
        article.append(title, body)
        log.append(article)
      }
      log.scrollTop = log.scrollHeight
    }
    form.addEventListener('submit', async (event) => {
      event.preventDefault()
      const prompt = field.value.trim()
      if (!prompt) return
      button.disabled = true
      try {
        const response = await fetch('/api/turn', {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ prompt }),
        })
        const body = await response.json()
        if (!response.ok && !body.messages) throw new Error(body.error || response.statusText)
        render(body.messages || [])
        field.value = ''
      } catch (error) {
        if (log.querySelector('.empty')) log.replaceChildren()
        const article = document.createElement('article')
        article.dataset.role = 'error'
        const title = document.createElement('h2')
        title.textContent = 'error'
        const body = document.createElement('pre')
        body.textContent = String(error && error.message || error)
        article.append(title, body)
        log.append(article)
      } finally {
        button.disabled = false
        field.focus()
      }
    })
  </script>
</body>
</html>
`
}

async function readBody(req: IncomingMessage, limit = 1_000_000): Promise<string> {
  const announced = Number(req.headers['content-length'] ?? 0)
  if (Number.isFinite(announced) && announced > limit) {
    throw Object.assign(new Error('payload too large'), { status: 413 })
  }
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > limit) throw Object.assign(new Error('payload too large'), { status: 413 })
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function parsePrompt(req: IncomingMessage, raw: string): string {
  const type = req.headers['content-type'] ?? ''
  if (type.includes('application/json')) {
    const data: unknown = raw === '' ? {} : JSON.parse(raw)
    if (typeof data !== 'object' || data === null || !('prompt' in data) || typeof data.prompt !== 'string') {
      return ''
    }
    return data.prompt
  }
  if (type.includes('application/x-www-form-urlencoded')) {
    return new URLSearchParams(raw).get('prompt') ?? ''
  }
  return raw
}

function wantsHtml(req: IncomingMessage): boolean {
  const type = req.headers['content-type'] ?? ''
  const accept = req.headers.accept ?? ''
  if (type.includes('application/x-www-form-urlencoded')) return !accept.includes('application/json')
  return accept.includes('text/html') && !accept.includes('application/json')
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

function createDeepSeekAdapter(home: string): DeepSeekAdapter {
  return new DeepSeekAdapter({
    options: () => ({
      baseURL: process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com',
      apiKeyEnv: credentialRef(API_KEY_ENV),
      defaults: { thinking: 'enabled', reasoningEffort: 'high' },
      maxTokens: 256_000,
      defaultContextWindow: 1_000_000,
      models: [
        { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash' },
        { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
      ],
      streamIdleTimeoutMs: 300_000,
      maxRequestImageBytes: 20 * 1024 * 1024,
      retryPolicy: resolveRetryPolicy(undefined, 'library-boot.deepseek'),
    }),
    resolveApiKey: async (connection) => {
      const value = readHomeSecret(home, connection.apiKeyEnv)
      if (!value) throw new Error(`missing ${connection.apiKeyEnv}`)
      return value
    },
    resolveUserId: () => getOrCreateAnonymousUserId({ env: { ...process.env, DSH_HOME: home } }),
  })
}

export async function startLibraryHost(options: LibraryBootOptions): Promise<LibraryHost> {
  assertNotLivePort(options.port)
  assertIsolatedHome(options.home)

  const distIndex = options.distIndex ?? resolveFrontendDistIndex()
  const distRoot = dirname(distIndex)
  const host = options.host ?? '127.0.0.1'
  const sessionRoot = join(options.home, 'sessions')
  const cwd = options.cwd ?? options.home
  const modelAdapter = options.adapter ?? createDeepSeekAdapter(options.home)
  const bashTool = createLibraryBashTool()
  const hasApiKey = Boolean(readHomeSecret(options.home, API_KEY_ENV) || options.adapter)

  const sessionId = SessionId('session-library-boot')
  const header = {
    version: SESSION_FORMAT_VERSION,
    id: sessionId,
    createdAt: Date.now(),
    cwd,
    delegationDepth: 0,
    agentPreset: 'library-boot',
  }
  const dir = sessionDir(sessionRoot, header.cwd, header.id)
  await mkdir(dir, { recursive: true })
  const artifact = logPath(sessionRoot, header.cwd, header.id, 'none')
  await writeFile(artifact, `${JSON.stringify(toHeaderLine(header))}\n`, 'utf8')

  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: PERSONA })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter([PROVIDER], modelAdapter)
  ctx.tools.register(bashTool)

  const created = ctx.agentLoop.create(sessionId, { provider: PROVIDER, model: MODEL }, { cwd })
  if (!(created instanceof ReactLoopAgent)) {
    throw new Error(`library-boot: expected ReactLoopAgent, got ${created.constructor.name}`)
  }
  const agentLoop = created

  let turnGate = Promise.resolve()
  const runTurn = async (prompt: string): Promise<LibraryChatLine[]> => {
    const previous = turnGate
    let release = (): void => {}
    turnGate = new Promise<void>((resolve) => { release = resolve })
    await previous
    try {
      agentLoop.followup(createUserMessage({
        content: [{ type: 'text', text: prompt }],
        source: { kind: 'user' },
      }))
      await agentLoop.whenIdle()
      return libraryTranscript(agentLoop.session)
    } finally {
      release()
    }
  }

  const statusPayload = () => ({
    surface: 'deepseek-harness-library-boot',
    dsh: true,
    usedCordisLoader: false,
    usedProfileBundles: false,
    chat: true,
    turn: '/api/turn',
    credentials: { [API_KEY_ENV]: hasApiKey },
    spine: {
      agentLoop: { class: agentLoop.constructor.name, status: agentLoop.status, id: agentLoop.id },
      tools: { bash: bashTool.name },
      sessionLog: artifact,
      modelAdapter: modelAdapter.constructor.name,
      provider: PROVIDER,
      model: MODEL,
    },
  })

  const renderIndex = async (): Promise<string> => renderLibraryBootPage({
    status: agentLoop.status,
    sessionId: String(agentLoop.id),
    adapter: modelAdapter.constructor.name,
    hasApiKey,
    messages: libraryTranscript(agentLoop.session),
  })

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', `http://${host}`)
      if (url.pathname === '/api/library-boot') {
        sendJson(res, 200, statusPayload())
        return
      }
      if (url.pathname === '/api/session' && (req.method === 'GET' || req.method === 'HEAD')) {
        sendJson(res, 200, {
          status: agentLoop.status,
          sessionId: agentLoop.id,
          messages: libraryTranscript(agentLoop.session),
        })
        return
      }
      if (url.pathname === '/api/turn' && req.method === 'POST') {
        let prompt: string
        try {
          prompt = parsePrompt(req, await readBody(req)).trim()
        } catch (error: unknown) {
          const status = typeof error === 'object' && error !== null && 'status' in error
            && typeof error.status === 'number' ? error.status : 400
          sendJson(res, status, { error: error instanceof Error ? error.message : String(error) })
          return
        }
        if (prompt === '') {
          sendJson(res, 400, { error: 'prompt is required' })
          return
        }
        try {
          const messages = await runTurn(prompt)
          if (wantsHtml(req)) {
            res.writeHead(303, { location: '/' })
            res.end()
            return
          }
          sendJson(res, 200, {
            ok: true,
            status: agentLoop.status,
            sessionId: agentLoop.id,
            messages,
          })
        } catch (error: unknown) {
          sendJson(res, 500, {
            error: error instanceof Error ? error.message : String(error),
            messages: libraryTranscript(agentLoop.session),
          })
        }
        return
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405)
        res.end()
        return
      }
      await serveStatic(decodeURIComponent(url.pathname), res, distRoot, distIndex, renderIndex)
    })().catch((error: unknown) => {
      if (!res.headersSent) {
        res.writeHead(500)
        res.end(error instanceof Error ? error.message : String(error))
      }
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port, host, () => resolve())
  })
  const address = server.address()
  if (address === null || typeof address === 'string') {
    server.close()
    throw new Error('library-boot: failed to bind TCP port')
  }
  assertNotLivePort(address.port)

  return {
    port: address.port,
    url: `http://${host}:${address.port}`,
    usedCordisLoader: false,
    usedProfileBundles: false,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve())
      })
      await ctx.fiber.dispose()
    },
    spine: {
      agentLoop,
      tools: { bash: bashTool },
      sessionLog: { root: sessionRoot, artifact },
      modelAdapter,
      http: server,
    },
  }
}
