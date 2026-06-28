/* =============================================================================
 * BOMB ARENA - client (V2: progression + loadouts)
 *   Still "dumb": renders the latest server snapshot and forwards inputs +
 *   the chosen loadout. Persists a per-device profile in localStorage.
 *   Systems:
 *     1. constants + shared catalog       6. collection / loadout screen
 *     2. palette + canvas                 7. lobby rendering
 *     3. WebAudio SFX                     8. input (keys + touch + ability)
 *     4. localStorage profile             9. rendering
 *     5. socket wiring + screens         10. post-match XP screen
 * ===========================================================================*/

'use strict';

/* ---- 1. constants + shared -------------------------------------------- */
const SHARED = window.SHARED;

// Where the multiplayer server lives. Web builds connect to their own origin;
// native (Electron/Capacitor) builds load from file://|capacitor:// and need a
// hosted URL. Order: saved Settings value > native default > same-origin.
const DEFAULT_SERVER_URL = '';   // <-- baked default for native apps (Render URL)
function resolveServerUrl() {
  try { const s = localStorage.getItem('bombArenaServer'); if (s) return s; } catch (e) {}
  if (location.protocol === 'http:' || location.protocol === 'https:') return ''; // same-origin
  return DEFAULT_SERVER_URL;      // file:// / capacitor:// -> use baked default
}
const SERVER_URL = resolveServerUrl();
const COLS = 13, ROWS = 11;
const TILE = 32, PX = 2;
const COLORS = ['#fcfcfc', '#e84040', '#5878fc', '#48b048'];

/* ---- 2. palette + canvas --------------------------------------------- */
const PAL = {
  bg: '#0b0b16', floorA: '#161628', floorB: '#12121f',
  wall: '#7c7c7c', wallLit: '#bcbcbc', wallDark: '#3a3a52',
  crate: '#a05a2c', crateLit: '#c87f3e', crateDark: '#6e3c18',
  bomb: '#101018', bombLit: '#50506a', fuse: '#fcc800',
  flameCore: '#fcfc54', flameMid: '#fc9838', flameEdge: '#e84040',
  ice: '#7ad0fc', iceDark: '#3a6ea0', temp: '#5a7a9a', tempLit: '#8aa8c8',
  text: '#fcfcfc',
};
// Per-arena themes: palette overrides + ambient style + explosion colors.
const THEMES = {
  dungeon: { name: 'DUNGEON', bg: '#0b0b16', floorA: '#161628', floorB: '#12121f', wall: '#7c7c7c', wallLit: '#bcbcbc', wallDark: '#3a3a52', flameCore: '#fcfc54', flameMid: '#fc9838', flameEdge: '#e84040', ambient: 'dust' },
  neon:    { name: 'NEON GRID', bg: '#04040c', floorA: '#0a0a1e', floorB: '#08081a', wall: '#2050a0', wallLit: '#54a0fc', wallDark: '#102040', flameCore: '#affcff', flameMid: '#54fcfc', flameEdge: '#5878fc', ambient: 'grid' },
  ice:     { name: 'ICE CAVERN', bg: '#081420', floorA: '#1a3a52', floorB: '#163046', wall: '#6aa8d8', wallLit: '#b8e4fc', wallDark: '#244a66', flameCore: '#ffffff', flameMid: '#aff0ff', flameEdge: '#54c0fc', ambient: 'snow' },
  volcano: { name: 'VOLCANO', bg: '#1a0808', floorA: '#3a1810', floorB: '#2e120c', wall: '#7a3a2a', wallLit: '#c87850', wallDark: '#421c10', flameCore: '#fcfc54', flameMid: '#fc6018', flameEdge: '#e02000', ambient: 'embers' },
  factory: { name: 'FACTORY', bg: '#0e1014', floorA: '#22262e', floorB: '#1c2028', wall: '#586068', wallLit: '#98a0a8', wallDark: '#2a2e34', flameCore: '#fcfc54', flameMid: '#fcc800', flameEdge: '#fc6018', ambient: 'spark' },
  manor:   { name: 'HAUNTED MANOR', bg: '#0c0814', floorA: '#1e1630', floorB: '#181226', wall: '#4a3a5a', wallLit: '#8a6aa8', wallDark: '#281e36', flameCore: '#d8fcd8', flameMid: '#a060f0', flameEdge: '#7020c0', ambient: 'fog' },
};
function setTheme(a) {
  curTheme = THEMES[a] || THEMES.dungeon;
  ambient = [];
  const kind = curTheme.ambient;
  const n = (kind === 'snow' || kind === 'embers' || kind === 'fog') ? 40 : (kind === 'dust' ? 18 : 0);
  for (let i = 0; i < n; i++) ambient.push({ x: Math.random() * 416, y: Math.random() * 352, v: 0.3 + Math.random() * 1.2, s: 1 + (Math.random() * 2 | 0) });
}

const canvas = document.getElementById('game-canvas');
const ctx = canvas.getContext('2d');
ctx.imageSmoothingEnabled = false;

/* ---- 3. WEBAUDIO SFX -------------------------------------------------- */
let actx = null;
function ensureAudio() {
  if (!actx) { const AC = window.AudioContext || window.webkitAudioContext; if (AC) actx = new AC(); }
  if (actx && actx.state === 'suspended') actx.resume();
}
function note(freq, start, dur, vol, type) {
  const t0 = actx.currentTime + start;
  const osc = actx.createOscillator(), gain = actx.createGain();
  osc.type = type || 'square';
  osc.frequency.setValueAtTime(freq, t0);
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(vol, t0 + 0.005);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(gain).connect(actx.destination);
  osc.start(t0); osc.stop(t0 + dur + 0.02);
}
function sfx(name) {
  if (!actx) return;
  switch (name) {
    case 'place': note(180, 0, 0.07, 0.18); note(120, 0.05, 0.07, 0.14); break;
    case 'explode': note(90, 0, 0.18, 0.22, 'sawtooth'); note(60, 0.04, 0.22, 0.2); note(200, 0, 0.06, 0.12); break;
    case 'pickup': note(660, 0, 0.06, 0.16); note(880, 0.06, 0.08, 0.16); note(1320, 0.13, 0.08, 0.14); break;
    case 'curse': note(300, 0, 0.1, 0.18, 'sawtooth'); note(160, 0.1, 0.18, 0.18, 'sawtooth'); break;
    case 'death': note(440, 0, 0.1, 0.2); note(300, 0.1, 0.1, 0.2); note(150, 0.2, 0.18, 0.2); break;
    case 'win': [523, 659, 784, 1046].forEach((f, i) => note(f, i * 0.09, 0.12, 0.18)); break;
    case 'ability': note(520, 0, 0.06, 0.16); note(780, 0.05, 0.08, 0.14); break;
    case 'dash': note(900, 0, 0.05, 0.14); note(1300, 0.04, 0.05, 0.12); break;
    case 'levelup': [523, 659, 784, 1046, 1318].forEach((f, i) => note(f, i * 0.08, 0.14, 0.2)); break;
    case 'count': note(660, 0, 0.08, 0.14); break;
    case 'go': note(880, 0, 0.18, 0.18); break;
    case 'coin': note(1046, 0, 0.05, 0.12); note(1318, 0.05, 0.06, 0.12); break;
  }
}

