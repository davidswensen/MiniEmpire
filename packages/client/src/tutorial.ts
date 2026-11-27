// Guided first match on "Tutorial Island" against a sleepy bot.

import { Order, UNITS, type Entity } from '@mini/shared';
import { sfx } from './audio.ts';
import type { GameSession } from './game.ts';
import type { Hud } from './ui/hud.ts';

interface Step {
  text: string;
  done: (g: GameSession) => boolean;
}

function mine(g: GameSession, kind?: string): Entity[] {
  return g.state.entities.filter((e) => e.owner === g.me && (!kind || e.kind === kind));
}

function enemyCastle(g: GameSession): Entity | undefined {
  const other = g.state.players.find((p) => p.slot !== g.me);
  return other ? g.state.byId.get(other.castleId) : undefined;
}

const STEPS: Step[] = [
  {
    text: 'Welcome to <b>MiniEmpire</b>! 🏰 This is your castle. Drag the map or use <b>WASD</b> to look around. Now <b>click one of your workers</b> 🧑‍🌾.',
    done: (g) => g.selected().some((e) => e.owner === g.me && e.kind === 'worker'),
  },
  {
    text: 'Great! Now <b>click a tree</b> 🌳 to chop wood. Workers carry the wood home all by themselves.',
    done: (g) => mine(g, 'worker').some((e) => (e.order === Order.GATHER || e.order === Order.RETURN) && e.lastResKind === 'tree'),
  },
  {
    text: 'Gold is important too! <b>Select another worker and click the gold rock</b> 🪙.',
    done: (g) => mine(g, 'worker').some((e) => (e.order === Order.GATHER || e.order === Order.RETURN) && e.lastResKind === 'goldmine'),
  },
  {
    text: 'More workers = more stuff! <b>Click your castle</b> and press <b>Worker</b> to train one.',
    done: (g) => mine(g, 'worker').length >= 5 || mine(g, 'castle').some((c) => c.queue.includes('worker')),
  },
  {
    text: 'Your army needs room. <b>Select a worker</b>, press <b>House</b> 🏠 and click on the grass to build it.',
    done: (g) => mine(g, 'house').length > 0,
  },
  {
    text: 'Now build a <b>Barracks</b> ⚔️ the same way. That is where soldiers are trained.',
    done: (g) => mine(g, 'barracks').length > 0,
  },
  {
    text: 'Building takes time. Tip: select <b>more workers</b> and click the barracks to help build it faster!',
    done: (g) => mine(g, 'barracks').some((b) => b.done),
  },
  {
    text: 'Click the barracks and train <b>3 Swordsmen</b> 🗡️. (If you run out of gold, send more workers to the gold rock!)',
    done: (g) => mine(g, 'swordsman').length >= 3,
  },
  {
    text: 'Archers shoot from far away. Train <b>2 Archers</b> 🏹 too.',
    done: (g) => mine(g, 'archer').length >= 2,
  },
  {
    text: 'Time to attack! Press the ⚔️ button (top right) to <b>select your army</b>, then <b>click the enemy castle</b> far away.',
    done: (g) => {
      const c = enemyCastle(g);
      return !!c && c.hp < c.maxHp;
    },
  },
  {
    text: 'Keep going! Train more soldiers and <b>knock down the castle</b> to win! 🎉',
    done: (g) => g.state.over,
  },
];

export class Tutorial {
  step = 0;
  private lastShown = -1;

  update(g: GameSession, hud: Hud): void {
    if (this.step >= STEPS.length) {
      hud.setTutorial(null);
      return;
    }
    if (STEPS[this.step].done(g)) {
      this.step++;
      sfx('built');
    }
    if (this.step !== this.lastShown) {
      this.lastShown = this.step;
      const s = STEPS[Math.min(this.step, STEPS.length - 1)];
      hud.setTutorial(this.step >= STEPS.length ? null : `<div class="step">Step ${this.step + 1} of ${STEPS.length}</div>${s.text}`);
    }
  }
}

export function armyCount(g: GameSession): number {
  return mine(g).filter((e) => UNITS[e.kind] && e.kind !== 'worker').length;
}
