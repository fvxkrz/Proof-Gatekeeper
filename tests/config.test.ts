import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

test('configuration requires the dashboard secret and defaults to testnet with bounded budgets', async () => {
  const module = await import('../src/config.js').catch(() => null);
  assert.ok(module, 'safe environment configuration is not implemented');
  assert.throws(() => module.loadConfig({}), /CONFIGURATION/);
  const secret = randomBytes(32).toString('hex');
  const config = module.loadConfig({ AGENT_GAMES_HMAC_SECRET: secret });
  assert.equal(config.network, 'testnet');
  assert.equal(config.secret, secret);
  assert.equal(config.responseBudgetMs, 55_000);
  assert.equal(config.agentPath, '/agent');
  assert.throws(() => module.loadConfig({ AGENT_GAMES_HMAC_SECRET: secret, ZKVERIFY_NETWORK: 'mainnet' }), /CONFIGURATION/);
  assert.throws(() => module.loadConfig({ AGENT_GAMES_HMAC_SECRET: secret, RESPONSE_BUDGET_MS: '60001' }), /CONFIGURATION/);
  assert.throws(() => module.loadConfig({ AGENT_GAMES_HMAC_SECRET: secret, AGENT_PATH: '/' }), /CONFIGURATION/);
});