/* ---- 4. localStorage profile ----------------------------------------- */
const PKEY = 'bombArenaProfile';
function defaultProfile() {
  return {
    name: '', xp: 0, coins: 0,
    loadout: Object.assign({}, SHARED.DEFAULT_LOADOUT),
    unlocks: { bomb: [], ability: [], cls: [], hat: [] },   // purchased (Phase 2 shop)
    stats: { wins: 0, losses: 0, kills: 0, crates: 0, matches: 0 },
    daily: null,
  };
}
let profile = loadProfile();
function loadProfile() {
  try {
    const p = JSON.parse(localStorage.getItem(PKEY));
    if (!p || typeof p !== 'object') return defaultProfile();
    const d = defaultProfile();
    return Object.assign(d, p, {
      loadout: SHARED.sanitizeLoadout(p.loadout),
      unlocks: Object.assign(d.unlocks, p.unlocks || {}),
      stats: Object.assign(d.stats, p.stats || {}),
    });
  } catch (e) { return defaultProfile(); }
}
function saveProfile() { try { localStorage.setItem(PKEY, JSON.stringify(profile)); } catch (e) {} }
function myLevel() { return SHARED.levelFromXp(profile.xp).level; }
const CAT_TABLE = { bomb: 'BOMB_TYPES', ability: 'ABILITIES', cls: 'CLASSES', hat: 'COSMETICS' };
function isUnlocked(cat, id) {
  const def = SHARED[CAT_TABLE[cat]][id];
  if (!def) return false;
  return myLevel() >= def.unlock || (profile.unlocks[cat] || []).includes(id);
}
// apply match rewards, return {newly, before, after, gainedXp, gainedCoins}
function addRewards(mine) {
  const before = myLevel();
  profile.xp += mine.xp; profile.coins += mine.coins;
  profile.stats.matches++;
  if (mine.won) profile.stats.wins++; else profile.stats.losses++;
  profile.stats.kills += mine.breakdown.kills;
  profile.stats.crates += mine.breakdown.crates;
  const after = SHARED.levelFromXp(profile.xp).level;
  saveProfile();
  const newly = [];
  if (after > before) {
    for (const cat of Object.keys(CAT_TABLE)) {
      for (const [id, def] of Object.entries(SHARED[CAT_TABLE[cat]]))
        if (def.unlock > before && def.unlock <= after) newly.push(def.name);
    }
  }
  return { newly, before, after, gainedXp: mine.xp, gainedCoins: mine.coins };
}

/* ---- 5. socket + screens --------------------------------------------- */
const socket = SERVER_URL ? io(SERVER_URL, { transports: ['websocket'] }) : io();
let myId = null, mySlot = null;
let mapGrid = null, snapshot = null, phase = 'landing';
let roster = [];                 // lobby/scoreboard rows
let meta = {};                   // slot -> {name,color,level,loadout}
let balanced = false, hostId = null, houseRules = {}, matchWins = 3;
let arenaPick = 'dungeon', arenaList = [];
let arena = 'dungeon', conveyors = {}, teleports = [], iceFloor = false, lavaTiles = [];
let curTheme = null, ambient = [];
let seenBombs = new Set(), prevPU = new Map(), prevAlive = {}, prevCurse = {};

const $ = id => document.getElementById(id);
const screens = { landing: $('landing'), settings: $('settings'), collection: $('collection'), lobby: $('lobby'), game: $('game') };
function showScreen(name) { for (const k in screens) screens[k].classList.toggle('hidden', k !== name); }

socket.on('connect', () => { myId = socket.id; });
socket.on('errorMsg', ({ message }) => { $('landingMsg').textContent = message || 'ERROR'; });

socket.on('roomState', (st) => {
  balanced = st.balanced; hostId = st.hostId; houseRules = st.houseRules || {}; matchWins = st.matchWins || 3;
  arenaPick = st.arenaPick || 'dungeon'; arenaList = st.arenas || [];
  roster = st.players.map(p => ({ ...p }));
  for (const p of st.players) meta[p.slot] = { name: p.name, color: p.color, level: p.level, loadout: p.loadout };
  const me = st.players.find(p => p.id === myId); if (me) mySlot = me.slot;

  if (st.phase === 'lobby' || st.phase === 'countdown') {
    phase = st.phase;
    showScreen('lobby');
    $('roomCode').textContent = st.roomCode;
    $('roomMode').textContent = balanced ? 'QUICK PLAY · BALANCED' : 'PRIVATE · YOUR LOADOUTS';
    $('matchInfo').textContent = `FIRST TO ${matchWins} WINS`;
    renderPlayerList(st.players);
    renderArenaPicker();
    renderHouseRules();
    const cd = $('countdown');
    if (st.phase === 'countdown' && st.countdown > 0) { cd.classList.remove('hidden'); cd.textContent = st.countdown; sfx('count'); }
    else cd.classList.add('hidden');
  }
});

socket.on('gameStart', (g) => {
  phase = 'playing'; mapGrid = g.map;
  arena = g.arena || 'dungeon'; conveyors = g.conveyors || {}; teleports = g.teleports || []; iceFloor = !!g.iceFloor;
  lavaTiles = g.lavaTiles || [];
  setTheme(arena);
  seenBombs = new Set(); prevPU = new Map(); prevAlive = {}; prevCurse = {}; snapshot = null;
  for (const p of g.players) { meta[p.slot] = { name: p.name, color: p.color, level: p.level, loadout: p.loadout }; }
  roster = g.players.map(p => ({ slot: p.slot, name: p.name, color: p.color, score: p.score, level: p.level }));
  $('overlay').classList.add('hidden');
  showScreen('game');
  renderScoreboard();
  sfx('go');
});

