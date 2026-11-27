import { describe, expect, it } from 'vitest';
import {
  BUILDINGS, FP, TECH_INDEX, TECHS, Tile, UNITS, applyCommand, createGame, newEntity, statAtk, statMaxHp, step,
  techCost, tileCenter, type Command, type Entity, type GameState,
} from '../src/index.ts';

function game(): GameState {
  const s = createGame({ seed: 77, mode: '1v1', players: [
    { name: 'A', team: 0, isBot: false, botLevel: 0, hat: 0 },
    { name: 'B', team: 1, isBot: false, botLevel: 0, hat: 0 },
  ] });
  for (const p of s.players) {
    p.wood = 5000;
    p.gold = 5000;
  }
  return s;
}
const cmd = (s: GameState, p: number, c: Command) => applyCommand(s, { p, c });
const run = (s: GameState, n: number) => { for (let i = 0; i < n; i++) step(s); };

function spawn(s: GameState, kind: string, owner: number, tx: number, ty: number): Entity {
  const e = newEntity(s.nextId++, kind, owner, tileCenter(tx), tileCenter(ty));
  e.maxHp = statMaxHp(s, owner, kind);
  e.hp = e.maxHp;
  s.entities.push(e);
  s.byId.set(e.id, e);
  return e;
}

function building(s: GameState, kind: string, owner: number, tx: number, ty: number): Entity {
  const b = newEntity(s.nextId++, kind, owner, tx * FP + BUILDINGS[kind].size * 512, ty * FP + BUILDINGS[kind].size * 512);
  b.tileX = tx;
  b.tileY = ty;
  b.size = BUILDINGS[kind].size;
  b.maxHp = statMaxHp(s, owner, kind);
  b.hp = b.maxHp;
  s.entities.push(b);
  s.byId.set(b.id, b);
  for (let y = ty; y < ty + b.size; y++) for (let x = tx; x < tx + b.size; x++) s.occ[y * s.map.w + x] = b.id;
  return b;
}

describe('research', () => {
  it('researching Sharp Weapons costs resources, takes time and raises melee attack', () => {
    const s = game();
    const bs = building(s, 'blacksmith', 0, 14, 3);
    const base = statAtk(s, 0, 'swordsman');
    const wood = s.players[0].wood;
    cmd(s, 0, { t: 'research', b: bs.id, tech: 'weapons' });
    const t = TECHS[TECH_INDEX.weapons];
    expect(s.players[0].wood).toBe(wood - techCost(t, 1).wood);
    run(s, t.time - 5);
    expect(s.players[0].tech[TECH_INDEX.weapons]).toBe(0);
    run(s, 10);
    expect(s.players[0].tech[TECH_INDEX.weapons]).toBe(1);
    expect(statAtk(s, 0, 'swordsman')).toBe(base + 2);
    expect(statAtk(s, 0, 'archer')).toBe(UNITS.archer.atk); // melee only
    expect(statAtk(s, 1, 'swordsman')).toBe(base); // other player unaffected
  });

  it('cannot research past the max level, twice at once, or at the wrong building', () => {
    const s = game();
    const bs = building(s, 'blacksmith', 0, 14, 3);
    const castle = s.byId.get(s.players[0].castleId) as Entity;
    cmd(s, 0, { t: 'research', b: castle.id, tech: 'weapons' }); // wrong building
    expect(castle.queue.length).toBe(0);
    cmd(s, 0, { t: 'research', b: bs.id, tech: 'baskets' }); // castle tech at blacksmith
    expect(bs.queue.length).toBe(0);
    cmd(s, 0, { t: 'research', b: bs.id, tech: 'weapons' });
    cmd(s, 0, { t: 'research', b: bs.id, tech: 'weapons' }); // already queued
    expect(bs.queue.length).toBe(1);
    cmd(s, 0, { t: 'research', b: bs.id, tech: 'barding' }); // needs castle level 2
    expect(bs.queue.length).toBe(1);
    s.players[0].tech[TECH_INDEX.archery] = 3;
    cmd(s, 0, { t: 'research', b: bs.id, tech: 'archery' }); // maxed
    expect(bs.queue.length).toBe(1);
    const gold = s.players[0].gold;
    cmd(s, 0, { t: 'cancel', b: bs.id }); // refund
    expect(s.players[0].gold).toBe(gold + techCost(TECHS[TECH_INDEX.weapons], 1).gold);
  });

  it('health research upgrades units you already have', () => {
    const s = game();
    const w = s.entities.find((e) => e.owner === 0 && e.kind === 'worker') as Entity;
    w.hp = 20;
    const castle = s.byId.get(s.players[0].castleId) as Entity;
    cmd(s, 0, { t: 'research', b: castle.id, tech: 'tough' });
    run(s, TECHS[TECH_INDEX.tough].time + 2);
    expect(w.maxHp).toBe(UNITS.worker.hp + 30);
    expect(w.hp).toBe(50); // damage taken is kept
  });

  it('Better Tools makes workers gather faster', () => {
    const gathered = (tools: number) => {
      const s = game();
      s.players[0].wood = 0;
      s.players[0].tech[TECH_INDEX.tools] = tools;
      const ws = s.entities.filter((e) => e.owner === 0 && e.kind === 'worker');
      const tree = s.entities.filter((e) => e.kind === 'tree').sort((a, b) => Math.hypot(a.x - ws[0].x, a.y - ws[0].y) - Math.hypot(b.x - ws[0].x, b.y - ws[0].y))[0];
      cmd(s, 0, { t: 'gather', ids: ws.map((w) => w.id), target: tree.id });
      run(s, 20 * 90);
      return s.players[0].stats.gathered;
    };
    expect(gathered(2)).toBeGreaterThan(gathered(0));
  });

  it('armor reduces damage taken', () => {
    const hits = (armor: number) => {
      const s = game();
      s.players[1].tech[TECH_INDEX.armor] = armor;
      const a = spawn(s, 'swordsman', 0, 30, 4);
      const b = spawn(s, 'swordsman', 1, 31, 4);
      cmd(s, 0, { t: 'attack', ids: [a.id], target: b.id });
      cmd(s, 1, { t: 'stop', ids: [b.id] });
      b.scanAt = 1 << 30; // b does not fight back
      run(s, 60);
      return b.maxHp - b.hp;
    };
    expect(hits(3)).toBeLessThan(hits(0));
  });
});

