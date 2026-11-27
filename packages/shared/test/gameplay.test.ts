import { describe, expect, it } from 'vitest';
import {
  BUILDINGS, FP, Order, UNITS, applyCommand, canPlace, createGame, newEntity, step, tileCenter,
  type Command, type Entity, type GameSetup, type GameState,
} from '../src/index.ts';

function humans(mode: GameSetup['mode'] = '1v1'): GameSetup {
  const teams = mode === '2v2' ? [0, 0, 1, 1] : mode === '1v1' ? [0, 1] : [0, 1, 2, 3].slice(0, mode === 'ffa3' ? 3 : 4);
  return { seed: 77, mode, players: teams.map((team, i) => ({ name: `P${i}`, team, isBot: false, botLevel: 0, hat: 0 })) };
}

function run(s: GameState, ticks: number): void {
  for (let i = 0; i < ticks; i++) step(s);
}

function cmd(s: GameState, p: number, c: Command): void {
  applyCommand(s, { p, c });
}

function own(s: GameState, p: number, kind: string): Entity[] {
  return s.entities.filter((e) => e.owner === p && e.kind === kind);
}

/** Test-only helper: drop a unit onto a tile. */
function spawn(s: GameState, kind: string, owner: number, tx: number, ty: number): Entity {
  const e = newEntity(s.nextId++, kind, owner, tileCenter(tx), tileCenter(ty));
  e.hp = UNITS[kind].hp;
  e.maxHp = UNITS[kind].hp;
  s.entities.push(e);
  s.byId.set(e.id, e);
  return e;
}

function nearest(s: GameState, from: Entity, kind: string): Entity {
  let best: Entity | null = null;
  let bd = Infinity;
  for (const e of s.entities) {
    if (e.kind !== kind) continue;
    const d = Math.hypot(e.x - from.x, e.y - from.y);
    if (d < bd) {
      bd = d;
      best = e;
    }
  }
  return best as Entity;
}

describe('economy', () => {
  it('workers chop wood and bring it home', () => {
    const s = createGame(humans());
    const w = own(s, 0, 'worker')[0];
    const tree = nearest(s, w, 'tree');
    const before = s.players[0].wood;
    cmd(s, 0, { t: 'gather', ids: [w.id], target: tree.id });
    run(s, 20 * 60);
    expect(s.players[0].wood).toBeGreaterThan(before);
    expect(s.players[0].stats.gathered).toBeGreaterThan(0);
  });

  it('workers mine gold', () => {
    const s = createGame(humans());
    const ws = own(s, 0, 'worker');
    const mine = nearest(s, ws[0], 'goldmine');
    const before = s.players[0].gold;
    cmd(s, 0, { t: 'gather', ids: ws.map((w) => w.id), target: mine.id });
    run(s, 20 * 60);
    expect(s.players[0].gold).toBeGreaterThan(before + 20);
  });

  it('builds a house which raises the population cap', () => {
    const s = createGame(humans());
    const ws = own(s, 0, 'worker');
    const castle = s.byId.get(s.players[0].castleId) as Entity;
    let spot: [number, number] | null = null;
    for (let dy = 4; dy < 10 && !spot; dy++) for (let dx = -3; dx < 6 && !spot; dx++) {
      if (canPlace(s, 0, 'house', castle.tileX + dx, castle.tileY + dy)) spot = [castle.tileX + dx, castle.tileY + dy];
    }
    expect(spot).not.toBeNull();
    const cap = s.players[0].popCap;
    cmd(s, 0, { t: 'build', ids: ws.map((w) => w.id), kind: 'house', tx: spot![0], ty: spot![1] });
    expect(s.players[0].wood).toBe(200 - BUILDINGS.house.cost.wood);
    const house = own(s, 0, 'house')[0];
    expect(house.done).toBe(false);
    run(s, 20 * 30);
    expect(house.done).toBe(true);
    expect(s.players[0].popCap).toBe(cap + BUILDINGS.house.popCap);
  });

  it('trains a worker from the castle and refunds a cancel', () => {
    const s = createGame(humans());
    const castle = s.byId.get(s.players[0].castleId) as Entity;
    const gold = s.players[0].gold;
    cmd(s, 0, { t: 'train', b: castle.id, kind: 'worker' });
    cmd(s, 0, { t: 'train', b: castle.id, kind: 'worker' });
    expect(s.players[0].gold).toBe(gold - 60);
    cmd(s, 0, { t: 'cancel', b: castle.id });
    expect(s.players[0].gold).toBe(gold - 30);
    run(s, UNITS.worker.trainTime + 5);
    expect(own(s, 0, 'worker').length).toBe(5);
  });

  it('cannot train units that need a higher castle level', () => {
    const s = createGame(humans());
    const st = newEntity(s.nextId++, 'stable', 0, 0, 0);
    s.entities.push(st);
    s.byId.set(st.id, st);
    cmd(s, 0, { t: 'train', b: st.id, kind: 'knight' });
    expect(st.queue.length).toBe(0);
  });

  it('upgrades the castle', () => {
    const s = createGame(humans());
    s.players[0].wood = 1000;
    s.players[0].gold = 1000;
    const castle = s.byId.get(s.players[0].castleId) as Entity;
    cmd(s, 0, { t: 'upgrade', b: castle.id });
    run(s, 700);
    expect(s.players[0].level).toBe(2);
  });
});

