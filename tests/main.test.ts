import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

test('entrypoint refuses startup without a dashboard secret and emits no configuration values', () => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: { PATH: process.env.PATH ?? '', NODE_ENV: 'test' }, encoding: 'utf8', timeout: 10_000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^service_startup_failed\n$/);
  assert.equal(result.stdout, '');
});

test('hosted entrypoint emits sanitized rejection diagnostics through its real HTTP listener', () => {
  const directory = mkdtempSync(join(tmpdir(), 'gatekeeper-diagnostic-main-'));
  const secret = randomBytes(32).toString('hex');
  const script = `
    import { startService } from './src/main.ts';
    import { loadConfig } from './src/config.ts';
    import { createHmac } from 'node:crypto';
    const service = await startService({ ...loadConfig(), port: 0 });
    try {
      const address = service.server.server.address();
      const body = '{' + process.env.AGENT_GAMES_HMAC_SECRET;
      const signature = createHmac('sha256', process.env.AGENT_GAMES_HMAC_SECRET).update(body).digest('hex');
      const response = await fetch('http://127.0.0.1:' + address.port + '/agent', {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-agent-games-signature': signature },
        body, signal: AbortSignal.timeout(3000),
      });
      const result = await response.json();
      if (response.status !== 400 || result.reason_code !== 'INVALID_JSON') throw new Error('WRONG_RESPONSE');
    } finally { await service.stop(); }
  `;
  try {
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', TMPDIR: directory,
        NODE_ENV: 'test', AGENT_GAMES_HMAC_SECRET: secret, ZKVERIFY_NETWORK: 'testnet',
        DB_PATH: join(directory, 'test.sqlite'), ARTIFACTS_DIR: fileURLToPath(new URL('../circuits', import.meta.url)) },
      encoding: 'utf8', timeout: 10_000,
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout.includes(secret), false);
    assert.equal(result.stderr.includes(secret), false);
    assert.deepEqual(result.stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)), [
      { event: 'request_rejected', reason_code: 'INVALID_JSON', issues: [] },
    ]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