socket.on('state', (s) => { handleStateSfx(s); snapshot = s; updateHudStrip(s); });

// status strip: bomb pips, range, ability cooldown, active effects, + PC keybinds
function updateHudStrip(s) {
  const el = $('hudStrip'); if (!el) return;
  const me = s.players.find(p => p.i === mySlot);
  if (!me) { el.innerHTML = ''; return; }
  const m = meta[mySlot];
  const abName = (m && m.loadout && SHARED.ABILITIES[m.loadout.ability]) ? SHARED.ABILITIES[m.loadout.ability].name : 'ABILITY';
  const ready = me.cd <= 0;
  const cdPct = me.cm ? Math.max(0, Math.min(100, Math.round((1 - me.cd / me.cm) * 100))) : 100;
  const avail = Math.max(0, (me.mb || 0) - (me.ab || 0));
  let pips = '';
  for (let i = 0; i < (me.mb || 0); i++) pips += `<span class="pip ${i < avail ? 'on' : ''}"></span>`;
  const tags = [];
  if (me.k & 1) tags.push('KICK'); if (me.k & 2) tags.push('THROW'); if (me.k & 4) tags.push('REMOTE'); if (me.k & 8) tags.push('PIERCE');
  if (me.sh) tags.push('SHIELD'); if (me.ph) tags.push('PHASE'); if (me.cu) tags.push('CURSE:' + String(me.cu).toUpperCase());
  const keys = document.body.classList.contains('touch') ? '' :
    '<span class="hud-keys">MOVE WASD/Arrows &middot; BOMB Space &middot; ' + abName + ' E &middot; DETONATE Q</span>';
  el.innerHTML =
    `<span class="hud-item">BOMBS <span class="pips">${pips}</span></span>` +
    `<span class="hud-item">RANGE ${me.rg || 1}</span>` +
    `<span class="hud-item ability ${ready ? 'ready' : ''}">${abName} ${ready ? '● READY' : cdPct + '%'}</span>` +
    (tags.length ? `<span class="hud-item tags">${tags.join(' · ')}</span>` : '') +
    keys;
  // touch buttons: ability label + cooldown sweep, bomb pips, contextual detonate
  const ab = $('abilityBtn');
  if (ab) { ab.style.setProperty('--cd', cdPct + '%'); ab.classList.toggle('charged', ready); ab.firstChild ? (ab.childNodes[0].nodeValue = abName) : (ab.textContent = abName); }
  const bb = $('bombBtn');
  if (bb) bb.innerHTML = 'BOMB<span class="btn-pips">' + pips + '</span>';
  const det = $('detBtn');
  if (det) { const showDet = (m && m.loadout && m.loadout.bomb === 'remote') || (me.k & 4); det.style.display = showDet ? '' : 'none'; }
}

socket.on('roundOver', (r) => {
  phase = 'roundover';
  roster = r.scores.map(p => ({ ...p }));
  renderScoreboard();
  const ov = $('overlay'); ov.classList.remove('hidden');
  const winColor = r.winnerSlot != null ? COLORS[r.winnerSlot] : PAL.text;
  const title = r.winnerName ? `${r.winnerName} WINS ROUND` : 'DRAW!';
  const board = r.scores.slice().sort((a, b) => b.score - a.score)
    .map(p => `<span style="color:${p.color}">${p.name}: ${p.score}/${matchWins}</span>`).join('<br />');
  ov.innerHTML = `<div class="big" style="color:${winColor}">${title}</div><div class="sub">${board}</div><div class="sub" style="color:var(--dim)">next round...</div>`;
  if (r.winnerId === myId) sfx('win'); else sfx('death');
});

socket.on('matchOver', (m) => {
  phase = 'matchover';
  const mine = m.results.find(r => r.slot === mySlot);
  const info = mine ? addRewards(mine) : null;
  showMatchOverlay(m, mine, info);
  sfx(m.winnerId === myId ? 'win' : 'death');
  if (info && (info.after > info.before)) setTimeout(() => sfx('levelup'), 400);
});

function handleStateSfx(s) {
  const cur = new Set(s.bombs.map(b => b.id));
  for (const b of s.bombs) if (!seenBombs.has(b.id)) sfx('place');
  seenBombs = cur;
  if (s.nb > 0) sfx('explode');
  const flame = new Set(s.explosions);
  const curPU = new Map(s.powerups.map(p => [p.id, p]));
  for (const [id, p] of prevPU) if (!curPU.has(id)) { if (!flame.has(p.y * COLS + p.x)) sfx(p.c ? 'curse' : 'pickup'); }
  prevPU = curPU;
  for (const pl of s.players) {
    if (prevAlive[pl.i] === true && !pl.a) sfx('death');
    if (pl.cu && prevCurse[pl.i] !== pl.cu) sfx('curse');
  }
  prevAlive = {}; prevCurse = {};
  for (const pl of s.players) { prevAlive[pl.i] = pl.a; prevCurse[pl.i] = pl.cu; }
}

/* ---- 6. collection / loadout screen ---------------------------------- */
function openCollection() {
  ensureAudio();
  saveName();
  showScreen('collection');
  renderCollection();
}
function renderCollection() {
  const lv = SHARED.levelFromXp(profile.xp);
  $('colName').textContent = profile.name || 'PLAYER';
  $('colLevel').textContent = 'LV ' + lv.level;
  $('colCoins').textContent = '◎ ' + profile.coins;
  $('colXpFill').style.width = Math.round((lv.into / lv.need) * 100) + '%';
  $('colXpText').textContent = `${lv.into}/${lv.need} XP`;
  const wrap = $('colSections'); wrap.innerHTML = '';
  const sections = [
    ['BOMB TYPE', 'bomb'], ['ABILITY', 'ability'], ['CLASS', 'cls'], ['HAT', 'hat'],
  ];
  for (const [label, cat] of sections) {
    const sec = document.createElement('div'); sec.className = 'col-section';
    sec.innerHTML = `<h3>${label}</h3>`;
    const grid = document.createElement('div'); grid.className = 'col-grid';
    for (const [id, def] of Object.entries(SHARED[CAT_TABLE[cat]])) {
      const unlocked = isUnlocked(cat, id);
      const equipped = profile.loadout[cat] === id;
      const card = document.createElement('button');
      card.className = 'item' + (equipped ? ' equipped' : '') + (unlocked ? '' : ' locked');
      card.innerHTML =
        `<div class="item-name">${def.name}</div>` +
        `<div class="item-desc">${def.desc}</div>` +
        (unlocked ? '' : `<div class="item-lock">LV ${def.unlock}</div>`);
      if (unlocked) card.onclick = () => { ensureAudio(); profile.loadout[cat] = id; saveProfile(); renderCollection(); sfx('pickup'); };
      grid.appendChild(card);
    }
    sec.appendChild(grid); wrap.appendChild(sec);
  }
}

