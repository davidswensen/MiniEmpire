import { describe, expect, it } from 'vitest';
import {
  FP, Tile, cornersForMode, findPath, generateMap, idiv, isqrt, makeRng, mapSizeFor, nextU32, passableFn, createGame,
} from '../src/index.ts';

describe('fixed-point math', () => {
  it('isqrt is the exact floor square root', () => {
    for (let n = 0; n < 20000; n++) {
      const r = isqrt(n);
      expect(r * r <= n && (r + 1) * (r + 1) > n).toBe(true);
    }
    for (const n of [2 ** 40 - 1, 2 ** 40, 123456789012, 999999999999]) {
      const r = isqrt(n);
      expect(r * r <= n && (r + 1) * (r + 1) > n).toBe(true);
    }
  });

  it('idiv truncates toward zero', () => {
    expect(idiv(7, 2)).toBe(3);
    expect(idiv(-7, 2)).toBe(-3);
    expect(idiv(7, -2)).toBe(-3);
    expect(idiv(1024 * 80 * 1024, 1023)).toBe(Math.trunc((1024 * 80 * 1024) / 1023));
  });
});

describe('seeded rng', () => {
  it('produces a fixed sequence for a seed', () => {
    const r = makeRng(42);
    const seq = [nextU32(r), nextU32(r), nextU32(r)];
    const r2 = makeRng(42);
    expect([nextU32(r2), nextU32(r2), nextU32(r2)]).toEqual(seq);
    expect(seq.every((v) => Number.isInteger(v) && v >= 0 && v < 2 ** 32)).toBe(true);
  });
});

describe('map generation', () => {
  it('is identical for the same seed', () => {
    const a = generateMap(5, 2);
    const b = generateMap(5, 2);
    expect(Buffer.from(a.map.tiles).equals(Buffer.from(b.map.tiles))).toBe(true);
    expect(a.features).toEqual(b.features);
  });

  it('is rotationally symmetric so starts are fair', () => {
    for (const corners of [2, 4]) {
      const S = mapSizeFor(corners);
      const { map, features } = generateMap(11, corners);
      for (let y = 0; y < S; y++) {
        for (let x = 0; x < S; x++) {
          const t = map.tiles[y * S + x];
          const [rx, ry] = corners === 2 ? [S - 1 - x, S - 1 - y] : [S - 1 - y, x];
          expect(map.tiles[ry * S + rx]).toBe(t);
        }
      }
      for (const kind of ['castle', 'goldmine', 'tree']) {
        const per = new Array(corners).fill(0);
        for (const f of features) if (f.kind === kind) per[f.corner]++;
        expect(new Set(per).size).toBe(1);
      }
    }
  });

  it('has water, land and a castle per corner', () => {
    const { map, features } = generateMap(3, 4);
    expect(map.tiles.includes(Tile.WATER)).toBe(true);
    expect(features.filter((f) => f.kind === 'castle').length).toBe(4);
  });
});

describe('pathfinding', () => {
  it('finds a land path between castles that never touches water', () => {
    const s = createGame({ seed: 8, mode: '1v1', players: [
      { name: 'a', team: 0, isBot: false, botLevel: 0, hat: 0 },
      { name: 'b', team: 1, isBot: false, botLevel: 0, hat: 0 },
    ] });
    const w = s.map.w;
    const pass = passableFn(s, 0, false);
    const start = 4 * w + 4;
    const goal = (w - 5) * w + (w - 5);
    const path = findPath(w, s.map.h, start, goal, pass);
    expect(path[path.length - 1]).toBe(goal);
    for (const i of path) expect(s.map.tiles[i]).not.toBe(Tile.WATER);
  });

  it('naval paths stay on water', () => {
    const { map } = generateMap(8, 2);
    const w = map.w;
    const water: number[] = [];
    map.tiles.forEach((t, i) => { if (t === Tile.WATER) water.push(i); });
    const fake = { map, occ: new Int32Array(map.tiles.length), byId: new Map(), players: [] } as unknown as Parameters<typeof passableFn>[0];
    const pass = passableFn(fake, 0, true);
    const path = findPath(w, map.h, water[0], water[water.length - 1], pass);
    for (const i of path) expect(map.tiles[i]).toBe(Tile.WATER);
    expect(cornersForMode('1v1')).toBe(2);
    expect(FP).toBe(1024);
  });
});
