/* =============================================================================
 * BOMB ARENA - Authoritative game server  (V2: progression + loadouts)
 * -----------------------------------------------------------------------------
 * Express serves the static client; Socket.io handles rooms + realtime messaging.
 * The server owns ALL game state and simulation, including every V2 mechanic
 * (bomb types, abilities, class traits, curses, kick physics, ice, mines, ...).
 * Clients send inputs + their chosen loadout only; the server validates and
 * broadcasts compact snapshots at a fixed 30 ticks/second.
 *
 * Systems in this file:
 *   1. Tuning constants            5. Simulation (movement/bombs/abilities/...)
 *   2. Express + Socket.io         6. State broadcast
 *   3. Room / lobby management     7. Match flow + XP/coins
 *   4. Map generation              8. Socket event handlers
 * ===========================================================================*/

'use strict';

const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const SHARED = require('./public/shared.js');   // shared loadout catalog

/* ----------------------------------------------------------------------------
 * 1. TUNING CONSTANTS
 * --------------------------------------------------------------------------*/
const COLS = 13, ROWS = 11;
const EMPTY = 0, WALL = 1, CRATE = 2, TEMPWALL = 3;   // tile types

const TICK_RATE = 30;
const DT = 1 / TICK_RATE;

const CRATE_PROB = 0.70;
const POWERUP_PROB = 0.30;

const BOMB_FUSE_TICKS = Math.round(3 * TICK_RATE);
const EXPLOSION_TICKS = Math.round(0.5 * TICK_RATE);

const BASE_BOMBS = 1, MAX_BOMBS = 6;
const BASE_RANGE = 1, MAX_RANGE = 6;
const BASE_SPEED = 1 / 0.18;
const SPEED_INC = 0.9, MAX_SPEED = 9;

const COUNTDOWN_TICKS = 3 * TICK_RATE;
const ROUNDOVER_TICKS = 3 * TICK_RATE;
const MATCHOVER_TICKS = 7 * TICK_RATE;

const MIN_PLAYERS = 2, MAX_PLAYERS = 4;

// V2 mechanic timings
const FROZEN_TICKS    = 3 * TICK_RATE;
const MINE_ARM_TICKS  = Math.round(1.5 * TICK_RATE);
const CLUSTER_FUSE    = 1 * TICK_RATE;
const GRENADE_FUSE    = Math.round(0.45 * TICK_RATE);
const TEMPWALL_TICKS  = 10 * TICK_RATE;
const DECOY_TICKS     = 4 * TICK_RATE;
const SHIELD_TICKS    = 2 * TICK_RATE;
const ARMOR_IFRAMES   = Math.round(0.5 * TICK_RATE);
const PHASE_TICKS     = 5 * TICK_RATE;
const CURSE_TICKS     = 8 * TICK_RATE;
const KICK_TICKS      = 3;                 // a kicked bomb advances 1 tile / 3 ticks
const DASH_TILES      = 2;
const SD_START        = 22 * TICK_RATE;    // sudden-death begins (house rule)
const SD_INTERVAL     = 7;                 // ticks per closing tile

// Arenas
const ARENAS = ['dungeon', 'neon', 'ice', 'volcano', 'factory', 'manor'];
const LAVA_INTERVAL = Math.round(2.2 * TICK_RATE);   // volcano: new eruptions cadence
const LAVA_WARN     = Math.round(1.1 * TICK_RATE);   // telegraph time before lava bursts
const LAVA_COUNT    = 3;                              // eruptions per cadence
const TP_COOLDOWN   = Math.round(0.6 * TICK_RATE);   // manor teleport debounce

const COLORS = ['#fcfcfc', '#e84040', '#5878fc', '#48b048'];
const SPAWNS = [[1, 1], [COLS - 2, ROWS - 2], [COLS - 2, 1], [1, ROWS - 2]];

const DIRV = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
const OPP = { up: 'down', down: 'up', left: 'right', right: 'left', none: 'none' };
const VALID_DIRS = new Set(['up', 'down', 'left', 'right', 'none']);

// Weighted in-match power-up drops (common boosts beat rare). 'curse' resolves
// to one of the curse subtypes when rolled.
const PU_WEIGHTS = [
  ['bomb', 18], ['range', 18], ['speed', 14],
  ['kick', 8], ['throw', 6], ['pierce', 6], ['remote', 5],
  ['shield', 5], ['phase', 4],
];
const CURSE_TYPES = ['reversed', 'slowed', 'tiny'];
const CURSE_CHANCE = 0.10;

// inward spiral over the grid (used by Sudden Death house rule)
function spiralOrder() {
  const res = []; let top = 0, bottom = ROWS - 1, left = 0, right = COLS - 1;
  while (left <= right && top <= bottom) {
    for (let x = left; x <= right; x++) res.push([x, top]);
    for (let y = top + 1; y <= bottom; y++) res.push([right, y]);
    if (top < bottom) for (let x = right - 1; x >= left; x--) res.push([x, bottom]);
    if (left < right) for (let y = bottom - 1; y > top; y--) res.push([left, y]);
    top++; bottom--; left++; right--;
  }
  return res;
}
const SPIRAL = spiralOrder();

/* ----------------------------------------------------------------------------
 * 2. EXPRESS + SOCKET.IO
 * --------------------------------------------------------------------------*/
const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
// startServer() lets the Electron app host a match in-process ("Host Locally").
function startServer(port) {
  const p = port || PORT;
  return server.listen(p, () => console.log(`Bomb Arena listening on :${p}`));
}
// Only auto-listen when run directly (`node server.js`); stays silent when
// required by a test harness or the Electron main process.
if (require.main === module) startServer(PORT);

/* ----------------------------------------------------------------------------
 * 3. ROOM / LOBBY MANAGEMENT
 * --------------------------------------------------------------------------*/
const rooms = {};
const socketRoom = {};

function makeRoomCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) code += letters[(Math.random() * letters.length) | 0];
  } while (rooms[code]);
  return code;
}