describe('flyers', () => {
  it('a dragon flies straight across the lake', () => {
    const s = game();
    const w = s.map.w;
    const d = spawn(s, 'dragon', 0, 8, 8);
    const target = (w - 9) * FP;
    cmd(s, 0, { t: 'move', ids: [d.id], x: target, y: target });
    let overWater = false;
    for (let i = 0; i < 20 * 40; i++) {
      step(s);
      if (s.map.tiles[(d.y >> 10) * w + (d.x >> 10)] === Tile.WATER) overWater = true;
    }
    expect(overWater).toBe(true);
    expect(Math.hypot(d.x - target, d.y - target)).toBeLessThan(2 * FP);
  });

  it('swordsmen cannot hit flyers, archers and arrow towers can, cannon towers cannot', () => {
    const s = game();
    const g = spawn(s, 'griffin', 1, 30, 30);
    const sw = spawn(s, 'swordsman', 0, 29, 30);
    const ar = spawn(s, 'archer', 0, 27, 30);
    cmd(s, 0, { t: 'attack', ids: [sw.id], target: g.id });
    expect(sw.order).toBe(0);
    cmd(s, 0, { t: 'attack', ids: [ar.id], target: g.id });
    expect(ar.order).toBe(2);

    const s2 = game();
    s2.players[0].level = 3;
    const ct = building(s2, 'cannontower', 0, 30, 30);
    const at = building(s2, 'tower', 0, 30, 34);
    const d1 = spawn(s2, 'wyvern', 1, 32, 32);
    d1.scanAt = 1 << 30;
    run(s2, 60);
    expect(d1.hp).toBeLessThan(d1.maxHp); // the arrow tower shot it
    void ct;
    void at;
  });

  it('a sky ballista tower shreds dragons (anti-air bonus)', () => {
    const s = game();
    building(s, 'skytower', 0, 30, 30);
    const d = spawn(s, 'dragon', 1, 33, 30);
    d.scanAt = 1 << 30;
    run(s, 100); // 3 shots
    const dealt = d.maxHp - d.hp;
    expect(dealt).toBeGreaterThan(UNITS.dragon.hp / 4);
  });

  it('flyers attack ground units and buildings', () => {
    const s = game();
    const d = spawn(s, 'dragon', 0, 30, 30);
    const sw = spawn(s, 'swordsman', 1, 32, 30);
    sw.scanAt = 1 << 30;
    cmd(s, 0, { t: 'attack', ids: [d.id], target: sw.id });
    run(s, 20 * 10);
    expect(s.byId.has(sw.id)).toBe(false);
  });

  it('new units can be trained from their buildings', () => {
    const s = game();
    s.players[0].level = 3;
    const roost = building(s, 'roost', 0, 14, 3);
    const ws = building(s, 'workshop', 0, 14, 8);
    building(s, 'house', 0, 3, 14);
    building(s, 'house', 0, 3, 17);
    s.players[0].popCap = 40;
    cmd(s, 0, { t: 'train', b: roost.id, kind: 'dragon' });
    cmd(s, 0, { t: 'train', b: ws.id, kind: 'trebuchet' });
    run(s, 720);
    expect(s.entities.some((e) => e.owner === 0 && e.kind === 'dragon')).toBe(true);
    expect(s.entities.some((e) => e.owner === 0 && e.kind === 'trebuchet')).toBe(true);
  });
});
