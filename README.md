# 💣 Bomb Arena

A retro, **Bomberman-style real-time multiplayer** arena battler that runs in the
browser. Join a room, move on a grid, drop bombs, blow up crates and each other —
last blob standing wins the round. Server-authoritative, no build step, no assets
(everything is drawn on a canvas and every sound is synthesized with WebAudio).

![stack](https://img.shields.io/badge/node-express-green) ![rt](https://img.shields.io/badge/realtime-socket.io-blue)

---

## Tech stack

- **Server:** Node.js + Express (static client) + Socket.io (rooms / realtime).
- **Client:** Vanilla JS + HTML5 Canvas. No React, no bundler, no build step.
- **State:** In-memory only (no database).
- **Assets:** None. Graphics are drawn in code; SFX are square-wave chiptune via
  the WebAudio API. The only external resource is the *Press Start 2P* Google Font.
- **Architecture:** **Server-authoritative.** The server owns all state, runs a
  fixed 30 tick/s simulation, validates every move and bomb, and broadcasts compact
  snapshots. Clients only send inputs and render the latest snapshot.

---

## Run locally

Requires **Node.js 18+**.

```bash
npm install
npm start
```

Then open **two** browser tabs at <http://localhost:3000>.

1. In tab 1: type a name → **Create Room** (note the 4-letter code) → click **READY**.
2. In tab 2: type a name → enter the code → **Join** → click **READY**.
   (Or just hit **Quick Play** in both tabs to be matched automatically.)
3. When 2+ players are all READY a 3-second countdown starts the match.

**Controls:** Arrow keys / **WASD** to move, **Space** (or **X**) to drop a bomb.

> Tip: click the page once before playing so the browser allows audio.

---

## How to play

- **Map:** 13×11 grid. Gray blocks are indestructible; brown crates can be blown up.
- **Bombs:** drop one on your tile; it explodes after 3 seconds in a `+` cross.
  Explosions are blocked by walls and destroy the first crate they hit per direction.
  A blast that reaches another bomb **chain-detonates** it.
- **Power-ups** (drop from ~30% of crates):
  - **B** Extra Bomb — +1 max active bombs
  - **R** Bigger Blast — +1 explosion range
  - **S** Speed Up — move faster (capped)
- **Win:** last player alive wins the round (+1 point). Everyone dying on the same
  tick is a draw. After a 3-second results screen the map regenerates and the next
  round starts automatically. A running scoreboard persists across rounds.
- Closing a tab removes that player cleanly; empty rooms are deleted.

---

## Deploy online (free, websockets enabled)

The server reads its port from `process.env.PORT` (falling back to `3000`), so it
works on any Node host with WebSocket support. Example using **Render**:

1. Push this folder to a GitHub repo.
2. On <https://render.com> → **New → Web Service** → connect the repo.
3. Settings:
   - **Environment:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance type:** Free
4. Deploy. Render injects `PORT` automatically and supports WebSockets out of the
   box — no extra config needed. Open the public URL in two tabs / two devices.

**Railway / Fly.io** work the same way: they set `PORT` for you and run
`npm install` then `npm start`. Just make sure WebSockets are enabled (default on
all three). No environment variables are required.

---

## Project structure

```
server.js          Express + Socket.io, rooms, authoritative game loop
public/index.html  canvas + lobby UI
public/client.js   rendering, input, socket handling, WebAudio SFX
public/style.css   retro styling, CRT scanline overlay, pixel font
package.json       deps (express, socket.io) + "start" script
README.md          this file
```

All gameplay tuning constants live at the top of `server.js` (authoritative);
render-relevant constants are mirrored at the top of `public/client.js`.

---

## Networking protocol

**Client → Server:** `joinRoom {name, roomCode|null}`, `quickPlay {name}`,
`setReady {ready}`, `input {dir}` (`up|down|left|right|none`), `placeBomb`,
`leaveRoom`.

**Server → Client:** `roomState {roomCode, players[], phase, countdown}`,
`gameStart {map, players, spawns}`, `state {tick, players[], bombs[], explosions[],
powerups[], crates[]}` (every tick, minimal payload), `roundOver {winnerId, scores}`,
`errorMsg {message}`.
