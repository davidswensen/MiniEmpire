// Effective stats after research. Pure integer math on (player tech levels, kind).

import { BUILDINGS, TECHS, UNITS, type TechStat } from './defs.ts';
import { idiv } from './fixed.ts';
import type { GameState } from './types.ts';

/** Sum of a stat's bonus for one player and kind, over all researched techs. */
export function techBonus(s: GameState, owner: number, kind: string, stat: TechStat): number {
  if (owner < 0 || owner >= s.players.length) return 0;
  const lv = s.players[owner].tech;
  let total = 0;
  for (let i = 0; i < TECHS.length; i++) {
    const n = lv[i] ?? 0;
    if (n === 0) continue;
    for (const fx of TECHS[i].effects) if (fx.stat === stat && fx.who(kind)) total += fx.amount * n;
  }
  return total;
}

export function statAtk(s: GameState, owner: number, kind: string): number {
  const base = UNITS[kind]?.atk ?? BUILDINGS[kind]?.atk ?? 0;
  if (base <= 0) return 0;
  const flat = base + techBonus(s, owner, kind, 'atk');
  return idiv(flat * (100 + techBonus(s, owner, kind, 'atkPct')), 100);
}

export function statRange(s: GameState, owner: number, kind: string): number {
  const base = UNITS[kind]?.range ?? BUILDINGS[kind]?.range ?? 0;
  return base + techBonus(s, owner, kind, 'range');
}

export function statArmor(s: GameState, owner: number, kind: string): number {
  return (UNITS[kind]?.armorPts ?? 0) + techBonus(s, owner, kind, 'armor');
}

export function statMaxHp(s: GameState, owner: number, kind: string): number {
  const base = UNITS[kind]?.hp ?? BUILDINGS[kind]?.hp ?? 1;
  const flat = base + techBonus(s, owner, kind, 'hp');
  return idiv(flat * (100 + techBonus(s, owner, kind, 'hpPct')), 100);
}

export function statCarry(s: GameState, owner: number, kind: string): number {
  return (UNITS[kind]?.carry ?? 0) + techBonus(s, owner, kind, 'carry');
}

export function statGatherTicks(s: GameState, owner: number, kind: string): number {
  const t = (UNITS[kind]?.gatherTicks ?? 0) - techBonus(s, owner, kind, 'gather');
  return t < 3 ? 3 : t;
}

export function techLevel(s: GameState, owner: number, techIndex: number): number {
  return s.players[owner]?.tech[techIndex] ?? 0;
}
