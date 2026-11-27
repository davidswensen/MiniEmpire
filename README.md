# MiniEmpire 🏰

A simple, kid-friendly (ages 10–15) medieval real-time strategy game that runs in the browser.
Gather wood and gold, build a castle town, train swordsmen, archers and knights, build rams,
catapults and ships, and knock down the enemy castle, against bots or friends online.

- **Blocky 3D** look (Three.js), runs on Chromebooks and tablets (touch supported)
- **Online multiplayer** with 4-letter room codes: 1v1, 2v2, or free-for-all with up to 4 players; bots fill empty slots
- **Deterministic lockstep networking**: only commands travel over the network
- **Kid-safe**: no accounts, no personal info, no free-text chat (quick-chat buttons and emotes only), no ads or purchases
- **Upgrades** (blacksmith, castle, workshop, dock, dragon roost), **siege vehicles** (ram, ballista, war wagon, catapult, trebuchet, bombard), **ships** (transport, longship, warship, fire ship, galleon), **flyers** (griffin rider, wyvern, dragon) and **towers** (arrow, sky ballista, flame, cannon)
- **Alliances** in free-for-all games: offer, accept, break at any time; allies share vision and can win together
- Tutorial, cosmetic hats unlocked with XP, replays, sound effects

## Run it

Requires Node 22+.

```powershell
npm install
npm run dev
```

Open http://localhost:5173. `npm run dev` starts the relay server on port 8080 and Vite on 5173.
To play online with someone on your network, they open `http://<your-ip>:5173`.

Production (one port):

```powershell
npm run build
npm start
```

Then open http://localhost:8080. The relay serves the built client and the WebSocket at `/ws`.
Set the `PORT` environment variable to change the port.

## Deploy

No Docker needed. On any host with Node 22+ that allows WebSockets (a VPS, a Raspberry Pi, or Render or Railway set to Node):

```powershell
npm ci
npm run build
npm start
```

One process serves the game and the relay (WebSocket at `/ws`, health check at `/health`). Set `PORT` to change the port. Game rooms live in memory, so run exactly one instance.

## Checks

```powershell
npm test          # determinism lint + all tests (sim, bots, replays, live relay server)
npm run typecheck
npm run golden    # regenerate golden hashes after an intentional gameplay change
npx tsx scripts/balance.ts 6   # automated balance playtest (bot difficulty matrix)
npx tsx scripts/net-jitter.ts 15 60   # 4 clients on the running relay: smoothness under network jitter
```

Open `/determinism.html` in any browser to check that browser reproduces the golden games
exactly as Node does (cross-engine determinism).

## How it works

```
packages/
  shared/   the deterministic simulation (used by browser, tests and tools)
    fixed.ts      integer math: idiv, isqrt (the only file allowed to divide)
    rng.ts        seeded PRNG, stored in the game state
    map.ts        symmetric seeded map generation (fair starts)
    path.ts       A* with deterministic tie-breaking
    sim.ts        entities, orders, economy, combat, boats, victory
    bot.ts        bot players (run inside the sim, use only its RNG)
    lockstep.ts   turn runner shared by client, replays and tests
    hash.ts       state hash for desync detection
  server/   relay: rooms, room codes, turn clock, hash comparison, reconnect
  client/   Three.js renderer, input, HUD, menus, tutorial, audio
scripts/check-determinism.mjs   lint that bans floats, Math.random, Date, trig... in the sim
```

**Lockstep model.** Every browser runs the same simulation from the same seed. The server
batches all commands every 100 ms into a numbered turn and sends that turn to everyone. Each
turn runs 2 simulation ticks (20 ticks/s). The server sets the pace, so one player's slow wifi
only delays that player's own commands. Every 10 turns each client reports a state hash. If two
clients disagree, the server flags a desync and saves the full log to `desyncs/` so it can be
replayed (`npm test` replays any saved logs).

**Reconnecting.** The server keeps the turn log. A player who reloads or drops out
reconnects with their session token and fast-forwards through the history.

**Determinism rules for `packages/shared/src`** (enforced by `npm run lint`):

- integers only (`FP = 1024` units per tile), divide with `idiv()`
- no `Math.random`, `Date`, `performance`, `Math.sin`/`cos`/`atan2`/`pow`...
- iterate entities in id order, and give every sort a comparator
- the only input is commands applied at turn boundaries

The renderer is free to use floats; it only reads the state.
