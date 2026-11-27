// The deterministic simulation. Rules (enforced by scripts/check-determinism.mjs):
//  - integers only, division via idiv(), no Math.random / Date / trig
//  - iterate entities in id order, break ties by id
//  - the only inputs are PlayerCommands applied at turn boundaries

import {
  BUILDINGS, CASTLE_UPGRADES, MAX_POP, PLAYER_COLORS, RESOURCES, START_GOLD, START_WOOD,
  START_WORKERS, UNITS, UPGRADE_ITEM, type BuildingDef, type Cost, type UnitDef,
} from './defs.ts';
import { FP, idiv, ilen, pct, tileCenter, toTile } from './fixed.ts';
import { cornerForSlot, cornersForMode, generateMap } from './map.ts';
import { findPath, nearestTile, passableFn, type Passable } from './path.ts';
import { makeRng } from './rng.ts';
import { botThink } from './bot.ts';
import {
  Order, Tile, type Command, type Entity, type GameSetup, type GameState, type Player, type PlayerCommand,
} from './types.ts';

// ---------------------------------------------------------------- creation

/** How close (to the target edge) a worker must be to gather, build or drop off. */
const REACH = 760;

export function newEntity(id: number, kind: string, owner: number, x: number, y: number): Entity {
  return {
    id, kind, owner, x, y, hp: 1, maxHp: 1, dead: false,
    order: Order.IDLE, targetId: 0, tx: 0, ty: 0, amX: -1, amY: -1,
    path: [], pathIdx: 0, repathAt: 0, cooldown: 0,
    carryRes: 0, carryAmt: 0, gatherTimer: 0, lastResKind: '', lastResId: 0,
    inside: 0, cargo: [], scanAt: 0, autoTarget: false,
    tileX: 0, tileY: 0, size: 0, progress: 0, done: true,
    queue: [], queueTime: 0, rallyX: -1, rallyY: -1, amount: 0,
  };
}

function addEntity(s: GameState, e: Entity): Entity {
  s.entities.push(e); // ids are increasing, so the array stays sorted
  s.byId.set(e.id, e);
  return e;
}

function setOcc(s: GameState, e: Entity, v: number): void {
  const w = s.map.w;
  for (let y = e.tileY; y < e.tileY + e.size; y++) {
    for (let x = e.tileX; x < e.tileX + e.size; x++) s.occ[y * w + x] = v;
  }
}

function spawnStatic(s: GameState, kind: string, owner: number, tx: number, ty: number, size: number): Entity {
  const e = newEntity(s.nextId++, kind, owner, tx * FP + size * 512, ty * FP + size * 512);
  e.tileX = tx;
  e.tileY = ty;
  e.size = size;
  const bd = BUILDINGS[kind];
  const rd = RESOURCES[kind];
  if (bd) {
    e.maxHp = bd.hp;
    e.hp = bd.hp;
  } else if (rd) {
    e.amount = rd.amount;
    e.hp = 1;
    e.maxHp = 1;
  }
  addEntity(s, e);
  setOcc(s, e, e.id);
  return e;
}

function spawnUnit(s: GameState, kind: string, owner: number, tileIdx: number): Entity {
  const w = s.map.w;
  const tx = tileIdx % w;
  const ty = idiv(tileIdx, w);
  const e = newEntity(s.nextId++, kind, owner, tileCenter(tx), tileCenter(ty));
  const d = UNITS[kind];
  e.hp = d.hp;
  e.maxHp = d.hp;
  addEntity(s, e);
  return e;
}

export function createGame(setup: GameSetup): GameState {
  const corners = cornersForMode(setup.mode);
  const gen = generateMap(setup.seed, corners);
  const { map } = gen;
  idx = { grid: [], buildings: [] }; // never reuse another game's index
  const s: GameState = {
    seed: setup.seed | 0,
    tick: 0,
    rng: makeRng(setup.seed ^ 0x2545f491),
    map,
    occ: new Int32Array(map.w * map.h),
    entities: [],
    byId: new Map(),
    nextId: 1,
    players: [],
    events: [],
    over: false,
    winnerTeam: -1,
  };
  setup.players.forEach((ps, i) => {
    const p: Player = {
      slot: i, name: ps.name, team: ps.team | 0, color: PLAYER_COLORS[i % PLAYER_COLORS.length], hat: ps.hat | 0,
      isBot: !!ps.isBot,
      bot: ps.isBot ? { level: ps.botLevel | 0, nextThink: 20 + i * 3, waveSize: 0, waves: 0, lastAttackTick: 0 } : null,
      wood: START_WOOD, gold: START_GOLD, pop: 0, popCap: 0, level: 1, alive: true, castleId: 0,
      corner: cornerForSlot(setup.mode, i),
      stats: { trained: 0, kills: 0, lost: 0, gathered: 0, built: 0 },
    };
    s.players.push(p);
  });
  // Castles first (lowest ids), then resources.
  for (const p of s.players) {
    const f = gen.features.find((ft) => ft.kind === 'castle' && ft.corner === p.corner);
    if (!f) continue;
    const c = spawnStatic(s, 'castle', p.slot, f.x, f.y, 3);
    p.castleId = c.id;
  }
  for (const f of gen.features) {
    if (f.kind === 'castle') continue;
    spawnStatic(s, f.kind, -1, f.x, f.y, f.size);
  }
  for (const p of s.players) {
    const c = s.byId.get(p.castleId);
    if (!c) continue;
    const land = passableFn(s, p.slot, false);
    for (let i = 0; i < START_WORKERS; i++) {
      const t = freeTileNear(s, c, land, i);
      if (t >= 0) spawnUnit(s, 'worker', p.slot, t);
    }
  }
  recomputePop(s);
  return s;
}

// ---------------------------------------------------------------- queries