function createRoom(balanced) {
  const code = makeRoomCode();
  const room = {
    code,
    players: new Map(),
    phase: 'lobby',                 // lobby | countdown | playing | roundover | matchover
    balanced: !!balanced,           // quick-play = balanced; private = personal loadouts
    hostId: null,
    houseRules: { doublePowerups: false, suddenDeath: false },
    arenaPick: 'dungeon',           // host choice ('random' allowed); resolved per round
    arena: 'dungeon',
    conveyors: {}, teleports: [], iceFloor: false, volcano: false,
    lavaWarn: [], lavaTimer: 0,
    map: null,
    bombs: [], explosions: [], powerups: [], frozen: [], tempWalls: [], decoys: [],
    tick: 0, bombId: 1, puId: 1, newBursts: 0,
    countdown: 0, lastSec: -1, roundOver: 0,
    matchActive: false, sdIndex: 0, sdTimer: 0,
    loop: null,
  };
  rooms[code] = room;
  room.loop = setInterval(() => roomTick(room), 1000 / TICK_RATE);
  return room;
}

function destroyRoom(room) {
  if (room.loop) clearInterval(room.loop);
  delete rooms[room.code];
}

function freeSlot(room) {
  const taken = new Set([...room.players.values()].map(p => p.slot));
  for (let i = 0; i < MAX_PLAYERS; i++) if (!taken.has(i)) return i;
  return -1;
}

function makePlayer(id, name, slot, loadout, level) {
  return {
    id, name: (name || 'PLAYER').slice(0, 10).toUpperCase(), slot,
    color: COLORS[slot],
    loadout: SHARED.sanitizeLoadout(loadout),
    level: Math.max(1, (level | 0) || 1),
    ready: false, spawned: false, played: false, alive: false,
    x: SPAWNS[slot][0], y: SPAWNS[slot][1],
    inputDir: 'none', moveDir: 'none', movingTo: null, facing: 'down',
    // per-round combat stats (reset each round-start of the FIRST round of a match)
    maxBombs: BASE_BOMBS, maxBombsCap: MAX_BOMBS, activeBombs: 0,
    range: BASE_RANGE, rangePenalty: 0, speed: BASE_SPEED,
    canKick: false, canThrow: false, bombPierce: false, bombRemote: false,
    armor: 0, shieldUntil: 0, phaseUntil: 0, curse: null, abilityCd: 0, tpCd: 0,
    matchScore: 0,                       // round wins this match
    stats: { kills: 0, crates: 0, roundWins: 0 },
  };
}

function lobbyPlayer(p) {
  return {
    id: p.id, name: p.name, slot: p.slot, color: p.color,
    ready: p.ready, score: p.matchScore, alive: p.alive,
    level: p.level, loadout: p.loadout,
  };
}

function emitRoomState(room) {
  io.to(room.code).emit('roomState', {
    roomCode: room.code,
    phase: room.phase,
    balanced: room.balanced,
    hostId: room.hostId,
    houseRules: room.houseRules,
    arenaPick: room.arenaPick,
    arenas: ARENAS,
    matchWins: SHARED.MATCH_WINS,
    countdown: room.phase === 'countdown' ? Math.ceil(room.countdown / TICK_RATE) : 0,
    players: [...room.players.values()].map(lobbyPlayer),
  });
}

function lobbyReadyToStart(room) {
  const ps = [...room.players.values()];
  return ps.length >= MIN_PLAYERS && ps.every(p => p.ready);
}

function maybeStartCountdown(room) {
  if (room.phase === 'lobby' && lobbyReadyToStart(room)) {
    room.phase = 'countdown';
    room.countdown = COUNTDOWN_TICKS;
    room.lastSec = Math.ceil(room.countdown / TICK_RATE);
    emitRoomState(room);
  } else if (room.phase === 'countdown' && !lobbyReadyToStart(room)) {
    room.phase = 'lobby';
    emitRoomState(room);
  }
}

function gotoLobby(room) {
  room.phase = 'lobby';
  room.matchActive = false;
  for (const p of room.players.values()) {
    p.ready = false; p.alive = false; p.spawned = false; p.played = false;
    p.matchScore = 0; p.stats = { kills: 0, crates: 0, roundWins: 0 };
  }
  emitRoomState(room);
}

/* ----------------------------------------------------------------------------
 * 4. MAP GENERATION
 * --------------------------------------------------------------------------*/
function generateMap() {
  const map = [];
  for (let y = 0; y < ROWS; y++) {
    const row = [];
    for (let x = 0; x < COLS; x++) {
      if (x === 0 || y === 0 || x === COLS - 1 || y === ROWS - 1) row.push(WALL);
      else if (x % 2 === 0 && y % 2 === 0) row.push(WALL);
      else row.push(EMPTY);
    }
    map.push(row);
  }
  const protectedTiles = new Set();
  const corners = [[1, 1], [COLS - 2, 1], [1, ROWS - 2], [COLS - 2, ROWS - 2]];
  for (const [cx, cy] of corners) {
    const inX = cx === 1 ? 1 : -1, inY = cy === 1 ? 1 : -1;
    for (const [x, y] of [[cx, cy], [cx + inX, cy], [cx, cy + inY]]) protectedTiles.add(y * COLS + x);
  }
  for (let y = 1; y < ROWS - 1; y++)
    for (let x = 1; x < COLS - 1; x++) {
      if (map[y][x] !== EMPTY || protectedTiles.has(y * COLS + x)) continue;
      if (Math.random() < CRATE_PROB) map[y][x] = CRATE;
    }
  return map;
}

