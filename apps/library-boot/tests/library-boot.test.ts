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

test('startLibraryHost refuses the live port and live home', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-library-boot-'))
  await expect(startLibraryHost({ port: 3080, home })).rejects.toThrow(/refuses port 3080/)
})

test('startLibraryHost serves the official DeepSeek Harness SPA', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-library-boot-'))
  const host = await startLibraryHost({ port: 0, home, host: '127.0.0.1' })
  try {
    expect(host.port).not.toBe(3080)
    const ui = await fetch(host.url)
    expect(ui.ok).toBe(true)
    const html = await ui.text()
    expect(html.includes('DeepSeek Harness')).toBe(true)
    expect(html.includes('__ModuleLoader__')).toBe(true)
    expect(html.includes('__DSH_BOOT__')).toBe(true)
    expect(html.includes('/plugins/')).toBe(true)
    expect(html.includes('Send a message to start')).toBe(false)
    expect(html.includes('Failed to load plugins')).toBe(false)
  } finally {
    await host.close()
  }
}, 60_000)