export function unitDef(e: Entity): UnitDef | undefined {
  return UNITS[e.kind];
}
export function buildingDef(e: Entity): BuildingDef | undefined {
  return BUILDINGS[e.kind];
}
export function isUnit(e: Entity): boolean {
  return e.kind in UNITS;
}
export function isBuilding(e: Entity): boolean {
  return e.kind in BUILDINGS;
}
export function isResource(e: Entity): boolean {
  return e.kind in RESOURCES;
}
export function teamOf(s: GameState, owner: number): number {
  return owner >= 0 && owner < s.players.length ? s.players[owner].team : -1;
}
export function areEnemies(s: GameState, a: number, b: number): boolean {
  if (a < 0 || b < 0) return false;
  return teamOf(s, a) !== teamOf(s, b);
}

/** Distance from point to the target's body edge (fixed-point). */
export function distToEdge(x: number, y: number, t: Entity): number {
  if (t.size > 0) {
    const x0 = t.tileX * FP;
    const y0 = t.tileY * FP;
    const x1 = x0 + t.size * FP;
    const y1 = y0 + t.size * FP;
    const cx = x < x0 ? x0 : x > x1 ? x1 : x;
    const cy = y < y0 ? y0 : y > y1 ? y1 : y;
    return ilen(x - cx, y - cy);
  }
  const r = UNITS[t.kind]?.radius ?? 300;
  const d = ilen(x - t.x, y - t.y) - r;
  return d < 0 ? 0 : d;
}

function canAfford(p: Player, c: Cost): boolean {
  return p.wood >= c.wood && p.gold >= c.gold;
}
function pay(p: Player, c: Cost): void {
  p.wood -= c.wood;
  p.gold -= c.gold;
}
function refund(p: Player, c: Cost): void {
  p.wood += c.wood;
  p.gold += c.gold;
}

export function canPlace(s: GameState, owner: number, kind: string, tx: number, ty: number): boolean {
  const d = BUILDINGS[kind];
  if (!d || !d.buildable) return false;
  const { w, h, tiles } = s.map;
  if (tx < 0 || ty < 0 || tx + d.size > w || ty + d.size > h) return false;
  for (let y = ty; y < ty + d.size; y++) {
    for (let x = tx; x < tx + d.size; x++) {
      const i = y * w + x;
      if (tiles[i] === Tile.WATER || s.occ[i] !== 0) return false;
    }
  }
  if (d.needsWater) {
    let water = 0;
    for (let y = ty - 1; y <= ty + d.size; y++) {
      for (let x = tx - 1; x <= tx + d.size; x++) {
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        if (x >= tx && x < tx + d.size && y >= ty && y < ty + d.size) continue;
        if (tiles[y * w + x] === Tile.WATER) water++;
      }
    }
    if (water < 2) return false;
  }
  void owner;
  return true;
}

// ---------------------------------------------------------------- per-tick indexes

interface TickIndex {
  grid: number[][]; // unit ids per tile (land and naval, not inside transports)
  buildings: Entity[];
}
let idx: TickIndex = { grid: [], buildings: [] };

function buildIndex(s: GameState): void {
  const n = s.map.w * s.map.h;
  if (idx.grid.length !== n) idx.grid = Array.from({ length: n }, () => []);
  for (const b of idx.grid) b.length = 0;
  idx.buildings = [];
  const w = s.map.w;
  for (const e of s.entities) {
    if (e.dead) continue;
    if (e.size > 0) {
      if (e.kind in BUILDINGS) idx.buildings.push(e);
      continue;
    }
    if (e.inside) continue;
    const t = toTile(e.y) * w + toTile(e.x);
    if (t >= 0 && t < n) idx.grid[t].push(e.id);
  }
}

/** Nearest valid enemy within `tiles` radius (units first, then buildings). */
function findEnemy(s: GameState, e: Entity, tiles: number, ok: (t: Entity) => boolean): Entity | null {
  const w = s.map.w;
  const h = s.map.h;
  const cx = toTile(e.x);
  const cy = toTile(e.y);
  const maxD = tiles * FP;
  let best: Entity | null = null;
  let bestD = 1 << 30;
  for (let y = cy - tiles; y <= cy + tiles; y++) {
    if (y < 0 || y >= h) continue;
    for (let x = cx - tiles; x <= cx + tiles; x++) {
      if (x < 0 || x >= w) continue;
      for (const id of idx.grid[y * w + x]) {
        const t = s.byId.get(id);
        if (!t || t.dead || !areEnemies(s, e.owner, t.owner) || !ok(t)) continue;
        const d = distToEdge(e.x, e.y, t);
        if (d <= maxD && (d < bestD || (d === bestD && best !== null && t.id < best.id))) {
          bestD = d;
          best = t;
        }
      }
    }
  }
  if (best) return best;
  for (const b of idx.buildings) {
    if (b.dead || !areEnemies(s, e.owner, b.owner) || !ok(b)) continue;
    const d = distToEdge(e.x, e.y, b);
    if (d <= maxD && d < bestD) {
      bestD = d;
      best = b;
    }
  }
  return best;
}

// ---------------------------------------------------------------- movement

function domainPass(s: GameState, e: Entity): Passable {
  return passableFn(s, e.owner, !!UNITS[e.kind]?.naval);
}

function tileOf(s: GameState, x: number, y: number): number {
  return toTile(y) * s.map.w + toTile(x);
}

function pathTo(s: GameState, e: Entity, goal: number): void {
  const pass = domainPass(s, e);
  const start = tileOf(s, e.x, e.y);
  let g = goal;
  if (g < 0) {
    e.path = [];
    e.pathIdx = 0;
    return;
  }
  if (!pass(g)) {
    const w = s.map.w;
    g = nearestTile(w, s.map.h, g % w, idiv(g, w), pass, 10);
    if (g < 0) {
      e.path = [];
      e.pathIdx = 0;
      return;
    }
  }
  e.path = findPath(s.map.w, s.map.h, start, g, pass);
  e.pathIdx = 0;
}

