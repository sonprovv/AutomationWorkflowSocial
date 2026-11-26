/** DB -> API representation helpers. Counts are BIGINT in Postgres; they fit in JS numbers for social metrics. */
export function num(v: bigint | number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'bigint' ? Number(v) : v;
  return Number.isSafeInteger(n) ? n : null;
}

export function big(v: number | null | undefined): bigint | null {
  return v === null || v === undefined ? null : BigInt(Math.trunc(v));
}

export function iso(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}

export function dec(v: { toString(): string } | null | undefined): string | null {
  return v === null || v === undefined ? null : v.toString();
}

export function isUniqueViolation(e: unknown): boolean {
  const code = (e as { code?: string })?.code;
  const msg = String((e as Error)?.message ?? '');
  return code === 'P2002' || /unique constraint|23505/i.test(msg);
}
