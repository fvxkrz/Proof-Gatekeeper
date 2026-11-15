import { ZodError } from 'zod';

export type RejectionDiagnostic = {
  event: 'request_rejected';
  reason_code: 'INVALID_ENVELOPE' | 'INVALID_JSON' | 'STALE_TIMESTAMP' | 'FUTURE_TIMESTAMP';
  issues: Array<{
    field: string;
    code: string;
    received_type: string;
    string_length?: number;
    unknown_field_count?: number;
  }>;
};

const fields = new Set([
  '', 'type', 'task_id', 'mode', 'issued_at', 'deadline_at', 'agent_id', 'nonce', 'input',
  ...['registered_vk', 'proof_vk', 'minimum', 'public_balance', 'expiry_block', 'current_block',
    'recipient', 'condition_recipient', 'amount', 'max_transfer', 'proof_tx'].map(x => `input.${x}`),
]);
const codes = new Set(['invalid_type', 'invalid_format', 'too_big', 'too_small', 'unrecognized_keys',
  'invalid_value', 'custom', 'invalid_union']);

/** Only fixed schema names, fixed codes, types and counts may enter diagnostics. */
export function summarizeEnvelopeFailure(decoded: unknown, error: unknown): RejectionDiagnostic {
  const issues: RejectionDiagnostic['issues'] = [];
  if (error instanceof ZodError) {
    for (const issue of error.issues.slice(0, 8)) {
      const path = issue.path.map(x => typeof x === 'string' ? x : '?').join('.');
      const known = fields.has(path);
      let value: unknown = decoded;
      if (known) {
        for (const part of issue.path) {
          if (typeof part !== 'string' || value === null || typeof value !== 'object'
            || !Object.hasOwn(value, part)) { value = undefined; break; }
          value = (value as Record<string, unknown>)[part];
        }
      } else value = undefined;
      const receivedType = value === undefined ? 'missing' : value === null ? 'null'
        : Array.isArray(value) ? 'array' : ['object', 'string', 'number', 'boolean'].includes(typeof value)
          ? typeof value : 'other';
      issues.push({
        field: known && path ? path : 'envelope',
        code: codes.has(issue.code) ? issue.code : 'validation_error',
        received_type: receivedType,
        ...(typeof value === 'string' ? { string_length: value.length } : {}),
        ...(issue.code === 'unrecognized_keys' ? { unknown_field_count: issue.keys.length } : {}),
      });
    }
  }
  return { event: 'request_rejected', reason_code: 'INVALID_ENVELOPE', issues };
}