/** Advance along the path. Returns true when the path is finished. */
function moveAlong(s: GameState, e: Entity): boolean {
  const d = UNITS[e.kind];
  if (!d || e.pathIdx >= e.path.length) return true;
  const w = s.map.w;
  const next = e.path[e.pathIdx];
  const pass = domainPass(s, e);
  if (!pass(next)) {
    // something was built in the way: re-plan to the same destination
    pathTo(s, e, e.path[e.path.length - 1]);
    return e.path.length === 0;
  }
  const nx = tileCenter(next % w);
  const ny = tileCenter(idiv(next, w));
  const dx = nx - e.x;
  const dy = ny - e.y;
  const dist = ilen(dx, dy);
  // Waypoints count as reached within a radius: units sharing a path push each
  // other around and might otherwise never touch the exact tile center.
  const isFinal = e.pathIdx === e.path.length - 1;
  const reach = isFinal ? 320 : 440;
  if (dist <= d.speed) {
    e.x = nx;
    e.y = ny;
    e.pathIdx++;
  } else if (dist <= reach) {
    e.pathIdx++;
  } else {
    e.x += idiv(dx * d.speed, dist);
    e.y += idiv(dy * d.speed, dist);
  }
  return e.pathIdx >= e.path.length;
}

function stopMoving(e: Entity): void {
  e.path = [];
  e.pathIdx = 0;
}

