/**
 * Library-boot host: construct the harness spine as ordinary modules
 * (agent loop, tools, session JSONL format, DeepSeek adapter, HTTP + SPA)
 * without walking the profile-bundle loader or patch-tree discovery.
 */
import { execFile } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { promisify } from 'node:util'
import { Context } from '../../../vendor/cordis/src/index.ts'
import { serveStatic } from '../../../packages/host/frontend-static/src/index.ts'
import { DeepSeekAdapter } from '../../../packages/llm/llm-deepseek/src/adapter.ts'
import { resolveRetryPolicy } from '../../../packages/llm/llm/src/retry-policy.ts'
import { credentialRef } from '../../../packages/credentials/credentials/src/index.ts'
import { getOrCreateAnonymousUserId } from '../../../packages/identity/anonymous-user-id/src/index.ts'
import { toHeaderLine, sessionDir, logPath } from '../../../packages/session/session-persistence-jsonl/src/format.ts'
import { Session, SESSION_FORMAT_VERSION, SessionId } from '../../../packages/core/session/src/index.ts'
import { ReactLoopAgent } from '../../../packages/core/agent-loop/src/agent.ts'
import { defineTool } from '../../../packages/core/tools/src/schema.ts'
import type { ToolDefinition } from '../../../packages/core/tools/src/index.ts'

const LIVE_PORT = 3080
const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url))

export interface LibraryBootOptions {
  /** Listen port. Must not be 3080. 0 lets the OS assign. */
  port: number
  /** Isolated harness home (must not be ~/.dsh). */
  home: string
  /** Absolute path to the shipped SPA index.html. */
  distIndex?: string
  /** Bind host. */
  host?: '127.0.0.1'
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
    modelAdapter: DeepSeekAdapter
    http: Server
  }
}

const execFileAsync = promisify(execFile)

/** Library bash tool: `defineTool` from dsh-tools, not a Cordis `ctx.tools.register` plugin. */
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

function renderLibraryBootPage(spine: {
  agentLoop: string
  status: string
  sessionId: string
  bash: string
  adapter: string
}): string {
  const rows = [
    ['surface', 'library-boot (Bun)'],
    ['agent loop', `${spine.agentLoop} (${spine.status})`],
    ['session', spine.sessionId],
    ['tool', spine.bash],
    ['model adapter', spine.adapter],
  ]
  const list = rows.map(([k, v]) => `<li><span>${k}</span> ${v}</li>`).join('')
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>DeepSeek Harness</title>
  <style>
    :root { color-scheme: dark; }
    body { margin: 0; font: 16px/1.45 ui-sans-serif, system-ui, sans-serif; background: #111; color: #eee; }
    main { max-width: 40rem; margin: 12vh auto; padding: 0 1.5rem; }
    h1 { font-size: 1.25rem; font-weight: 600; }
    p, li { color: #bbb; }
    span { color: #888; display: inline-block; min-width: 8.5rem; }
    a { color: #8ec8ff; }
    code { font: 13px/1.4 ui-monospace, monospace; }
  </style>
</head>
<body>
  <main>
    <h1>DeepSeek Harness</h1>
    <p>Library-boot host. This page does not load the plugin SPA (no client plugin graph).</p>
    <ul>${list}</ul>
    <p><a href="/api/library-boot"><code>/api/library-boot</code></a></p>
  </main>
</body>
</html>
`
}

function assertIsolatedHome(home: string): void {
  const live = join(homedir(), '.dsh')
  if (home === live || home.startsWith(live + '/')) {
    throw new Error('library-boot refuses ~/.dsh (live roster)')
  }
}

export async function startLibraryHost(options: LibraryBootOptions): Promise<LibraryHost> {
  assertNotLivePort(options.port)
  assertIsolatedHome(options.home)

  const distIndex = options.distIndex ?? resolveFrontendDistIndex()
  const distRoot = dirname(distIndex)
  const host = options.host ?? '127.0.0.1'
  const sessionRoot = join(options.home, 'sessions')

  const modelAdapter = new DeepSeekAdapter({
    options: () => ({
      baseURL: process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com',
      apiKeyEnv: credentialRef('DEEPSEEK_API_KEY'),
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
      const value = process.env[connection.apiKeyEnv]
      if (!value) throw new Error(`missing ${connection.apiKeyEnv}`)
      return value
    },
    resolveUserId: () => getOrCreateAnonymousUserId({ env: { ...process.env, DSH_HOME: options.home } }),
  })

  const sessionId = SessionId('session-library-boot')
  const header = {
    version: SESSION_FORMAT_VERSION,
    id: sessionId,
    createdAt: Date.now(),
    cwd: options.home,
    delegationDepth: 0,
    agentPreset: 'library-boot',
  }
  const dir = sessionDir(sessionRoot, header.cwd, header.id)
  await mkdir(dir, { recursive: true })
  const artifact = logPath(sessionRoot, header.cwd, header.id, 'none')
  await writeFile(artifact, `${JSON.stringify(toHeaderLine(header))}\n`, 'utf8')

  const session = Session.create(sessionId, undefined, header)
  const loopCtx = new Context()
  const agentLoop = new ReactLoopAgent(
    loopCtx,
    sessionId,
    { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    session,
  )
  const bashTool = createLibraryBashTool()

  const renderIndex = async (): Promise<string> => renderLibraryBootPage({
    agentLoop: agentLoop.constructor.name,
    status: agentLoop.status,
    sessionId: String(agentLoop.id),
    bash: bashTool.name,
    adapter: modelAdapter.constructor.name,
  })

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', `http://${host}`)
      if (url.pathname === '/api/library-boot') {
        const body = JSON.stringify({
          surface: 'deepseek-harness-library-boot',
          dsh: true,
          usedCordisLoader: false,
          usedProfileBundles: false,
          spine: {
            agentLoop: { class: agentLoop.constructor.name, status: agentLoop.status, id: agentLoop.id },
            tools: { bash: bashTool.name },
            sessionLog: artifact,
            modelAdapter: modelAdapter.constructor.name,
          },
        })
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(body)
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
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    }),
    spine: {
      agentLoop,
      tools: { bash: bashTool },
      sessionLog: { root: sessionRoot, artifact },
      modelAdapter,
      http: server,
    },
  }
}