// --- Arena builder: returns a config object the round installs onto the room.
const cornerProtected = () => {
  const s = new Set();
  for (const [cx, cy] of [[1, 1], [COLS - 2, 1], [1, ROWS - 2], [COLS - 2, ROWS - 2]]) {
    const inX = cx === 1 ? 1 : -1, inY = cy === 1 ? 1 : -1;
    for (const [x, y] of [[cx, cy], [cx + inX, cy], [cx, cy + inY]]) s.add(y * COLS + x);
  }
  return s;
};
function blankMap(pillars) {
  const map = [];
  for (let y = 0; y < ROWS; y++) {
    const row = [];
    for (let x = 0; x < COLS; x++) {
      if (x === 0 || y === 0 || x === COLS - 1 || y === ROWS - 1) row.push(WALL);
      else if (pillars && x % 2 === 0 && y % 2 === 0) row.push(WALL);
      else row.push(EMPTY);
    }
    map.push(row);
  }
  return map;
}
function scatterCrates(map, prob, prot) {
  for (let y = 1; y < ROWS - 1; y++)
    for (let x = 1; x < COLS - 1; x++) {
      if (map[y][x] !== EMPTY || prot.has(y * COLS + x)) continue;
      if (Math.random() < prob) map[y][x] = CRATE;
    }
}

function generateArena(arena, variant) {
  const prot = cornerProtected();
  const cfg = { map: null, conveyors: {}, teleports: [], iceFloor: false, volcano: false };

  if (arena === 'neon') {
    // open Tron-like layout: no pillar grid, sparse walls, fewer crates
    const map = blankMap(false);
    if (variant) { // a central diamond of walls
      const mx = (COLS - 1) / 2, my = (ROWS - 1) / 2;
      for (let d = 0; d <= 2; d++) {
        map[my - d] && (map[my - d][mx] = WALL);
        map[my + d] && (map[my + d][mx] = WALL);
      }
    } else { // a few scattered single pillars
      for (const [x, y] of [[3, 3], [9, 3], [3, 7], [9, 7], [6, 5]]) map[y][x] = WALL;
    }
    scatterCrates(map, 0.30, prot);
    cfg.map = map;
    return cfg;
  }

  // all other arenas share the classic pillar layout
  const map = blankMap(true);
  scatterCrates(map, CRATE_PROB, prot);
  cfg.map = map;

  if (arena === 'ice') { cfg.iceFloor = true; }
  else if (arena === 'volcano') { cfg.volcano = true; }
  else if (arena === 'factory') {
    // conveyor lanes on a couple of odd rows/cols (which are crate-free corridors)
    const lanes = variant
      ? [{ row: 5, dir: 'right' }, { col: 3, dir: 'down' }, { col: 9, dir: 'up' }]
      : [{ row: 3, dir: 'left' }, { row: 7, dir: 'right' }, { col: 6, dir: 'down' }];
    for (const l of lanes) {
      if (l.row != null) {
        for (let x = 1; x < COLS - 1; x++) if (map[l.row][x] !== WALL) { map[l.row][x] = EMPTY; cfg.conveyors[l.row * COLS + x] = l.dir; }
      } else {
        for (let y = 1; y < ROWS - 1; y++) if (map[y][l.col] !== WALL) { map[y][l.col] = EMPTY; cfg.conveyors[y * COLS + l.col] = l.dir; }
      }
    }
  } else if (arena === 'manor') {
    // two teleporter pairs on clear interior tiles
    const pairs = variant
      ? [[[3, 1], [COLS - 4, ROWS - 2]], [[1, ROWS - 4], [COLS - 2, 3]]]
      : [[[5, 1], [7, ROWS - 2]], [[1, 5], [COLS - 2, 5]]];
    for (const [[ax, ay], [bx, by]] of pairs) {
      map[ay][ax] = EMPTY; map[by][bx] = EMPTY;
      cfg.teleports.push({ x: ax, y: ay, tx: bx, ty: by });
      cfg.teleports.push({ x: bx, y: by, tx: ax, ty: ay });
    }
  }
  return cfg;
}
function teleportAt(room, x, y) { return room.teleports.find(t => t.x === x && t.y === y); }

/* ----------------------------------------------------------------------------
 * 5. SIMULATION
 * --------------------------------------------------------------------------*/
function bombAt(room, x, y) { return room.bombs.find(b => b.x === x && b.y === y); }
function frozenAt(room, x, y) { return room.frozen.some(f => f.x === x && f.y === y); }
function playerOnTile(room, x, y, except) {
  for (const p of room.players.values())
    if (p !== except && p.spawned && p.alive && Math.round(p.x) === x && Math.round(p.y) === y) return true;
  return false;
}

// passability for a moving player (phase lets them cross real crates)
function isPassable(room, x, y, p) {
  if (x < 0 || y < 0 || x >= COLS || y >= ROWS) return false;
  const t = room.map[y][x];
  if (t === WALL || t === TEMPWALL) return false;
  if (t === CRATE && !(p && p.phaseUntil > room.tick)) return false;
  if (bombAt(room, x, y)) return false;
  return true;
}
// can a kicked/sliding bomb enter this tile?
function bombCanEnter(room, x, y) {
  if (x < 0 || y < 0 || x >= COLS || y >= ROWS) return false;
  if (room.map[y][x] !== EMPTY) return false;
  if (bombAt(room, x, y)) return false;
  if (playerOnTile(room, x, y, null)) return false;
  return true;
}

function approach(cur, target, step) {
  if (cur < target) return Math.min(cur + step, target);
  if (cur > target) return Math.max(cur - step, target);
  return target;
}

function effInputDir(p, room) {
  let d = p.inputDir;
  if (p.curse && p.curse.type === 'reversed' && room.tick < p.curse.until) d = OPP[d];
  return d;
}

function kickBomb(room, bomb, dx, dy) { bomb.slide = { dx, dy }; bomb.slideCd = KICK_TICKS; }

