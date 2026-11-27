# MiniEmpire: implementation plan and status

A simple browser real-time strategy game for ages 10–15: blocky 3D, medieval (knights and
castles), land and sea, workers, soldiers, siege engines and ships, played head to head online.

## Decisions

| Area | Choice |
|---|---|
| Look | Blocky low-poly 3D (Three.js, instanced box models), tilted camera |
| Networking | **Deterministic lockstep, timed by the relay server** (commands only, 100 ms turns, 20 ticks/s) |
| Resources | 2: wood and gold |
| Progression | Castle levels 1 → 2 → 3 unlock units and buildings |
| Goal | Destroy the enemy castle |
| Match length | about 10–15 min on 64×64 (2 players) or 80×80 (4 players) maps |
| Modes | 1v1, 2v2, 3- or 4-player free-for-all; bots fill slots (Easy, Normal, Hard) |
| Joining | 4-letter room codes, public quick play |
| Safety | No accounts, generated nicknames, quick-chat and emotes only, no purchases |

## Content

- **Units:** worker, swordsman, archer, knight, battering ram, catapult, transport boat, warship
- **Counters:** knight > archer > swordsman > knight; rams and catapults are strong against buildings
- **Buildings:** castle (shoots arrows), house, storehouse, barracks, stable, workshop, dock, tower, wall, gate

## Phases

| Phase | Scope | Status |
|---|---|---|
| 0. Setup | Monorepo, Vite + Three.js, WebSocket relay, fixed-point math, seeded RNG, determinism lint, hash and replay test harness | ✅ |
| 1. World and movement | Symmetric map generation, deterministic A*, selection, camera, local relay for single-player | ✅ |
| 2. Economy | Workers, wood and gold, drop-off, buildings that snap to the grid, training queues, population | ✅ |
| 3. Combat | Units, counters, auto-attack, attack-move, castle and towers, elimination and victory, bot AI | ✅ |
| 4. Multiplayer | Room codes, server-timed turns, hash-based desync detection with saved logs, reconnect by fast-forward, quick-chat | ✅ |
| 5. Boats and siege | Dock, transport boarding and unloading, warships, rams, catapults with splash damage, walls and gates | ✅ |
| 6. Fun layer | Tutorial, XP and hat cosmetics, synthesized sound, particles, replays (save, load, watch at 1–8x) | ✅ |
| 7. Playtest and launch | Touch controls verified (phone emulation); automated balance playtest (`scripts/balance.ts`) with bot difficulty curve fixed; production run with plain Node (`npm run build && npm start`) verified with a live 2v2 | ✅ automated parts done. Real-kid playtesting and going live are deferred by choice (owner decision, 2026-11-26) |

## Expansion: upgrades, vehicles, ships, flyers, towers, alliances

| Area | Added |
|---|---|
| Research | 13 techs: Better Tools, Bigger Baskets, Tough Workers, Masonry, Tower Guards (castle); Sharp Weapons, Strong Bows, Armor, Horse Armor (blacksmith); Siege Craft (workshop); Shipwright (dock); Dragon Fire, Thick Scales (roost) |
| Vehicles | Ballista (anti-air), War Wagon, Trebuchet, Bombard cannon |
| Ships | Longship, Fire Ship, Cannon Galleon |
| Flyers | Griffin Rider, Wyvern, Dragon (Dragon Roost). Fly over water and walls; only ranged attackers, towers and flyers can hit them |
| Towers | Arrow Tower, Sky Ballista Tower (anti-air), Flame Tower, Cannon Tower (cannot hit flyers) |
| Alliances | Free-for-all only: offer, accept, break any time. Allies share vision, never fight, and win together. Bots accept unless it would end the game |

## Verification in place

- `npm test`: determinism lint, plus 50 tests covering math, map symmetry, pathfinding, economy,
  combat, boats, command validation, golden hashes, fuzzed replay equality, reconnect
  fast-forward, and a live relay-server integration test (two WebSocket clients)
- `/determinism.html`: the same golden games run in any browser and are compared to Node's hashes

## Balance playtest (automated, 6 seeds per row)

| Match-up | Result |
|---|---|
| Hard vs Normal | Hard wins 6/6 (about 15 min) |
| Hard vs Easy | Hard wins 6/6 (about 8 min) |
| Normal vs Easy | Normal wins 6/6 (about 8 min) |
| Scripted beginner vs Sleepy (tutorial) | beginner wins 6/6 (about 4.5 min) |
| Scripted beginner vs Easy | beginner wins 4, loses 1, 1 unfinished |
| Scripted beginner vs Normal | beginner loses 6/6 |

Re-run with `npx tsx scripts/balance.ts 6` after changing numbers.

## Next ideas

- Playtest with the target age group; tune costs and timings in `packages/shared/src/defs.ts`
  (then run `npm run golden`)
- Cross-browser golden check in Firefox and Safari: skipped for now (Chromium and Node verified); open `/determinism.html` in those browsers any time
- Going live: when ready, run `npm ci && npm run build && npm start` on any Node host (see README)