/* ---- 7. lobby rendering ---------------------------------------------- */
function kitLabel(l) {
  const b = SHARED.BOMB_TYPES[l.bomb]?.name || '?';
  const a = SHARED.ABILITIES[l.ability]?.name || '?';
  const c = SHARED.CLASSES[l.cls]?.name || '?';
  return `${c} · ${b} · ${a}`;
}
function renderPlayerList(players) {
  const ul = $('playerList'); ul.innerHTML = '';
  for (const p of players) {
    const li = document.createElement('li');
    li.innerHTML =
      `<span class="swatch" style="background:${p.color}"></span>` +
      `<span class="lvbadge">L${p.level}</span>` +
      `<span class="pname">${p.name}${p.id === myId ? ' (YOU)' : ''}<br><span class="kit">${kitLabel(p.loadout)}</span></span>` +
      `<span class="pscore">${p.score}</span>` +
      `<span class="pstatus ${p.ready ? 'ready' : ''}">${p.ready ? 'READY' : 'WAIT'}</span>`;
    ul.appendChild(li);
  }
}
function renderArenaPicker() {
  const box = $('arenaPick'); if (!box) return;
  const amHost = myId === hostId;
  const opts = arenaList.concat(['random']);
  box.innerHTML = `<div class="hr-title">ARENA${amHost ? '' : ' (HOST PICKS)'}</div>`;
  for (const a of opts) {
    const on = arenaPick === a;
    const label = a === 'random' ? 'RANDOM' : (THEMES[a]?.name || a.toUpperCase());
    const b = document.createElement('button');
    b.className = 'hr-toggle arena-opt' + (on ? ' on' : '');
    b.textContent = (on ? '▸ ' : '') + label;
    b.disabled = !amHost;
    if (amHost) b.onclick = () => { ensureAudio(); socket.emit('setArena', { arena: a }); };
    box.appendChild(b);
  }
}
function renderHouseRules() {
  const box = $('houseRules');
  const amHost = myId === hostId;
  if (balanced) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  const rules = [['doublePowerups', 'DOUBLE POWER-UPS'], ['suddenDeath', 'SUDDEN DEATH']];
  box.innerHTML = `<div class="hr-title">HOUSE RULES${amHost ? '' : ' (HOST SETS)'}</div>`;
  for (const [key, label] of rules) {
    const on = !!houseRules[key];
    const b = document.createElement('button');
    b.className = 'hr-toggle' + (on ? ' on' : '');
    b.textContent = (on ? '☑ ' : '☐ ') + label;
    b.disabled = !amHost;
    if (amHost) b.onclick = () => { ensureAudio(); socket.emit('setHouseRule', { key, value: !on }); };
    box.appendChild(b);
  }
}
function renderScoreboard() {
  const sb = $('scoreboard'); sb.innerHTML = '';
  const aliveBySlot = {}; if (snapshot) for (const p of snapshot.players) aliveBySlot[p.i] = p.a;
  for (const p of roster.slice().sort((a, b) => a.slot - b.slot)) {
    const dead = phase === 'playing' && aliveBySlot[p.slot] === false;
    const div = document.createElement('div');
    div.className = 'score-pill' + (dead ? ' dead' : '') + (p.slot === mySlot ? ' me' : '');
    div.innerHTML = `<span class="swatch" style="background:${p.color}"></span><span>${p.name}</span><span class="pscore">${p.score}</span>`;
    sb.appendChild(div);
  }
}

/* ---- buttons ---- */
function nameVal() { const n = $('nameInput').value.trim(); return n || 'PLAYER'; }
function saveName() { profile.name = nameVal(); saveProfile(); }
function joinPayload(extra) { return Object.assign({ name: nameVal(), loadout: profile.loadout, level: myLevel() }, extra); }
$('nameInput').value = profile.name || '';
$('createBtn').onclick = () => { ensureAudio(); saveName(); socket.emit('joinRoom', joinPayload({ roomCode: null })); };
$('joinBtn').onclick = () => {
  ensureAudio(); saveName();
  const code = $('codeInput').value.trim().toUpperCase();
  if (!code) { $('landingMsg').textContent = 'ENTER A CODE'; return; }
  socket.emit('joinRoom', joinPayload({ roomCode: code }));
};
$('quickBtn').onclick = () => { ensureAudio(); saveName(); socket.emit('quickPlay', joinPayload({})); };
$('loadoutBtn').onclick = openCollection;
$('colBack').onclick = () => { saveProfile(); showScreen('landing'); refreshLanding(); };
function refreshLanding() {
  const lv = SHARED.levelFromXp(profile.xp);
  $('landingStats').textContent = `LV ${lv.level}  ·  ◎ ${profile.coins}`;
}
refreshLanding();

/* ---- Settings (server URL) ---- */
function updateServerStatus() {
  const el = $('serverStatus'); if (!el) return;
  const target = SERVER_URL || (location.host || 'this site');
  el.textContent = (socket.connected ? '● CONNECTED' : '○ connecting') + ' — ' + target;
  el.style.color = socket.connected ? 'var(--p4)' : 'var(--dim)';
}
function openSettings() {
  ensureAudio(); showScreen('settings');
  let saved = ''; try { saved = localStorage.getItem('bombArenaServer') || ''; } catch (e) {}
  $('serverInput').value = saved;
  updateServerStatus();
}
if ($('settingsBtn')) $('settingsBtn').onclick = openSettings;
if ($('settingsBack')) $('settingsBack').onclick = () => showScreen('landing');
if ($('serverSave')) $('serverSave').onclick = () => {
  const v = $('serverInput').value.trim();
  try { if (v) localStorage.setItem('bombArenaServer', v); else localStorage.removeItem('bombArenaServer'); } catch (e) {}
  location.reload();
};
if ($('serverReset')) $('serverReset').onclick = () => { try { localStorage.removeItem('bombArenaServer'); } catch (e) {} location.reload(); };
socket.on('connect', updateServerStatus);
socket.on('disconnect', updateServerStatus);