function updateMovement(p, room) {
  if (!p.movingTo) {
    const d = effInputDir(p, room);
    if (d !== 'none') {
      const [dx, dy] = DIRV[d];
      const nx = Math.round(p.x) + dx, ny = Math.round(p.y) + dy;
      const bombHere = bombAt(room, nx, ny);
      if (bombHere && p.canKick && !bombHere.slide) {
        kickBomb(room, bombHere, dx, dy);
        p.moveDir = 'none'; p.facing = d;
      } else if (isPassable(room, nx, ny, p)) {
        p.movingTo = { x: nx, y: ny }; p.moveDir = d; p.facing = d;
      } else { p.moveDir = 'none'; p.facing = d; }
    } else p.moveDir = 'none';
  }
  if (p.movingTo) {
    const slowed = p.curse && p.curse.type === 'slowed' && room.tick < p.curse.until;
    const step = p.speed * (slowed ? 0.5 : 1) * DT;
    p.x = approach(p.x, p.movingTo.x, step);
    p.y = approach(p.y, p.movingTo.y, step);
    if (p.x === p.movingTo.x && p.y === p.movingTo.y) {
      p.movingTo = null;
      // ice: slide one more tile if you stop on a frozen/ice tile while moving
      if (p.moveDir !== 'none' && (room.iceFloor || frozenAt(room, Math.round(p.x), Math.round(p.y)))) {
        const [dx, dy] = DIRV[p.moveDir];
        const nx = Math.round(p.x) + dx, ny = Math.round(p.y) + dy;
        if (isPassable(room, nx, ny, p)) p.movingTo = { x: nx, y: ny };
      }
    }
  }
}

function addExplosion(room, x, y, owner) {
  const e = room.explosions.find(e => e.x === x && e.y === y);
  if (e) { e.timer = EXPLOSION_TICKS; e.owner = owner; }
  else room.explosions.push({ x, y, timer: EXPLOSION_TICKS, owner });
}
function addFrozen(room, x, y) {
  const f = room.frozen.find(f => f.x === x && f.y === y);
  if (f) f.timer = FROZEN_TICKS; else room.frozen.push({ x, y, timer: FROZEN_TICKS });
}
function removePowerupAt(room, x, y) {
  const i = room.powerups.findIndex(p => p.x === x && p.y === y);
  if (i >= 0) room.powerups.splice(i, 1);
}

function rollDrop(room) {
  if (Math.random() < CURSE_CHANCE)
    return { t: CURSE_TYPES[(Math.random() * CURSE_TYPES.length) | 0], curse: true };
  let total = 0; for (const [, w] of PU_WEIGHTS) total += w;
  let r = Math.random() * total;
  for (const [t, w] of PU_WEIGHTS) { if ((r -= w) < 0) return { t, curse: false }; }
  return { t: 'bomb', curse: false };
}

function destroyBlock(room, x, y, owner) {
  const t = room.map[y][x];
  room.map[y][x] = EMPTY;
  if (t === TEMPWALL) {
    const i = room.tempWalls.findIndex(w => w.x === x && w.y === y);
    if (i >= 0) room.tempWalls.splice(i, 1);
    return;
  }
  // real crate: credit owner + maybe drop
  const o = room.players.get(owner);
  if (o) o.stats.crates++;
  const prob = room.houseRules.doublePowerups ? Math.min(1, POWERUP_PROB * 2) : POWERUP_PROB;
  if (Math.random() < prob) {
    const d = rollDrop(room);
    room.powerups.push({ id: room.puId++, x, y, t: d.t, curse: d.curse });
  }
}

function spawnCluster(room, bomb) {
  for (const dir of Object.keys(DIRV)) {
    const [dx, dy] = DIRV[dir];
    const x = bomb.x + dx, y = bomb.y + dy;
    if (x < 0 || y < 0 || x >= COLS || y >= ROWS) continue;
    if (room.map[y][x] !== EMPTY || bombAt(room, x, y)) continue;
    room.bombs.push({
      id: room.bombId++, x, y, owner: bomb.owner, range: Math.max(1, bomb.range - 1),
      type: 'classic', fuse: CLUSTER_FUSE, pierce: false, freeze: false, cluster: false,
      mine: false, armed: true, armTimer: 0, remote: false, thrown: false,
      slide: null, slideCd: 0, counted: false,
    });
  }
}

// Detonate one bomb: stamp cross, handle pierce/freeze/cluster, chain other bombs.
function detonate(room, bomb, queue) {
  room.newBursts++;
  const tiles = [{ x: bomb.x, y: bomb.y }];
  addExplosion(room, bomb.x, bomb.y, bomb.owner);
  for (const dir of Object.keys(DIRV)) {
    const [dx, dy] = DIRV[dir];
    for (let r = 1; r <= bomb.range; r++) {
      const x = bomb.x + dx * r, y = bomb.y + dy * r;
      if (x < 0 || y < 0 || x >= COLS || y >= ROWS) break;
      const t = room.map[y][x];
      if (t === WALL) break;
      if (t === CRATE || t === TEMPWALL) {
        destroyBlock(room, x, y, bomb.owner);
        addExplosion(room, x, y, bomb.owner); tiles.push({ x, y });
        if (bomb.pierce) continue; else break;
      }
      addExplosion(room, x, y, bomb.owner); tiles.push({ x, y });
      removePowerupAt(room, x, y);
      const other = bombAt(room, x, y);
      if (other && !other.exploding) { other.exploding = true; queue.push(other); break; }
    }
  }
  if (bomb.freeze) for (const tl of tiles) addFrozen(room, tl.x, tl.y);
  if (bomb.cluster) spawnCluster(room, bomb);
}

function updateBombs(room) {
  for (const b of room.bombs) {
    if (b.mine) {
      if (!b.armed) { if (--b.armTimer <= 0) b.armed = true; }
      else {
        for (const p of room.players.values()) {
          if (!(p.spawned && p.alive) || p.id === b.owner) continue;
          if (Math.abs(Math.round(p.x) - b.x) <= 1 && Math.abs(Math.round(p.y) - b.y) <= 1) { b.triggered = true; break; }
        }
      }
    }
    if (b.slide) {
      if (--b.slideCd <= 0) {
        const nx = b.x + b.slide.dx, ny = b.y + b.slide.dy;
        if (bombCanEnter(room, nx, ny)) { b.x = nx; b.y = ny; b.slideCd = KICK_TICKS; }
        else b.slide = null;
      }
    }
  }
}

