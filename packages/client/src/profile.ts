// Local player profile. No accounts and no personal info: a generated nickname,
// XP and cosmetic choices, stored only in this browser.

export interface Profile {
  name: string;
  hat: number;
  xp: number;
  wins: number;
  games: number;
  tutorialDone: boolean;
  sound: boolean;
  quality: 'high' | 'low';
}

const KEY = 'miniempire.profile.v1';

const ADJ = ['Brave', 'Swift', 'Mighty', 'Clever', 'Jolly', 'Bold', 'Lucky', 'Sneaky', 'Royal', 'Fuzzy', 'Golden', 'Noble', 'Happy', 'Tiny', 'Giant', 'Silly'];
const ANIMAL = ['Badger', 'Falcon', 'Otter', 'Dragon', 'Fox', 'Bear', 'Wolf', 'Owl', 'Panda', 'Lion', 'Hedgehog', 'Goose', 'Turtle', 'Pony', 'Moose', 'Llama'];

export function randomName(): string {
  const a = ADJ[Math.floor(Math.random() * ADJ.length)];
  const b = ANIMAL[Math.floor(Math.random() * ANIMAL.length)];
  return `${a} ${b}`;
}

export const HATS = [
  { name: 'No hat', icon: '🙂', level: 1 },
  { name: 'Straw hat', icon: '👒', level: 1 },
  { name: 'Iron helm', icon: '⛑️', level: 2 },
  { name: 'Viking horns', icon: '🐂', level: 3 },
  { name: 'Wizard hat', icon: '🧙', level: 4 },
  { name: 'Party hat', icon: '🥳', level: 5 },
  { name: 'Golden crown', icon: '👑', level: 7 },
];

export function levelFor(xp: number): number {
  return Math.floor(xp / 100) + 1;
}

function defaults(): Profile {
  const touch = typeof window !== 'undefined' && 'ontouchstart' in window;
  return { name: randomName(), hat: 1, xp: 0, wins: 0, games: 0, tutorialDone: false, sound: true, quality: touch ? 'low' : 'high' };
}

let cached: Profile | null = null;

export function loadProfile(): Profile {
  if (cached) return cached;
  let p = defaults();
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) p = { ...p, ...JSON.parse(raw) };
  } catch {
    /* storage unavailable: play with defaults */
  }
  cached = p;
  return p;
}

export function saveProfile(p: Profile): void {
  cached = p;
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* ignore */
  }
}

/** Award XP; returns the new level if the player levelled up. */
export function addXp(amount: number): { before: number; after: number } {
  const p = loadProfile();
  const before = levelFor(p.xp);
  p.xp += amount;
  saveProfile(p);
  return { before, after: levelFor(p.xp) };
}
