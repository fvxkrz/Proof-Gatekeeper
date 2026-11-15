/** True only for a canonical, exact-width 32-byte 0x-prefixed transaction hash. */
export function isCanonicalProofReference(value: unknown): value is string {
  return typeof value === 'string' && value.length === 66 && /^0[xX][0-9a-fA-F]{64}$/.test(value);
}