/** Best passable tile next to a static target's footprint (or a unit's tile). */
function approachTile(s: GameState, e: Entity, t: Entity): number {
  const pass = domainPass(s, e);
  const w = s.map.w;
  const h = s.map.h;
  if (t.size === 0) {
    const ti = tileOf(s, t.x, t.y);
    if (pass(ti)) return ti;
    return nearestTile(w, h, ti % w, idiv(ti, w), pass, 6);
  }
  let best = -1;
  let bestD = 1 << 30;
  for (let y = t.tileY - 1; y <= t.tileY + t.size; y++) {
    for (let x = t.tileX - 1; x <= t.tileX + t.size; x++) {
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      if (x >= t.tileX && x < t.tileX + t.size && y >= t.tileY && y < t.tileY + t.size) continue;
      const i = y * w + x;
      if (!pass(i)) continue;
      const d = ilen(tileCenter(x) - e.x, tileCenter(y) - e.y);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
  }
  if (best >= 0) return best;
  return nearestTile(w, h, t.tileX, t.tileY, pass, 8);
}

/** Walk toward a target; repaths periodically. */
function approach(s: GameState, e: Entity, t: Entity): void {
  const goal = approachTile(s, e, t);
  const end = e.path.length > 0 ? e.path[e.path.length - 1] : -1;
  if (goal >= 0 && (e.path.length === 0 || e.pathIdx >= e.path.length || (s.tick >= e.repathAt && end !== goal))) {
    pathTo(s, e, goal);
    e.repathAt = s.tick + 12;
    if (e.path.length === 0) {
      // already standing on the goal tile: nudge toward the target
      nudgeToward(e, t);
      return;
    }
  }
  moveAlong(s, e);
}

function nudgeToward(e: Entity, t: Entity): void {
  const d = UNITS[e.kind];
  if (!d) return;
  const dx = t.x - e.x;
  const dy = t.y - e.y;
  const dist = ilen(dx, dy);
  if (dist === 0) return;
  const step = d.speed < dist ? idiv(d.speed, 2) : 0;
  e.x += idiv(dx * step, dist);
  e.y += idiv(dy * step, dist);
}

function freeTileNear(s: GameState, b: Entity, pass: Passable, skip: number): number {
  // ring tiles around the footprint, south side first, deterministic order
  const w = s.map.w;
  const h = s.map.h;
  for (let r = 1; r <= 6; r++) {
    const ring: number[] = [];
    for (let y = b.tileY - r; y < b.tileY + b.size + r; y++) {
      for (let x = b.tileX - r; x < b.tileX + b.size + r; x++) {
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        const onRing = x === b.tileX - r || y === b.tileY - r || x === b.tileX + b.size + r - 1 || y === b.tileY + b.size + r - 1;
        if (!onRing) continue;
        const i = y * w + x;
        const free = idx.grid.length === 0 || (idx.grid[i]?.length ?? 0) === 0;
        if (pass(i) && free) ring.push(i);
      }
    }
    // prefer tiles below (larger y), then by index
    ring.sort((a, c) => idiv(c, w) - idiv(a, w) || a - c);
    if (ring.length > skip) return ring[skip];
    skip -= ring.length;
  }
  return -1;
}

// ---------------------------------------------------------------- combat

function canTarget(s: GameState, e: Entity, t: Entity): boolean {
  const d = UNITS[e.kind];
  if (!d || d.atk <= 0) return false;
  if (t.dead || t.inside) return false;
  if (!areEnemies(s, e.owner, t.owner)) return false;
  const targetIsBuilding = t.kind in BUILDINGS;
  if (d.buildingsOnly && !targetIsBuilding) return false;
  const tn = UNITS[t.kind]?.naval ?? false;
  // melee land units cannot reach boats; boats cannot melee
  if (tn && !d.naval && d.range <= FP) return false;
  return true;
}

function damage(s: GameState, attacker: Entity, atk: number, bonus: UnitDef['bonus'], t: Entity): void {
  if (t.dead) return;
  const armor = t.kind in BUILDINGS ? 'building' : UNITS[t.kind]?.armor;
  let dmg = atk;
  const b = armor ? bonus[armor] : undefined;
  if (b !== undefined) dmg = pct(dmg, b);
  if (dmg < 1) dmg = 1;
  t.hp -= dmg;
  if (t.hp <= 0) {
    t.hp = 0;
    t.dead = true;
    if (attacker.owner >= 0 && t.owner >= 0) s.players[attacker.owner].stats.kills++;
  }
}

function hit(s: GameState, e: Entity, t: Entity, atk: number, bonus: UnitDef['bonus'], ranged: boolean, splash: number): void {
  s.events.push({ e: 'attack', from: e.id, to: t.id, ranged, kind: e.kind, x: e.x, y: e.y, tx: t.x, ty: t.y });
  damage(s, e, atk, bonus, t);
  if (splash > 0) {
    const half = idiv(atk, 2);
    const w = s.map.w;
    const cx = toTile(t.x);
    const cy = toTile(t.y);
    for (let y = cy - 1; y <= cy + 1; y++) {
      for (let x = cx - 1; x <= cx + 1; x++) {
        if (x < 0 || y < 0 || x >= w || y >= s.map.h) continue;
        for (const id of idx.grid[y * w + x]) {
          const o = s.byId.get(id);
          if (!o || o === t || o.dead || !areEnemies(s, e.owner, o.owner)) continue;
          if (ilen(o.x - t.x, o.y - t.y) <= splash) damage(s, e, half, bonus, o);
        }
      }
    }
  }
}

// ---------------------------------------------------------------- orders

function setIdle(e: Entity): void {
  e.order = Order.IDLE;
  e.targetId = 0;
  e.amX = -1;
  e.amY = -1;
  e.autoTarget = false;
  stopMoving(e);
}

function orderMove(s: GameState, e: Entity, goal: number, attackMove: boolean): void {
  e.order = Order.MOVE;
  e.targetId = 0;
  e.autoTarget = false;
  const w = s.map.w;
  e.tx = tileCenter(goal % w);
  e.ty = tileCenter(idiv(goal, w));
  e.amX = attackMove ? e.tx : -1;
  e.amY = attackMove ? e.ty : -1;
  pathTo(s, e, goal);
}

function orderAttack(e: Entity, t: Entity, auto: boolean): void {
  e.order = Order.ATTACK;
  e.targetId = t.id;
  e.autoTarget = auto;
  stopMoving(e);
  e.repathAt = 0;
}

function orderGather(e: Entity, r: Entity): void {
  e.order = Order.GATHER;
  e.targetId = r.id;
  e.lastResId = r.id;
  e.lastResKind = r.kind;
  e.amX = -1;
  stopMoving(e);
}

function orderBuild(e: Entity, b: Entity): void {
  e.order = Order.BUILD;
  e.targetId = b.id;
  e.amX = -1;
  stopMoving(e);
}

function nearestResource(s: GameState, x: number, y: number, kind: string, maxTiles: number): Entity | null {
  let best: Entity | null = null;
  let bestD = maxTiles * FP;
  for (const e of s.entities) {
    if (e.dead || e.kind !== kind || e.amount <= 0) continue;
    const d = distToEdge(x, y, e);
    if (d < bestD) {
      bestD = d;
      best = e;
    }
  }
  return best;
}

function nearestDropoff(s: GameState, e: Entity): Entity | null {
  let best: Entity | null = null;
  let bestD = 1 << 30;
  for (const b of idx.buildings) {
    if (b.dead || b.owner !== e.owner || !b.done || !BUILDINGS[b.kind].dropoff) continue;
    const d = distToEdge(e.x, e.y, b);
    if (d < bestD) {
      bestD = d;
      best = b;
    }
  }
  return best;
}

/** Send a worker to the nearest resource of whichever kind its owner has less of. */
function autoGather(s: GameState, e: Entity): void {
  const p = s.players[e.owner];
  const first = p.wood <= p.gold ? 'tree' : 'goldmine';
  const second = first === 'tree' ? 'goldmine' : 'tree';
  const r = nearestResource(s, e.x, e.y, first, 14) ?? nearestResource(s, e.x, e.y, second, 14);
  if (r) orderGather(e, r);
  else setIdle(e);
}

function updateUnit(s: GameState, e: Entity, d: UnitDef): void {
  if (e.cooldown > 0) e.cooldown--;
  switch (e.order) {
    case Order.IDLE: {
      if (d.atk > 0 && e.kind !== 'worker' && s.tick >= e.scanAt) {
        e.scanAt = s.tick + 8;
        const t = findEnemy(s, e, d.sight, (t) => canTarget(s, e, t));
        if (t) orderAttack(e, t, true);
      }
      return;
    }
    case Order.MOVE: {
      if (e.amX >= 0 && d.atk > 0 && s.tick >= e.scanAt) {
        e.scanAt = s.tick + 8;
        const t = findEnemy(s, e, d.sight, (t) => canTarget(s, e, t));
        if (t) {
          const ax = e.amX;
          const ay = e.amY;
          orderAttack(e, t, true);
          e.amX = ax;
          e.amY = ay;
          return;
        }
      }
      if (moveAlong(s, e)) {
        if (e.amX >= 0 && ilen(e.amX - e.x, e.amY - e.y) > 2 * FP) {
          // got pushed off course during an attack-move: keep going
          pathTo(s, e, tileOf(s, e.amX, e.amY));
          if (e.path.length === 0) setIdle(e);
        } else {
          setIdle(e);
        }
      }
      return;
    }
    case Order.ATTACK: {
      const t = s.byId.get(e.targetId);
      if (!t || !canTarget(s, e, t)) {
        resumeAfterAttack(s, e);
        return;
      }
      // Marching on a building? Fight back against enemy soldiers close by first,
      // then carry on to the building (what players expect).
      if (t.kind in BUILDINGS && s.tick >= e.scanAt && e.kind !== 'worker') {
        e.scanAt = s.tick + 8;
        const foe = findEnemy(s, e, 3, (o) => !(o.kind in BUILDINGS) && o.kind !== 'worker' && canTarget(s, e, o));
        if (foe) {
          orderAttack(e, foe, true);
          e.amX = t.x;
          e.amY = t.y;
          return;
        }
      }
      const dist = distToEdge(e.x, e.y, t);
      if (e.autoTarget && dist > (d.sight + 4) * FP) {
        resumeAfterAttack(s, e);
        return;
      }
      if (dist <= d.range) {
        if (dist < d.minRange) {
          resumeAfterAttack(s, e);
          e.scanAt = s.tick + 20;
          return;
        }
        stopMoving(e);
        if (e.cooldown === 0) {
          hit(s, e, t, d.atk, d.bonus, d.range > FP, d.splash);
          e.cooldown = d.cooldown;
        }
        return;
      }
      approach(s, e, t); // boats chase on water as close as they can get
      return;
    }
    case Order.GATHER: {
      let r = s.byId.get(e.targetId);
      if (!r || r.dead || r.amount <= 0) {
        r = nearestResource(s, e.x, e.y, e.lastResKind || 'tree', 12) ?? undefined;
        if (!r) {
          if (e.carryAmt > 0) e.order = Order.RETURN;
          else setIdle(e);
          return;
        }
        e.targetId = r.id;
        e.lastResId = r.id;
        stopMoving(e);
      }
      const res = RESOURCES[r.kind].res === 'wood' ? 1 : 2;
      if (e.carryRes !== res) {
        e.carryRes = res;
        e.carryAmt = 0;
      }
      if (e.carryAmt >= d.carry) {
        e.order = Order.RETURN;
        e.targetId = 0;
        stopMoving(e);
        return;
      }
      if (distToEdge(e.x, e.y, r) <= REACH) {
        stopMoving(e);
        e.gatherTimer++;
        if (e.gatherTimer >= d.gatherTicks) {
          e.gatherTimer = 0;
          e.carryAmt++;
          r.amount--;
          if (r.amount <= 0) r.dead = true;
        }
        return;
      }
      approach(s, e, r);
      return;
    }
    case Order.RETURN: {
      let b = s.byId.get(e.targetId);
      if (!b || b.dead || !b.done || b.owner !== e.owner || !BUILDINGS[b.kind]?.dropoff) {
        b = nearestDropoff(s, e) ?? undefined;
        if (!b) {
          setIdle(e);
          return;
        }
        e.targetId = b.id;
        stopMoving(e);
      }
      if (distToEdge(e.x, e.y, b) <= REACH) {
        const p = s.players[e.owner];
        if (e.carryRes === 1) p.wood += e.carryAmt;
        else if (e.carryRes === 2) p.gold += e.carryAmt;
        p.stats.gathered += e.carryAmt;
        e.carryAmt = 0;
        const last = s.byId.get(e.lastResId);
        if (last && !last.dead && last.amount > 0) orderGather(e, last);
        else {
          const r = nearestResource(s, e.x, e.y, e.lastResKind || 'tree', 14);
          if (r) orderGather(e, r);
          else setIdle(e);
        }
        return;
      }
      approach(s, e, b);
      return;
    }
    case Order.BUILD: {
      const b = s.byId.get(e.targetId);
      if (!b || b.dead || teamOf(s, b.owner) !== teamOf(s, e.owner)) {
        setIdle(e);
        return;
      }
      if (b.done && b.hp >= b.maxHp) {
        if (BUILDINGS[b.kind].dropoff || BUILDINGS[b.kind].popCap > 0) autoGather(s, e);
        else setIdle(e);
        return;
      }
      if (distToEdge(e.x, e.y, b) <= REACH) {
        stopMoving(e);
        const bd = BUILDINGS[b.kind];
        if (!b.done) {
          b.progress++;
          // hp grows from 10% to 100% exactly as progress goes 0 -> buildTime
          const base = idiv(b.maxHp, 10);
          const want = base + idiv((b.maxHp - base) * b.progress, bd.buildTime);
          if (want > b.hp) b.hp = want;
          if (b.progress >= bd.buildTime) {
            b.done = true;
            b.hp = b.maxHp;
            s.players[b.owner].stats.built++;
            s.events.push({ e: 'built', id: b.id, owner: b.owner });
          }
        } else {
          b.hp += 3;
          if (b.hp > b.maxHp) b.hp = b.maxHp;
        }
        return;
      }
      approach(s, e, b);
      return;
    }
    case Order.BOARD: {
      const t = s.byId.get(e.targetId);
      const td = t ? UNITS[t.kind] : undefined;
      if (!t || t.dead || !td || td.cargo === 0 || t.owner !== e.owner || t.cargo.length >= td.cargo) {
        setIdle(e);
        return;
      }
      if (ilen(t.x - e.x, t.y - e.y) <= 1800) {
        e.inside = t.id;
        t.cargo.push(e.id);
        setIdle(e);
        e.x = t.x;
        e.y = t.y;
        return;
      }
      approach(s, e, t);
      return;
    }
    case Order.UNLOAD: {
      const done = moveAlong(s, e);
      if (done || e.path.length === 0) {
        unloadAll(s, e);
        setIdle(e);
      }
      return;
    }
  }
}

function resumeAfterAttack(s: GameState, e: Entity): void {
  if (e.amX >= 0) {
    const ax = e.amX;
    const ay = e.amY;
    orderMove(s, e, tileOf(s, ax, ay), true);
  } else {
    setIdle(e);
  }
}

function hasLandNeighbor(s: GameState, i: number): boolean {
  const w = s.map.w;
  const x = i % w;
  const y = idiv(i, w);
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= s.map.h) continue;
      if (s.map.tiles[ny * w + nx] !== Tile.WATER) return true;
    }
  }
  return false;
}

