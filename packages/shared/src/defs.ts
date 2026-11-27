// Game data. Balancing = editing numbers here.
// Speeds are fixed-point units per tick (1 tile = 1024, 20 ticks per second).
// Ranges are fixed-point, measured from attacker center to target edge.
// Times are in ticks.

export const TICKS_PER_SECOND = 20;
export const TICKS_PER_TURN = 2; // one lockstep turn = 100 ms
export const TURN_MS = 100;
export const HASH_EVERY_TURNS = 10;
export const MAX_POP = 100;
export const START_WOOD = 200;
export const START_GOLD = 150;
export const START_WORKERS = 4;

export type ArmorClass = 'worker' | 'infantry' | 'archer' | 'cavalry' | 'siege' | 'ship' | 'building';

export interface Cost {
  wood: number;
  gold: number;
}

export interface UnitDef {
  kind: string;
  name: string;
  icon: string;
  desc: string;
  hp: number;
  speed: number;
  sight: number; // tiles
  atk: number;
  range: number;
  minRange: number;
  cooldown: number;
  splash: number; // fixed-point radius, 0 = none
  armor: ArmorClass;
  bonus: Partial<Record<ArmorClass, number>>; // percent damage multipliers
  buildingsOnly: boolean;
  naval: boolean;
  cost: Cost;
  trainTime: number;
  pop: number;
  level: number; // castle level required
  carry: number; // workers
  gatherTicks: number; // ticks per resource unit
  cargo: number; // transport capacity
  radius: number; // fixed-point body radius
}

export interface BuildingDef {
  kind: string;
  name: string;
  icon: string;
  desc: string;
  size: number;
  hp: number;
  cost: Cost;
  buildTime: number;
  trains: string[];
  popCap: number;
  dropoff: boolean;
  atk: number;
  range: number;
  cooldown: number;
  sight: number;
  level: number;
  needsWater: boolean;
  gate: boolean;
  buildable: boolean; // can workers place it
}

function unit(u: Partial<UnitDef> & Pick<UnitDef, 'kind' | 'name' | 'icon' | 'desc' | 'hp' | 'speed' | 'armor' | 'cost' | 'trainTime'>): UnitDef {
  return {
    sight: 7,
    atk: 0,
    range: 900,
    minRange: 0,
    cooldown: 20,
    splash: 0,
    bonus: {},
    buildingsOnly: false,
    naval: false,
    pop: 1,
    level: 1,
    carry: 0,
    gatherTicks: 0,
    cargo: 0,
    radius: 300,
    ...u,
  };
}

function building(b: Partial<BuildingDef> & Pick<BuildingDef, 'kind' | 'name' | 'icon' | 'desc' | 'size' | 'hp' | 'cost' | 'buildTime'>): BuildingDef {
  return {
    trains: [],
    popCap: 0,
    dropoff: false,
    atk: 0,
    range: 0,
    cooldown: 25,
    sight: 6,
    level: 1,
    needsWater: false,
    gate: false,
    buildable: true,
    ...b,
  };
}

export const UNITS: Record<string, UnitDef> = {
  worker: unit({
    kind: 'worker', name: 'Worker', icon: '🧑‍🌾', desc: 'Chops wood, mines gold and builds.',
    hp: 40, speed: 82, armor: 'worker', atk: 3, cooldown: 25,
    cost: { wood: 0, gold: 30 }, trainTime: 160, carry: 10, gatherTicks: 8,
  }),
  swordsman: unit({
    kind: 'swordsman', name: 'Swordsman', icon: '🗡️', desc: 'Tough fighter. Beats knights.',
    hp: 110, speed: 77, armor: 'infantry', atk: 10, cooldown: 20,
    bonus: { cavalry: 175 }, cost: { wood: 20, gold: 40 }, trainTime: 240,
  }),
  archer: unit({
    kind: 'archer', name: 'Archer', icon: '🏹', desc: 'Shoots from far away. Beats swordsmen.',
    hp: 55, speed: 82, armor: 'archer', atk: 7, range: 5 * 1024, cooldown: 26, sight: 8,
    bonus: { infantry: 175 }, cost: { wood: 35, gold: 25 }, trainTime: 240,
  }),
  knight: unit({
    kind: 'knight', name: 'Knight', icon: '🐴', desc: 'Fast and strong. Beats archers.',
    hp: 140, speed: 133, armor: 'cavalry', atk: 13, cooldown: 22, sight: 8,
    bonus: { archer: 200 }, cost: { wood: 40, gold: 70 }, trainTime: 320, level: 2, radius: 380,
  }),
  ram: unit({
    kind: 'ram', name: 'Battering Ram', icon: '🪵', desc: 'Smashes gates, walls and castles.',
    hp: 180, speed: 51, armor: 'siege', atk: 45, cooldown: 40, buildingsOnly: true,
    cost: { wood: 120, gold: 40 }, trainTime: 400, level: 2, pop: 2, radius: 420,
  }),
  catapult: unit({
    kind: 'catapult', name: 'Catapult', icon: '☄️', desc: 'Throws rocks very far. Great vs buildings.',
    hp: 90, speed: 46, armor: 'siege', atk: 30, range: 7 * 1024, minRange: 2 * 1024, cooldown: 70,
    splash: 1024, sight: 9, bonus: { building: 250 }, cost: { wood: 140, gold: 100 }, trainTime: 480,
    level: 3, pop: 2, radius: 420,
  }),
  transport: unit({
    kind: 'transport', name: 'Transport Boat', icon: '⛵', desc: 'Carries 8 units across water.',
    hp: 120, speed: 123, armor: 'ship', naval: true, cargo: 8, sight: 7,
    cost: { wood: 100, gold: 0 }, trainTime: 300, radius: 500,
  }),
  warship: unit({
    kind: 'warship', name: 'Warship', icon: '🚢', desc: 'Fights boats and units near the shore.',
    hp: 130, speed: 113, armor: 'ship', naval: true, atk: 9, range: 5 * 1024, cooldown: 25, sight: 8,
    bonus: { ship: 150 }, cost: { wood: 120, gold: 40 }, trainTime: 400, level: 2, radius: 500,
  }),
};

