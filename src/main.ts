import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { loadArtifacts } from './artifacts.js';
import { loadPinnedEncoder } from './encoding.js';
import { ProcessProver } from './prover.js';
import { SQLiteStore } from './store.js';
import { KurierClient } from './zkverify.js';
import { createEngine } from './engine.js';
import { createServer } from './server.js';

export async function startService(config = loadConfig()) {
  const artifacts = await loadArtifacts(config.artifactsDir);
  const encoder = await loadPinnedEncoder({ ...(config.encodingModule ? { modulePath: config.encodingModule } : {}),
    ...(config.encodingDigest ? { sha256: config.encodingDigest } : {}) });
  const finalizer = config.apiKey && config.vkHash ? new KurierClient({ network: config.network, apiKey: config.apiKey, vkHash: config.vkHash }) : undefined;
  const store = new SQLiteStore(config.dbPath);
  const stop = new AbortController();
  // No historical-reference adapter is enabled: its authoritative lookup/binding
  // contract is unpublished. An encoder and new-proof finality alone cannot activate.
  const engine = createEngine({ store, prover: new ProcessProver(artifacts), ...(encoder ? { encoder } : {}),
    ...(finalizer ? { finalizer } : {}), shutdownSignal: stop.signal,
    maxInFlight: config.maxInFlight, proofTimeoutMs: config.proofTimeoutMs });
  const server = createServer({ secret: config.secret, agentPath: config.agentPath, bodyLimit: config.bodyLimit,
    handler: engine.handle, onOutcome: engine.onOutcome,
    onDiagnostic: diagnostic => { process.stdout.write(JSON.stringify(diagnostic) + '\n'); },
    ready: engine.ready, maxTaskAgeMs: config.maxTaskAgeMs, clockSkewMs: config.clockSkewMs, responseBudgetMs: config.responseBudgetMs });
  server.addHook('onClose', async () => { stop.abort(); store.close(); });
  try { await server.listen({ host: config.host, port: config.port }); }
  catch { await server.close(); throw new Error('STARTUP_FAILED'); }
  return { server, ready: engine.ready, stop: async () => { stop.abort(); await server.close(); } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const config = loadConfig();
    const service = await startService(config);
    process.stdout.write(JSON.stringify({ event: 'service_started', network: config.network, ready: service.ready() }) + '\n');
    let closing = false;
    const shutdown = async (): Promise<void> => {
      if (closing) return; closing = true;
      try { await service.stop(); } catch { process.exitCode = 1; }
    };
    process.once('SIGTERM', () => { void shutdown(); });
    process.once('SIGINT', () => { void shutdown(); });
  } catch {
    process.stderr.write('service_startup_failed\n');
    process.exitCode = 1;
  }
}
