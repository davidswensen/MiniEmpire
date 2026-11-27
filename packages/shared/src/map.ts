// Seeded, rotationally symmetric map generation so every start is fair.
// 2 corners -> 180 degree symmetry, 4 corners -> 90 degree symmetry.

import { makeRng, randInt, randRange, type RngState } from './rng.ts';
import { Tile, type GameMap } from './types.ts';
import { idiv } from './fixed.ts';

export interface MapFeature {
  kind: string; // 'tree' | 'goldmine' | 'castle'
  x: number; // footprint origin tile
  y: number;
  size: number;
  corner: number; // for castles: which corner
}

export interface GeneratedMap {
  map: GameMap;
  features: MapFeature[];
}

export function mapSizeFor(corners: number): number {
  return corners === 2 ? 64 : 80;
}

/** Rotate a footprint origin by k symmetry steps. */
function rot(S: number, corners: number, k: number, x: number, y: number, n: number): [number, number] {
  let ox = x;
  let oy = y;
  if (corners === 2) {
    if (k % 2 === 1) return [S - n - ox, S - n - oy];
    return [ox, oy];
  }
  for (let i = 0; i < k; i++) {
    const nx = S - n - oy;
    const ny = ox;
    ox = nx;
    oy = ny;
  }
  return [ox, oy];
}