export const BUILDINGS: Record<string, BuildingDef> = {
  castle: building({
    kind: 'castle', name: 'Castle', icon: '🏰', desc: 'Your home. Protect it! Trains workers.',
    size: 3, hp: 2400, cost: { wood: 0, gold: 0 }, buildTime: 1, trains: ['worker'], popCap: 10,
    dropoff: true, atk: 7, range: 6 * 1024, cooldown: 25, sight: 9, buildable: false,
  }),
  house: building({
    kind: 'house', name: 'House', icon: '🏠', desc: 'Lets you have 6 more units.',
    size: 2, hp: 500, cost: { wood: 40, gold: 0 }, buildTime: 260, popCap: 6,
  }),
  storehouse: building({
    kind: 'storehouse', name: 'Storehouse', icon: '📦', desc: 'Workers drop wood and gold here.',
    size: 2, hp: 600, cost: { wood: 60, gold: 0 }, buildTime: 280, dropoff: true,
  }),
  barracks: building({
    kind: 'barracks', name: 'Barracks', icon: '⚔️', desc: 'Trains swordsmen and archers.',
    size: 3, hp: 1200, cost: { wood: 120, gold: 0 }, buildTime: 500, trains: ['swordsman', 'archer'],
  }),
  stable: building({
    kind: 'stable', name: 'Stable', icon: '🐎', desc: 'Trains knights.',
    size: 3, hp: 1200, cost: { wood: 150, gold: 50 }, buildTime: 550, trains: ['knight'], level: 2,
  }),
  workshop: building({
    kind: 'workshop', name: 'Workshop', icon: '🔨', desc: 'Builds rams and catapults.',
    size: 3, hp: 1200, cost: { wood: 150, gold: 100 }, buildTime: 600, trains: ['ram', 'catapult'], level: 2,
  }),
  dock: building({
    kind: 'dock', name: 'Dock', icon: '⚓', desc: 'Builds boats. Must touch water.',
    size: 3, hp: 1000, cost: { wood: 120, gold: 0 }, buildTime: 450, trains: ['transport', 'warship'],
    needsWater: true,
  }),
  tower: building({
    kind: 'tower', name: 'Tower', icon: '🗼', desc: 'Shoots arrows at enemies.',
    size: 1, hp: 600, cost: { wood: 60, gold: 60 }, buildTime: 360, atk: 8, range: 6 * 1024,
    cooldown: 25, sight: 8, level: 2,
  }),
  wall: building({
    kind: 'wall', name: 'Wall', icon: '🧱', desc: 'Blocks enemies.',
    size: 1, hp: 450, cost: { wood: 6, gold: 0 }, buildTime: 50, sight: 2,
  }),
  gate: building({
    kind: 'gate', name: 'Gate', icon: '🚪', desc: 'A wall your team can walk through.',
    size: 1, hp: 550, cost: { wood: 25, gold: 0 }, buildTime: 90, sight: 2, gate: true,
  }),
};

export interface ResourceDef {
  kind: string;
  res: 'wood' | 'gold';
  size: number;
  amount: number;
}

export const RESOURCES: Record<string, ResourceDef> = {
  tree: { kind: 'tree', res: 'wood', size: 1, amount: 100 },
  goldmine: { kind: 'goldmine', res: 'gold', size: 2, amount: 2500 },
};

/** Castle upgrades: index = current level. */
export const CASTLE_UPGRADES: Record<number, { cost: Cost; time: number }> = {
  1: { cost: { wood: 200, gold: 150 }, time: 600 },
  2: { cost: { wood: 300, gold: 300 }, time: 900 },
};

export const UPGRADE_ITEM = '@upgrade';

export const BUILD_MENU = ['house', 'storehouse', 'barracks', 'dock', 'stable', 'workshop', 'tower', 'wall', 'gate'];

export function isUnitKind(k: string): boolean {
  return k in UNITS;
}
export function isBuildingKind(k: string): boolean {
  return k in BUILDINGS;
}
export function isResourceKind(k: string): boolean {
  return k in RESOURCES;
}

export const PLAYER_COLORS = [0x3b82f6, 0xef4444, 0x22c55e, 0xf59e0b];
export const PLAYER_COLOR_NAMES = ['Blue', 'Red', 'Green', 'Gold'];

export const QUICK_CHAT = [
  'Attack!', 'Help me!', 'Defend the castle!', 'Nice one!', 'Good game!',
  'Need wood', 'Need gold', 'On my way!', 'Wow!', 'Oops!',
];
export const EMOTES = ['😀', '😂', '😮', '😎', '👍', '🔥', '🏰', '⚔️'];
