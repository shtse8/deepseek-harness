/**
 * Library-boot host: construct the harness spine as ordinary modules
 * (agent loop, tools, session JSONL format, DeepSeek adapter, HTTP + SPA)
 * without walking the profile-bundle loader or patch-tree discovery.
 */
import { createServer, type Server } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { serveStatic } from '../../../packages/host/frontend-static/src/index.ts'
import { DeepSeekAdapter } from '../../../packages/llm/llm-deepseek/src/adapter.ts'
import { resolveRetryPolicy } from '../../../packages/llm/llm/src/retry-policy.ts'
import { credentialRef } from '../../../packages/credentials/credentials/src/index.ts'
import { getOrCreateAnonymousUserId } from '../../../packages/identity/anonymous-user-id/src/index.ts'
import { toHeaderLine, sessionDir, logPath } from '../../../packages/session/session-persistence-jsonl/src/format.ts'
import { SESSION_FORMAT_VERSION, type SessionHeader, type SessionId } from '../../../packages/core/session/src/types.ts'
import { DEFAULT_MAX_PARALLEL_TOOL_CALLS } from '../../../packages/core/agent-loop/src/constants.ts'
import { ReactLoopAgent } from '../../../packages/core/agent-loop/src/agent.ts'
import { defineTool } from '../../../packages/core/tools/src/schema.ts'
import { name as bashToolName } from '../../../packages/shell/tool-bash/src/index.ts'

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
    agentLoop: { className: string; maxParallelToolCalls: number }
    tools: { defineTool: typeof defineTool; bashToolName: string }
    sessionLog: { root: string; artifact: string }
    modelAdapter: DeepSeekAdapter
    http: Server
  }
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

  const sessionId = 'session-library-boot' as SessionId
  const header: SessionHeader = {
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

  const renderIndex = async (): Promise<string> => {
    const { readFile } = await import('node:fs/promises')
    return readFile(distIndex, 'utf8')
  }

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
            agentLoop: ReactLoopAgent.name,
            tools: bashToolName,
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
      agentLoop: {
        className: ReactLoopAgent.name,
        maxParallelToolCalls: DEFAULT_MAX_PARALLEL_TOOL_CALLS,
      },
      tools: { defineTool, bashToolName },
      sessionLog: { root: sessionRoot, artifact },
      modelAdapter,
      http: server,
    },
  }
}