function unloadAll(s: GameState, t: Entity): void {
  if (t.cargo.length === 0) return;
  const w = s.map.w;
  const land = passableFn(s, t.owner, false);
  const tx = toTile(t.x);
  const ty = toTile(t.y);
  const used = new Set<number>();
  for (const id of t.cargo) {
    const u = s.byId.get(id);
    if (!u) continue;
    const spot = nearestTile(w, s.map.h, tx, ty, (i) => land(i) && !used.has(i), 4);
    const finalSpot = spot >= 0 ? spot : nearestTile(w, s.map.h, tx, ty, land, 4);
    if (finalSpot < 0) continue; // stays aboard
    used.add(finalSpot);
    u.inside = 0;
    u.x = tileCenter(finalSpot % w);
    u.y = tileCenter(idiv(finalSpot, w));
    setIdle(u);
  }
  t.cargo = t.cargo.filter((id) => (s.byId.get(id)?.inside ?? 0) === t.id);
}

// ---------------------------------------------------------------- buildings

function updateBuilding(s: GameState, b: Entity, d: BuildingDef): void {
  if (!b.done || b.owner < 0) return;
  const p = s.players[b.owner];
  if (b.queue.length > 0) {
    const item = b.queue[0];
    if (item === UPGRADE_ITEM) {
      const up = CASTLE_UPGRADES[p.level];
      b.queueTime++;
      if (!up || b.queueTime >= up.time) {
        b.queue.shift();
        b.queueTime = 0;
        if (up) {
          p.level++;
          s.events.push({ e: 'levelup', owner: p.slot, level: p.level });
        }
      }
    } else {
      const ud = UNITS[item];
      if (b.queueTime < ud.trainTime) b.queueTime++;
      if (b.queueTime >= ud.trainTime && p.pop + ud.pop <= p.popCap) {
        const pass = passableFn(s, b.owner, ud.naval);
        const spot = freeTileNear(s, b, pass, 0);
        const spot2 = spot >= 0 ? spot : freeTileNearAny(s, b, pass);
        if (spot2 >= 0) {
          b.queue.shift();
          b.queueTime = 0;
          const u = spawnUnit(s, item, b.owner, spot2);
          idx.grid[spot2]?.push(u.id);
          p.pop += ud.pop;
          p.stats.trained++;
          s.events.push({ e: 'trained', id: u.id, owner: b.owner });
          sendToRally(s, b, u);
        }
      }
    }
  }
  if (d.atk > 0) {
    if (b.cooldown > 0) b.cooldown--;
    if (b.cooldown === 0 && s.tick >= b.scanAt) {
      b.scanAt = s.tick + 4;
      const t = findEnemy(s, b, idiv(d.range, FP) + 1, (t) => !t.dead && !t.inside && !(t.kind in BUILDINGS));
      if (t && distToEdge(b.x, b.y, t) <= d.range) {
        hit(s, b, t, d.atk, {}, true, 0);
        b.cooldown = d.cooldown;
      }
    }
  }
}