describe('combat', () => {
  it('knights beat archers (counter bonus)', () => {
    const s = createGame(humans());
    const k = spawn(s, 'knight', 0, 30, 4);
    const a = spawn(s, 'archer', 1, 33, 4);
    cmd(s, 0, { t: 'attack', ids: [k.id], target: a.id });
    run(s, 20 * 20);
    expect(s.byId.has(a.id)).toBe(false);
    expect(s.byId.has(k.id)).toBe(true);
    expect(s.players[0].stats.kills).toBe(1);
  });

  it('idle soldiers defend themselves automatically', () => {
    const s = createGame(humans());
    const a = spawn(s, 'swordsman', 0, 30, 4);
    const b = spawn(s, 'swordsman', 1, 32, 4);
    run(s, 20 * 40);
    expect(s.byId.has(a.id) && s.byId.has(b.id)).toBe(false);
  });

  it('destroying the castle ends the game', () => {
    const s = createGame(humans());
    const castle = s.byId.get(s.players[1].castleId) as Entity;
    castle.hp = 30;
    const r = spawn(s, 'ram', 0, castle.tileX - 1, castle.tileY + 1);
    cmd(s, 0, { t: 'attack', ids: [r.id], target: castle.id });
    run(s, 20 * 10);
    expect(s.players[1].alive).toBe(false);
    expect(s.over).toBe(true);
    expect(s.winnerTeam).toBe(0);
    expect(own(s, 1, 'worker').length).toBe(0);
  });

  it('a group sent across the map reaches the enemy castle and damages it (no path deadlock)', () => {
    const s = createGame({ ...humans(), seed: 4 });
    const ids: number[] = [];
    for (let i = 0; i < 8; i++) ids.push(spawn(s, i % 2 ? 'swordsman' : 'archer', 0, 11 + (i % 3), 12 + (i >> 2)).id);
    const c = s.byId.get(s.players[1].castleId) as Entity;
    cmd(s, 0, { t: 'attack', ids, target: c.id });
    run(s, 20 * 90);
    expect(c.hp).toBeLessThan(c.maxHp / 2);
  });

  it('melee units cannot attack boats', () => {
    const s = createGame(humans());
    const sw = spawn(s, 'swordsman', 0, 10, 20);
    const boat = spawn(s, 'warship', 1, 30, 30);
    cmd(s, 0, { t: 'attack', ids: [sw.id], target: boat.id });
    expect(sw.order).toBe(Order.IDLE);
  });

  it('resigning eliminates the player', () => {
    const s = createGame(humans());
    cmd(s, 1, { t: 'resign' });
    step(s);
    expect(s.over).toBe(true);
    expect(s.winnerTeam).toBe(0);
  });

  it('2v2 needs both enemies to fall', () => {
    const s = createGame(humans('2v2'));
    cmd(s, 2, { t: 'resign' });
    step(s);
    expect(s.over).toBe(false);
    cmd(s, 3, { t: 'resign' });
    step(s);
    expect(s.over).toBe(true);
    expect(s.winnerTeam).toBe(0);
  });
});

