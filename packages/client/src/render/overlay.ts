// 2D overlay drawn over the 3D view: health bars, build progress, names,
// emote bubbles and the drag-selection box.

import { BUILDINGS, RESOURCES, UNITS } from '@mini/shared';
import type { GameSession } from '../game.ts';
import type { Renderer } from './scene.ts';

export class Overlay {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private dpr = 1;
  box: { x0: number; y0: number; x1: number; y1: number } | null = null;
  private bubbles = new Map<number, { text: string; until: number }>();

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
    this.resize();
  }

  resize(): void {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.floor(window.innerWidth * this.dpr);
    this.canvas.height = Math.floor(window.innerHeight * this.dpr);
  }

  bubble(slot: number, text: string): void {
    this.bubbles.set(slot, { text, until: performance.now() + 3500 });
  }

  draw(g: GameSession, r: Renderer): void {
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    const s = g.state;
    const now = performance.now();
    for (const a of r.anchors) {
      const e = a.e;
      const ud = UNITS[e.kind];
      const bd = BUILDINGS[e.kind];
      const rd = RESOURCES[e.kind];
      const sel = g.selection.has(e.id) || g.hover === e.id;
      const scale = a.scale;
      const y = a.topY - 6 * scale;
      const width = (ud ? 34 : 18 * e.size + 18) * scale;
      if (ud || bd) {
        const damaged = e.hp < e.maxHp;
        if (sel || damaged || (bd && !e.done)) {
          const frac = Math.max(0, e.hp / e.maxHp);
          this.bar(a.sx - width / 2, y, width, Math.max(4, 5 * scale), frac, frac > 0.5 ? '#22c55e' : frac > 0.25 ? '#facc15' : '#ef4444');
        }
        if (bd && !e.done) {
          this.bar(a.sx - width / 2, y + 7 * scale, width, Math.max(3, 4 * scale), e.progress / bd.buildTime, '#60a5fa');
        }
        if (ud?.cargo && e.cargo.length > 0) {
          this.label(`⚓ ${e.cargo.length}/${ud.cargo}`, a.sx, y - 10 * scale, '#ffffff', 12 * Math.max(0.8, scale));
        }
      } else if (rd && sel) {
        this.bar(a.sx - width / 2, y, width, 5, e.amount / rd.amount, rd.res === 'wood' ? '#a16207' : '#facc15');
        this.label(`${e.amount}`, a.sx, y - 8, '#ffffff', 13);
      }
      if (e.kind === 'castle' && e.owner >= 0) {
        const p = s.players[e.owner];
        const color = '#' + p.color.toString(16).padStart(6, '0');
        this.label(p.name, a.sx, y - 16 * scale, color, 15 * Math.max(0.8, Math.min(1.3, scale)), true);
        const b = this.bubbles.get(e.owner);
        if (b && b.until > now) this.speech(b.text, a.sx, y - 44 * scale);
      }
    }
    if (this.box) {
      const { x0, y0, x1, y1 } = this.box;
      ctx.strokeStyle = '#4ade80';
      ctx.lineWidth = 2;
      ctx.fillStyle = 'rgba(74, 222, 128, 0.12)';
      ctx.fillRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
      ctx.strokeRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
    }
  }

  private bar(x: number, y: number, w: number, h: number, frac: number, color: string): void {
    const ctx = this.ctx;
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(x - 1, y - 1, w + 2, h + 2);
    ctx.fillStyle = color;
    ctx.fillRect(x, y, w * Math.max(0, Math.min(1, frac)), h);
  }

  private label(text: string, x: number, y: number, color: string, size: number, bold = false): void {
    const ctx = this.ctx;
    ctx.font = `${bold ? 800 : 600} ${size}px Fredoka, Nunito, 'Trebuchet MS', sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0,0,0,0.7)';
    ctx.strokeText(text, x, y);
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
  }

  private speech(text: string, x: number, y: number): void {
    const ctx = this.ctx;
    ctx.font = `700 18px Fredoka, Nunito, 'Trebuchet MS', sans-serif`;
    const w = ctx.measureText(text).width + 20;
    const h = 32;
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#1f2937';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(x - w / 2, y - h, w, h, 12);
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x - 6, y);
    ctx.lineTo(x, y + 8);
    ctx.lineTo(x + 6, y);
    ctx.fill();
    ctx.fillStyle = '#111827';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x, y - h / 2);
  }
}