function freeTileNearAny(s: GameState, b: Entity, pass: Passable): number {
  return nearestTile(s.map.w, s.map.h, b.tileX, b.tileY, pass, 8);
}

function sendToRally(s: GameState, b: Entity, u: Entity): void {
  const ud = UNITS[u.kind];
  if (b.rallyX >= 0) {
    const ri = tileOf(s, b.rallyX, b.rallyY);
    const o = s.occ[ri];
    const r = o ? s.byId.get(o) : undefined;
    if (u.kind === 'worker' && r && r.kind in RESOURCES) {
      orderGather(u, r);
      return;
    }
    orderMove(s, u, ri, ud.atk > 0 && u.kind !== 'worker');
    return;
  }
  if (u.kind === 'worker') autoGather(s, u);
}

// ---------------------------------------------------------------- separation

function separate(s: GameState): void {
  const w = s.map.w;
  const h = s.map.h;
  for (const a of s.entities) {
    if (a.dead || a.size > 0 || a.inside) continue;
    const ad = UNITS[a.kind];
    if (!ad) continue;
    const ax = toTile(a.x);
    const ay = toTile(a.y);
    for (let y = ay - 1; y <= ay + 1; y++) {
      if (y < 0 || y >= h) continue;
      for (let x = ax - 1; x <= ax + 1; x++) {
        if (x < 0 || x >= w) continue;
        for (const id of idx.grid[y * w + x]) {
          if (id <= a.id) continue;
          const b = s.byId.get(id);
          if (!b || b.dead || b.inside) continue;
          const bd = UNITS[b.kind];
          if (!bd || bd.naval !== ad.naval) continue;
          const minD = ad.radius + bd.radius;
          let dx = b.x - a.x;
          let dy = b.y - a.y;
          let dist = ilen(dx, dy);
          if (dist >= minD) continue;
          if (dist === 0) {
            dx = (a.id % 3) - 1 || 1;
            dy = (b.id % 3) - 1;
            dist = ilen(dx, dy);
          }
          const push = idiv((minD - dist) * 3, 8);
          const px = idiv(dx * push, dist);
          const py = idiv(dy * push, dist);
          tryShift(s, a, -px, -py);
          tryShift(s, b, px, py);
        }
      }
    }
  }
}

function tryShift(s: GameState, e: Entity, dx: number, dy: number): void {
  // units busy at a spot (gathering, building, attacking in range) are pushed less
  if (e.order === Order.ATTACK && e.path.length === 0) {
    dx = idiv(dx, 3);
    dy = idiv(dy, 3);
  }
  const nx = e.x + dx;
  const ny = e.y + dy;
  if (nx < 0 || ny < 0 || nx >= s.map.w * FP || ny >= s.map.h * FP) return;
  const pass = domainPass(s, e);
  if (!pass(tileOf(s, nx, ny))) return;
  e.x = nx;
  e.y = ny;
}

// ---------------------------------------------------------------- deaths and victory

function eliminate(s: GameState, slot: number): void {
  const p = s.players[slot];
  if (!p.alive) return;
  p.alive = false;
  for (const e of s.entities) {
    if (e.owner === slot && !e.dead) {
      e.dead = true;
      e.hp = 0;
    }
  }
  s.events.push({ e: 'eliminated', owner: slot });
}

function processDeaths(s: GameState): void {
  // castles falling eliminates their owner
  for (const p of s.players) {
    if (!p.alive) continue;
    const c = s.byId.get(p.castleId);
    if (!c || c.dead) eliminate(s, p.slot);
  }
  // passengers sink with their boat
  for (const e of s.entities) {
    if (e.dead && e.cargo.length > 0) {
      for (const id of e.cargo) {
        const u = s.byId.get(id);
        if (u) u.dead = true;
      }
    }
  }
  let any = false;
  for (const e of s.entities) {
    if (!e.dead) continue;
    any = true;
    s.byId.delete(e.id);
    if (e.size > 0) setOcc(s, e, 0);
    if (e.owner >= 0) {
      const p = s.players[e.owner];
      if (e.kind in UNITS) p.stats.lost++;
    }
    if (!(e.kind in RESOURCES) || e.amount <= 0) {
      s.events.push({ e: 'death', id: e.id, kind: e.kind, owner: e.owner, x: e.x, y: e.y, building: e.size > 0 && e.kind in BUILDINGS });
    }
  }
  if (any) {
    s.entities = s.entities.filter((e) => !e.dead);
    for (const e of s.entities) {
      if (e.cargo.length > 0) e.cargo = e.cargo.filter((id) => s.byId.has(id));
    }
  }
}

