import { mkdir, mkdtemp, writeFile, rename, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { loadArtifacts, OFFICIAL_ARTIFACTS } from '../src/artifacts.js';

try {
  const dir = resolve(process.env.ARTIFACTS_DIR || './circuits');
  const command = process.argv[2];
  if (command === 'download') {
    const staging = await mkdtemp(join(tmpdir(), 'gatekeeper-artifacts-'));
    try {
      for (const name of ['gatekeeper.wasm', 'gatekeeper_final.zkey'] as const) {
        const response = await fetch(`https://agentgames.zkverify.io/circuits/${name}`, { redirect: 'error', signal: AbortSignal.timeout(30_000) });
        if (!response.ok) throw new Error('DOWNLOAD_FAILED');
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.length > 4_194_304 || createHash('sha256').update(bytes).digest('hex') !== OFFICIAL_ARTIFACTS[name]) throw new Error('ARTIFACT_INTEGRITY');
        await writeFile(join(staging, name), bytes);
      }
      const require = createRequire(import.meta.url);
      const cli = join(dirname(require.resolve('snarkjs')), 'cli.cjs');
      const exportResult = spawnSync(process.execPath, [cli, 'zkey', 'export', 'verificationkey', join(staging, 'gatekeeper_final.zkey'), join(staging, 'verification_key.json')], { stdio: 'ignore', timeout: 30_000 });
      if (exportResult.status !== 0) throw new Error('VK_EXPORT_FAILED');
      await loadArtifacts(staging);
      await mkdir(dir, { recursive: true });
      for (const name of Object.keys(OFFICIAL_ARTIFACTS)) await rename(join(staging, name), join(dir, name));
    } finally { await rm(staging, { recursive: true, force: true }); }
  } else if (command !== 'verify') throw new Error('UNKNOWN_COMMAND');
  await loadArtifacts(dir);
  process.stdout.write(JSON.stringify({ event: 'official_artifacts_verified', protocol: 'groth16', curve: 'bn128' }) + '\n');
} catch {
  process.stderr.write('artifact_operation_failed\n'); process.exitCode = 1;
}
