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
app.use(express.json({ limit: '64kb' }));

/* ----------------------------------------------------------------------------
 * 2b. ACCOUNTS / AUTH  (server-side persistence; passwords bcrypt-hashed)
 * --------------------------------------------------------------------------*/
const DB = require('./db.js');
const bcrypt = require('bcryptjs');
const USER_RE = /^[a-zA-Z0-9_]{3,16}$/;

function defaultProfile() {
  return {
    xp: 0, coins: 0,
    loadout: Object.assign({}, SHARED.DEFAULT_LOADOUT),
    unlocks: { bomb: [], ability: [], cls: [], hat: [] },
    stats: { wins: 0, losses: 0, kills: 0, crates: 0, matches: 0 },
  };
}
function publicAccount(u) {
  return {
    username: u.username, mmr: u.mmr, ranked_w: u.ranked_w, ranked_l: u.ranked_l,
    level: SHARED.levelFromXp(u.profile.xp || 0).level,
    profile: u.profile,
  };
}
function userFromAuth(req) {
  const h = req.headers['authorization'] || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : (req.query.token || (req.body && req.body.token));
  if (!token) return null;
  const id = DB.sessionUser(token); if (!id) return null;
  return DB.userById(id);
}

app.post('/api/register', async (req, res) => {
  const { username, password } = req.body || {};
  if (!USER_RE.test(username || '')) return res.status(400).json({ error: 'Username: 3-16 letters, numbers or _.' });
  if (typeof password !== 'string' || password.length < 6 || password.length > 100) return res.status(400).json({ error: 'Password must be 6-100 characters.' });
  try {
    const passHash = await bcrypt.hash(password, 10);
    const u = DB.createUser({ username, passHash, profile: defaultProfile() });
    res.json({ token: DB.newSession(u.id), account: publicAccount(u) });
  } catch (e) {
    if (e.code === 'DUP') return res.status(409).json({ error: 'That username is taken.' });
    res.status(500).json({ error: 'Server error.' });
  }
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  const u = DB.userByName(String(username || '').toLowerCase());
  if (!u || !(await bcrypt.compare(String(password || ''), u.pass_hash))) return res.status(401).json({ error: 'Wrong username or password.' });
  res.json({ token: DB.newSession(u.id), account: publicAccount(u) });
});

app.post('/api/logout', (req, res) => {
  const h = req.headers['authorization'] || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : (req.body && req.body.token);
  if (token) DB.endSession(token);
  res.json({ ok: true });
});

app.post('/api/change-password', async (req, res) => {
  const u = userFromAuth(req);
  if (!u) return res.status(401).json({ error: 'Not logged in.' });
  const { oldPassword, newPassword } = req.body || {};
  if (!(await bcrypt.compare(String(oldPassword || ''), u.pass_hash))) return res.status(401).json({ error: 'Current password is wrong.' });
  if (typeof newPassword !== 'string' || newPassword.length < 6 || newPassword.length > 100) return res.status(400).json({ error: 'New password must be 6-100 characters.' });
  const hash = await bcrypt.hash(newPassword, 10);
  if (DB.setPassword) DB.setPassword(u.id, hash);
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  const u = userFromAuth(req);
  if (!u) return res.status(401).json({ error: 'Not logged in.' });
  res.json({ account: publicAccount(u) });
});

// client may push cosmetic/loadout/unlock changes; xp/coins/mmr stay server-authoritative
app.post('/api/profile', (req, res) => {
  const u = userFromAuth(req);
  if (!u) return res.status(401).json({ error: 'Not logged in.' });
  const incoming = (req.body && req.body.profile) || {};
  const p = u.profile;
  if (incoming.loadout) p.loadout = SHARED.sanitizeLoadout(incoming.loadout);
  if (incoming.unlocks && typeof incoming.unlocks === 'object') {
    for (const k of ['bomb', 'ability', 'cls', 'hat']) if (Array.isArray(incoming.unlocks[k])) p.unlocks[k] = incoming.unlocks[k].slice(0, 64);
  }
  DB.saveProfile(u.id, p);
  res.json({ account: publicAccount(u) });
});

app.get('/api/leaderboard', (req, res) => {
  const rows = DB.leaderboard(50).map((u, i) => ({
    rank: i + 1, username: u.username, mmr: u.mmr, ranked_w: u.ranked_w, ranked_l: u.ranked_l,
    level: SHARED.levelFromXp((u.profile && u.profile.xp) || 0).level,
  }));
  res.json({ leaderboard: rows });
});

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

/* ---- ranked matchmaking queue (1v1, Elo). Pairs closest MMR; the wait widens
 * the acceptable gap so a match always eventually happens (small-playerbase ok). */