function useAbility(room, p) {
  if (p.abilityCd > 0 || !p.alive) return;
  const id = p.loadout.ability;
  const def = SHARED.ABILITIES[id]; if (!def) return;
  const face = p.facing === 'none' ? 'down' : p.facing;
  const [dx, dy] = DIRV[face];
  let used = true;
  if (id === 'dash') {
    let tx = Math.round(p.x), ty = Math.round(p.y), moved = false;
    for (let s = 1; s <= DASH_TILES; s++) {
      const nx = Math.round(p.x) + dx * s, ny = Math.round(p.y) + dy * s;
      if (isPassable(room, nx, ny, p)) { tx = nx; ty = ny; moved = true; } else break;
    }
    if (moved) { p.x = tx; p.y = ty; p.movingTo = null; } else used = false;
  } else if (id === 'wall') {
    const x = Math.round(p.x) + dx, y = Math.round(p.y) + dy;
    if (x > 0 && y > 0 && x < COLS - 1 && y < ROWS - 1 && room.map[y][x] === EMPTY &&
        !bombAt(room, x, y) && !playerOnTile(room, x, y, p)) {
      room.map[y][x] = TEMPWALL; room.tempWalls.push({ x, y, timer: TEMPWALL_TICKS });
    } else used = false;
  } else if (id === 'decoy') {
    room.decoys.push({ x: Math.round(p.x), y: Math.round(p.y), slot: p.slot, hat: p.loadout.hat, timer: DECOY_TICKS });
  } else if (id === 'shield') {
    p.shieldUntil = room.tick + SHIELD_TICKS;
  } else if (id === 'kickpulse') {
    for (const dir of Object.keys(DIRV)) {
      const [kx, ky] = DIRV[dir];
      const b = bombAt(room, Math.round(p.x) + kx, Math.round(p.y) + ky);
      if (b) kickBomb(room, b, kx, ky);
    }
  }
  if (used) p.abilityCd = Math.round(def.cd * TICK_RATE);
}

function placeBomb(room, p) {
  if (p.activeBombs >= p.maxBombs) return;
  const bt = p.loadout.bomb;
  const isMine = bt === 'mine';
  const thrown = !isMine && (bt === 'grenade' || p.canThrow);
  let bx, by;
  if (thrown) {
    const t = throwTarget(room, p); bx = t.x; by = t.y;
  } else { bx = Math.round(p.x); by = Math.round(p.y); }
  if (bombAt(room, bx, by)) return;

  let range = p.range - (p.rangePenalty || 0);
  if (bt === 'pierce') range -= 1;
  if (p.curse && p.curse.type === 'tiny' && room.tick < p.curse.until) range = 1;
  range = Math.max(1, range);

  const remote = bt === 'remote' || p.bombRemote;
  let fuse;
  if (remote || isMine) fuse = Infinity;
  else if (thrown) fuse = GRENADE_FUSE;
  else fuse = bt === 'ice' ? BOMB_FUSE_TICKS - 15 : BOMB_FUSE_TICKS;

  room.bombs.push({
    id: room.bombId++, x: bx, y: by, owner: p.id, range, type: bt, fuse,
    pierce: bt === 'pierce' || p.bombPierce, freeze: bt === 'ice', cluster: bt === 'cluster',
    mine: isMine, armed: false, armTimer: isMine ? MINE_ARM_TICKS : 0,
    remote, thrown, slide: null, slideCd: 0, counted: true,
  });
  p.activeBombs++;
}

function throwTarget(room, p) {
  const face = p.facing === 'none' ? 'down' : p.facing;
  const [dx, dy] = DIRV[face];
  const tx = Math.round(p.x), ty = Math.round(p.y);
  for (let r = 3; r >= 1; r--) {            // land as far as possible (flies over walls)
    const x = tx + dx * r, y = ty + dy * r;
    if (x < 0 || y < 0 || x >= COLS || y >= ROWS) continue;
    if (room.map[y][x] !== EMPTY || bombAt(room, x, y)) continue;
    return { x, y };
  }
  return { x: tx, y: ty };
}

function applyPowerup(room, p, pu) {
  if (pu.curse) { p.curse = { type: pu.t, until: room.tick + CURSE_TICKS }; return; }
  switch (pu.t) {
    case 'bomb': p.maxBombs = Math.min(p.maxBombs + 1, p.maxBombsCap); break;
    case 'range': p.range = Math.min(p.range + 1, MAX_RANGE); break;
    case 'speed': p.speed = Math.min(p.speed + SPEED_INC, MAX_SPEED); break;
    case 'kick': p.canKick = true; break;
    case 'throw': p.canThrow = true; break;
    case 'pierce': p.bombPierce = true; break;
    case 'remote': p.bombRemote = true; break;
    case 'shield': p.armor += 1; break;                  // one-time absorb
    case 'phase': p.phaseUntil = room.tick + PHASE_TICKS; break;
  }
}

function suddenDeathStep(room) {
  if (!room.houseRules.suddenDeath || room.tick < SD_START) return;
  if (--room.sdTimer > 0) return;
  room.sdTimer = SD_INTERVAL;
  while (room.sdIndex < SPIRAL.length) {
    const [x, y] = SPIRAL[room.sdIndex++];
    if (room.map[y][x] === WALL) continue;
    room.map[y][x] = WALL;
    removePowerupAt(room, x, y);
    const i = room.bombs.findIndex(b => b.x === x && b.y === y);
    if (i >= 0) room.bombs.splice(i, 1);
    for (const p of room.players.values())
      if (p.spawned && p.alive && Math.round(p.x) === x && Math.round(p.y) === y) p.alive = false;
    break;
  }
}