function recomputePop(s: GameState): void {
  for (const p of s.players) {
    p.pop = 0;
    p.popCap = 0;
  }
  for (const e of s.entities) {
    if (e.dead || e.owner < 0) continue;
    const p = s.players[e.owner];
    const ud = UNITS[e.kind];
    if (ud) p.pop += ud.pop;
    else {
      const bd = BUILDINGS[e.kind];
      if (bd && e.done) p.popCap += bd.popCap;
    }
  }
  for (const p of s.players) if (p.popCap > MAX_POP) p.popCap = MAX_POP;
}

function checkVictory(s: GameState): void {
  if (s.over) return;
  const teams: number[] = [];
  for (const p of s.players) if (p.alive && !teams.includes(p.team)) teams.push(p.team);
  if (teams.length <= 1) {
    s.over = true;
    s.winnerTeam = teams.length === 1 ? teams[0] : -1;
    s.events.push({ e: 'gameover', team: s.winnerTeam });
  }
}

// ---------------------------------------------------------------- commands

function int(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) | 0 : 0;
}

/** Owned, alive, on-map units from an untrusted id list, sorted and unique. */
function ownUnits(s: GameState, p: number, ids: unknown): Entity[] {
  if (!Array.isArray(ids)) return [];
  const seen = new Set<number>();
  const out: Entity[] = [];
  for (const raw of ids.slice(0, 200)) {
    const id = int(raw);
    if (seen.has(id)) continue;
    seen.add(id);
    const e = s.byId.get(id);
    if (e && !e.dead && e.owner === p && e.kind in UNITS && !e.inside) out.push(e);
  }
  out.sort((a, b) => a.id - b.id);
  return out;
}

function ownBuilding(s: GameState, p: number, id: unknown): Entity | null {
  const e = s.byId.get(int(id));
  if (!e || e.dead || e.owner !== p || !(e.kind in BUILDINGS)) return null;
  return e;
}

/** Spread a group over distinct tiles around the goal (spiral order). */
function formationGoals(s: GameState, units: Entity[], gx: number, gy: number): number[] {
  const w = s.map.w;
  const h = s.map.h;
  const result: number[] = [];
  const used = new Set<number>();
  for (const u of units) {
    const pass = domainPass(s, u);
    const t = nearestTile(w, h, gx, gy, (i) => pass(i) && !used.has(i), 8);
    const goal = t >= 0 ? t : nearestTile(w, h, gx, gy, pass, 12);
    if (goal >= 0) used.add(goal);
    result.push(goal);
  }
  return result;
}

function groupMove(s: GameState, units: Entity[], x: number, y: number, attackMove: boolean): void {
  const gx = toTile(x);
  const gy = toTile(y);
  if (gx < 0 || gy < 0 || gx >= s.map.w || gy >= s.map.h) return;
  const goals = formationGoals(s, units, gx, gy);
  units.forEach((u, i) => {
    if (goals[i] < 0) return;
    const d = UNITS[u.kind];
    if (u.kind === 'transport' && u.cargo.length > 0 && s.map.tiles[gy * s.map.w + gx] !== Tile.WATER) {
      orderUnload(s, u, x, y);
      return;
    }
    orderMove(s, u, goals[i], attackMove && d.atk > 0);
  });
}

function orderUnload(s: GameState, t: Entity, x: number, y: number): void {
  const w = s.map.w;
  const water = passableFn(s, t.owner, true);
  const gx = toTile(x);
  const gy = toTile(y);
  const goal = nearestTile(w, s.map.h, gx, gy, (i) => water(i) && hasLandNeighbor(s, i), 12);
  if (goal < 0) return;
  t.order = Order.UNLOAD;
  t.targetId = 0;
  t.amX = -1;
  pathTo(s, t, goal);
}