export function generateMap(seed: number, corners: number): GeneratedMap {
  const S = mapSizeFor(corners);
  const rng: RngState = makeRng(seed ^ 0x5eed1234);
  const tiles = new Uint8Array(S * S);
  const symSteps = corners === 2 ? 2 : 4;

  // --- Lake: a union of circles around the middle, replicated by symmetry.
  // Circles use doubled coordinates so the center (S-1)/2 stays an integer.
  const circles: Array<[number, number, number]> = []; // cx2, cy2, r2 (doubled units)
  const mid2 = S - 1;
  // r is a radius in tiles; centers are in doubled units.
  circles.push([mid2, mid2, idiv(S, 6)]);
  const extra = randRange(rng, 2, 3);
  for (let i = 0; i < extra; i++) {
    const ox = randRange(rng, -idiv(S * 2, 5), idiv(S * 2, 5));
    const oy = randRange(rng, -idiv(S * 2, 5), idiv(S * 2, 5));
    const r = randRange(rng, 4, 8);
    let cx = ox;
    let cy = oy;
    for (let k = 0; k < symSteps; k++) {
      circles.push([mid2 + cx, mid2 + cy, r]);
      if (corners === 2) {
        cx = -cx;
        cy = -cy;
      } else {
        const t = cx;
        cx = -cy;
        cy = t;
      }
    }
  }
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const x2 = 2 * x;
      const y2 = 2 * y;
      let water = false;
      for (const [cx, cy, r] of circles) {
        const dx = x2 - cx;
        const dy = y2 - cy;
        if (dx * dx + dy * dy <= r * r * 4) {
          water = true;
          break;
        }
      }
      tiles[y * S + x] = water ? Tile.WATER : Tile.GRASS;
    }
  }
  // Castle yards are always dry land.
  for (let k = 0; k < symSteps; k++) {
    const [yx, yy] = rot(S, corners, k, 2, 2, 13);
    for (let y = yy; y < yy + 13; y++) for (let x = yx; x < yx + 13; x++) tiles[y * S + x] = Tile.GRASS;
  }
  // Shore sand.
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      if (tiles[y * S + x] !== Tile.GRASS) continue;
      let shore = false;
      for (let dy = -1; dy <= 1 && !shore; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx >= 0 && ny >= 0 && nx < S && ny < S && tiles[ny * S + nx] === Tile.WATER) {
            shore = true;
            break;
          }
        }
      }
      if (shore) tiles[y * S + x] = Tile.SAND;
    }
  }

  const occupied = new Uint8Array(S * S);
  const features: MapFeature[] = [];

  const fits = (x: number, y: number, n: number, pad: number): boolean => {
    for (let yy = y - pad; yy < y + n + pad; yy++) {
      for (let xx = x - pad; xx < x + n + pad; xx++) {
        if (xx < 1 || yy < 1 || xx >= S - 1 || yy >= S - 1) return false;
        const i = yy * S + xx;
        if (tiles[i] === Tile.WATER || occupied[i]) return false;
      }
    }
    return true;
  };
  const mark = (x: number, y: number, n: number, v: number): void => {
    for (let yy = y; yy < y + n; yy++) for (let xx = x; xx < x + n; xx++) occupied[yy * S + xx] = v;
  };
  /** Place a feature and all its symmetric copies, only if all fit. */
  const placeSym = (kind: string, x: number, y: number, n: number, pad: number): boolean => {
    const spots: Array<[number, number]> = [];
    for (let k = 0; k < symSteps; k++) spots.push(rot(S, corners, k, x, y, n));
    for (const [sx, sy] of spots) if (!fits(sx, sy, n, pad)) return false;
    // copies must not overlap each other
    for (let a = 0; a < spots.length; a++) {
      for (let b = a + 1; b < spots.length; b++) {
        if (Math.abs(spots[a][0] - spots[b][0]) < n + pad && Math.abs(spots[a][1] - spots[b][1]) < n + pad) return false;
      }
    }
    for (let k = 0; k < spots.length; k++) {
      const [sx, sy] = spots[k];
      mark(sx, sy, n, 1);
      features.push({ kind, x: sx, y: sy, size: n, corner: k });
    }
    return true;
  };

  // --- Castles: corner 0 origin, rotated for the others.
  const cx0 = 7;
  const cy0 = 7;
  placeSym('castle', cx0, cy0, 3, 0);
  // Keep a clear yard around each castle.
  const yard: Array<[number, number]> = [];
  for (let k = 0; k < symSteps; k++) yard.push(rot(S, corners, k, cx0 - 3, cy0 - 3, 9));
  for (const [yx, yy] of yard) mark(yx, yy, 9, 2);
  for (const f of features) mark(f.x, f.y, f.size, 1);

  // --- Home gold mines (2 per player) near the castle.
  const goldSpots: Array<[number, number]> = [
    [cx0 + 8 + randInt(rng, 2), cy0 + randInt(rng, 3)],
    [cx0 + randInt(rng, 3), cy0 + 8 + randInt(rng, 2)],
  ];
  for (const [gx, gy] of goldSpots) {
    for (let tries = 0; tries < 12; tries++) {
      if (placeSym('goldmine', gx + randInt(rng, 3) - 1, gy + randInt(rng, 3) - 1, 2, 1)) break;
    }
  }

  // --- Home forests: clumps grown by random walk.
  const growForest = (fx: number, fy: number, count: number): void => {
    let x = fx;
    let y = fy;
    for (let i = 0; i < count * 3 && count > 0; i++) {
      if (placeSym('tree', x, y, 1, 0)) count--;
      x += randInt(rng, 3) - 1;
      y += randInt(rng, 3) - 1;
      if (x < 2 || y < 2 || x >= S - 2 || y >= S - 2) {
        x = fx;
        y = fy;
      }
    }
  };
  growForest(cx0 + 11, cy0 + 9, 22);
  growForest(cx0 - 4, cy0 + 13, 18);
  growForest(cx0 + 13, cy0 - 4, 18);

  // --- Contested middle resources and scattered woods.
  const half = idiv(S, 2);
  for (let i = 0; i < 6; i++) {
    growForest(randRange(rng, 4, half - 2), randRange(rng, 4, half - 2), randRange(rng, 6, 14));
  }
  for (let i = 0; i < 2; i++) {
    for (let tries = 0; tries < 20; tries++) {
      if (placeSym('goldmine', randRange(rng, 14, half), randRange(rng, 14, half), 2, 2)) break;
    }
  }

  return { map: { w: S, h: S, tiles }, features };
}

/** Which corner index each player slot uses for a given mode. */
export function cornerForSlot(mode: string, slot: number): number {
  if (mode === '1v1') return slot === 0 ? 0 : 1; // 2-fold map: corners 0 and 1 are opposite
  if (mode === '2v2') return [0, 3, 1, 2][slot]; // teammates on the same side
  return slot; // ffa
}

export function cornersForMode(mode: string): number {
  return mode === '1v1' ? 2 : 4;
}
