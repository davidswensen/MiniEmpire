// Determinism lint for the simulation (packages/shared/src).
// Fails the build if simulation code uses anything that can differ between
// machines or browsers: floating point division, trig, randomness, clocks.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SIM_DIR = new URL('../packages/shared/src/', import.meta.url);
// protocol.ts holds network types and a regex; it never runs inside a tick.
const SKIP = new Set(['protocol.ts', 'index.ts']);
// fixed.ts is the one place allowed to divide and use Math.sqrt.
const MATH_ALLOWED_EVERYWHERE = new Set(['trunc', 'imul', 'abs', 'min', 'max', 'floor']);

const BANNED = [
  [/\bMath\.random\b/, 'Math.random (use the seeded rng)'],
  [/\bDate\b/, 'Date (time differs per machine)'],
  [/\bperformance\b/, 'performance.now (time differs per machine)'],
  [/\bsetTimeout\b|\bsetInterval\b/, 'timers'],
  [/\bparseFloat\b|\btoFixed\b/, 'floating point parsing/formatting'],
  [/\b\d+\.\d+\b/, 'float literal'],
  [/\bfor\s*\(\s*(const|let|var)\s+\w+\s+in\b/, 'for...in (use arrays in id order)'],
  [/\.sort\(\s*\)/, 'sort() without a comparator'],
  [/\bNumber\.EPSILON\b|\bInfinity\b/, 'floating point constants'],
];

function stripCommentsAndStrings(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === '/' && n === '/') {
      while (i < src.length && src[i] !== '\n') i++;
    } else if (c === '/' && n === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n') out += '\n';
        i++;
      }
      i += 2;
    } else if (c === "'" || c === '"' || c === '`') {
      const q = c;
      out += q + q;
      i++;
      while (i < src.length && src[i] !== q) {
        if (src[i] === '\\') i++;
        i++;
      }
      i++;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

let problems = 0;
for (const f of readdirSync(SIM_DIR)) {
  if (!f.endsWith('.ts') || SKIP.has(f)) continue;
  const src = readFileSync(new URL(f, SIM_DIR), 'utf8');
  const code = stripCommentsAndStrings(src);
  const lines = code.split('\n');
  lines.forEach((line, i) => {
    const where = `${join('packages/shared/src', f)}:${i + 1}`;
    for (const [re, why] of BANNED) {
      if (re.test(line)) {
        console.error(`${where}  banned: ${why}\n    ${src.split('\n')[i].trim()}`);
        problems++;
      }
    }
    for (const m of line.matchAll(/\bMath\.(\w+)/g)) {
      const fn = m[1];
      if (MATH_ALLOWED_EVERYWHERE.has(fn)) continue;
      if (f === 'fixed.ts' && fn === 'sqrt') continue;
      console.error(`${where}  banned: Math.${fn} (not deterministic across engines; use fixed.ts)\n    ${src.split('\n')[i].trim()}`);
      problems++;
    }
    if (f !== 'fixed.ts' && /[^/*]\/[^/*=]/.test(line.replace(/\/\/.*$/, ''))) {
      console.error(`${where}  banned: '/' division (use idiv from fixed.ts)\n    ${src.split('\n')[i].trim()}`);
      problems++;
    }
  });
}

if (problems > 0) {
  console.error(`\nDeterminism check failed: ${problems} problem(s).`);
  process.exit(1);
}
console.log('Determinism check passed.');