export function applyCommand(s: GameState, pc: PlayerCommand): void {
  const p = int(pc.p);
  if (p < 0 || p >= s.players.length || !s.players[p].alive || s.over) return;
  const player = s.players[p];
  const c = pc.c as Command;
  if (!c || typeof c !== 'object') return;
  switch (c.t) {
    case 'smart': {
      const units = ownUnits(s, p, c.ids);
      if (units.length === 0) return;
      const target = c.target ? s.byId.get(int(c.target)) : undefined;
      const movers: Entity[] = [];
      for (const u of units) {
        const ud = UNITS[u.kind];
        if (target && !target.dead) {
          if (areEnemies(s, p, target.owner) && canTarget(s, u, target)) {
            orderAttack(u, target, false);
            continue;
          }
          if (u.kind === 'worker' && target.kind in RESOURCES) {
            orderGather(u, target);
            continue;
          }
          if (u.kind === 'worker' && target.kind in BUILDINGS && teamOf(s, target.owner) === player.team) {
            if (!target.done || target.hp < target.maxHp) {
              orderBuild(u, target);
              continue;
            }
            if (u.carryAmt > 0 && target.owner === p && BUILDINGS[target.kind].dropoff) {
              u.order = Order.RETURN;
              u.targetId = target.id;
              stopMoving(u);
              continue;
            }
          }
          if (!ud.naval && UNITS[target.kind]?.cargo && target.owner === p) {
            u.order = Order.BOARD;
            u.targetId = target.id;
            stopMoving(u);
            continue;
          }
        }
        movers.push(u);
      }
      if (movers.length > 0) groupMove(s, movers, int(c.x), int(c.y), false);
      return;
    }
    case 'move':
    case 'amove': {
      const units = ownUnits(s, p, c.ids);
      groupMove(s, units, int(c.x), int(c.y), c.t === 'amove');
      return;
    }
    case 'attack': {
      const t = s.byId.get(int(c.target));
      if (!t) return;
      for (const u of ownUnits(s, p, c.ids)) if (canTarget(s, u, t)) orderAttack(u, t, false);
      return;
    }
    case 'gather': {
      const r = s.byId.get(int(c.target));
      if (!r || !(r.kind in RESOURCES)) return;
      for (const u of ownUnits(s, p, c.ids)) if (u.kind === 'worker') orderGather(u, r);
      return;
    }
    case 'repair': {
      const b = s.byId.get(int(c.target));
      if (!b || !(b.kind in BUILDINGS) || teamOf(s, b.owner) !== player.team) return;
      for (const u of ownUnits(s, p, c.ids)) if (u.kind === 'worker') orderBuild(u, b);
      return;
    }
    case 'build': {
      const kind = String(c.kind);
      const bd = BUILDINGS[kind];
      if (!bd || !bd.buildable || player.level < bd.level) return;
      const workers = ownUnits(s, p, c.ids).filter((u) => u.kind === 'worker');
      if (workers.length === 0) return;
      const tx = int(c.tx);
      const ty = int(c.ty);
      if (!canPlace(s, p, kind, tx, ty) || !canAfford(player, bd.cost)) return;
      pay(player, bd.cost);
      const b = spawnStatic(s, kind, p, tx, ty, bd.size);
      b.done = false;
      b.progress = 0;
      b.hp = Math.max(1, idiv(bd.hp, 10));
      // nudge any units standing on the footprint
      for (const e of s.entities) {
        if (e.size > 0 || e.inside || e.dead || UNITS[e.kind]?.naval) continue;
        const ex = toTile(e.x);
        const ey = toTile(e.y);
        if (ex >= tx && ex < tx + bd.size && ey >= ty && ey < ty + bd.size) {
          const spot = nearestTile(s.map.w, s.map.h, ex, ey, passableFn(s, e.owner, false), 6);
          if (spot >= 0) {
            e.x = tileCenter(spot % s.map.w);
            e.y = tileCenter(idiv(spot, s.map.w));
            stopMoving(e);
          }
        }
      }
      for (const u of workers) orderBuild(u, b);
      return;
    }
    case 'train': {
      const b = ownBuilding(s, p, c.b);
      const kind = String(c.kind);
      if (!b || !b.done) return;
      const bd = BUILDINGS[b.kind];
      const ud = UNITS[kind];
      if (!ud || !bd.trains.includes(kind) || player.level < ud.level || b.queue.length >= 5) return;
      if (!canAfford(player, ud.cost)) return;
      pay(player, ud.cost);
      b.queue.push(kind);
      return;
    }
    case 'cancel': {
      const b = ownBuilding(s, p, c.b);
      if (!b || b.queue.length === 0) return;
      const item = b.queue.pop() as string;
      if (b.queue.length === 0) b.queueTime = 0;
      if (item === UPGRADE_ITEM) {
        const up = CASTLE_UPGRADES[player.level];
        if (up) refund(player, up.cost);
      } else if (UNITS[item]) refund(player, UNITS[item].cost);
      return;
    }
    case 'upgrade': {
      const b = ownBuilding(s, p, c.b);
      if (!b || b.kind !== 'castle' || !b.done || b.queue.includes(UPGRADE_ITEM) || b.queue.length >= 5) return;
      const up = CASTLE_UPGRADES[player.level];
      if (!up || !canAfford(player, up.cost)) return;
      pay(player, up.cost);
      b.queue.push(UPGRADE_ITEM);
      return;
    }
    case 'rally': {
      const b = ownBuilding(s, p, c.b);
      if (!b) return;
      b.rallyX = int(c.x);
      b.rallyY = int(c.y);
      return;
    }
    case 'stop': {
      for (const u of ownUnits(s, p, c.ids)) setIdle(u);
      return;
    }
    case 'board': {
      const t = s.byId.get(int(c.transport));
      if (!t || t.owner !== p || !UNITS[t.kind]?.cargo) return;
      for (const u of ownUnits(s, p, c.ids)) {
        if (UNITS[u.kind].naval) continue;
        u.order = Order.BOARD;
        u.targetId = t.id;
        stopMoving(u);
      }
      return;
    }
    case 'unload': {
      const t = s.byId.get(int(c.transport));
      if (!t || t.owner !== p || t.cargo.length === 0) return;
      orderUnload(s, t, int(c.x), int(c.y));
      return;
    }
    case 'resign': {
      eliminate(s, p);
      return;
    }
  }
}

// ---------------------------------------------------------------- the tick

export function step(s: GameState): void {
  s.events = [];
  if (s.over) {
    s.tick++;
    return;
  }
  buildIndex(s);
  for (const e of s.entities) {
    if (e.dead) continue;
    const bd = BUILDINGS[e.kind];
    if (bd) updateBuilding(s, e, bd);
  }
  for (const e of s.entities) {
    if (e.dead || e.inside) continue;
    const ud = UNITS[e.kind];
    if (ud) updateUnit(s, e, ud);
  }
  // passengers ride along
  for (const e of s.entities) {
    if (e.cargo.length === 0) continue;
    for (const id of e.cargo) {
      const u = s.byId.get(id);
      if (u) {
        u.x = e.x;
        u.y = e.y;
      }
    }
  }
  buildIndex(s);
  separate(s);
  processDeaths(s);
  recomputePop(s);
  for (const p of s.players) {
    if (p.alive && p.bot && s.tick >= p.bot.nextThink) botThink(s, p);
  }
  checkVictory(s);
  s.tick++;
}

/** Internal command entry used by bots (same validation as players). */
export function botCommand(s: GameState, slot: number, c: Command): void {
  applyCommand(s, { p: slot, c });
}

export { tileOf, nearestResource };