const rankedQueue = [];   // { socket, userId, mmr, name, joinedAt }
function dequeueRanked(socketId) {
  const i = rankedQueue.findIndex(e => e.socket.id === socketId);
  if (i >= 0) rankedQueue.splice(i, 1);
}
function startRankedMatch(a, b) {
  const room = createRoom(true, true);   // balanced + ranked
  for (const e of [a, b]) {
    const u = DB.userById(e.userId);
    const auth = u
      ? { userId: u.id, name: u.username, loadout: u.profile.loadout, level: SHARED.levelFromXp(u.profile.xp || 0).level }
      : { userId: null, name: e.name, loadout: null, level: 1 };
    joinExistingRoom(e.socket, room, auth);
    const p = room.players.get(e.socket.id);
    if (p) p.ready = true;
  }
  emitRoomState(room);
  maybeStartCountdown(room);
}
function matchmakeRanked() {
  if (rankedQueue.length < 2) return;
  rankedQueue.sort((x, y) => x.mmr - y.mmr);
  for (let i = 0; i < rankedQueue.length - 1; i++) {
    const a = rankedQueue[i], b = rankedQueue[i + 1];
    const waited = Date.now() - Math.min(a.joinedAt, b.joinedAt);
    const tol = 100 + Math.floor(waited / 1000) * 50;   // widen 50 MMR per second
    if (Math.abs(a.mmr - b.mmr) <= tol || waited > 20000) {
      rankedQueue.splice(i, 2);
      startRankedMatch(a, b);
      return matchmakeRanked();
    }
  }
}
setInterval(matchmakeRanked, 1000);

function makeRoomCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) code += letters[(Math.random() * letters.length) | 0];
  } while (rooms[code]);
  return code;
}

