/**
 * Injectable clock seam — every schedule, cutoff, "today", expiry, and
 * late/on-time decision routes through now(). Tests can override with setNow().
 */

let frozenMs: number | null = null;

/** Current wall-clock time (or the test-frozen instant). */
export function now(): Date {
  return frozenMs === null ? new Date() : new Date(frozenMs);
}

/** Epoch milliseconds for the current (or frozen) instant. */
export function nowMs(): number {
  return frozenMs === null ? Date.now() : frozenMs;
}

/** Freeze the clock at an absolute epoch ms (tests). Pass null to unfreeze. */
export function setNow(ms: number | null): void {
  frozenMs = ms;
}

/** Advance a frozen clock by `deltaMs` (no-op if not frozen). */
export function advanceMs(deltaMs: number): void {
  if (frozenMs !== null) frozenMs += deltaMs;
}
