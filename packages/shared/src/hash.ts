import type { GameState } from './types.ts';

// FNV-1a over every gameplay-relevant integer, in a fixed order.
// Two clients with equal hashes are (with overwhelming probability) in sync.

const FNV_PRIME = 0x01000193;

class Hasher {
  h = 0x811c9dc5 | 0;
  int(v: number): void {
    // The simulation keeps every value within int32.
    this.h = Math.imul(this.h ^ (v | 0), FNV_PRIME);
  }
  str(s: string): void {
    for (let i = 0; i < s.length; i++) this.h = Math.imul(this.h ^ s.charCodeAt(i), FNV_PRIME);
    this.int(s.length);
  }
  bool(b: boolean): void {
    this.int(b ? 1 : 0);
  }
}

export function hashState(s: GameState): number {
  const h = new Hasher();
  h.int(s.tick);
  h.int(s.rng.s);
  h.int(s.nextId);
  h.bool(s.over);
  h.int(s.winnerTeam);
  h.int(s.winners);
  h.bool(s.diplomacy);
  for (const p of s.players) {
    h.int(p.slot);
    h.int(p.wood);
    h.int(p.gold);
    h.int(p.pop);
    h.int(p.popCap);
    h.int(p.level);
    h.bool(p.alive);
    h.int(p.castleId);
    h.int(p.tech.length);
    for (const t of p.tech) h.int(t);
    h.int(p.allies);
    h.int(p.offers);
    if (p.bot) {
      h.int(p.bot.nextThink);
      h.int(p.bot.waveSize);
      h.int(p.bot.waves);
    }
  }
  h.int(s.entities.length);
  for (const e of s.entities) {
    h.int(e.id);
    h.str(e.kind);
    h.int(e.owner);
    h.int(e.x);
    h.int(e.y);
    h.int(e.hp);
    h.int(e.order);
    h.int(e.targetId);
    h.int(e.tx);
    h.int(e.ty);
    h.int(e.amX);
    h.int(e.amY);
    h.int(e.path.length);
    h.int(e.pathIdx);
    h.int(e.cooldown);
    h.int(e.carryRes);
    h.int(e.carryAmt);
    h.int(e.inside);
    h.int(e.cargo.length);
    for (const c of e.cargo) h.int(c);
    h.int(e.progress);
    h.bool(e.done);
    h.int(e.queue.length);
    for (const q of e.queue) h.str(q);
    h.int(e.queueTime);
    h.int(e.amount);
  }
  return h.h >>> 0;
}
