import type { RngState } from './rng.ts';

export const Order = {
  IDLE: 0,
  MOVE: 1,
  ATTACK: 2,
  GATHER: 3,
  RETURN: 4,
  BUILD: 5,
  BOARD: 6,
  UNLOAD: 7,
} as const;

export const Tile = {
  GRASS: 0,
  WATER: 1,
  SAND: 2,
} as const;

/** One struct for every thing on the map: units, buildings and resources. */
export interface Entity {
  id: number;
  kind: string;
  owner: number; // player slot, -1 = nature
  x: number; // fixed-point center
  y: number;
  hp: number;
  maxHp: number;
  dead: boolean;

  // units
  order: number;
  targetId: number;
  tx: number; // order target point (fixed-point)
  ty: number;
  amX: number; // attack-move destination, -1 = none
  amY: number;
  path: number[]; // tile indices
  pathIdx: number;
  repathAt: number;
  cooldown: number;
  carryRes: number; // 0 none, 1 wood, 2 gold
  carryAmt: number;
  gatherTimer: number;
  lastResKind: string;
  lastResId: number;
  inside: number; // transport id or 0
  cargo: number[];
  scanAt: number;
  autoTarget: boolean; // target was auto-acquired (gives up chasing far away)

  // buildings and resources
  tileX: number;
  tileY: number;
  size: number;
  progress: number; // construction ticks done
  done: boolean;
  queue: string[];
  queueTime: number;
  rallyX: number; // -1 = none
  rallyY: number;
  amount: number; // resources
}

export interface PlayerStats {
  trained: number;
  kills: number;
  lost: number;
  gathered: number;
  built: number;
}

export interface BotMemory {
  level: number; // 0 passive, 1 easy, 2 normal, 3 hard
  nextThink: number;
  waveSize: number;
  waves: number;
  lastAttackTick: number;
}

export interface Player {
  slot: number;
  name: string;
  team: number;
  color: number;
  hat: number; // cosmetic, never affects gameplay
  isBot: boolean;
  bot: BotMemory | null;
  wood: number;
  gold: number;
  pop: number;
  popCap: number;
  level: number;
  alive: boolean;
  castleId: number;
  corner: number;
  stats: PlayerStats;
}

export interface GameMap {
  w: number;
  h: number;
  tiles: Uint8Array;
}

export type GameEvent =
  | { e: 'attack'; from: number; to: number; ranged: boolean; kind: string; x: number; y: number; tx: number; ty: number }
  | { e: 'death'; id: number; kind: string; owner: number; x: number; y: number; building: boolean }
  | { e: 'built'; id: number; owner: number }
  | { e: 'trained'; id: number; owner: number }
  | { e: 'levelup'; owner: number; level: number }
  | { e: 'eliminated'; owner: number }
  | { e: 'gameover'; team: number };

export interface GameState {
  seed: number;
  tick: number;
  rng: RngState;
  map: GameMap;
  occ: Int32Array; // static blocker entity id per tile (buildings, trees, mines)
  entities: Entity[]; // always sorted by id
  byId: Map<number, Entity>; // derived index
  nextId: number;
  players: Player[];
  events: GameEvent[]; // this tick only, not hashed
  over: boolean;
  winnerTeam: number;
}

export type Command =
  | { t: 'smart'; ids: number[]; x: number; y: number; target: number }
  | { t: 'move'; ids: number[]; x: number; y: number }
  | { t: 'amove'; ids: number[]; x: number; y: number }
  | { t: 'attack'; ids: number[]; target: number }
  | { t: 'gather'; ids: number[]; target: number }
  | { t: 'build'; ids: number[]; kind: string; tx: number; ty: number }
  | { t: 'repair'; ids: number[]; target: number }
  | { t: 'train'; b: number; kind: string }
  | { t: 'cancel'; b: number }
  | { t: 'rally'; b: number; x: number; y: number }
  | { t: 'upgrade'; b: number }
  | { t: 'stop'; ids: number[] }
  | { t: 'board'; ids: number[]; transport: number }
  | { t: 'unload'; transport: number; x: number; y: number }
  | { t: 'resign' };

/** A command stamped with the player slot by the relay server. */
export interface PlayerCommand {
  p: number;
  c: Command;
}

export interface PlayerSetup {
  name: string;
  team: number;
  isBot: boolean;
  botLevel: number;
  hat: number;
}

export interface GameSetup {
  seed: number;
  mode: GameMode;
  players: PlayerSetup[];
}

export type GameMode = '1v1' | '2v2' | 'ffa3' | 'ffa4';
