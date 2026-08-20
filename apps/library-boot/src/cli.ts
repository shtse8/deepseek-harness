#!/usr/bin/env bun
/**
 * Bun CLI for the isolated official web host. Never binds 3080.
 */
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startLibraryHost } from './boot.ts'

const LIVE_PORT = 3080
const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url))

function argValue(flag: string, fallback: string): string {
  const index = process.argv.indexOf(flag)
  if (index === -1 || index === process.argv.length - 1) return fallback
  return process.argv[index + 1]!
}

function argValues(flag: string): string[] {
  const values: string[] = []
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] === flag && process.argv[index + 1] !== undefined) {
      values.push(process.argv[index + 1]!)
      index += 1
    }
  }
  return values
}

const port = Number(argValue('--port', process.env.DSH_LIBRARY_BOOT_PORT ?? '3099'))
if (!Number.isInteger(port) || port < 0 || port === LIVE_PORT) {
  throw new Error(`library-boot CLI refuses port ${String(port)} (live service is ${LIVE_PORT})`)
}

const home = argValue('--home', process.env.DSH_LIBRARY_BOOT_HOME ?? join(REPO_ROOT, '.dsh-library-boot'))
const trustedHosts = argValues('--trusted-host')

const host = await startLibraryHost({ port, home, host: '127.0.0.1', trustedHosts })
console.log(`dsh library-boot: ${host.url} (official web UI)`)

const stop = (): void => {
  void host.close().finally(() => process.exit(0))
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