// Arena mechanics: conveyors push, teleporters warp, volcano erupts lava.
function arenaMechanics(room) {
  // conveyors push settled players one tile along the belt
  for (const p of room.players.values()) {
    if (!(p.spawned && p.alive)) continue;
    if (p.tpCd > 0) p.tpCd--;
    if (!p.movingTo) {
      const dir = room.conveyors[Math.round(p.y) * COLS + Math.round(p.x)];
      if (dir) {
        const [dx, dy] = DIRV[dir];
        const nx = Math.round(p.x) + dx, ny = Math.round(p.y) + dy;
        if (isPassable(room, nx, ny, p)) { p.movingTo = { x: nx, y: ny }; p.moveDir = dir; }
      }
    }
  }
  // teleporters warp a centered player to the paired tile
  for (const p of room.players.values()) {
    if (!(p.spawned && p.alive) || p.movingTo || p.tpCd > 0) continue;
    const t = teleportAt(room, Math.round(p.x), Math.round(p.y));
    if (t) { p.x = t.tx; p.y = t.ty; p.movingTo = null; p.tpCd = TP_COOLDOWN; }
  }
  // conveyors also shove idle bombs
  for (const b of room.bombs) {
    if (b.slide) continue;
    const dir = room.conveyors[b.y * COLS + b.x];
    if (dir) { const [dx, dy] = DIRV[dir]; kickBomb(room, b, dx, dy); }
  }
  // volcano: telegraphed lava bursts
  if (room.volcano) {
    for (const w of room.lavaWarn) w.t--;
    for (const w of room.lavaWarn) if (w.t <= 0) addExplosion(room, w.x, w.y, null);
    room.lavaWarn = room.lavaWarn.filter(w => w.t > 0);
    if (--room.lavaTimer <= 0) {
      room.lavaTimer = LAVA_INTERVAL;
      for (let i = 0; i < LAVA_COUNT; i++) {
        const x = 1 + ((Math.random() * (COLS - 2)) | 0), y = 1 + ((Math.random() * (ROWS - 2)) | 0);
        if (room.map[y][x] === EMPTY && !room.lavaWarn.some(w => w.x === x && w.y === y))
          room.lavaWarn.push({ x, y, t: LAVA_WARN });
      }
    }
  }
}

function simulate(room) {
  room.tick++;
  room.newBursts = 0;

  // cooldowns + timed overlays
  for (const p of room.players.values()) if (p.abilityCd > 0) p.abilityCd--;
  for (const e of room.explosions) e.timer--;
  room.explosions = room.explosions.filter(e => e.timer > 0);
  for (const f of room.frozen) f.timer--;
  room.frozen = room.frozen.filter(f => f.timer > 0);
  for (const d of room.decoys) d.timer--;
  room.decoys = room.decoys.filter(d => d.timer > 0);
  for (const w of room.tempWalls) {
    if (--w.timer <= 0 && room.map[w.y][w.x] === TEMPWALL) room.map[w.y][w.x] = EMPTY;
  }
  room.tempWalls = room.tempWalls.filter(w => w.timer > 0);

  // mines arm/trigger + kicked bombs slide
  updateBombs(room);

  // fuses + chain detonation (also fires remote/mine 'triggered' bombs)
  const queue = [];
  for (const b of room.bombs) {
    if (b.fuse !== Infinity) b.fuse--;
    if (!b.exploding && (b.fuse <= 0 || b.triggered)) { b.exploding = true; queue.push(b); }
  }
  while (queue.length) detonate(room, queue.shift(), queue);
  if (room.bombs.some(b => b.exploding)) {
    for (const b of room.bombs) {
      if (!b.exploding || !b.counted) continue;
      const owner = room.players.get(b.owner);
      if (owner && owner.activeBombs > 0) owner.activeBombs--;
    }
    room.bombs = room.bombs.filter(b => !b.exploding);
  }

  // movement
  for (const p of room.players.values()) if (p.spawned && p.alive) updateMovement(p, room);

  // arena mechanics (conveyors / teleporters / volcano)
  arenaMechanics(room);

  // power-up pickups
  for (const p of room.players.values()) {
    if (!(p.spawned && p.alive)) continue;
    const tx = Math.round(p.x), ty = Math.round(p.y);
    const i = room.powerups.findIndex(pu => pu.x === tx && pu.y === ty);
    if (i >= 0) { applyPowerup(room, p, room.powerups[i]); room.powerups.splice(i, 1); }
  }

  // sudden death (house rule)
  suddenDeathStep(room);

  // deaths (shield/armor absorb), with kill attribution
  const flame = new Map();
  for (const e of room.explosions) flame.set(e.y * COLS + e.x, e.owner);
  for (const p of room.players.values()) {
    if (!(p.spawned && p.alive)) continue;
    const key = Math.round(p.y) * COLS + Math.round(p.x);
    if (!flame.has(key)) continue;
    if (room.tick < p.shieldUntil) continue;
    if (p.armor > 0) { p.armor--; p.shieldUntil = room.tick + ARMOR_IFRAMES; continue; }
    p.alive = false;
    const killerId = flame.get(key);
    if (killerId && killerId !== p.id) {
      const k = room.players.get(killerId);
      if (k) k.stats.kills++;
    }
  }

  // win detection
  const inGame = [...room.players.values()].filter(p => p.spawned);
  const alive = inGame.filter(p => p.alive);
  if (inGame.length >= 1 && alive.length <= 1) setRoundOver(room, alive.length === 1 ? alive[0] : null);
}

/* ----------------------------------------------------------------------------
 * 7. MATCH FLOW + XP/COINS
 * --------------------------------------------------------------------------*/
function startMatch(room) {
  room.matchActive = true;
  for (const p of room.players.values()) {
    p.matchScore = 0; p.stats = { kills: 0, crates: 0, roundWins: 0 };
  }
}

