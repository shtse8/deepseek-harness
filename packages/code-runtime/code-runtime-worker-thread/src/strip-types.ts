/**
 * Host-side TypeScript strip for code-mode programs.
 * Node provides `module.stripTypeScriptTypes`; Bun does not — fall back to
 * Bun.Transpiler so the worker-thread runtime can load on Bun.
 */
import * as nodeModule from 'node:module'

type Strip = (code: string) => string

function bunStrip(code: string): string {
  const bun = (globalThis as { Bun?: { Transpiler: new (options: { loader: string }) => { transformSync: (source: string) => string } } }).Bun
  if (bun === undefined) {
    throw new TypeError('stripTypeScriptTypes is not available on this runtime')
  }
  return new bun.Transpiler({ loader: 'ts' }).transformSync(code)
}

const native = (nodeModule as { stripTypeScriptTypes?: Strip }).stripTypeScriptTypes

/** Strip type annotations. Prefers Node's position-preserving strip when present. */
export const stripTypeScriptTypes: Strip = typeof native === 'function'
  ? native.bind(nodeModule)
  : bunStrip
