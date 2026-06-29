/* =============================================================================
 * BOMB ARENA - shared catalog  (single source of truth for server + client)
 * -----------------------------------------------------------------------------
 * UMD module: in the browser it attaches to window.SHARED; in Node it is
 * require()'d by server.js. Defines the unlockable loadout (bomb types,
 * abilities, classes), cosmetics, the XP/level curve, and reward tables.
 *
 * Balance philosophy: unlocks are SIDEGRADES with tradeoffs, never raw power.
 * ===========================================================================*/
(function (root, factory) {
  const data = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = data;
  else root.SHARED = data;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---- Bomb types (equip ONE primary). Same base lethality; differ in behavior. */
  const BOMB_TYPES = {
    classic: { name: 'CLASSIC', unlock: 1,  price: 0,   desc: 'Standard 3s timer cross blast. Reliable.' },
    remote:  { name: 'REMOTE',  unlock: 3,  price: 150, desc: 'No timer. Press DETONATE to blow all your bombs. Can catch you.' },
    pierce:  { name: 'PIERCE',  unlock: 5,  price: 220, desc: 'Blast punches through multiple crates. Range starts 1 lower.' },
    ice:     { name: 'ICE',     unlock: 7,  price: 260, desc: 'Blast tiles freeze 3s; steppers slide. Great zoning.' },
    cluster: { name: 'CLUSTER', unlock: 9,  price: 300, desc: 'Spawns 4 mini-bombs on blast (1s later). Chaotic; hurts you too.' },
    mine:    { name: 'MINE',    unlock: 11, price: 340, desc: 'No timer. Arms after 1.5s, blows when a player steps adjacent.' },
    grenade: { name: 'GRENADE', unlock: 13, price: 380, desc: 'Thrown 3 tiles in your facing; explodes on landing. Hits over walls.' },
  };

  /* ---- Active abilities (equip ONE; cooldown-based). */
  const ABILITIES = {
    dash:      { name: 'DASH',       unlock: 1,  price: 0,   cd: 6,  desc: 'Blink 2 tiles forward (6s).' },
    wall:      { name: 'WALL',       unlock: 4,  price: 180, cd: 8,  desc: 'Drop a temporary block in front to wall a lane (8s).' },
    decoy:     { name: 'DECOY',      unlock: 6,  price: 240, cd: 10, desc: 'Drop a 4s look-alike clone to bait foes (10s).' },
    shield:    { name: 'SHIELD',     unlock: 8,  price: 280, cd: 14, desc: '2s invulnerability (14s).' },
    kickpulse: { name: 'KICK-PULSE', unlock: 10, price: 320, cd: 7,  desc: 'Shove adjacent bombs 1 tile away (7s).' },
  };

  /* ---- Character classes (equip ONE). Mild, tradeoff-balanced leans. */
  const CLASSES = {
    bomber:    { name: 'BOMBER',    unlock: 1, price: 0,   desc: 'Balanced baseline.' },
    speedster: { name: 'SPEEDSTER', unlock: 2, price: 120, desc: 'Faster, but max 1 bomb to start and cap of 4.' },
    tank:      { name: 'TANK',      unlock: 4, price: 200, desc: 'Survives the first lethal hit each round, but slower.' },
    trickster: { name: 'TRICKSTER', unlock: 6, price: 240, desc: 'Starts with Kick built-in, but base range is 1 lower.' },
  };

  /* ---- Cosmetics (purely visual; never affect stats/hitbox). */
  const COSMETICS = {
    none:  { name: 'NONE',  unlock: 1,  price: 0,   desc: 'No hat.' },
    cap:   { name: 'CAP',   unlock: 1,  price: 0,   desc: 'Backwards cap.' },
    crown: { name: 'CROWN', unlock: 5,  price: 200, desc: 'Royalty.' },
    horns: { name: 'HORNS', unlock: 8,  price: 260, desc: 'Lil devil.' },
    halo:  { name: 'HALO',  unlock: 12, price: 400, desc: 'Angelic.' },
    antenna: { name: 'ANTENNA', unlock: 3, price: 100, desc: 'Robo antenna.' },
  };

  const DEFAULT_LOADOUT = { bomb: 'classic', ability: 'dash', cls: 'bomber', hat: 'none' };

  /* ---- XP / level curve.  cost to advance FROM `level` TO level+1. */
  function xpToAdvance(level) { return Math.round(100 * level * Math.pow(1.35, level - 1)); }
  function levelFromXp(totalXp) {
    let level = 1, remaining = Math.max(0, totalXp | 0);
    while (remaining >= xpToAdvance(level)) { remaining -= xpToAdvance(level); level++; }
    return { level, into: remaining, need: xpToAdvance(level), total: totalXp | 0 };
  }

  /* ---- reward tables (computed server-side, persisted client-side). */
  const XP_REWARDS   = { crate: 10, kill: 25, roundWin: 50, matchWin: 100, placement: 30 };
  const COIN_REWARDS = { crate: 1, kill: 5, roundWin: 15, matchWin: 40, participate: 10 };

  const MATCH_WINS = 3;   // first to this many round wins takes the match

  /* ---- ranked tiers mapped from MMR (Elo) ---- */
  const RANK_TIERS = [
    { name: 'BRONZE',   min: 0,    color: '#b08050' },
    { name: 'SILVER',   min: 1100, color: '#c0c8d0' },
    { name: 'GOLD',     min: 1200, color: '#fcc800' },
    { name: 'PLATINUM', min: 1350, color: '#48d0c0' },
    { name: 'DIAMOND',  min: 1500, color: '#78b0fc' },
    { name: 'MASTER',   min: 1700, color: '#e060fc' },
  ];
  function rankTier(mmr) {
    let t = RANK_TIERS[0];
    for (const r of RANK_TIERS) if ((mmr | 0) >= r.min) t = r;
    return t;
  }

  /* ---- validation helpers (server trusts client *choice* but not invalid ids) */
  const pick = (table, id, def) => (table[id] ? id : def);
  function sanitizeLoadout(l) {
    l = l || {};
    return {
      bomb: pick(BOMB_TYPES, l.bomb, 'classic'),
      ability: pick(ABILITIES, l.ability, 'dash'),
      cls: pick(CLASSES, l.cls, 'bomber'),
      hat: pick(COSMETICS, l.hat, 'none'),
    };
  }

  return {
    BOMB_TYPES, ABILITIES, CLASSES, COSMETICS, DEFAULT_LOADOUT,
    XP_REWARDS, COIN_REWARDS, MATCH_WINS, RANK_TIERS,
    xpToAdvance, levelFromXp, sanitizeLoadout, rankTier,
  };
});
