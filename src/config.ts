import { resolve } from 'node:path';
import { MAINNET_VK_HASH } from './artifacts.js';
import type { Network } from './zkverify.js';

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const fail = (): never => { throw new Error('CONFIGURATION_INVALID'); };
  const integer = (name: string, fallback: number, min: number, max: number): number => {
    const raw = env[name];
    if (raw !== undefined && !/^[0-9]+$/.test(raw)) return fail();
    const value = raw === undefined ? fallback : Number(raw);
    if (!Number.isSafeInteger(value) || value < min || value > max) return fail();
    return value;
  };
  const secret = env.AGENT_GAMES_HMAC_SECRET;
  if (!secret || secret.length < 32 || secret.length > 1024 || /^(changeme|placeholder|example|test-secret)/i.test(secret)) return fail();
  const network = env.ZKVERIFY_NETWORK ?? 'testnet';
  if (network !== 'testnet' && network !== 'mainnet') return fail();
  if (network === 'mainnet' && env.ALLOW_MAINNET !== 'true') return fail();
  const agentPath = env.AGENT_PATH ?? '/agent';
  if (!/^\/[a-zA-Z0-9/_-]+$/.test(agentPath) || agentPath.includes('//') || ['/healthz','/readyz'].includes(agentPath)) return fail();
  const practiceEncoder = env.PRACTICE_ENCODER ?? '';
  if (practiceEncoder !== '' && practiceEncoder !== 'sha256-vk-modp-taskid-sha256-modp-v1') return fail();
  const vkHash = env.KURIER_VK_HASH || undefined;
  if (vkHash && !/^0x[0-9a-fA-F]{64}$/.test(vkHash)) return fail();
  if (network === 'mainnet' && vkHash?.toLowerCase() !== MAINNET_VK_HASH) return fail();
  if (Boolean(env.ENCODING_MODULE) !== Boolean(env.ENCODING_MODULE_SHA256)) return fail();
  return {
    secret, network: network as Network, agentPath, host: env.HOST ?? '127.0.0.1',
    port: integer('PORT', 3000, 1, 65535), bodyLimit: integer('BODY_LIMIT_BYTES', 65536, 1024, 262144),
    responseBudgetMs: integer('RESPONSE_BUDGET_MS', 55000, 1000, 55000),
    proofTimeoutMs: integer('PROOF_TIMEOUT_MS', 15000, 100, 30000), maxInFlight: integer('MAX_IN_FLIGHT', 1, 1, 4),
    maxTaskAgeMs: integer('MAX_TASK_AGE_MS', 60000, 1000, 60000), clockSkewMs: integer('CLOCK_SKEW_MS', 5000, 0, 5000),
    dbPath: resolve(env.DB_PATH ?? './data/gatekeeper.sqlite'), artifactsDir: resolve(env.ARTIFACTS_DIR ?? './circuits'),
    apiKey: env.KURIER_API_KEY || undefined, vkHash,
    encodingModule: env.ENCODING_MODULE || undefined, encodingDigest: env.ENCODING_MODULE_SHA256 || undefined,
    practiceEncoder: practiceEncoder || undefined,
  };
}
