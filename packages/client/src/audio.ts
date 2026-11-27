// Tiny synthesized sound effects (no audio files needed).

import { loadProfile } from './profile.ts';

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
const lastPlayed = new Map<string, number>();

function ac(): AudioContext | null {
  if (!loadProfile().sound) return null;
  if (!ctx) {
    try {
      ctx = new AudioContext();
      master = ctx.createGain();
      master.gain.value = 0.35;
      master.connect(ctx.destination);
    } catch {
      return null;
    }
  }
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

export function unlockAudio(): void {
  ac();
}

function tone(freq: number, dur: number, type: OscillatorType, vol: number, slide = 0, delay = 0): void {
  const c = ac();
  if (!c || !master) return;
  const t = c.currentTime + delay;
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(master);
  o.start(t);
  o.stop(t + dur + 0.02);
}

function noise(dur: number, vol: number, freq: number, delay = 0): void {
  const c = ac();
  if (!c || !master) return;
  const t = c.currentTime + delay;
  const len = Math.floor(c.sampleRate * dur);
  const buf = c.createBuffer(1, len, c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const src = c.createBufferSource();
  src.buffer = buf;
  const f = c.createBiquadFilter();
  f.type = 'bandpass';
  f.frequency.value = freq;
  const g = c.createGain();
  g.gain.value = vol;
  src.connect(f).connect(g).connect(master);
  src.start(t);
}

export type Sfx =
  | 'click' | 'select' | 'command' | 'sword' | 'arrow' | 'boom' | 'build' | 'built'
  | 'train' | 'death' | 'levelup' | 'victory' | 'defeat' | 'error' | 'chat' | 'collapse';

const MIN_GAP: Partial<Record<Sfx, number>> = { sword: 70, arrow: 60, boom: 120, death: 90, build: 300 };

export function sfx(name: Sfx, volume = 1): void {
  const now = performance.now();
  const gap = MIN_GAP[name] ?? 30;
  if (now - (lastPlayed.get(name) ?? 0) < gap) return;
  lastPlayed.set(name, now);
  const v = Math.max(0, Math.min(1, volume));
  if (v < 0.05) return;
  switch (name) {
    case 'click': tone(660, 0.06, 'square', 0.15 * v); break;
    case 'select': tone(520, 0.07, 'triangle', 0.3 * v); tone(780, 0.07, 'triangle', 0.25 * v, 0, 0.05); break;
    case 'command': tone(440, 0.08, 'triangle', 0.3 * v, 200); break;
    case 'sword': noise(0.08, 0.5 * v, 3200); tone(1400, 0.05, 'square', 0.06 * v, -600); break;
    case 'arrow': noise(0.12, 0.25 * v, 6000); break;
    case 'boom': noise(0.35, 0.8 * v, 180); tone(90, 0.3, 'sine', 0.4 * v, -50); break;
    case 'build': tone(220, 0.07, 'square', 0.12 * v); noise(0.05, 0.3 * v, 900); break;
    case 'built': [523, 659, 784].forEach((f, i) => tone(f, 0.14, 'triangle', 0.25 * v, 0, i * 0.08)); break;
    case 'train': tone(392, 0.1, 'triangle', 0.25 * v); tone(587, 0.12, 'triangle', 0.25 * v, 0, 0.08); break;
    case 'death': tone(300, 0.25, 'sawtooth', 0.12 * v, -220); break;
    case 'collapse': noise(0.7, 0.9 * v, 120); tone(70, 0.6, 'sine', 0.4 * v, -30); break;
    case 'levelup': [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.2, 'triangle', 0.3 * v, 0, i * 0.1)); break;
    case 'victory': [523, 659, 784, 659, 784, 1047].forEach((f, i) => tone(f, 0.25, 'triangle', 0.35 * v, 0, i * 0.14)); break;
    case 'defeat': [392, 349, 311, 262].forEach((f, i) => tone(f, 0.35, 'triangle', 0.3 * v, 0, i * 0.2)); break;
    case 'error': tone(180, 0.15, 'square', 0.15 * v); break;
    case 'chat': tone(880, 0.08, 'sine', 0.25 * v); tone(1175, 0.1, 'sine', 0.2 * v, 0, 0.07); break;
  }
}
