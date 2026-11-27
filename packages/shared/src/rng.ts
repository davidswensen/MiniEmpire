// Seeded PRNG (mulberry32). Pure 32-bit integer ops: identical on every engine.

export interface RngState {
  s: number;
}

export function makeRng(seed: number): RngState {
  return { s: seed | 0 };
}

export function nextU32(r: RngState): number {
  let t = (r.s = (r.s + 0x6d2b79f5) | 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return (t ^ (t >>> 14)) >>> 0;
}

/** Integer in [0, n). */
export function randInt(r: RngState, n: number): number {
  if (n <= 0) return 0;
  return nextU32(r) % n;
}

/** Integer in [lo, hi] inclusive. */
export function randRange(r: RngState, lo: number, hi: number): number {
  return lo + randInt(r, hi - lo + 1);
}

/** Returns true with probability p/100. */
export function chance(r: RngState, p: number): boolean {
  return randInt(r, 100) < p;
}
