import { describe, expect, it } from 'vitest';
import {
  applyCommand, areEnemies, createGame, newEntity, statMaxHp, step, tileCenter,
  type Command, type Entity, type GameMode, type GameState,
} from '../src/index.ts';

function game(mode: GameMode, bots: number[] = []): GameState {
  const teams = { '1v1': [0, 1], '2v2': [0, 0, 1, 1], ffa3: [0, 1, 2], ffa4: [0, 1, 2, 3] }[mode];
  return createGame({ seed: 5, mode, players: teams.map((team, i) => ({ name: `P${i}`, team, isBot: bots.includes(i), botLevel: 2, hat: 0 })) });
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

describe('alliances', () => {
  it('an offer needs the other player to accept; then they stop being enemies', () => {
    const s = game('ffa3');
    expect(s.diplomacy).toBe(true);
    cmd(s, 0, { t: 'ally', target: 1 });
    expect(areEnemies(s, 0, 1)).toBe(true); // just an offer so far
    expect(s.players[0].offers).toBe(1 << 1);
    cmd(s, 1, { t: 'ally', target: 0 }); // accept
    expect(areEnemies(s, 0, 1)).toBe(false);
    expect(areEnemies(s, 1, 0)).toBe(false);
    expect(areEnemies(s, 0, 2)).toBe(true);
    expect(s.players[0].offers).toBe(0);
  });

  it('either side can break the alliance at any time', () => {
    const s = game('ffa4');
    cmd(s, 2, { t: 'ally', target: 3 });
    cmd(s, 3, { t: 'ally', target: 2 });
    expect(areEnemies(s, 2, 3)).toBe(false);
    cmd(s, 3, { t: 'unally', target: 2 });
    expect(areEnemies(s, 2, 3)).toBe(true);
    expect(areEnemies(s, 3, 2)).toBe(true);
    // offers can be withdrawn too
    cmd(s, 0, { t: 'ally', target: 1 });
    cmd(s, 0, { t: 'unally', target: 1 });
    expect(s.players[0].offers).toBe(0);
  });

  it('allied soldiers stop fighting each other, and fight again after a break', () => {
    const s = game('ffa3');
    const a = spawn(s, 'swordsman', 0, 30, 4);
    const b = spawn(s, 'swordsman', 1, 31, 4);
    cmd(s, 0, { t: 'ally', target: 1 });
    cmd(s, 1, { t: 'ally', target: 0 });
    run(s, 100);
    expect(a.hp).toBe(a.maxHp);
    expect(b.hp).toBe(b.maxHp);
    cmd(s, 1, { t: 'unally', target: 0 });
    run(s, 100);
    expect(a.hp < a.maxHp || b.hp < b.maxHp).toBe(true);
  });

  it('allies who outlast everyone else win together', () => {
    const s = game('ffa3');
    cmd(s, 0, { t: 'ally', target: 2 });
    cmd(s, 2, { t: 'ally', target: 0 });
    cmd(s, 1, { t: 'resign' });
    step(s);
    expect(s.over).toBe(true);
    expect(s.winners).toBe((1 << 0) | (1 << 2));
    expect(s.winnerTeam).toBe(-1);
  });

  it('is not available in 1v1 or 2v2 (that would just end the game)', () => {
    for (const mode of ['1v1', '2v2'] as const) {
      const s = game(mode);
      expect(s.diplomacy).toBe(false);
      cmd(s, 0, { t: 'ally', target: mode === '1v1' ? 1 : 2 });
      expect(s.players[0].offers).toBe(0);
    }
  });

  it('team victory still works and lists every teammate as a winner', () => {
    const s = game('2v2');
    cmd(s, 2, { t: 'resign' });
    cmd(s, 3, { t: 'resign' });
    cmd(s, 1, { t: 'resign' }); // a fallen teammate still shares the win
    step(s);
    expect(s.winnerTeam).toBe(0);
    expect(s.winners).toBe(0b0011);
  });

  it('bots accept offers, but not one that would end the game', () => {
    const s = game('ffa3', [1, 2]);
    cmd(s, 0, { t: 'ally', target: 1 });
    run(s, 60);
    expect(areEnemies(s, 0, 1)).toBe(false);
    // bots 1 and 2 are still enemies of each other, so 2 accepts too
    cmd(s, 0, { t: 'ally', target: 2 });
    run(s, 60);
    expect(areEnemies(s, 0, 2)).toBe(false);

    // with only two players left, accepting would end the game: the bot refuses
    const s2 = game('ffa3', [1, 2]);
    cmd(s2, 1, { t: 'resign' });
    cmd(s2, 0, { t: 'ally', target: 2 });
    run(s2, 60);
    expect(areEnemies(s2, 0, 2)).toBe(true);
    expect(s2.over).toBe(false);
  });
});
