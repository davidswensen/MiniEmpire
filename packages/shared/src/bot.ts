// Bot players live inside the deterministic simulation: they read the state and
// issue ordinary commands, using only the simulation's own seeded RNG.

import { BUILDINGS, CASTLE_UPGRADES, MAX_POP, TECHS, TECH_INDEX, TECH_PREFIX, UNITS, UPGRADE_ITEM, techCost, type Cost } from './defs.ts';
import { FP, idiv, ilen, toTile } from './fixed.ts';
import { randInt } from './rng.ts';
import { areEnemies, botCommand, canPlace, distToEdge, nearestResource } from './sim.ts';
import { Order, type Entity, type GameState, type Player } from './types.ts';

interface BotParams {
  think: number;
  maxWorkers: number;
  firstAttack: number;
  wave: number;
  grow: number;
  maxLevel: number;
  towers: number;
  army: boolean;
  armyCap: number; // most soldiers this bot keeps at once
  trainEvery: number; // train at most once every N thinks (1 = every think)
  minWave: number; // later waves wait for at least this many idle soldiers
  techs: string[]; // research wish list, in order
  roost: boolean; // builds a dragon roost at castle level 3
}

const NEVER = 1 << 30;
const MIN = 20 * 60;

export const BOT_LEVELS = ['Sleepy (tutorial)', 'Easy', 'Normal', 'Hard'];

const PARAMS: BotParams[] = [
  // Sleepy: tutorial punching bag. Easy: small, slow army, no knights. Normal: steady.
  // Hard: big economy, full tech, large waves.
  { think: 40, maxWorkers: 6, firstAttack: NEVER, wave: 0, grow: 0, maxLevel: 1, towers: 0, army: false, armyCap: 0, trainEvery: 1, minWave: 0, techs: [], roost: false },
  { think: 40, maxWorkers: 8, firstAttack: 9 * MIN, wave: 5, grow: 1, maxLevel: 1, towers: 0, army: true, armyCap: 8, trainEvery: 3, minWave: 4, techs: [], roost: false },
  { think: 24, maxWorkers: 14, firstAttack: 6 * MIN, wave: 8, grow: 2, maxLevel: 2, towers: 1, army: true, armyCap: 22, trainEvery: 1, minWave: 8,
    techs: ['tools', 'weapons', 'armor'], roost: false },
  { think: 12, maxWorkers: 20, firstAttack: 5 * MIN, wave: 12, grow: 3, maxLevel: 3, towers: 1, army: true, armyCap: 60, trainEvery: 1, minWave: 16,
    techs: ['tools', 'baskets', 'weapons', 'archery', 'armor', 'tools', 'weapons', 'barding', 'towerguards', 'siegecraft', 'dragonfire', 'armor', 'masonry'], roost: true },
];

function afford(p: Player, c: Cost, reserveW = 0, reserveG = 0): boolean {
  return p.wood - reserveW >= c.wood && p.gold - reserveG >= c.gold;
}

function findSpot(s: GameState, p: Player, kind: string, cx: number, cy: number, minR: number): [number, number] | null {
  const n = BUILDINGS[kind].size;
  const w = s.map.w;
  const h = s.map.h;
  const start = randInt(s.rng, 8);
  for (let r = minR; r <= 18; r++) {
    const ring: Array<[number, number]> = [];
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
        ring.push([cx + dx - idiv(n, 2), cy + dy - idiv(n, 2)]);
      }
    }
    for (let k = 0; k < ring.length; k++) {
      const [x, y] = ring[(k + start * r) % ring.length];
      if (!canPlace(s, p.slot, kind, x, y)) continue;
      // keep a one-tile lane around every bot building so it never walls itself in
      let clear = true;
      for (let yy = y - 1; yy <= y + n && clear; yy++) {
        for (let xx = x - 1; xx <= x + n; xx++) {
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const o = s.occ[yy * w + xx];
          if (o !== 0) {
            const e = s.byId.get(o);
            if (e && e.kind in BUILDINGS) {
              clear = false;
              break;
            }
          }
        }
      }
      if (clear) return [x, y];
    }
  }
  return null;
}