let isReady = false;
$('readyBtn').onclick = () => {
  ensureAudio(); isReady = !isReady;
  $('readyBtn').classList.toggle('is-ready', isReady);
  $('readyBtn').textContent = isReady ? 'NOT READY' : 'READY';
  socket.emit('setReady', { ready: isReady });
};
$('leaveBtn').onclick = () => { socket.emit('leaveRoom'); location.reload(); };

/* ---- PWA: service worker + install prompt ---------------------------- */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
let deferredInstall = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault(); deferredInstall = e;
  const b = $('installBtn'); if (b) b.classList.remove('hidden');
});
if ($('installBtn')) $('installBtn').onclick = async () => {
  if (!deferredInstall) return;
  deferredInstall.prompt(); await deferredInstall.userChoice;
  deferredInstall = null; $('installBtn').classList.add('hidden');
};

/* ---- 8. INPUT -------------------------------------------------------- */
const KEYDIR = { arrowup: 'up', arrowdown: 'down', arrowleft: 'left', arrowright: 'right', w: 'up', s: 'down', a: 'left', d: 'right' };
const dirStack = []; let lastSentDir = 'none';
function sendDir() { const d = dirStack.length ? dirStack[dirStack.length - 1] : 'none'; if (d !== lastSentDir) { lastSentDir = d; socket.emit('input', { dir: d }); } }
function pressDir(d) { if (!dirStack.includes(d)) { dirStack.push(d); sendDir(); } }
function releaseDir(d) { const i = dirStack.indexOf(d); if (i >= 0) { dirStack.splice(i, 1); sendDir(); } }
function dropBomb() { if (phase === 'playing') { socket.emit('placeBomb'); } }
function doAbility() { if (phase === 'playing') { socket.emit('useAbility'); sfx('ability'); } }
function doDetonate() { if (phase === 'playing') { socket.emit('detonate'); } }
function isTyping(e) { const t = e.target; return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable); }

window.addEventListener('keydown', (e) => {
  ensureAudio();
  if (isTyping(e)) return;
  const k = e.key.toLowerCase();
  if (k === ' ' || k === 'spacebar' || k === 'x') { if (!e.repeat) dropBomb(); e.preventDefault(); return; }
  if (k === 'e' || k === 'shift') { if (!e.repeat) doAbility(); e.preventDefault(); return; }
  if (k === 'q' || k === 'f') { if (!e.repeat) doDetonate(); e.preventDefault(); return; }
  const dir = KEYDIR[k]; if (dir) { e.preventDefault(); pressDir(dir); }
});
window.addEventListener('keyup', (e) => { if (isTyping(e)) return; const dir = KEYDIR[e.key.toLowerCase()]; if (dir) releaseDir(dir); });

if (('ontouchstart' in window) || navigator.maxTouchPoints > 0) document.body.classList.add('touch');
// best-effort landscape lock for installed/native builds (ignored on web)
try { if (screen.orientation && screen.orientation.lock) screen.orientation.lock('landscape').catch(() => {}); } catch (e) {}
document.querySelectorAll('#touch .dir').forEach((btn) => {
  const dir = btn.dataset.dir;
  const down = (e) => { e.preventDefault(); ensureAudio(); pressDir(dir); btn.classList.add('active'); };
  const up = (e) => { e.preventDefault(); releaseDir(dir); btn.classList.remove('active'); };
  btn.addEventListener('pointerdown', down); btn.addEventListener('pointerup', up);
  btn.addEventListener('pointercancel', up); btn.addEventListener('pointerleave', up);
});
function wireActionBtn(id, fn) {
  const b = $(id); if (!b) return;
  b.addEventListener('pointerdown', (e) => { e.preventDefault(); ensureAudio(); fn(); b.classList.add('active'); });
  const rel = () => b.classList.remove('active');
  b.addEventListener('pointerup', rel); b.addEventListener('pointercancel', rel); b.addEventListener('pointerleave', rel);
}
wireActionBtn('bombBtn', dropBomb);
wireActionBtn('abilityBtn', doAbility);
wireActionBtn('detBtn', doDetonate);

