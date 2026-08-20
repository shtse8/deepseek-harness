/**
 * Library-boot host: official `dsh web` (same SPA, same plugin UI) on an
 * isolated home and a port that is never 3080.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const LIVE_PORT = 3080
const READY_RE = /dsh web: (http:\/\/127\.0\.0\.1:(\d+))/
const DEFAULT_TRUSTED_HOST = 'lib.kylet.se'

export interface LibraryBootOptions {
  /** Listen port. Must not be 3080. 0 lets the OS assign. */
  port: number
  /** Isolated harness home (must not be ~/.dsh). */
  home: string
  /** Bind is always loopback; official dsh web refuses 0.0.0.0. */
  host?: '127.0.0.1'
  /** Extra `--trusted-host` authorities. Default includes lib.kylet.se. */
  trustedHosts?: string[]
  /** Absolute `dsh` binary. */
  dshBin?: string
  /** Workspace for the isolated web host. */
  cwd?: string
}

export interface LibraryHost {
  port: number
  url: string
  close: () => Promise<void>
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

export function resolveDshBin(): string {
  const fromEnv = process.env.DSH_BIN
  const candidates = [
    fromEnv,
    join(homedir(), '.bun/bin/dsh'),
    join(homedir(), '.local/bin/dsh'),
  ]
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate
  }
  throw new Error('library-boot: dsh binary not found')
}

function waitForReady(child: ChildProcess, log: { text: string }): Promise<{ url: string; port: number }> {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (error?: Error, value?: { url: string; port: number }): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.off('exit', onExit)
      child.off('error', onError)
      if (error) {
        child.stdout?.off('data', onData)
        child.stderr?.off('data', onData)
        reject(error)
      } else {
        resolve(value!)
      }
    }
    const onData = (chunk: Buffer | string): void => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      log.text += text
      process.stdout.write(text)
      const match = log.text.match(READY_RE)
      if (match?.[1] && match[2]) {
        const port = Number(match[2])
        assertNotLivePort(port)
        finish(undefined, { url: match[1], port })
      }
    }
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      finish(new Error(`library-boot: dsh web exited code=${String(code)} signal=${String(signal)}\n${log.text}`))
    }
    const onError = (error: Error): void => { finish(error) }
    const timer = setTimeout(() => {
      finish(new Error(`library-boot: timed out waiting for dsh web\n${log.text}`))
    }, 45_000)
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.once('exit', onExit)
    child.once('error', onError)
  })
}

export async function startLibraryHost(options: LibraryBootOptions): Promise<LibraryHost> {
  assertNotLivePort(options.port)
  assertIsolatedHome(options.home)

  const dshBin = options.dshBin ?? resolveDshBin()
  const trustedHosts = [...new Set([
    DEFAULT_TRUSTED_HOST,
    ...options.trustedHosts ?? [],
  ])]
  const args = [
    dshBin,
    'web',
    '--no-open',
    '--port', String(options.port),
    ...trustedHosts.flatMap(host => ['--trusted-host', host]),
  ]
  const log = { text: '' }
  const child = spawn('node', args, {
    env: {
      ...process.env,
      DSH_HOME: options.home,
      DSH_CWD: options.cwd ?? process.env.DSH_CWD ?? join(homedir(), 'projects'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  try {
    const ready = await waitForReady(child, log)
    return {
      port: ready.port,
      url: ready.url,
      close: () => new Promise((resolve, reject) => {
        const done = (): void => resolve()
        child.once('exit', done)
        child.kill('SIGTERM')
        setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
        }, 3_000).unref()
        child.once('error', reject)
      }),
    }
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    throw error
  }
}
