// Deterministic integer math. This is the ONLY simulation file allowed to use
// the `/` operator and Math.sqrt (see scripts/check-determinism.mjs).
//
// All simulation values are plain JS integers kept well below 2^53, so +, -, *
// are exact. Division of integers below 2^53 followed by trunc is exact too,
// because IEEE-754 division is correctly rounded.

/** Fixed-point units per tile. */
export const FP = 1024;

/** Integer division, truncating toward zero (like C). */
export function idiv(a: number, b: number): number {
  return Math.trunc(a / b);
}

/** Exact integer square root (floor). Math.sqrt is only a first guess. */
export function isqrt(n: number): number {
  if (n <= 0) return 0;
  let r = Math.floor(Math.sqrt(n));
  while (r * r > n) r--;
  while ((r + 1) * (r + 1) <= n) r++;
  return r;
}

/** Integer euclidean length. */
export function ilen(dx: number, dy: number): number {
  return isqrt(dx * dx + dy * dy);
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Tile coordinate -> fixed-point center of that tile. */
export function tileCenter(t: number): number {
  return t * FP + 512;
}

/** Fixed-point coordinate -> tile coordinate. */
export function toTile(v: number): number {
  return v >> 10;
}

/** Percent scaling with truncation: v * pct / 100. */
export function pct(v: number, p: number): number {
  return idiv(v * p, 100);
}
