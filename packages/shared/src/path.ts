// Deterministic 8-direction A* on the tile grid. Ties always break the same way
// (lower f, then lower h, then lower tile index), so every client gets the same path.

import type { GameState } from './types.ts';
import { Tile } from './types.ts';
import { BUILDINGS } from './defs.ts';
import { idiv } from './fixed.ts';

export type Passable = (idx: number) => boolean;

const DIRS: Array<[number, number, number]> = [
  [1, 0, 10], [-1, 0, 10], [0, 1, 10], [0, -1, 10],
  [1, 1, 14], [-1, 1, 14], [1, -1, 14], [-1, -1, 14],
];

function teamOf(s: GameState, owner: number): number {
  return owner >= 0 && owner < s.players.length ? s.players[owner].team : -1;
}

/** Passability for a mover of the given owner and domain. */
export function passableFn(s: GameState, owner: number, naval: boolean, air = false): Passable {
  if (air) return () => true; // flyers ignore terrain, walls and trees
  const tiles = s.map.tiles;
  const occ = s.occ;
  const team = teamOf(s, owner);
  if (naval) {
    return (i) => tiles[i] === Tile.WATER && occ[i] === 0;
  }
  return (i) => {
    if (tiles[i] === Tile.WATER) return false;
    const o = occ[i];
    if (o === 0) return true;
    const e = s.byId.get(o);
    if (!e) return true;
    if (e.done && BUILDINGS[e.kind]?.gate && teamOf(s, e.owner) === team) return true;
    return false;
  };
}

// Reusable scratch buffers, sized on demand.
let gScore = new Int32Array(0);
let came = new Int32Array(0);
let stamp = new Int32Array(0);
let closed = new Int32Array(0);
let curStamp = 0;

function ensure(n: number): void {
  if (gScore.length < n) {
    gScore = new Int32Array(n);
    came = new Int32Array(n);
    stamp = new Int32Array(n);
    closed = new Int32Array(n);
    curStamp = 0;
  }
}

// Binary heap of [f, h, idx] packed into parallel arrays.
class Heap {
  f: number[] = [];
  h: number[] = [];
  i: number[] = [];
  get size(): number {
    return this.i.length;
  }
  less(a: number, b: number): boolean {
    if (this.f[a] !== this.f[b]) return this.f[a] < this.f[b];
    if (this.h[a] !== this.h[b]) return this.h[a] < this.h[b];
    return this.i[a] < this.i[b];
  }
  swap(a: number, b: number): void {
    let t = this.f[a]; this.f[a] = this.f[b]; this.f[b] = t;
    t = this.h[a]; this.h[a] = this.h[b]; this.h[b] = t;
    t = this.i[a]; this.i[a] = this.i[b]; this.i[b] = t;
  }
  push(f: number, h: number, i: number): void {
    this.f.push(f); this.h.push(h); this.i.push(i);
    let c = this.i.length - 1;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (!this.less(c, p)) break;
      this.swap(c, p);
      c = p;
    }
  }
  pop(): number {
    const top = this.i[0];
    const last = this.i.length - 1;
    this.swap(0, last);
    this.f.pop(); this.h.pop(); this.i.pop();
    let c = 0;
    const n = this.i.length;
    for (;;) {
      const l = c * 2 + 1;
      const r = l + 1;
      let m = c;
      if (l < n && this.less(l, m)) m = l;
      if (r < n && this.less(r, m)) m = r;
      if (m === c) break;
      this.swap(c, m);
      c = m;
    }
    return top;
  }
}

function heuristic(ax: number, ay: number, bx: number, by: number): number {
  const dx = Math.abs(ax - bx);
  const dy = Math.abs(ay - by);
  return dx > dy ? 14 * dy + 10 * (dx - dy) : 14 * dx + 10 * (dy - dx);
}

/**
 * Find a path of tile indices from start to goal (exclusive of start).
 * If the goal is unreachable, returns the path to the closest reachable tile.
 */
export function findPath(w: number, h: number, start: number, goal: number, pass: Passable, maxNodes = w * h): number[] {
  if (start === goal) return [];
  ensure(w * h);
  curStamp++;
  const gx = goal % w;
  const heap = new Heap();
  const sx = start % w;
  const sy = yOf(start, w);
  stamp[start] = curStamp;
  gScore[start] = 0;
  came[start] = -1;
  closed[start] = 0;
  const h0 = heuristic(sx, sy, gx, yOf(goal, w));
  heap.push(h0, h0, start);
  let best = start;
  let bestH = h0;
  let expanded = 0;
  const gyy = yOf(goal, w);
  while (heap.size > 0) {
    const cur = heap.pop();
    if (closed[cur] === curStamp) continue;
    closed[cur] = curStamp;
    if (cur === goal) {
      best = cur;
      break;
    }
    if (++expanded > maxNodes) break;
    const cx = cur % w;
    const cy = yOf(cur, w);
    for (const [dx, dy, cost] of DIRS) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const ni = ny * w + nx;
      if (closed[ni] === curStamp) continue;
      if (!pass(ni)) continue;
      // no corner cutting
      if (dx !== 0 && dy !== 0) {
        if (!pass(cy * w + nx) || !pass(ny * w + cx)) continue;
      }
      const g = gScore[cur] + cost;
      if (stamp[ni] !== curStamp || g < gScore[ni]) {
        stamp[ni] = curStamp;
        gScore[ni] = g;
        came[ni] = cur;
        const hh = heuristic(nx, ny, gx, gyy);
        heap.push(g + hh, hh, ni);
        if (hh < bestH || (hh === bestH && ni < best)) {
          bestH = hh;
          best = ni;
        }
      }
    }
  }
  const out: number[] = [];
  let c = best;
  while (c !== start && c !== -1) {
    out.push(c);
    c = came[c];
  }
  out.reverse();
  return out;
}

function yOf(i: number, w: number): number {
  return idiv(i, w);
}

/** Nearest tile (spiral search) that satisfies `ok`, starting at (tx, ty). */
export function nearestTile(w: number, h: number, tx: number, ty: number, ok: Passable, maxR = 12): number {
  for (let r = 0; r <= maxR; r++) {
    let best = -1;
    let bestD = 1 << 30;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
        const x = tx + dx;
        const y = ty + dy;
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        const i = y * w + x;
        if (!ok(i)) continue;
        const d = dx * dx + dy * dy;
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
    }
    if (best >= 0) return best;
  }
  return -1;
}