function startRound(room) {
  // resolve arena (host pick, or random each round)
  room.arena = room.arenaPick === 'random'
    ? ARENAS[(Math.random() * ARENAS.length) | 0]
    : (ARENAS.includes(room.arenaPick) ? room.arenaPick : 'dungeon');
  const cfg = generateArena(room.arena, (Math.random() * 2) | 0);
  room.map = cfg.map;
  room.conveyors = cfg.conveyors; room.teleports = cfg.teleports;
  room.iceFloor = cfg.iceFloor; room.volcano = cfg.volcano;

  room.bombs = []; room.explosions = []; room.powerups = [];
  room.frozen = []; room.tempWalls = []; room.decoys = []; room.lavaWarn = [];
  room.tick = 0; room.newBursts = 0; room.sdIndex = 0; room.sdTimer = SD_INTERVAL;
  room.lavaTimer = LAVA_INTERVAL;

  const spawns = [];
  for (const p of room.players.values()) {
    const [sx, sy] = SPAWNS[p.slot];
    p.x = sx; p.y = sy; p.alive = true; p.spawned = true; p.played = true;
    p.inputDir = 'none'; p.moveDir = 'none'; p.movingTo = null; p.facing = 'down'; p.tpCd = 0;
    p.maxBombs = BASE_BOMBS; p.maxBombsCap = MAX_BOMBS; p.activeBombs = 0;
    p.range = BASE_RANGE; p.rangePenalty = 0; p.speed = BASE_SPEED;
    p.canKick = false; p.canThrow = false; p.bombPierce = false; p.bombRemote = false;
    p.armor = 0; p.shieldUntil = 0; p.phaseUntil = 0; p.curse = null; p.abilityCd = 0;
    applyClass(p);
    spawns.push({ slot: p.slot, x: sx, y: sy });
  }

  room.phase = 'playing';
  io.to(room.code).emit('gameStart', {
    map: room.map, spawns,
    balanced: room.balanced,
    arena: room.arena,
    conveyors: room.conveyors, teleports: room.teleports, iceFloor: room.iceFloor,
    players: [...room.players.values()].map(p => ({
      slot: p.slot, name: p.name, color: p.color, x: p.x, y: p.y,
      score: p.matchScore, level: p.level, loadout: p.loadout,
    })),
  });
}

function applyClass(p) {
  switch (p.loadout.cls) {
    case 'speedster': p.speed = BASE_SPEED * 1.3; p.maxBombs = 1; p.maxBombsCap = 4; break;
    case 'tank': p.speed = BASE_SPEED * 0.82; p.armor = 1; break;
    case 'trickster': p.canKick = true; p.rangePenalty = 1; break;
    default: break; // bomber
  }
}

function setRoundOver(room, winner) {
  if (winner) { winner.matchScore++; winner.stats.roundWins++; }
  const matchEnded = (room.matchActive && winner && winner.matchScore >= SHARED.MATCH_WINS) ||
                     room.players.size < MIN_PLAYERS;
  if (matchEnded) { endMatch(room, winner); return; }

  room.phase = 'roundover';
  room.roundOver = ROUNDOVER_TICKS;
  io.to(room.code).emit('roundOver', {
    winnerId: winner ? winner.id : null,
    winnerName: winner ? winner.name : null,
    winnerSlot: winner ? winner.slot : null,
    scores: [...room.players.values()].map(p => ({
      id: p.id, name: p.name, slot: p.slot, color: p.color, score: p.matchScore,
    })),
  });
}

function endMatch(room, winner) {
  room.phase = 'matchover';
  room.roundOver = MATCHOVER_TICKS;
  room.matchActive = false;
  const XP = SHARED.XP_REWARDS, CO = SHARED.COIN_REWARDS;
  const results = [];
  for (const p of room.players.values()) {
    if (!p.played) continue;
    const won = winner && winner.id === p.id;
    const s = p.stats;
    const xp =
      s.crates * XP.crate + s.kills * XP.kill + s.roundWins * XP.roundWin +
      (won ? XP.matchWin + XP.placement : 0);
    const coins =
      s.crates * CO.crate + s.kills * CO.kill + s.roundWins * CO.roundWin +
      (won ? CO.matchWin : 0) + CO.participate;
    results.push({
      id: p.id, slot: p.slot, name: p.name, color: p.color, won,
      xp, coins, breakdown: { crates: s.crates, kills: s.kills, roundWins: s.roundWins, won },
    });
  }
  io.to(room.code).emit('matchOver', {
    winnerId: winner ? winner.id : null,
    winnerName: winner ? winner.name : null,
    winnerSlot: winner ? winner.slot : null,
    results,
  });
}

/* ----------------------------------------------------------------------------
 * 6. STATE BROADCAST
 * --------------------------------------------------------------------------*/
const r2 = v => Math.round(v * 100) / 100;

function broadcastState(room) {
  const crates = [], walls2 = [];
  for (let y = 0; y < ROWS; y++)
    for (let x = 0; x < COLS; x++) {
      const t = room.map[y][x];
      if (t === CRATE) crates.push(y * COLS + x);
      else if (t === TEMPWALL) walls2.push(y * COLS + x);
    }

  io.to(room.code).emit('state', {
    tick: room.tick,
    players: [...room.players.values()].filter(p => p.spawned).map(p => ({
      i: p.slot, x: r2(p.x), y: r2(p.y), a: p.alive, f: p.facing,
      sh: (room.tick < p.shieldUntil || p.armor > 0) ? 1 : 0,
      cu: p.curse && room.tick < p.curse.until ? p.curse.type : 0,
      ph: p.phaseUntil > room.tick ? 1 : 0,
      cd: p.abilityCd, cm: Math.round((SHARED.ABILITIES[p.loadout.ability]?.cd || 1) * TICK_RATE),
    })),
    bombs: room.bombs.map(b => ({ id: b.id, x: b.x, y: b.y, f: b.fuse === Infinity ? -1 : b.fuse, t: b.type, m: b.mine ? (b.armed ? 2 : 1) : 0 })),
    explosions: room.explosions.map(e => e.y * COLS + e.x),
    nb: room.newBursts,
    powerups: room.powerups.map(p => ({ id: p.id, x: p.x, y: p.y, t: p.t, c: p.curse ? 1 : 0 })),
    crates, walls2,
    frozen: room.frozen.map(f => f.y * COLS + f.x),
    decoys: room.decoys.map(d => ({ x: d.x, y: d.y, i: d.slot })),
    lava: room.lavaWarn.map(w => w.y * COLS + w.x),
  });
}