export function botThink(s: GameState, p: Player): void {
  const mem = p.bot;
  if (!mem) return;
  const prm = PARAMS[mem.level] ?? PARAMS[2];
  mem.nextThink = s.tick + prm.think;
  const castle = s.byId.get(p.castleId);
  if (!castle) return;
  // diplomacy: accept alliance offers, unless that would end the game right away
  if (s.diplomacy) {
    for (const q of s.players) {
      if (!q.alive || q.slot === p.slot || !(q.offers & (1 << p.slot))) continue;
      const otherEnemies = s.players.some((o) => o.alive && o.slot !== q.slot && o.slot !== p.slot && (areEnemies(s, p.slot, o.slot) || areEnemies(s, q.slot, o.slot)));
      if (otherEnemies) botCommand(s, p.slot, { t: 'ally', target: q.slot });
    }
  }
  const ctx = toTile(castle.x);
  const cty = toTile(castle.y);

  const workers: Entity[] = [];
  const army: Entity[] = [];
  const blds: Record<string, Entity[]> = {};
  let queuedWorkers = 0;
  for (const e of s.entities) {
    if (e.dead || e.owner !== p.slot) continue;
    if (e.kind === 'worker') workers.push(e);
    else if (UNITS[e.kind]) {
      if (!UNITS[e.kind].naval) army.push(e);
    } else if (BUILDINGS[e.kind]) {
      (blds[e.kind] ??= []).push(e);
      for (const q of e.queue) if (q === 'worker') queuedWorkers++;
    }
  }
  const has = (k: string): boolean => (blds[k]?.length ?? 0) > 0;
  const unfinished = (k: string): boolean => (blds[k] ?? []).some((b) => !b.done);

  // 1. workers
  if (workers.length + queuedWorkers < prm.maxWorkers && castle.queue.length < 2 && afford(p, UNITS.worker.cost)) {
    botCommand(s, p.slot, { t: 'train', b: castle.id, kind: 'worker' });
  }

  // 2. idle workers gather (aim for a 55/45 wood/gold split)
  let onWood = 0;
  let onGold = 0;
  for (const wk of workers) {
    if (wk.lastResKind === 'tree' && (wk.order === Order.GATHER || wk.order === Order.RETURN)) onWood++;
    if (wk.lastResKind === 'goldmine' && (wk.order === Order.GATHER || wk.order === Order.RETURN)) onGold++;
  }
  const woodHeavy = p.wood > p.gold + 150;
  const goldHeavy = p.gold > p.wood + 150;
  // rebalance one worker per think when stockpiles drift apart
  if (woodHeavy || goldHeavy) {
    const from = woodHeavy ? 'tree' : 'goldmine';
    const to = woodHeavy ? 'goldmine' : 'tree';
    const wk = workers.find((w) => w.order === Order.GATHER && w.lastResKind === from && w.carryAmt === 0);
    const r = wk ? nearestResource(s, wk.x, wk.y, to, 90) : null;
    if (wk && r) {
      botCommand(s, p.slot, { t: 'gather', ids: [wk.id], target: r.id });
      if (from === 'tree') onWood--;
      else onGold--;
    }
  }
  for (const wk of workers) {
    if (wk.order !== Order.IDLE) continue;
    const wantWood = goldHeavy || (!woodHeavy && onWood * 45 <= onGold * 55);
    const kind = wantWood ? 'tree' : 'goldmine';
    const r = nearestResource(s, wk.x, wk.y, kind, 90) ?? nearestResource(s, wk.x, wk.y, wantWood ? "goldmine" : "tree", 90);
    if (r) {
      botCommand(s, p.slot, { t: 'gather', ids: [wk.id], target: r.id });
      if (r.kind === 'tree') onWood++;
      else onGold++;
    }
  }

  const builder = (): Entity | undefined => workers.find((wk) => wk.order !== Order.BUILD);
  const tryBuild = (kind: string, near: [number, number], minR: number): boolean => {
    const bd = BUILDINGS[kind];
    if (p.level < bd.level || !afford(p, bd.cost)) return false;
    const wk = builder();
    if (!wk) return false;
    const spot = findSpot(s, p, kind, near[0], near[1], minR);
    if (!spot) return false;
    botCommand(s, p.slot, { t: 'build', ids: [wk.id], kind, tx: spot[0], ty: spot[1] });
    return true;
  };
  const home: [number, number] = [ctx, cty];

  // 3. houses
  if (p.popCap < MAX_POP && p.popCap - p.pop <= 3 + p.level && !unfinished('house')) {
    tryBuild('house', home, 4);
  }
  // 4. core buildings
  if (!has('barracks') && workers.length >= 5) tryBuild('barracks', home, 5);
  if (!has('storehouse') && workers.length >= 8) {
    const tree = nearestResource(s, castle.x + 6 * FP, castle.y + 6 * FP, 'tree', 30);
    if (tree) tryBuild('storehouse', [toTile(tree.x), toTile(tree.y)], 2);
  }
  // 5. castle upgrades
  const upgrading = castle.queue.includes(UPGRADE_ITEM);
  const up = CASTLE_UPGRADES[p.level];
  const wantUpgrade = prm.army && !!up && p.level < prm.maxLevel && !upgrading && has('barracks') && workers.length >= 9;
  if (wantUpgrade && up && afford(p, up.cost)) {
    botCommand(s, p.slot, { t: 'upgrade', b: castle.id });
  }
  // while saving for an upgrade, only train army with what is left over
  const saveW = wantUpgrade && up ? up.cost.wood : 0;
  const saveG = wantUpgrade && up ? up.cost.gold : 0;
  // 6. advanced buildings
  if (prm.techs.length > 0 && has('barracks') && !has('blacksmith') && workers.length >= 10) tryBuild('blacksmith', home, 5);
  if (prm.army && p.level >= 2) {
    if (!has('stable')) tryBuild('stable', home, 5);
    else if (prm.maxLevel >= 3 && !has('workshop')) tryBuild('workshop', home, 6);
    else if ((blds.tower?.length ?? 0) < prm.towers) tryBuild('tower', home, 3);
    else if (prm.roost && p.level >= 3 && !has('roost')) tryBuild('roost', home, 6);
  }
  // enemy flyers spotted: put up anti-air towers
  if (prm.army && p.level >= 2 && (blds.skytower?.length ?? 0) < 2) {
    const flyers = s.entities.some((e) => !e.dead && UNITS[e.kind]?.air && areEnemies(s, p.slot, e.owner));
    if (flyers) tryBuild('skytower', home, 3);
  }
  // research the next wished-for upgrade (one at a time)
  const researching = s.entities.some((e) => e.owner === p.slot && e.queue.some((q) => q.startsWith(TECH_PREFIX)));
  if (!researching && army.length >= 4) {
    for (const id of prm.techs) {
      const ti = TECH_INDEX[id];
      const tech = TECHS[ti];
      const lvl = p.tech[ti];
      if (lvl >= tech.levels || p.level < tech.castleLevel) continue;
      const at = (blds[tech.at] ?? []).find((b) => b.done && b.queue.length < 2);
      if (!at) continue;
      if (afford(p, techCost(tech, lvl + 1), 60, 40)) botCommand(s, p.slot, { t: 'research', b: at.id, tech: id });
      break;
    }
  }

  if (!prm.army) return;

  // 7. train army (keep a little in reserve for houses)
  const reserveW = p.popCap - p.pop <= 2 ? 40 : 0;
  let armyRoom = prm.armyCap - army.length;
  const trainTurn = idiv(s.tick, prm.think) % prm.trainEvery === 0;
  for (const kind of ['barracks', 'stable', 'workshop', 'roost']) {
    for (const b of blds[kind] ?? []) {
      if (!b.done || b.queue.length >= 2 || armyRoom <= b.queue.length || !trainTurn) continue;
      // at most two siege engines of each kind: they cannot fight soldiers
      const options = BUILDINGS[kind].trains.filter((u) => UNITS[u].level <= p.level && (UNITS[u].armor !== 'siege' || army.filter((a) => a.kind === u).length < 2));
      if (options.length === 0) continue;
      const pick = options[randInt(s.rng, options.length)];
      // never starve the army while saving for an upgrade
      const save = army.length >= 6;
      if (afford(p, UNITS[pick].cost, reserveW + (save ? saveW : 0), save ? saveG : 0)) {
        botCommand(s, p.slot, { t: 'train', b: b.id, kind: pick });
        armyRoom--;
      }
    }
  }

  // 8. defend the castle
  let threat: Entity | null = null;
  let threatD = 14 * FP;
  for (const e of s.entities) {
    if (e.dead || e.inside || !UNITS[e.kind] || !areEnemies(s, p.slot, e.owner)) continue;
    const d = distToEdge(e.x, e.y, castle);
    if (d < threatD) {
      threatD = d;
      threat = e;
    }
  }
  if (threat) {
    const ids = army.filter((u) => u.order !== Order.ATTACK).map((u) => u.id);
    if (ids.length > 0) botCommand(s, p.slot, { t: 'amove', ids, x: threat.x, y: threat.y });
    return;
  }

  // 9. attack waves
  if (mem.waveSize === 0) mem.waveSize = prm.wave;
  const idleArmy = army.filter((u) => u.order === Order.IDLE);
  // later waves: launch when enough troops wait at home, or every 75s with a decent group
  const waveNeed = prm.minWave;
  const overdue = s.tick - mem.lastAttackTick > 120 * 20 && idleArmy.length >= idiv(prm.minWave, 2) + 2;
  const ready = mem.waves === 0 ? army.length >= mem.waveSize : idleArmy.length >= waveNeed || overdue;
  if (s.tick >= prm.firstAttack && ready) {
    let target: Entity | null = null;
    let best = 1 << 30;
    for (const other of s.players) {
      if (!other.alive || !areEnemies(s, p.slot, other.slot)) continue;
      const c = s.byId.get(other.castleId);
      if (!c) continue;
      const d = ilen(c.x - castle.x, c.y - castle.y);
      if (d < best) {
        best = d;
        target = c;
      }
    }
    if (target) {
      const ids = (mem.waves === 0 ? army : idleArmy).map((u) => u.id);
      botCommand(s, p.slot, { t: 'amove', ids, x: target.x, y: target.y });
      mem.waves++;
      mem.waveSize += prm.grow;
      mem.lastAttackTick = s.tick;
    }
  }
}