describe('boats', () => {
  it('soldiers board a transport and unload on another shore', () => {
    const s = createGame(humans());
    const w = s.map.w;
    // find a water tile with a land neighbour (a shore spot)
    let shore = -1;
    for (let i = 0; i < s.map.tiles.length && shore < 0; i++) {
      if (s.map.tiles[i] !== 1) continue;
      const x = i % w;
      const y = Math.floor(i / w);
      if (x > 0 && s.map.tiles[i - 1] !== 1 && s.occ[i - 1] === 0) shore = i;
      void y;
    }
    expect(shore).toBeGreaterThan(0);
    const bx = shore % w;
    const by = Math.floor(shore / w);
    const boat = spawn(s, 'transport', 0, bx, by);
    const sol = spawn(s, 'swordsman', 0, bx - 1, by);
    cmd(s, 0, { t: 'board', ids: [sol.id], transport: boat.id });
    run(s, 40);
    expect(sol.inside).toBe(boat.id);
    expect(boat.cargo).toEqual([sol.id]);
    // unload far away: opposite side of the lake (mirror point)
    const tx = w - 1 - bx;
    const ty = w - 1 - by;
    cmd(s, 0, { t: 'unload', transport: boat.id, x: tileCenter(tx + 1), y: tileCenter(ty) });
    run(s, 20 * 40);
    expect(sol.inside).toBe(0);
    expect(s.map.tiles[Math.floor(sol.y / FP) * w + Math.floor(sol.x / FP)]).not.toBe(1);
  });
});

describe('command safety', () => {
  it('ignores commands for units the player does not own', () => {
    const s = createGame(humans());
    const enemyWorker = own(s, 1, 'worker')[0];
    const before = { x: enemyWorker.x, y: enemyWorker.y };
    cmd(s, 0, { t: 'move', ids: [enemyWorker.id], x: 5000, y: 5000 });
    run(s, 40);
    expect({ x: enemyWorker.x, y: enemyWorker.y }).toEqual(before);
  });

  it('survives garbage commands and keeps every value an integer', () => {
    const s = createGame(humans());
    const ws = own(s, 0, 'worker');
    const junk: unknown[] = [
      { t: 'move', ids: [ws[0].id, 'x', null, 1.5], x: 1234.567, y: Number.NaN },
      { t: 'move', ids: 'nope', x: 1, y: 2 },
      { t: 'build', ids: [ws[0].id], kind: 'castle', tx: 3, ty: 3 },
      { t: 'build', ids: [ws[0].id], kind: '__proto__', tx: 3.3, ty: -1 },
      { t: 'train', b: 999999, kind: 'knight' },
      { t: 'smart', ids: [ws[1].id], x: 1e300, y: -1e300, target: 'abc' },
      { t: 'rally', b: s.players[0].castleId, x: 0.5, y: 99.9 },
      { t: 'whatever' },
      null,
      42,
    ];
    for (const c of junk) applyCommand(s, { p: 0, c: c as Command });
    applyCommand(s, { p: 7, c: { t: 'resign' } });
    applyCommand(s, { p: -1, c: { t: 'resign' } });
    run(s, 200);
    for (const e of s.entities) {
      for (const k of ['x', 'y', 'hp', 'tx', 'ty', 'amX', 'amY', 'rallyX', 'rallyY', 'progress', 'amount'] as const) {
        expect(Number.isInteger(e[k]), `${e.kind}.${k}=${e[k]}`).toBe(true);
      }
    }
    for (const p of s.players) expect(p.alive).toBe(true);
  });
});
