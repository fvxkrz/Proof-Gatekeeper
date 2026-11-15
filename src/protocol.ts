import { z } from 'zod';

// Local circuit-safety restriction, not a claimed maximum of the published wire protocol.
const uint32Decimal = z.string().refine(
  value => /^(0|[1-9][0-9]{0,9})$/.test(value) && BigInt(value) <= 4294967295n,
  'Expected a canonical unsigned decimal within the local uint32 circuit domain',
);
const hash32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const address20 = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const uint32Block = z.number().int().min(0).max(4294967295);

const transferInputSchema = z.strictObject({
  registered_vk: hash32,
  proof_vk: hash32,
  minimum: uint32Decimal,
  public_balance: uint32Decimal,
  expiry_block: uint32Block,
  current_block: uint32Block,
  recipient: address20,
  condition_recipient: address20,
  amount: uint32Decimal,
  max_transfer: uint32Decimal,
  proof_tx: hash32,
});

const taskSchema = z.strictObject({
  type: z.literal('agent-games.proof-gatekeeper.v1'),
  task_id: z.string(),
  mode: z.enum(['practice', 'competition']),
  issued_at: z.iso.datetime({ offset: true }),
  deadline_at: z.iso.datetime({ offset: true }),
  input: transferInputSchema,
}).refine(task => {
  const window = Date.parse(task.deadline_at) - Date.parse(task.issued_at);
  return window >= 0 && window <= 60_000;
}, 'Task timestamps must be ordered within the sixty-second hard window');

const preflightSchema = z.strictObject({
  type: z.literal('agent-games.preflight.v1'),
  agent_id: z.string(),
  issued_at: z.iso.datetime({ offset: true }),
  nonce: z.string(),
});

const envelopeSchema = z.discriminatedUnion('type', [taskSchema, preflightSchema]);

export type TransferInput = z.infer<typeof transferInputSchema>;
export type Task = z.infer<typeof taskSchema>;
export type Preflight = z.infer<typeof preflightSchema>;
export type Decision = 'APPROVE' | 'REJECT';
/** Evidence remains structural; transport does not define circuit encodings. */
export type Groth16Proof = Record<string, unknown>;
export type AgentResponse = {
  decision: Decision;
  reason_code: string;
  proof?: Groth16Proof;
  public_signals?: string[];
  proof_tx?: string;
};

export function parseEnvelope(value: unknown): Task | Preflight {
  return envelopeSchema.parse(value);
}
