import { parentPort, workerData } from 'node:worker_threads'
import { collectSessionArtifacts, type ListArtifactsRequest } from './list-artifacts.ts'

const request = workerData as ListArtifactsRequest
try {
  const artifacts = await collectSessionArtifacts(request)
  parentPort?.postMessage({ ok: true, artifacts })
} catch (error) {
  parentPort?.postMessage({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  })
}