/* ---- 9. RENDERING ---------------------------------------------------- */
function px(tx, ty, ax, ay, aw, ah, color) { ctx.fillStyle = color; ctx.fillRect(tx * TILE + ax * PX, ty * TILE + ay * PX, aw * PX, ah * PX); }
function TH() { return curTheme || THEMES.dungeon; }
function drawFloor(x, y) { const T = TH(); ctx.fillStyle = (x + y) % 2 === 0 ? T.floorA : T.floorB; ctx.fillRect(x * TILE, y * TILE, TILE, TILE); }
function drawWall(x, y) {
  const T = TH();
  ctx.fillStyle = T.wall; ctx.fillRect(x * TILE, y * TILE, TILE, TILE);
  px(x, y, 0, 0, 16, 2, T.wallLit); px(x, y, 0, 0, 2, 16, T.wallLit);
  px(x, y, 0, 14, 16, 2, T.wallDark); px(x, y, 14, 0, 2, 16, T.wallDark);
}
// arena overlays drawn on the floor before entities
function drawConveyor(x, y, dir) {
  const ph = (Date.now() / 120) % 4 | 0;
  ctx.fillStyle = '#2a2e34'; ctx.fillRect(x * TILE + 2, y * TILE + 2, TILE - 4, TILE - 4);
  ctx.fillStyle = '#fcc800';
  for (let i = 0; i < 3; i++) {
    const k = (i + ph) % 4;
    if (dir === 'right') ctx.fillRect(x * TILE + 4 + k * 6, y * TILE + 13, 4, 6);
    else if (dir === 'left') ctx.fillRect(x * TILE + 24 - k * 6, y * TILE + 13, 4, 6);
    else if (dir === 'down') ctx.fillRect(x * TILE + 13, y * TILE + 4 + k * 6, 6, 4);
    else ctx.fillRect(x * TILE + 13, y * TILE + 24 - k * 6, 6, 4);
  }
}
function drawTeleport(x, y) {
  const t = (Date.now() / 200) % (Math.PI * 2);
  ctx.save(); ctx.translate(x * TILE + 16, y * TILE + 16); ctx.rotate(t);
  ctx.fillStyle = '#a060f0'; ctx.fillRect(-10, -2, 20, 4); ctx.fillRect(-2, -10, 4, 20);
  ctx.fillStyle = '#d8a8ff'; ctx.fillRect(-6, -1, 12, 2); ctx.fillRect(-1, -6, 2, 12);
  ctx.restore();
}
function drawIceSheen(x, y) {
  ctx.fillStyle = 'rgba(120,200,255,0.10)'; ctx.fillRect(x * TILE, y * TILE, TILE, TILE);
  ctx.fillStyle = 'rgba(255,255,255,0.10)'; ctx.fillRect(x * TILE + 3, y * TILE + 3, 10, 2);
}
function drawLavaWarn(x, y) {
  const pulse = 0.3 + 0.4 * Math.abs(Math.sin(Date.now() / 120));
  ctx.fillStyle = `rgba(252,80,0,${pulse})`; ctx.fillRect(x * TILE + 2, y * TILE + 2, TILE - 4, TILE - 4);
  ctx.strokeStyle = '#fcc800'; ctx.lineWidth = 1; ctx.strokeRect(x * TILE + 3, y * TILE + 3, TILE - 6, TILE - 6);
}
// impassable molten terrain (volcano lava channel)
function drawLavaTile(x, y) {
  ctx.fillStyle = '#3a0c04'; ctx.fillRect(x * TILE, y * TILE, TILE, TILE);
  const t = Date.now() / 300;
  for (let i = 0; i < 4; i++) {
    const ph = Math.sin(t + (x + y + i) * 1.3);
    px(x, y, 1 + ((i * 4) % 14), 2 + ((ph + 1) * 6 | 0), 3, 3, ph > 0 ? '#fc6018' : '#e02000');
  }
  px(x, y, 0, 0, 16, 1, '#fcc800');
}
// hazard telegraph (about to be deadly) — pulsing themed warning
function drawHazardWarn(x, y) {
  const blink = Math.floor(Date.now() / 110) % 2 === 0;
  ctx.fillStyle = blink ? 'rgba(252,200,0,0.30)' : 'rgba(252,200,0,0.12)';
  ctx.fillRect(x * TILE, y * TILE, TILE, TILE);
  ctx.strokeStyle = '#fcc800'; ctx.lineWidth = 2;
  ctx.strokeRect(x * TILE + 2, y * TILE + 2, TILE - 4, TILE - 4);
  px(x, y, 7, 3, 2, 10, 'rgba(252,200,0,0.5)'); px(x, y, 3, 7, 10, 2, 'rgba(252,200,0,0.5)');
}
// hazard active (deadly now) — bright themed strike
function drawHazardDanger(x, y) {
  const T = TH();
  ctx.fillStyle = T.flameEdge; ctx.fillRect(x * TILE, y * TILE, TILE, TILE);
  px(x, y, 1, 1, 14, 14, T.flameMid);
  px(x, y, 6, 0, 4, 16, '#ffffff'); px(x, y, 0, 6, 16, 4, '#ffffff');
}
function drawCrate(x, y) {
  ctx.fillStyle = PAL.crate; ctx.fillRect(x * TILE, y * TILE, TILE, TILE);
  px(x, y, 1, 1, 14, 2, PAL.crateLit); px(x, y, 1, 1, 2, 14, PAL.crateLit);
  px(x, y, 1, 13, 14, 2, PAL.crateDark); px(x, y, 13, 1, 2, 14, PAL.crateDark);
  px(x, y, 1, 7, 14, 2, PAL.crateDark);
}
function drawTempWall(x, y) {
  ctx.fillStyle = PAL.temp; ctx.fillRect(x * TILE, y * TILE, TILE, TILE);
  px(x, y, 1, 1, 14, 2, PAL.tempLit); px(x, y, 1, 1, 2, 14, PAL.tempLit);
  px(x, y, 7, 1, 2, 14, PAL.iceDark); px(x, y, 1, 7, 14, 2, PAL.iceDark);
}
function drawFrozen(x, y) {
  ctx.fillStyle = 'rgba(122,208,252,0.30)'; ctx.fillRect(x * TILE, y * TILE, TILE, TILE);
  px(x, y, 2, 2, 3, 1, PAL.ice); px(x, y, 11, 4, 3, 1, PAL.ice); px(x, y, 5, 11, 3, 1, PAL.ice);
}
function drawBomb(b) {
  const x = b.x, y = b.y;
  if (b.m) {   // mine: flat disc, blinks when armed
    const armed = b.m === 2;
    px(x, y, 3, 7, 10, 5, '#202028'); px(x, y, 4, 6, 8, 2, '#202028');
    const lit = armed ? (Math.floor(Date.now() / 160) % 2 === 0) : (Math.floor(Date.now() / 400) % 2 === 0);
    px(x, y, 7, 8, 2, 2, lit ? PAL.flameEdge : '#600');
    return;
  }
  const tint = { ice: '#16384a', remote: '#101830', cluster: '#241018', grenade: '#10240f', pierce: '#1a1030' }[b.t] || PAL.bomb;
  px(x, y, 4, 5, 8, 9, tint); px(x, y, 3, 6, 10, 7, tint); px(x, y, 5, 4, 6, 11, tint);
  px(x, y, 5, 6, 2, 2, PAL.bombLit);
  if (b.t === 'remote') { px(x, y, 10, 1, 1, 4, '#aaa'); px(x, y, 9, 0, 3, 1, PAL.flameEdge); }
  else if (b.t === 'cluster') { px(x, y, 5, 8, 1, 1, PAL.fuse); px(x, y, 9, 9, 1, 1, PAL.fuse); px(x, y, 7, 11, 1, 1, PAL.fuse); }
  else if (b.t === 'ice') { px(x, y, 6, 7, 2, 2, PAL.ice); }
  else {
    const f = b.f, rate = (f >= 0 && f < 20) ? 3 : 6;
    const lit = f < 0 ? false : Math.floor(f / rate) % 2 === 0;
    px(x, y, 10, 2, 2, 3, tint);
    if (lit) { px(x, y, 11, 0, 3, 3, PAL.fuse); px(x, y, 12, 1, 1, 1, PAL.flameCore); }
  }
}
function drawExplosion(idx) {
  const T = TH();
  const x = idx % COLS, y = (idx / COLS) | 0;
  ctx.fillStyle = T.flameEdge; ctx.fillRect(x * TILE, y * TILE, TILE, TILE);
  px(x, y, 1, 1, 14, 14, T.flameMid); px(x, y, 3, 3, 10, 10, T.flameCore);
  if (Math.random() < 0.5) px(x, y, 6, 6, 4, 4, '#ffffff');
}
const PU_STYLE = {
  bomb: ['#e84040', 'B'], range: ['#fc9838', 'R'], speed: ['#fcc800', 'S'],
  kick: ['#48b048', 'K'], throw: ['#48b048', 'T'], pierce: ['#5878fc', 'P'],
  remote: ['#5878fc', 'M'], shield: ['#bcbcbc', 'O'], phase: ['#54fcfc', 'G'],
  reversed: ['#a020f0', 'X'], slowed: ['#a020f0', 'Z'], tiny: ['#a020f0', 'I'],
};
function drawPowerup(p) {
  const st = PU_STYLE[p.t] || ['#fff', '?'];
  ctx.fillStyle = '#000'; ctx.fillRect(p.x * TILE + 4, p.y * TILE + 4, TILE - 8, TILE - 8);
  px(p.x, p.y, 3, 3, 10, 10, st[0]); px(p.x, p.y, 4, 4, 8, 8, '#000');
  if (p.c) { px(p.x, p.y, 3, 3, 10, 1, '#000'); px(p.x, p.y, 3, 12, 10, 1, '#000'); }
  drawGlyph(p.x, p.y, st[1], st[0]);
}
const GLYPHS = {
  B: ['111', '101', '110', '101', '111'], R: ['111', '101', '110', '101', '101'],
  S: ['111', '100', '111', '001', '111'], K: ['101', '110', '100', '110', '101'],
  T: ['111', '010', '010', '010', '010'], P: ['111', '101', '111', '100', '100'],
  M: ['101', '111', '111', '101', '101'], O: ['111', '101', '101', '101', '111'],
  G: ['111', '100', '101', '101', '111'], X: ['101', '101', '010', '101', '101'],
  Z: ['111', '001', '010', '100', '111'], I: ['111', '010', '010', '010', '111'],
  '?': ['111', '001', '011', '000', '010'],
};
function drawGlyph(tx, ty, ch, color) {
  const g = GLYPHS[ch]; if (!g) return;
  for (let r = 0; r < g.length; r++) for (let c = 0; c < g[r].length; c++) if (g[r][c] === '1') px(tx, ty, 6 + c, 5 + r, 1, 1, color);
}
function drawHat(cx, cy, hat, color) {
  if (hat === 'cap') { px2(cx, cy, 8, -2, 16, 4, '#e84040'); px2(cx, cy, 20, 0, 8, 3, '#c03030'); }
  else if (hat === 'crown') { ctx.fillStyle = PAL.fuse; ctx.fillRect(cx + 8, cy - 1, 16, 5); ctx.fillStyle = PAL.bg; ctx.fillRect(cx + 10, cy - 4, 2, 4); ctx.fillRect(cx + 15, cy - 5, 2, 5); ctx.fillRect(cx + 20, cy - 4, 2, 4); }
  else if (hat === 'horns') { ctx.fillStyle = '#e84040'; ctx.fillRect(cx + 6, cy - 4, 3, 5); ctx.fillRect(cx + 23, cy - 4, 3, 5); }
  else if (hat === 'halo') { ctx.fillStyle = PAL.fuse; ctx.fillRect(cx + 9, cy - 6, 14, 2); }
  else if (hat === 'antenna') { ctx.fillStyle = '#bbb'; ctx.fillRect(cx + 15, cy - 6, 2, 6); ctx.fillStyle = PAL.flameCore; ctx.fillRect(cx + 14, cy - 8, 4, 3); }
}
function px2(cx, cy, ax, ay, w, h, color) { ctx.fillStyle = color; ctx.fillRect(cx + ax, cy + ay, w, h); }