function createRoom(balanced, ranked) {
  const code = makeRoomCode();
  const room = {
    code,
    players: new Map(),
    phase: 'lobby',                 // lobby | countdown | playing | roundover | matchover
    balanced: !!balanced,           // quick-play = balanced; private = personal loadouts
    ranked: !!ranked,               // ranked 1v1 (Elo) vs casual
    mode: 'lbs',                    // lbs (last bomber) | zombie | ...
    hostId: null,
    houseRules: { doublePowerups: false, suddenDeath: false },
    arenaPick: 'dungeon',           // host choice ('random' allowed); resolved per round
    arena: 'dungeon',
    conveyors: {}, teleports: [], iceFloor: false, volcano: false,
    lavaWarn: [], lavaTimer: 0,
    lavaTiles: [], hazards: [], warn: [], danger: [],
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

function makePlayer(id, name, slot, loadout, level, userId) {
  return {
    id, name: (name || 'PLAYER').slice(0, 10).toUpperCase(), slot,
    color: COLORS[slot],
    userId: userId || null,        // DB account id when logged in (else guest)
    loadout: SHARED.sanitizeLoadout(loadout),
    level: Math.max(1, (level | 0) || 1),
    ready: false, spawned: false, played: false, alive: false,
    x: SPAWNS[slot][0], y: SPAWNS[slot][1],
    inputDir: 'none', moveDir: 'none', movingTo: null, facing: 'down',
    // per-round combat stats (reset each round-start of the FIRST round of a match)
    maxBombs: BASE_BOMBS, maxBombsCap: MAX_BOMBS, activeBombs: 0,
    range: BASE_RANGE, rangePenalty: 0, speed: BASE_SPEED,
    canKick: false, canThrow: false, bombPierce: false, bombRemote: false,
    armor: 0, shieldUntil: 0, phaseUntil: 0, curse: null, abilityCd: 0, tpCd: 0, infected: false,
    matchScore: 0,                       // round wins this match
    stats: { kills: 0, crates: 0, roundWins: 0 },
  };
}

function lobbyPlayer(p) {
  return {
    id: p.id, name: p.name, slot: p.slot, color: p.color,
    ready: p.ready, score: p.matchScore, alive: p.alive,
    level: p.level, loadout: p.loadout, bot: !!p.isBot,
  };
}

function emitRoomState(room) {
  io.to(room.code).emit('roomState', {
    roomCode: room.code,
    phase: room.phase,
    balanced: room.balanced,
    hostId: room.hostId,
    houseRules: room.houseRules,
    mode: room.mode,
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

// telegraphed cycling hazard over a fixed tile set (lasers / pistons / trapdoors):
// mostly safe, then `warnDur` ticks of telegraph, then `activeDur` ticks deadly.
function makeLineHazard(map, kind, idx, cycle, warnDur, activeDur, offset) {
  const tiles = [];
  if (kind === 'row') { for (let x = 1; x < COLS - 1; x++) if (map[idx][x] !== WALL) tiles.push(idx * COLS + x); }
  else { for (let y = 1; y < ROWS - 1; y++) if (map[y][idx] !== WALL) tiles.push(y * COLS + idx); }
  return { tiles, cycle, warnDur, activeDur, offset };
}

// Each arena gets a DISTINCT wall-layout generator (not the same pillar grid),
// its own crate density, signature mechanic, and telegraphed hazards.
function generateArena(arena, variant) {
  const prot = cornerProtected();
  const cfg = { map: null, conveyors: {}, teleports: [], iceFloor: false, volcano: false, lavaTiles: [], hazards: [] };
  let map;

  if (arena === 'neon') {
    // Neon Circuit — very open, almost no walls; pulsing laser grids.
    map = blankMap(false);
    for (const [x, y] of (variant ? [[6, 2], [6, 8], [2, 5], [10, 5]] : [[3, 3], [9, 3], [3, 7], [9, 7]])) map[y][x] = WALL;
    scatterCrates(map, 0.22, prot);
    cfg.hazards.push(makeLineHazard(map, 'row', 3, 96, 20, 16, 0));
    cfg.hazards.push(makeLineHazard(map, 'row', 7, 96, 20, 16, 48));
    cfg.hazards.push(makeLineHazard(map, 'col', 6, 120, 22, 16, 30));

  } else if (arena === 'ice') {
    // Frostbite Lake — sparse pillars, wide open, slippery floor + long sightlines.
    map = blankMap(false);
    for (const [x, y] of (variant ? [[4, 4], [8, 4], [4, 6], [8, 6]] : [[6, 2], [2, 6], [10, 6], [6, 8], [6, 5]])) map[y][x] = WALL;
    scatterCrates(map, 0.34, prot);
    cfg.iceFloor = true;

  } else if (arena === 'volcano') {
    // Magma Foundry — asymmetric, split by an impassable lava channel with bridges.
    map = blankMap(true);
    const col = variant ? 4 : 8;
    const bridges = new Set([2, Math.floor(ROWS / 2), ROWS - 3]);
    for (let y = 1; y < ROWS - 1; y++) {
      if (bridges.has(y) || prot.has(y * COLS + col)) continue;
      map[y][col] = WALL; cfg.lavaTiles.push(y * COLS + col);
    }
    scatterCrates(map, 0.58, prot);
    cfg.volcano = true;

  } else if (arena === 'factory') {
    // Gearworks — conveyor belts thread the grid; piston crushers slam on a beat.
    map = blankMap(true);
    const lanes = variant
      ? [{ row: 5, dir: 'right' }, { col: 3, dir: 'down' }, { col: 9, dir: 'up' }]
      : [{ row: 3, dir: 'left' }, { row: 7, dir: 'right' }, { col: 6, dir: 'down' }];
    for (const l of lanes) {
      if (l.row != null) { for (let x = 1; x < COLS - 1; x++) if (map[l.row][x] !== WALL) { map[l.row][x] = EMPTY; cfg.conveyors[l.row * COLS + x] = l.dir; } }
      else { for (let y = 1; y < ROWS - 1; y++) if (map[y][l.col] !== WALL) { map[y][l.col] = EMPTY; cfg.conveyors[y * COLS + l.col] = l.dir; } }
    }
    scatterCrates(map, 0.58, prot);
    for (const [x, y] of (variant ? [[5, 3], [7, 7], [9, 5]] : [[3, 5], [5, 7], [9, 3]]))
      if (map[y][x] !== WALL) { map[y][x] = EMPTY; cfg.hazards.push({ tiles: [y * COLS + x], cycle: 78, warnDur: 16, activeDur: 12, offset: (x * 7 + y * 13) % 78 }); }

  } else if (arena === 'manor') {
    // Hollow Manor — partitioned rooms joined by doorways; teleporters + trapdoors.
    map = blankMap(true);
    for (let x = 1; x < COLS - 1; x++) if (x % 4 !== 0 && !prot.has(5 * COLS + x)) map[5][x] = WALL;       // h-divider w/ doors
    for (let y = 1; y < ROWS - 1; y++) if (y % 3 !== 0 && !prot.has(y * COLS + 6)) map[y][6] = WALL;       // v-divider w/ doors
    map[5][6] = EMPTY;
    scatterCrates(map, 0.48, prot);
    const pairs = variant
      ? [[[3, 1], [COLS - 4, ROWS - 2]], [[1, ROWS - 4], [COLS - 2, 3]]]
      : [[[5, 1], [7, ROWS - 2]], [[1, 5], [COLS - 2, 5]]];
    for (const [[ax, ay], [bx, by]] of pairs) {
      map[ay][ax] = EMPTY; map[by][bx] = EMPTY;
      cfg.teleports.push({ x: ax, y: ay, tx: bx, ty: by }, { x: bx, y: by, tx: ax, ty: ay });
    }
    for (const [x, y] of (variant ? [[3, 3], [9, 7], [9, 3]] : [[3, 7], [9, 3], [5, 5]]))
      if (map[y][x] !== WALL) { map[y][x] = EMPTY; cfg.hazards.push({ tiles: [y * COLS + x], cycle: 126, warnDur: 24, activeDur: 20, offset: (x * 5 + y * 9) % 126 }); }

  } else {
    // Crypt of Echoes (default) — dense pillar maze of tight corridors.
    map = blankMap(true);
    for (let y = 1; y < ROWS - 1; y++)
      for (let x = 1; x < COLS - 1; x++) {
        if (map[y][x] !== EMPTY || prot.has(y * COLS + x)) continue;
        if (x % 2 === 1 && y % 2 === 1 && Math.random() < (variant ? 0.18 : 0.12)) map[y][x] = WALL;
      }
    scatterCrates(map, 0.72, prot);
  }

  cfg.map = map;
  return cfg;
}
function teleportAt(room, x, y) { return room.teleports.find(t => t.x === x && t.y === y); }

/* ----------------------------------------------------------------------------
 * 4b. AI BOTS  (server-side players; obey the same rules, never cheat)
 * --------------------------------------------------------------------------*/
const BOT_DIFF = {
  easy:   { thinkEvery: 9, mistake: 0.30, escape: false, powerups: false, seek: false, dash: false },
  normal: { thinkEvery: 6, mistake: 0.10, escape: true,  powerups: true,  seek: true,  dash: false },
  hard:   { thinkEvery: 3, mistake: 0.00, escape: true,  powerups: true,  seek: true,  dash: true },
};
let botSeq = 1;
const inB = (x, y) => x >= 0 && y >= 0 && x < COLS && y < ROWS;
const idxOf = (x, y) => y * COLS + x;

function makeBotPlayer(slot, difficulty) {
  const clss = ['bomber', 'speedster', 'tank', 'trickster'];
  const p = makePlayer('bot_' + (botSeq++), 'BOT ' + difficulty[0].toUpperCase(), slot,
    { bomb: 'classic', ability: 'dash', cls: clss[(Math.random() * clss.length) | 0], hat: 'none' }, 1, null);
  p.isBot = true; p.difficulty = (BOT_DIFF[difficulty] ? difficulty : 'normal'); p.thinkCd = 0; p.ready = true;
  return p;
}

// tiles a bomb would hit (cross blocked by walls; stops on first crate/tempwall)
function blastTilesFor(room, bx, by, range) {
  const s = new Set([idxOf(bx, by)]);
  for (const dir of Object.keys(DIRV)) {
    const [dx, dy] = DIRV[dir];
    for (let r = 1; r <= range; r++) {
      const x = bx + dx * r, y = by + dy * r;
      if (!inB(x, y)) break;
      const t = room.map[y][x];
      if (t === WALL) break;
      s.add(idxOf(x, y));
      if (t === CRATE || t === TEMPWALL) break;
    }
  }
  return s;
}
// set of unsafe tiles: live flame + arena danger (+ future bomb blasts if `future`)
function dangerSet(room, future) {
  const s = new Set();
  for (const e of room.explosions) s.add(idxOf(e.x, e.y));
  for (const idx of room.danger) s.add(idx);
  if (future) for (const b of room.bombs) for (const i of blastTilesFor(room, b.x, b.y, b.range)) s.add(i);
  return s;
}
function botWalkable(room, x, y) {
  if (!inB(x, y)) return false;
  const t = room.map[y][x];
  if (t === WALL || t === CRATE || t === TEMPWALL) return false;
  if (bombAt(room, x, y)) return false;
  return true;
}
// team awareness: in zombie, only infected may attack uninfected (survivors don't attack)
function botCanAttack(self, other, room) {
  if (room.mode === 'zombie') return self.infected ? !other.infected : false;
  return true;
}
function enemyAt(room, x, y, self) {
  for (const p of room.players.values())
    if (p !== self && p.spawned && p.alive && botCanAttack(self, p, room) && Math.round(p.x) === x && Math.round(p.y) === y) return true;
  return false;
}
function nearestEnemy(room, self, sx, sy) {
  let best = null, bd = 1e9;
  for (const p of room.players.values()) {
    if (p === self || !(p.spawned && p.alive) || !botCanAttack(self, p, room)) continue;
    const d = Math.abs(Math.round(p.x) - sx) + Math.abs(Math.round(p.y) - sy);
    if (d < bd) { bd = d; best = { x: Math.round(p.x), y: Math.round(p.y) }; }
  }
  return best;
}
// route toward a target treating CRATES AS PASSABLE (so bots commit to a heading
// and blast through breakable walls); returns the first-step direction.
function routeThroughCrates(room, sx, sy, tx, ty, realDanger) {
  const start = idxOf(sx, sy), prev = new Map([[start, -1]]), q = [[sx, sy]];
  let found = null;
  while (q.length) {
    const [x, y] = q.shift();
    if (x === tx && y === ty) { found = idxOf(x, y); break; }
    for (const d of ['up', 'down', 'left', 'right']) {
      const [dx, dy] = DIRV[d], nx = x + dx, ny = y + dy, ni = idxOf(nx, ny);
      if (!inB(nx, ny) || prev.has(ni)) continue;
      const t = room.map[ny][nx];
      if (t === WALL || t === TEMPWALL || bombAt(room, nx, ny) || realDanger.has(ni)) continue;
      prev.set(ni, idxOf(x, y)); q.push([nx, ny]);
    }
  }
  if (found == null) return null;
  if (found === start) return 'none';
  let cur = found; while (prev.get(cur) !== start) cur = prev.get(cur);
  const cx = cur % COLS, cy = (cur / COLS) | 0;
  if (cx - sx === 1) return 'right'; if (cx - sx === -1) return 'left';
  if (cy - sy === 1) return 'down'; if (cy - sy === -1) return 'up';
  return 'none';
}
// BFS from (sx,sy); returns first-step dir toward nearest tile where goal() is true
// (or 'none' if already there, or null if unreachable). `avoid` = tiles not to enter.
function botBFS(room, sx, sy, goal, avoid) {
  const start = idxOf(sx, sy), prev = new Map([[start, -1]]), q = [[sx, sy]];
  let found = null;
  while (q.length) {
    const [x, y] = q.shift();
    if (goal(x, y, idxOf(x, y))) { found = idxOf(x, y); break; }
    for (const d of ['up', 'down', 'left', 'right']) {
      const [dx, dy] = DIRV[d], nx = x + dx, ny = y + dy, ni = idxOf(nx, ny);
      if (prev.has(ni) || !botWalkable(room, nx, ny) || (avoid && avoid.has(ni))) continue;
      prev.set(ni, idxOf(x, y)); q.push([nx, ny]);
    }
  }
  if (found == null) return null;
  if (found === start) return 'none';
  let cur = found;
  while (prev.get(cur) !== start) cur = prev.get(cur);
  const cx = cur % COLS, cy = (cur / COLS) | 0;
  if (cx - sx === 1) return 'right'; if (cx - sx === -1) return 'left';
  if (cy - sy === 1) return 'down'; if (cy - sy === -1) return 'up';
  return 'none';
}
// Can the bot reach a tile OUTSIDE its bomb's blast before it detonates?
// The escape path may cross the bomb's own (not-yet-lethal) blast tiles; it must
// only avoid CURRENT flame (realDanger).
function botCanEscapeAfterBomb(room, bot, bx, by, realDanger) {
  const blast = blastTilesFor(room, bx, by, Math.max(1, bot.range));
  const future = dangerSet(room, true);
  for (const i of blast) future.add(i);
  return botBFS(room, bx, by, (x, y, i) => !future.has(i), realDanger) !== null;
}
function botThink(bot, room) {
  if (bot.thinkCd > 0) { bot.thinkCd--; return; }
  if (bot.movingTo) return;                 // decide only when grid-aligned
  const D = BOT_DIFF[bot.difficulty] || BOT_DIFF.normal;
  bot.thinkCd = D.thinkEvery;
  const bx = Math.round(bot.x), by = Math.round(bot.y);
  const realDanger = dangerSet(room, false);  // current flame/hazard -> never enter
  const future = dangerSet(room, true);       // + soon-to-blast -> get out of these
  // zombie survivors steer clear of the infected
  if (room.mode === 'zombie' && !bot.infected) {
    for (const p of room.players.values()) if (p.spawned && p.alive && p.infected) future.add(idxOf(Math.round(p.x), Math.round(p.y)));
  }

  const dirs = ['up', 'down', 'left', 'right'];
  // 1) flee if our tile is (or will soon be) dangerous: path out via current-safe tiles
  if (future.has(idxOf(bx, by))) {
    const dir = botBFS(room, bx, by, (x, y, i) => !future.has(i), realDanger);
    if (dir && dir !== 'none') {
      bot.inputDir = dir; bot.facing = dir;
      if (D.dash && bot.loadout.ability === 'dash' && bot.abilityCd <= 0 && Math.random() < 0.6) useAbility(room, bot);
      return;
    }
  }
  if (Math.random() < D.mistake) { bot.inputDir = dirs.concat('none')[(Math.random() * 5) | 0]; return; }

  // 2) bomb an adjacent enemy or crate, only if an escape exists (normal/hard)
  const adjEnemy = dirs.some(d => { const [dx, dy] = DIRV[d]; return enemyAt(room, bx + dx, by + dy, bot); });
  const adjCrate = dirs.some(d => { const [dx, dy] = DIRV[d]; const x = bx + dx, y = by + dy; return inB(x, y) && room.map[y][x] === CRATE; });
  if ((adjEnemy || adjCrate) && bot.activeBombs < bot.maxBombs && !bombAt(room, bx, by)) {
    if (!D.escape || botCanEscapeAfterBomb(room, bot, bx, by, realDanger)) {
      placeBomb(room, bot);
      const f2 = dangerSet(room, true);
      const dir = botBFS(room, bx, by, (x, y, i) => !f2.has(i), realDanger);
      bot.inputDir = (dir && dir !== 'none') ? dir : dirs[(Math.random() * 4) | 0];
      return;
    }
  }
  // 3) grab a nearby power-up if one is cleanly reachable (avoid future-blast tiles)
  if (D.powerups && room.powerups.length) {
    const dir = botBFS(room, bx, by, (x, y) => room.powerups.some(p => p.x === x && p.y === y), future);
    if (dir && dir !== 'none') { bot.inputDir = dir; return; }
  }
  // 4) HUNT: march toward the nearest enemy, blasting crates that block the way
  const enemy = nearestEnemy(room, bot, bx, by);
  if (enemy) {
    const dir = routeThroughCrates(room, bx, by, enemy.x, enemy.y, realDanger);
    if (dir && dir !== 'none') {
      const [dx, dy] = DIRV[dir], nx = bx + dx, ny = by + dy;
      if (room.map[ny][nx] === CRATE) {
        if (bot.activeBombs < bot.maxBombs && !bombAt(room, bx, by) && (!D.escape || botCanEscapeAfterBomb(room, bot, bx, by, realDanger))) {
          placeBomb(room, bot);
          const f2 = dangerSet(room, true);
          const fd = botBFS(room, bx, by, (x, y, i) => !f2.has(i), realDanger);
          bot.inputDir = (fd && fd !== 'none') ? fd : dirs[(Math.random() * 4) | 0];
          return;
        }
      } else if (!future.has(idxOf(nx, ny))) { bot.inputDir = dir; return; }
    }
  }
  // 5) wander to a current-safe neighbour
  const opts = dirs.filter(d => { const [dx, dy] = DIRV[d]; const nx = bx + dx, ny = by + dy; return botWalkable(room, nx, ny) && !realDanger.has(idxOf(nx, ny)); });
  bot.inputDir = opts.length ? opts[(Math.random() * opts.length) | 0] : 'none';
}

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
  // cycling telegraphed hazards (lasers / pistons / trapdoors)
  room.warn = []; room.danger = [];
  for (const h of room.hazards) {
    const t = (room.tick + h.offset) % h.cycle;
    const activeStart = h.cycle - h.activeDur;
    const warnStart = activeStart - h.warnDur;
    if (t >= activeStart) { for (const idx of h.tiles) room.danger.push(idx); }
    else if (t >= warnStart) { for (const idx of h.tiles) room.warn.push(idx); }
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

  // AI bots decide their inputs (same rules as humans)
  for (const p of room.players.values()) if (p.isBot && p.spawned && p.alive) botThink(p, room);

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
  for (const idx of room.danger) if (!flame.has(idx)) flame.set(idx, null);   // arena hazards (no kill credit)
  for (const p of room.players.values()) {
    if (!(p.spawned && p.alive)) continue;
    if (room.mode === 'zombie' && p.infected) continue;     // zombies are immune to flame
    const key = Math.round(p.y) * COLS + Math.round(p.x);
    if (!flame.has(key)) continue;
    if (room.tick < p.shieldUntil) continue;
    if (p.armor > 0) { p.armor--; p.shieldUntil = room.tick + ARMOR_IFRAMES; continue; }
    if (room.mode === 'zombie') { p.infected = true; continue; }   // infected, not killed
    p.alive = false;
    const killerId = flame.get(key);
    if (killerId && killerId !== p.id) {
      const k = room.players.get(killerId);
      if (k) k.stats.kills++;
    }
  }

  // win detection (mode-aware)
  const inGame = [...room.players.values()].filter(p => p.spawned);
  if (room.mode === 'zombie') {
    const clean = inGame.filter(p => p.alive && !p.infected);   // last uninfected survivor wins
    if (inGame.length >= 1 && clean.length <= 1) setRoundOver(room, clean.length === 1 ? clean[0] : null);
  } else {
    const alive = inGame.filter(p => p.alive);
    if (inGame.length >= 1 && alive.length <= 1) setRoundOver(room, alive.length === 1 ? alive[0] : null);
  }
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
  room.lavaTiles = cfg.lavaTiles; room.hazards = cfg.hazards; room.warn = []; room.danger = [];

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
    p.armor = 0; p.shieldUntil = 0; p.phaseUntil = 0; p.curse = null; p.abilityCd = 0; p.infected = false;
    applyClass(p);
    spawns.push({ slot: p.slot, x: sx, y: sy });
  }

  // Zombie mode: one random player starts infected
  if (room.mode === 'zombie') {
    const ps = [...room.players.values()].filter(p => p.spawned);
    if (ps.length) ps[(Math.random() * ps.length) | 0].infected = true;
  }

  room.phase = 'playing';
  io.to(room.code).emit('gameStart', {
    map: room.map, spawns,
    balanced: room.balanced,
    mode: room.mode,
    arena: room.arena,
    conveyors: room.conveyors, teleports: room.teleports, iceFloor: room.iceFloor,
    lavaTiles: room.lavaTiles,
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

  // ranked 1v1 Elo update (server-authoritative; both must be logged in)
  let elo = null;
  if (room.ranked && winner && winner.userId) {
    const ps = [...room.players.values()].filter(p => p.played && p.userId);
    if (ps.length === 2) {
      const a = DB.userById(ps[0].userId), b = DB.userById(ps[1].userId);
      if (a && b && a.id !== b.id) {
        const wA = winner.userId === a.id, K = 32;
        const Ea = 1 / (1 + Math.pow(10, (b.mmr - a.mmr) / 400));
        const Ra2 = Math.round(a.mmr + K * ((wA ? 1 : 0) - Ea));
        const Rb2 = Math.round(b.mmr + K * ((wA ? 0 : 1) - (1 - Ea)));
        DB.setMMR(a.id, Ra2, wA); DB.setMMR(b.id, Rb2, !wA);
        elo = { [a.id]: { before: a.mmr, after: Ra2 }, [b.id]: { before: b.mmr, after: Rb2 } };
      }
    }
  }

  const results = [];
  for (const p of room.players.values()) {
    if (!p.played) continue;
    const won = winner && winner.id === p.id;
    const s = p.stats;
    const xp = s.crates * XP.crate + s.kills * XP.kill + s.roundWins * XP.roundWin + (won ? XP.matchWin + XP.placement : 0);
    const coins = s.crates * CO.crate + s.kills * CO.kill + s.roundWins * CO.roundWin + (won ? CO.matchWin : 0) + CO.participate;
    const r = {
      id: p.id, slot: p.slot, name: p.name, color: p.color, won, xp, coins,
      breakdown: { crates: s.crates, kills: s.kills, roundWins: s.roundWins, won }, saved: false,
    };
    // persist to the DB for logged-in accounts (XP/coins/stats are server-authoritative)
    if (p.userId) {
      const u = DB.userById(p.userId);
      if (u) {
        u.profile.xp = (u.profile.xp || 0) + xp;
        u.profile.coins = (u.profile.coins || 0) + coins;
        const st = u.profile.stats || (u.profile.stats = { wins: 0, losses: 0, kills: 0, crates: 0, matches: 0 });
        st.matches++; st.kills += s.kills; st.crates += s.crates; if (won) st.wins++; else st.losses++;
        DB.saveProfile(u.id, u.profile);
        r.saved = true;
        r.level = SHARED.levelFromXp(u.profile.xp).level;
        if (elo && elo[u.id]) { r.mmrBefore = elo[u.id].before; r.mmrAfter = elo[u.id].after; r.mmrDelta = elo[u.id].after - elo[u.id].before; }
      }
    }
    results.push(r);
  }
  io.to(room.code).emit('matchOver', {
    winnerId: winner ? winner.id : null,
    winnerName: winner ? winner.name : null,
    winnerSlot: winner ? winner.slot : null,
    ranked: !!room.ranked,
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
      mb: p.maxBombs, ab: p.activeBombs, rg: p.range, z: p.infected ? 1 : 0,
      k: (p.canKick ? 1 : 0) | (p.canThrow ? 2 : 0) | (p.bombRemote ? 4 : 0) | (p.bombPierce ? 8 : 0),
    })),
    bombs: room.bombs.map(b => ({ id: b.id, x: b.x, y: b.y, f: b.fuse === Infinity ? -1 : b.fuse, t: b.type, m: b.mine ? (b.armed ? 2 : 1) : 0 })),
    explosions: room.explosions.map(e => e.y * COLS + e.x),
    nb: room.newBursts,
    powerups: room.powerups.map(p => ({ id: p.id, x: p.x, y: p.y, t: p.t, c: p.curse ? 1 : 0 })),
    crates, walls2,
    frozen: room.frozen.map(f => f.y * COLS + f.x),
    decoys: room.decoys.map(d => ({ x: d.x, y: d.y, i: d.slot })),
    lava: room.lavaWarn.map(w => w.y * COLS + w.x),
    warn: room.warn,
    danger: room.danger,
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
// Resolve a session token to a logged-in account; logged-in players use their
// server-side name/loadout/level (can't be spoofed). Guests use client values.
function resolveAuth({ token, name, loadout, level }) {
  if (token) {
    const id = DB.sessionUser(token);
    if (id) {
      const u = DB.userById(id);
      if (u) return { userId: u.id, name: u.username, loadout: u.profile.loadout, level: SHARED.levelFromXp(u.profile.xp || 0).level };
    }
  }
  return { userId: null, name, loadout, level };
}

function joinExistingRoom(socket, room, auth) {
  const slot = freeSlot(room);
  if (slot < 0) { socket.emit('errorMsg', { message: 'ROOM IS FULL' }); return false; }
  const player = makePlayer(socket.id, auth.name, slot, auth.loadout, auth.level, auth.userId);
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

  socket.on('joinRoom', ({ name, roomCode, loadout, level, token } = {}) => {
    if (currentRoom()) return;
    let room;
    if (roomCode) {
      room = rooms[String(roomCode).toUpperCase()];
      if (!room) { socket.emit('errorMsg', { message: 'NO SUCH ROOM' }); return; }
    } else { room = createRoom(false); }      // private room => personal loadouts
    joinExistingRoom(socket, room, resolveAuth({ token, name, loadout, level }));
  });

  socket.on('quickPlay', ({ name, loadout, level, token } = {}) => {
    if (currentRoom()) return;
    let room = Object.values(rooms).find(r => r.balanced && !r.ranked && r.phase === 'lobby' && r.players.size < MAX_PLAYERS);
    if (!room) room = createRoom(true);        // balanced matchmaking room
    joinExistingRoom(socket, room, resolveAuth({ token, name, loadout, level }));
  });

  socket.on('setLoadout', ({ loadout, level } = {}) => {
    const room = currentRoom(), p = currentPlayer();
    if (!room || !p || (room.phase !== 'lobby' && room.phase !== 'countdown')) return;
    p.loadout = SHARED.sanitizeLoadout(loadout);
    if (level) p.level = Math.max(1, level | 0);
    emitRoomState(room);
  });

  socket.on('rankedQueue', ({ token } = {}) => {
    if (currentRoom()) return;
    const id = token && DB.sessionUser(token);
    const u = id && DB.userById(id);
    if (!u) { socket.emit('errorMsg', { message: 'RANKED NEEDS AN ACCOUNT' }); return; }
    if (rankedQueue.some(e => e.socket.id === socket.id)) return;
    rankedQueue.push({ socket, userId: u.id, mmr: u.mmr, name: u.username, joinedAt: Date.now() });
    socket.emit('rankedStatus', { queued: true, size: rankedQueue.length });
    matchmakeRanked();
  });
  socket.on('cancelRanked', () => { dequeueRanked(socket.id); socket.emit('rankedStatus', { queued: false, size: rankedQueue.length }); });

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

  socket.on('setMode', ({ mode } = {}) => {
    const room = currentRoom();
    if (!room || socket.id !== room.hostId || room.ranked || room.phase !== 'lobby') return;
    if (mode === 'lbs' || mode === 'zombie') { room.mode = mode; emitRoomState(room); }
  });

  socket.on('addBot', ({ difficulty } = {}) => {
    const room = currentRoom();
    if (!room || socket.id !== room.hostId || room.ranked || room.phase !== 'lobby') return;
    const slot = freeSlot(room);
    if (slot < 0) return;
    const bot = makeBotPlayer(slot, BOT_DIFF[difficulty] ? difficulty : 'normal');
    room.players.set(bot.id, bot);
    emitRoomState(room); maybeStartCountdown(room);
  });
  socket.on('removeBot', () => {
    const room = currentRoom();
    if (!room || socket.id !== room.hostId || room.phase !== 'lobby') return;
    const bots = [...room.players.values()].filter(p => p.isBot);
    if (bots.length) { room.players.delete(bots[bots.length - 1].id); emitRoomState(room); }
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
    dequeueRanked(socket.id);              // drop from ranked queue if waiting
    const room = currentRoom();
    if (!room) return;
    const wasHost = room.hostId === socket.id;
    room.players.delete(socket.id);
    delete socketRoom[socket.id];
    socket.leave(room.code);
    const humans = [...room.players.values()].filter(p => !p.isBot);
    if (humans.length === 0) { destroyRoom(room); return; }         // no humans -> close (drops bots)
    if (wasHost) room.hostId = humans[0].id;                        // reassign host to a human
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
