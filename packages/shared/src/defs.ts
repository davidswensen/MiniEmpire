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

export type ArmorClass = 'worker' | 'infantry' | 'archer' | 'cavalry' | 'siege' | 'ship' | 'air' | 'building';

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
  air: boolean; // flies over water, walls and trees; only ranged attacks and flyers can hit it
  noAir: boolean; // cannot shoot at flyers (catapults, cannons)
  armorPts: number; // flat damage reduction per hit
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
  bonus: Partial<Record<ArmorClass, number>>;
  splash: number;
  antiAir: boolean; // can shoot flyers
  tower: boolean; // affected by tower upgrades
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
    air: false,
    noAir: false,
    armorPts: 0,
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
    bonus: {},
    splash: 0,
    antiAir: true,
    tower: false,
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
    hp: 90, speed: 46, armor: 'siege', atk: 30, range: 7 * 1024, minRange: 2 * 1024, cooldown: 70, noAir: true,
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

  // ---- more vehicles (workshop)
  ballista: unit({
    kind: 'ballista', name: 'Ballista', icon: '🎯', desc: 'Giant crossbow on wheels. Shoots down dragons!',
    hp: 90, speed: 56, armor: 'siege', atk: 16, range: 7 * 1024, cooldown: 45, sight: 9,
    bonus: { air: 250, cavalry: 150 }, cost: { wood: 120, gold: 60 }, trainTime: 380, level: 2, pop: 2, radius: 400,
  }),
  warwagon: unit({
    kind: 'warwagon', name: 'War Wagon', icon: '🛡️', desc: 'Armored cart full of archers. Very tough.',
    hp: 260, speed: 72, armor: 'cavalry', atk: 9, range: 4 * 1024, cooldown: 25, armorPts: 3,
    bonus: { infantry: 125 }, cost: { wood: 140, gold: 80 }, trainTime: 420, level: 2, pop: 3, radius: 450,
  }),
  trebuchet: unit({
    kind: 'trebuchet', name: 'Trebuchet', icon: '🏗️', desc: 'Huge rock thrower. Hits castles from very far.',
    hp: 120, speed: 36, armor: 'siege', atk: 70, range: 11 * 1024, minRange: 4 * 1024, cooldown: 110, sight: 11,
    splash: 1024, noAir: true, bonus: { building: 300 }, cost: { wood: 220, gold: 160 }, trainTime: 600,
    level: 3, pop: 3, radius: 480,
  }),
  bombard: unit({
    kind: 'bombard', name: 'Bombard Cannon', icon: '💣', desc: 'Big cannon. Boom! Great vs soldiers and walls.',
    hp: 100, speed: 46, armor: 'siege', atk: 36, range: 8 * 1024, minRange: 2 * 1024, cooldown: 80, sight: 9,
    splash: 1400, noAir: true, bonus: { building: 200, infantry: 150 }, cost: { wood: 160, gold: 160 }, trainTime: 520,
    level: 3, pop: 2, radius: 420,
  }),

  // ---- more ships (dock)
  longship: unit({
    kind: 'longship', name: 'Longship', icon: '🛶', desc: 'Fast, cheap boat with archers.',
    hp: 80, speed: 140, armor: 'ship', naval: true, atk: 6, range: 4 * 1024, cooldown: 25, sight: 8,
    cost: { wood: 70, gold: 20 }, trainTime: 260, radius: 450,
  }),
  fireship: unit({
    kind: 'fireship', name: 'Fire Ship', icon: '🔥', desc: 'Sprays fire at close range. Burns other ships.',
    hp: 110, speed: 125, armor: 'ship', naval: true, atk: 12, range: 1500, cooldown: 15, splash: 900, noAir: true,
    bonus: { ship: 200 }, cost: { wood: 90, gold: 50 }, trainTime: 320, level: 2, radius: 500,
  }),
  galleon: unit({
    kind: 'galleon', name: 'Cannon Galleon', icon: '🏴‍☠️', desc: 'Big ship with cannons. Smashes buildings on the shore.',
    hp: 260, speed: 90, armor: 'ship', naval: true, atk: 30, range: 8 * 1024, minRange: 2 * 1024, cooldown: 70,
    splash: 1024, noAir: true, armorPts: 2, bonus: { building: 200 }, sight: 9,
    cost: { wood: 200, gold: 150 }, trainTime: 560, level: 3, pop: 3, radius: 560,
  }),

  // ---- flyers (dragon roost)
  griffin: unit({
    kind: 'griffin', name: 'Griffin Rider', icon: '🦅', desc: 'Flies fast over everything. Great vs archers.',
    hp: 120, speed: 150, armor: 'air', air: true, atk: 12, range: 1100, cooldown: 20, sight: 9,
    bonus: { archer: 150 }, cost: { wood: 60, gold: 90 }, trainTime: 360, level: 2, pop: 2, radius: 420,
  }),
  wyvern: unit({
    kind: 'wyvern', name: 'Wyvern', icon: '🦎', desc: 'Small dragon that breathes fire.',
    hp: 170, speed: 110, armor: 'air', air: true, atk: 13, range: 2 * 1024, cooldown: 30, splash: 700, sight: 9,
    bonus: { infantry: 125 }, cost: { wood: 90, gold: 120 }, trainTime: 420, level: 2, pop: 3, radius: 480,
  }),
  dragon: unit({
    kind: 'dragon', name: 'Dragon', icon: '🐉', desc: 'Huge fire-breathing dragon! Watch out for ballistas.',
    hp: 420, speed: 90, armor: 'air', air: true, atk: 28, range: 2560, cooldown: 40, splash: 1100, sight: 10,
    armorPts: 2, bonus: { building: 150, infantry: 125 }, cost: { wood: 250, gold: 250 }, trainTime: 700,
    level: 3, pop: 5, radius: 650,
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
    kind: 'workshop', name: 'Workshop', icon: '🔨', desc: 'Builds rams, ballistas, war wagons, catapults, trebuchets and cannons.',
    size: 3, hp: 1200, cost: { wood: 150, gold: 100 }, buildTime: 600,
    trains: ['ram', 'ballista', 'warwagon', 'catapult', 'trebuchet', 'bombard'], level: 2,
  }),
  dock: building({
    kind: 'dock', name: 'Dock', icon: '⚓', desc: 'Builds boats. Must touch water.',
    size: 3, hp: 1000, cost: { wood: 120, gold: 0 }, buildTime: 450, trains: ['transport', 'longship', 'warship', 'fireship', 'galleon'],
    needsWater: true,
  }),
  blacksmith: building({
    kind: 'blacksmith', name: 'Blacksmith', icon: '⚒️', desc: 'Upgrade weapons and armor for your soldiers.',
    size: 2, hp: 800, cost: { wood: 100, gold: 0 }, buildTime: 360,
  }),
  roost: building({
    kind: 'roost', name: 'Dragon Roost', icon: '🪺', desc: 'Raises griffins, wyverns and dragons!',
    size: 3, hp: 1300, cost: { wood: 200, gold: 150 }, buildTime: 650, trains: ['griffin', 'wyvern', 'dragon'], level: 2,
  }),
  tower: building({
    kind: 'tower', name: 'Arrow Tower', icon: '🗼', desc: 'Shoots arrows at enemies, even flyers.',
    size: 1, hp: 600, cost: { wood: 60, gold: 60 }, buildTime: 360, atk: 8, range: 6 * 1024,
    cooldown: 25, sight: 8, level: 2, tower: true,
  }),
  skytower: building({
    kind: 'skytower', name: 'Sky Ballista Tower', icon: '🎯', desc: 'Huge bolts that shoot down dragons and griffins.',
    size: 1, hp: 700, cost: { wood: 100, gold: 80 }, buildTime: 420, atk: 18, range: 8 * 1024,
    cooldown: 45, sight: 9, level: 2, tower: true, bonus: { air: 250 },
  }),
  flametower: building({
    kind: 'flametower', name: 'Flame Tower', icon: '🔥', desc: 'Burns everything close by.',
    size: 1, hp: 650, cost: { wood: 80, gold: 70 }, buildTime: 400, atk: 11, range: 3584,
    cooldown: 12, sight: 6, level: 2, tower: true, splash: 700,
  }),
  cannontower: building({
    kind: 'cannontower', name: 'Cannon Tower', icon: '💥', desc: 'Big splash damage. Cannot hit flyers.',
    size: 1, hp: 900, cost: { wood: 150, gold: 150 }, buildTime: 520, atk: 34, range: 7 * 1024,
    cooldown: 70, sight: 8, level: 3, tower: true, splash: 1024, antiAir: false,
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

export const BUILD_MENU = [
  'house', 'storehouse', 'barracks', 'blacksmith', 'dock', 'stable', 'workshop', 'roost',
  'tower', 'skytower', 'flametower', 'cannontower', 'wall', 'gate',
];

// ---------------------------------------------------------------- research

export type TechStat = 'atk' | 'atkPct' | 'armor' | 'hp' | 'hpPct' | 'range' | 'carry' | 'gather';

export interface TechDef {
  id: string;
  name: string;
  icon: string;
  desc: string;
  at: string; // building that researches it
  levels: number;
  cost: Cost; // per level: cost * level number
  time: number;
  castleLevel: number;
  effects: Array<{ stat: TechStat; amount: number; who: (kind: string) => boolean }>;
}

const isSoldier = (k: string): boolean => !!UNITS[k] && !UNITS[k].naval && !UNITS[k].air && UNITS[k].armor !== 'siege' && k !== 'worker';
const isMelee = (k: string): boolean => isSoldier(k) && UNITS[k].range <= 1024;
const isRanged = (k: string): boolean => isSoldier(k) && UNITS[k].range > 1024;
const isSiege = (k: string): boolean => !!UNITS[k] && UNITS[k].armor === 'siege';
const isShip = (k: string): boolean => !!UNITS[k] && UNITS[k].naval;
const isFlyer = (k: string): boolean => !!UNITS[k] && UNITS[k].air;
const isTower = (k: string): boolean => !!BUILDINGS[k] && BUILDINGS[k].tower;
const isDefense = (k: string): boolean => isTower(k) || k === 'castle';

/** Order matters: a player's tech levels are stored by index. Add new techs at the end. */
export const TECHS: TechDef[] = [
  { id: 'tools', name: 'Better Tools', icon: '⛏️', desc: 'Workers gather faster.', at: 'castle', levels: 2,
    cost: { wood: 75, gold: 50 }, time: 400, castleLevel: 1, effects: [{ stat: 'gather', amount: 2, who: (k) => k === 'worker' }] },
  { id: 'baskets', name: 'Bigger Baskets', icon: '🧺', desc: 'Workers carry 5 more each trip.', at: 'castle', levels: 1,
    cost: { wood: 80, gold: 40 }, time: 360, castleLevel: 1, effects: [{ stat: 'carry', amount: 5, who: (k) => k === 'worker' }] },
  { id: 'tough', name: 'Tough Workers', icon: '💪', desc: 'Workers get more health and hit harder.', at: 'castle', levels: 1,
    cost: { wood: 60, gold: 60 }, time: 360, castleLevel: 1,
    effects: [{ stat: 'hp', amount: 30, who: (k) => k === 'worker' }, { stat: 'atk', amount: 3, who: (k) => k === 'worker' }] },
  { id: 'weapons', name: 'Sharp Weapons', icon: '🗡️', desc: 'Swordsmen and knights hit harder.', at: 'blacksmith', levels: 3,
    cost: { wood: 60, gold: 80 }, time: 500, castleLevel: 1, effects: [{ stat: 'atk', amount: 2, who: isMelee }] },
  { id: 'archery', name: 'Strong Bows', icon: '🏹', desc: 'Archers and war wagons hit harder and shoot farther.', at: 'blacksmith', levels: 3,
    cost: { wood: 80, gold: 60 }, time: 500, castleLevel: 1,
    effects: [{ stat: 'atk', amount: 1, who: isRanged }, { stat: 'range', amount: 512, who: isRanged }] },
  { id: 'armor', name: 'Armor', icon: '🛡️', desc: 'Soldiers take less damage from every hit.', at: 'blacksmith', levels: 3,
    cost: { wood: 50, gold: 90 }, time: 550, castleLevel: 1, effects: [{ stat: 'armor', amount: 1, who: isSoldier }] },
  { id: 'barding', name: 'Horse Armor', icon: '🐎', desc: 'Knights and war wagons get more health.', at: 'blacksmith', levels: 2,
    cost: { wood: 60, gold: 100 }, time: 500, castleLevel: 2, effects: [{ stat: 'hpPct', amount: 20, who: (k) => UNITS[k]?.armor === 'cavalry' }] },
  { id: 'siegecraft', name: 'Siege Craft', icon: '⚙️', desc: 'Vehicles hit harder and are sturdier.', at: 'workshop', levels: 2,
    cost: { wood: 120, gold: 100 }, time: 600, castleLevel: 2,
    effects: [{ stat: 'atkPct', amount: 15, who: isSiege }, { stat: 'hpPct', amount: 15, who: isSiege }] },
  { id: 'shipwright', name: 'Shipwright', icon: '🪝', desc: 'Ships are tougher and hit harder.', at: 'dock', levels: 2,
    cost: { wood: 120, gold: 60 }, time: 550, castleLevel: 1,
    effects: [{ stat: 'hpPct', amount: 20, who: isShip }, { stat: 'atk', amount: 2, who: isShip }] },
  { id: 'dragonfire', name: 'Dragon Fire', icon: '🔥', desc: 'Flyers hit harder.', at: 'roost', levels: 2,
    cost: { wood: 100, gold: 150 }, time: 600, castleLevel: 2, effects: [{ stat: 'atkPct', amount: 20, who: isFlyer }] },
  { id: 'scales', name: 'Thick Scales', icon: '🐲', desc: 'Flyers take less damage.', at: 'roost', levels: 2,
    cost: { wood: 100, gold: 150 }, time: 600, castleLevel: 2, effects: [{ stat: 'armor', amount: 2, who: isFlyer }] },
  { id: 'masonry', name: 'Masonry', icon: '🧱', desc: 'All buildings get 25% more health.', at: 'castle', levels: 1,
    cost: { wood: 150, gold: 100 }, time: 600, castleLevel: 2, effects: [{ stat: 'hpPct', amount: 25, who: (k) => !!BUILDINGS[k] }] },
  { id: 'towerguards', name: 'Tower Guards', icon: '🏯', desc: 'Towers and the castle hit harder and shoot farther.', at: 'castle', levels: 2,
    cost: { wood: 100, gold: 100 }, time: 550, castleLevel: 2,
    effects: [{ stat: 'atk', amount: 2, who: isDefense }, { stat: 'range', amount: 512, who: isDefense }] },
];

export const TECH_INDEX: Record<string, number> = Object.fromEntries(TECHS.map((t, i) => [t.id, i]));
export const TECH_PREFIX = '@tech:';

/** Techs a building can research. */
export function researchesAt(kind: string): TechDef[] {
  return TECHS.filter((t) => t.at === kind);
}

export function techCost(t: TechDef, nextLevel: number): Cost {
  return { wood: t.cost.wood * nextLevel, gold: t.cost.gold * nextLevel };
}

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