function drawPlayerBody(cx, cy, color, f, opts) {
  const bx = cx + 6, by = cy + 6, bw = 20, bh = 22;
  if (opts && opts.ghost) ctx.globalAlpha = 0.5;
  ctx.fillStyle = '#000'; ctx.fillRect(bx - 2, by - 2, bw + 4, bh + 4);
  ctx.fillStyle = color; ctx.fillRect(bx, by, bw, bh); ctx.fillRect(bx + 4, by - 3, bw - 8, 3);
  ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.fillRect(bx + bw - 5, by, 5, bh);
  let ex = 0, ey = 0;
  if (f === 'left') ex = -3; else if (f === 'right') ex = 3;
  if (f === 'up') ey = -2; else if (f === 'down') ey = 1;
  ctx.fillStyle = '#000'; ctx.fillRect(bx + 4 + ex, by + 5 + ey, 4, 5); ctx.fillRect(bx + bw - 8 + ex, by + 5 + ey, 4, 5);
  ctx.fillStyle = '#fff'; ctx.fillRect(bx + 4 + ex, by + 5 + ey, 2, 2); ctx.fillRect(bx + bw - 8 + ex, by + 5 + ey, 2, 2);
  ctx.globalAlpha = 1;
}
function drawPlayer(pl) {
  const cx = pl.x * TILE, cy = pl.y * TILE;
  const color = COLORS[pl.i] || '#fff';
  const m = meta[pl.i];
  if (pl.ph) ctx.globalAlpha = 0.6;
  drawPlayerBody(cx, cy, color, pl.f);
  if (m && m.loadout) drawHat(cx, cy, m.loadout.hat, color);
  ctx.globalAlpha = 1;
  // shield ring
  if (pl.sh) {
    ctx.strokeStyle = '#7ad0fc'; ctx.lineWidth = 2;
    ctx.strokeRect(cx + 3, cy + 3, TILE - 6, TILE - 6);
  }
  // curse marker
  if (pl.cu) { ctx.fillStyle = '#a020f0'; ctx.fillRect(cx + 13, cy - 8, 6, 6); ctx.fillStyle = '#fff'; ctx.fillRect(cx + 15, cy - 6, 2, 2); }
}
function drawDecoy(d) {
  const cx = d.x * TILE, cy = d.y * TILE;
  drawPlayerBody(cx, cy, COLORS[d.i] || '#fff', 'down', { ghost: true });
}

function drawSelfHud() {
  if (!snapshot) return;
  const me = snapshot.players.find(p => p.i === mySlot); if (!me) return;
  const m = meta[mySlot];
  // ability cooldown pill, bottom-left
  const abName = m && m.loadout ? (SHARED.ABILITIES[m.loadout.ability]?.name || '') : '';
  const ready = me.cd <= 0;
  ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(4, canvas.height - 22, 150, 18);
  ctx.fillStyle = ready ? '#48b048' : '#555';
  const frac = me.cm ? 1 - me.cd / me.cm : 1;
  ctx.fillRect(6, canvas.height - 20, Math.max(0, 146 * frac), 14);
  ctx.fillStyle = '#fff'; ctx.font = '8px "Press Start 2P", monospace'; ctx.textAlign = 'left';
  ctx.fillText(abName + (ready ? ' READY' : ''), 10, canvas.height - 9);
  ctx.textAlign = 'center';
  if (me.cu) { ctx.fillStyle = '#a020f0'; ctx.font = '10px "Press Start 2P", monospace'; ctx.fillText('CURSED: ' + me.cu.toUpperCase(), canvas.width / 2, 14); }
}

