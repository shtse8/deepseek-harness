/**
 * Session-header listing, runnable on the main thread or a worker thread.
 * The walk and first-frame zstd decode are the CPU that used to sit on the
 * host event loop while the sidebar roster loaded.
 */
import { open, readdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import { logPath, logSuffix, parseHeaderMeta } from './format.ts'
import type { JsonlCompression } from './format.ts'
import { decompressZstdFrame, scanZstdFrames } from './zstd.ts'

export interface SessionArtifact {
  header: SessionHeader
  path: string
}

export interface ListArtifactsRequest {
  root: string
  compression: JsonlCompression
}

function isENOENT(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

function assertZstdHeaderFrame(plaintext: Buffer): void {
  if (plaintext.length === 0 || plaintext.indexOf(0x0A) !== plaintext.length - 1) {
    throw new Error('corrupt Zstandard session log: first frame is not exactly one header line')
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await realpath(path)
    return true
  } catch (error) {
    if (isENOENT(error)) return false
    throw error
  }
}

async function sameFile(path: string, expectedPath: string): Promise<boolean> {
  try {
    const [actual, expected] = await Promise.all([realpath(path), realpath(expectedPath)])
    return actual === expected
  } catch (error) {
    if (isENOENT(error)) return false
    throw error
  }
}

async function readFirstLine(path: string): Promise<string | undefined> {
  const handle = await open(path, 'r')
  try {
    const chunks: Buffer[] = []
    const buf = Buffer.alloc(8192)
    for (;;) {
      const { bytesRead } = await handle.read(buf, 0, buf.length, null)
      if (bytesRead === 0) return undefined
      const slice = buf.subarray(0, bytesRead)
      const nl = slice.indexOf(0x0a)
      if (nl !== -1) {
        chunks.push(slice.subarray(0, nl))
        return Buffer.concat(chunks).toString('utf8')
      }
      chunks.push(Buffer.from(slice))
    }
  } finally {
    await handle.close()
  }
}

async function readFirstZstdLine(path: string): Promise<string | undefined> {
  const handle = await open(path, 'r')
  try {
    let content = Buffer.alloc(0)
    const chunk = Buffer.alloc(8192)
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null)
      if (bytesRead === 0) return undefined
      content = Buffer.concat([content, chunk.subarray(0, bytesRead)])
      const first = scanZstdFrames(content, 1).frames[0]
      if (first === undefined) continue
      let plaintext: Buffer
      try {
        plaintext = await decompressZstdFrame(content.subarray(first.start, first.end))
      } catch (error) {
        throw new Error('corrupt Zstandard session log: header frame failed validation', { cause: error })
      }
      assertZstdHeaderFrame(plaintext)
      return plaintext.subarray(0, -1).toString('utf8')
    }
  } finally {
    await handle.close()
  }
}

async function assertStoredIdentity(
  root: string,
  compression: JsonlCompression,
  path: string,
  meta: SessionHeader,
): Promise<void> {
  let expectedPath: string
  try {
    expectedPath = logPath(root, meta.cwd, meta.id, compression)
  } catch (error) {
    throw new Error(`corrupt session log "${path}": header id cannot name a storage path`, { cause: error })
  }
  if (path !== expectedPath && !await sameFile(path, expectedPath)) {
    throw new Error(`corrupt session log "${path}": header id "${meta.id}" and cwd identify "${expectedPath}"`)
  }
}

/** Walk the JSONL root and return header+path rows. Safe to run in a worker. */
export async function collectSessionArtifacts(request: ListArtifactsRequest): Promise<SessionArtifact[]> {
  const { root, compression } = request
  const opposite: JsonlCompression = compression === 'zstd' ? 'none' : 'zstd'
  const artifacts: SessionArtifact[] = []
  const ids = new Set<SessionId>()
  let projects: string[]
  try {
    const entries = await readdir(root, { withFileTypes: true })
    projects = entries.filter(entry => entry.isDirectory()).map(entry => join(root, entry.name))
  } catch (error) {
    if (isENOENT(error)) return []
    throw error
  }
  for (const project of projects) {
    const entries = await readdir(project, { withFileTypes: true })
    const legacy = entries.find(entry =>
      entry.isFile() && (entry.name.endsWith('.jsonl') || entry.name.endsWith('.jsonl.zstd')))
    if (legacy !== undefined) {
      throw new Error(
        `session artifact ${JSON.stringify(join(project, legacy.name))} uses the unsupported flat-file layout; `
        + 'use a separate root or move it into a project/session directory before loading',
      )
    }
    for (const dir of entries.filter(entry => entry.isDirectory()).map(entry => join(project, entry.name))) {
      const oppositePath = join(dir, `session${logSuffix(opposite)}`)
      if (await exists(oppositePath)) {
        throw new Error(
          `session artifact ${JSON.stringify(oppositePath)} uses ${logSuffix(opposite)}, `
          + `but this backend is configured for compression ${JSON.stringify(compression)}; `
          + 'use a separate root or select the matching compression mode',
        )
      }
      const path = join(dir, `session${logSuffix(compression)}`)
      if (!await exists(path)) continue
      const first = compression === 'zstd' ? await readFirstZstdLine(path) : await readFirstLine(path)
      if (first === undefined) continue
      const meta = parseHeaderMeta(first)
      if (meta === undefined) continue
      await assertStoredIdentity(root, compression, path, meta)
      if (ids.has(meta.id)) {
        throw new Error(`duplicate JSONL session id "${meta.id}" appears in multiple project directories`)
      }
      ids.add(meta.id)
      artifacts.push({ header: meta, path })
    }
  }
  return artifacts
}

const WORKER_HREF = new URL(
  fileURLToPath(import.meta.url).endsWith('.ts') ? './list-artifacts-worker.ts' : './list-artifacts-worker.js',
  import.meta.url,
)

/** List artifacts on a worker thread; fall back in-process if the worker cannot start. */
export async function collectSessionArtifactsOffThread(
  request: ListArtifactsRequest,
  signal?: AbortSignal,
): Promise<SessionArtifact[]> {
  signal?.throwIfAborted()
  let delivered = false
  try {
    return await new Promise<SessionArtifact[]>((resolve, reject) => {
      const worker = new Worker(WORKER_HREF, { workerData: request })
      const onAbort = (): void => {
        void worker.terminate()
        reject(signal?.reason instanceof Error ? signal.reason : new Error('list artifacts aborted'))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      worker.once('message', (message: { ok: true; artifacts: SessionArtifact[] } | { ok: false; error: string }) => {
        delivered = true
        signal?.removeEventListener('abort', onAbort)
        void worker.terminate()
        if (message.ok) resolve(message.artifacts)
        else reject(new Error(message.error))
      })
      worker.once('error', (error) => {
        signal?.removeEventListener('abort', onAbort)
        reject(error)
      })
    })
  } catch (error) {
    if (delivered || signal?.aborted) throw error
    return collectSessionArtifacts(request)
  }
}
