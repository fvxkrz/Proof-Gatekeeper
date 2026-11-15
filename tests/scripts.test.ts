import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('artifact CLI verifies the shipped pinned artifacts without credentials', () => {
  const result = spawnSync(process.execPath, ['--import','tsx','scripts/artifacts.ts','verify'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8', timeout: 10_000,
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /official_artifacts_verified/);
  assert.equal(result.stderr, '');
});

test('VK registration refuses without explicit testnet confirmation and environment key', () => {
  const result = spawnSync(process.execPath, ['--import','tsx','scripts/register-vk.ts'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8', timeout: 10_000,
    env: { PATH: process.env.PATH ?? '' },
  });
  assert.equal(result.status, 1);
  assert.equal(result.stderr, 'vk_registration_unavailable\n');
});

test('live testnet proof smoke requires explicit confirmation and a local environment key', () => {
  const result = spawnSync(process.execPath, ['--import','tsx','scripts/testnet-smoke.ts'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8', timeout: 10_000,
    env: { PATH: process.env.PATH ?? '' },
  });
  assert.equal(result.status, 1);
  assert.equal(result.stderr, 'testnet_smoke_unavailable\n');
});