function drawBackdrop() {
  const T = TH();
  if (T.ambient === 'grid') {            // neon: scrolling parallax grid
    const off = (Date.now() / 40) % 32;
    ctx.strokeStyle = 'rgba(88,120,252,0.18)'; ctx.lineWidth = 1;
    for (let x = -32 + off; x < canvas.width; x += 32) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, canvas.height); ctx.stroke(); }
    for (let y = -32 + off; y < canvas.height; y += 32) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(canvas.width, y); ctx.stroke(); }
  }
}
function drawAmbient() {
  const T = TH(); const kind = T.ambient;
  if (kind === 'snow' || kind === 'fog') {
    ctx.fillStyle = kind === 'fog' ? 'rgba(160,120,200,0.35)' : 'rgba(220,240,255,0.8)';
    for (const p of ambient) { ctx.fillRect(p.x | 0, p.y | 0, p.s, p.s); p.y += p.v; p.x += Math.sin((p.y + p.x) / 40) * 0.4; if (p.y > 352) { p.y = -4; p.x = Math.random() * 416; } }
  } else if (kind === 'embers') {
    for (const p of ambient) { ctx.fillStyle = Math.random() < 0.5 ? '#fc6018' : '#fcc800'; ctx.fillRect(p.x | 0, p.y | 0, p.s, p.s); p.y -= p.v; p.x += Math.sin(p.y / 30) * 0.5; if (p.y < -4) { p.y = 356; p.x = Math.random() * 416; } }
  } else if (kind === 'dust') {
    ctx.fillStyle = 'rgba(120,120,160,0.4)';
    for (const p of ambient) { ctx.fillRect(p.x | 0, p.y | 0, p.s, p.s); p.x += p.v * 0.3; p.y += Math.sin(p.x / 50) * 0.2; if (p.x > 420) { p.x = -4; p.y = Math.random() * 352; } }
  }
}

function render() {
  requestAnimationFrame(render);
  if (phase !== 'playing' && phase !== 'roundover' && phase !== 'matchover') return;
  if (!mapGrid) return;
  ctx.fillStyle = TH().bg; ctx.fillRect(0, 0, canvas.width, canvas.height);
  drawBackdrop();
  const lavaSet = lavaTiles.length ? new Set(lavaTiles) : null;
  for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) {
    if (mapGrid[y][x] === 1) {
      if (lavaSet && lavaSet.has(y * COLS + x)) drawLavaTile(x, y); else drawWall(x, y);
      continue;
    }
    drawFloor(x, y);
    if (iceFloor) drawIceSheen(x, y);
    const cdir = conveyors[y * COLS + x];
    if (cdir) drawConveyor(x, y, cdir);
  }
  for (const t of teleports) drawTeleport(t.x, t.y);
  const s = snapshot;
  if (s) {
    if (s.warn) for (const idx of s.warn) drawHazardWarn(idx % COLS, (idx / COLS) | 0);
    if (s.lava) for (const idx of s.lava) drawLavaWarn(idx % COLS, (idx / COLS) | 0);
    for (const idx of s.frozen) drawFrozen(idx % COLS, (idx / COLS) | 0);
    for (const idx of s.crates) drawCrate(idx % COLS, (idx / COLS) | 0);
    if (s.walls2) for (const idx of s.walls2) drawTempWall(idx % COLS, (idx / COLS) | 0);
    for (const p of s.powerups) drawPowerup(p);
    if (s.decoys) for (const d of s.decoys) drawDecoy(d);
    for (const b of s.bombs) drawBomb(b);
    for (const p of s.players) if (p.a) drawPlayer(p);
    if (s.danger) for (const idx of s.danger) drawHazardDanger(idx % COLS, (idx / COLS) | 0);
    for (const idx of s.explosions) drawExplosion(idx);
    drawAmbient();
    drawSelfHud();
    const me = s.players.find(p => p.i === mySlot);
    if (phase === 'playing' && me && !me.a) {
      ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(0, canvas.height / 2 - 16, canvas.width, 32);
      ctx.fillStyle = PAL.flameEdge; ctx.font = '16px "Press Start 2P", monospace'; ctx.textAlign = 'center';
      ctx.fillText('ELIMINATED', canvas.width / 2, canvas.height / 2 + 6);
    }
  }
  if (phase === 'playing') renderScoreboard();
}
requestAnimationFrame(render);

/* ---- 10. post-match XP screen ---------------------------------------- */
function showMatchOverlay(m, mine, info) {
  const ov = $('overlay'); ov.classList.remove('hidden');
  const winColor = m.winnerSlot != null ? COLORS[m.winnerSlot] : PAL.text;
  const title = m.winnerName ? `${m.winnerName} WINS THE MATCH!` : 'DRAW MATCH!';
  let html = `<div class="big" style="color:${winColor}">${title}</div>`;
  // per-player rewards
  html += '<div class="sub results">';
  for (const r of m.results.slice().sort((a, b) => b.xp - a.xp)) {
    const meTag = r.slot === mySlot ? ' ◄' : '';
    html += `<div><span style="color:${r.color}">${r.name}</span> +${r.xp}XP +${r.coins}◎ (${r.breakdown.kills}K ${r.breakdown.crates}C)${meTag}</div>`;
  }
  html += '</div>';
  // your XP bar + level
  if (info) {
    const lv = SHARED.levelFromXp(profile.xp);
    html += `<div class="xpbar"><div class="xpbar-fill" style="width:${Math.round((lv.into / lv.need) * 100)}%"></div></div>`;
    html += `<div class="sub">LV ${lv.level} · ${lv.into}/${lv.need} XP · ◎ ${profile.coins}</div>`;
    if (info.after > info.before) html += `<div class="big levelup">LEVEL UP! ${info.before}→${info.after}</div>`;
    if (info.newly.length) html += `<div class="sub" style="color:var(--accent)">UNLOCKED: ${info.newly.join(', ')}</div>`;
  }
  html += `<div class="sub" style="color:var(--dim)">returning to lobby...</div>`;
  ov.innerHTML = html;
}