function roomTick(room) {
  if (room.phase === 'countdown') {
    room.countdown--;
    const sec = Math.ceil(room.countdown / TICK_RATE);
    if (sec !== room.lastSec) { room.lastSec = sec; emitRoomState(room); }
    if (room.countdown <= 0) { startMatch(room); startRound(room); }
  } else if (room.phase === 'playing') {
    simulate(room);
    broadcastState(room);
  } else if (room.phase === 'roundover') {
    if (--room.roundOver <= 0) {
      if (room.players.size >= MIN_PLAYERS) startRound(room); else gotoLobby(room);
    }
  } else if (room.phase === 'matchover') {
    if (--room.roundOver <= 0) gotoLobby(room);
  }
}

/* ----------------------------------------------------------------------------
 * 8. SOCKET EVENT HANDLERS
 * --------------------------------------------------------------------------*/
function joinExistingRoom(socket, name, room, loadout, level) {
  const slot = freeSlot(room);
  if (slot < 0) { socket.emit('errorMsg', { message: 'ROOM IS FULL' }); return false; }
  const player = makePlayer(socket.id, name, slot, loadout, level);
  room.players.set(socket.id, player);
  if (!room.hostId) room.hostId = socket.id;
  socketRoom[socket.id] = room.code;
  socket.join(room.code);
  emitRoomState(room);
  return true;
}

io.on('connection', (socket) => {
  const currentRoom = () => rooms[socketRoom[socket.id]] || null;
  const currentPlayer = () => { const r = currentRoom(); return r ? r.players.get(socket.id) : null; };

  socket.on('joinRoom', ({ name, roomCode, loadout, level } = {}) => {
    if (currentRoom()) return;
    let room;
    if (roomCode) {
      room = rooms[String(roomCode).toUpperCase()];
      if (!room) { socket.emit('errorMsg', { message: 'NO SUCH ROOM' }); return; }
    } else { room = createRoom(false); }      // private room => personal loadouts
    joinExistingRoom(socket, name, room, loadout, level);
  });

  socket.on('quickPlay', ({ name, loadout, level } = {}) => {
    if (currentRoom()) return;
    let room = Object.values(rooms).find(r => r.balanced && r.phase === 'lobby' && r.players.size < MAX_PLAYERS);
    if (!room) room = createRoom(true);        // balanced matchmaking room
    joinExistingRoom(socket, name, room, loadout, level);
  });

  socket.on('setLoadout', ({ loadout, level } = {}) => {
    const room = currentRoom(), p = currentPlayer();
    if (!room || !p || (room.phase !== 'lobby' && room.phase !== 'countdown')) return;
    p.loadout = SHARED.sanitizeLoadout(loadout);
    if (level) p.level = Math.max(1, level | 0);
    emitRoomState(room);
  });

  socket.on('setHouseRule', ({ key, value } = {}) => {
    const room = currentRoom();
    if (!room || room.balanced || socket.id !== room.hostId) return;
    if (room.phase !== 'lobby') return;
    if (key in room.houseRules) { room.houseRules[key] = !!value; emitRoomState(room); }
  });

  socket.on('setArena', ({ arena } = {}) => {
    const room = currentRoom();
    if (!room || socket.id !== room.hostId || room.phase !== 'lobby') return;
    if (arena === 'random' || ARENAS.includes(arena)) { room.arenaPick = arena; emitRoomState(room); }
  });

  socket.on('setReady', ({ ready } = {}) => {
    const room = currentRoom(), p = currentPlayer();
    if (!room || !p || (room.phase !== 'lobby' && room.phase !== 'countdown')) return;
    p.ready = !!ready;
    emitRoomState(room);
    maybeStartCountdown(room);
  });

  socket.on('input', ({ dir } = {}) => {
    const room = currentRoom(), p = currentPlayer();
    if (!room || !p || room.phase !== 'playing' || !p.alive) return;
    if (VALID_DIRS.has(dir)) p.inputDir = dir;
  });

  socket.on('placeBomb', () => {
    const room = currentRoom(), p = currentPlayer();
    if (room && p && room.phase === 'playing' && p.alive && p.spawned) placeBomb(room, p);
  });

  socket.on('detonate', () => {     // remote bombs
    const room = currentRoom(), p = currentPlayer();
    if (!room || !p || room.phase !== 'playing' || !p.alive) return;
    for (const b of room.bombs) if (b.owner === p.id && b.remote && !b.exploding) b.triggered = true;
  });

  socket.on('useAbility', () => {
    const room = currentRoom(), p = currentPlayer();
    if (room && p && room.phase === 'playing' && p.alive && p.spawned) useAbility(room, p);
  });

  socket.on('leaveRoom', () => leave());
  socket.on('disconnect', () => leave());

  function leave() {
    const room = currentRoom();
    if (!room) return;
    const wasHost = room.hostId === socket.id;
    room.players.delete(socket.id);
    delete socketRoom[socket.id];
    socket.leave(room.code);
    if (room.players.size === 0) { destroyRoom(room); return; }
    if (wasHost) room.hostId = room.players.keys().next().value;   // reassign host
    if (room.phase === 'countdown' && !lobbyReadyToStart(room)) room.phase = 'lobby';
    emitRoomState(room);
  }
});

// Exported for the test harness (no effect on `npm start`).
module.exports = {
  startServer,
  generateMap, generateArena, simulate, detonate, addExplosion,
  ARENAS, COLS, ROWS, EMPTY, WALL, CRATE, TEMPWALL, BOMB_FUSE_TICKS,
};
