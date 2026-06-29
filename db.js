/* =============================================================================
 * BOMB ARENA - database layer (thin, swappable)
 * -----------------------------------------------------------------------------
 * Persists accounts + profiles + sessions server-side so progress survives
 * sessions, devices, and redeploys (given a persistent disk).
 *
 * Backend: better-sqlite3 if available (single file, no DB server). Falls back
 * to a pure-JS JSON file store if the native module isn't installed, so the
 * server always runs. For ephemeral-disk hosts, swap to Postgres (see README) —
 * keep this same method surface and make the calls async.
 *
 * Config (env): DB_PATH (default ./data/bombarena.db)
 * Methods (all synchronous): createUser, userByName, userById, saveProfile,
 *   setMMR, newSession, sessionUser, endSession, leaderboard.
 * ===========================================================================*/
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'bombarena.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const clone = (o) => JSON.parse(JSON.stringify(o));

function makeSqlite(Database, file) {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      username_lc TEXT NOT NULL UNIQUE,
      pass_hash TEXT NOT NULL,
      created INTEGER NOT NULL,
      mmr INTEGER NOT NULL DEFAULT 1000,
      ranked_w INTEGER NOT NULL DEFAULT 0,
      ranked_l INTEGER NOT NULL DEFAULT 0,
      profile TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      created INTEGER NOT NULL
    );`);
  const toUser = (r) => r ? {
    id: r.id, username: r.username, pass_hash: r.pass_hash,
    mmr: r.mmr, ranked_w: r.ranked_w, ranked_l: r.ranked_l, profile: JSON.parse(r.profile),
  } : null;
  return {
    backend: 'sqlite',
    createUser({ username, passHash, profile }) {
      try {
        const info = db.prepare('INSERT INTO users(username,username_lc,pass_hash,created,profile) VALUES(?,?,?,?,?)')
          .run(username, username.toLowerCase(), passHash, Date.now(), JSON.stringify(profile));
        return toUser(db.prepare('SELECT * FROM users WHERE id=?').get(info.lastInsertRowid));
      } catch (e) { if (/UNIQUE/.test(e.message)) { const x = new Error('DUP'); x.code = 'DUP'; throw x; } throw e; }
    },
    userByName(lc) { return toUser(db.prepare('SELECT * FROM users WHERE username_lc=?').get(lc)); },
    userById(id) { return toUser(db.prepare('SELECT * FROM users WHERE id=?').get(id)); },
    saveProfile(id, profile) { db.prepare('UPDATE users SET profile=? WHERE id=?').run(JSON.stringify(profile), id); },
    setPassword(id, hash) { db.prepare('UPDATE users SET pass_hash=? WHERE id=?').run(hash, id); },
    setMMR(id, mmr, win) { db.prepare('UPDATE users SET mmr=?, ranked_w=ranked_w+?, ranked_l=ranked_l+? WHERE id=?').run(mmr, win ? 1 : 0, win ? 0 : 1, id); },
    newSession(userId) { const t = crypto.randomBytes(24).toString('hex'); db.prepare('INSERT INTO sessions(token,user_id,created) VALUES(?,?,?)').run(t, userId, Date.now()); return t; },
    sessionUser(token) { const r = db.prepare('SELECT user_id FROM sessions WHERE token=?').get(token); return r ? r.user_id : null; },
    endSession(token) { db.prepare('DELETE FROM sessions WHERE token=?').run(token); },
    leaderboard(limit) { return db.prepare('SELECT username,mmr,ranked_w,ranked_l,profile FROM users ORDER BY mmr DESC LIMIT ?').all(limit).map(r => ({ username: r.username, mmr: r.mmr, ranked_w: r.ranked_w, ranked_l: r.ranked_l, profile: JSON.parse(r.profile) })); },
  };
}

function makeJson(file) {
  let data = { users: [], nextId: 1, sessions: {} };
  try { Object.assign(data, JSON.parse(fs.readFileSync(file, 'utf8'))); } catch (e) {}
  const save = () => { try { fs.writeFileSync(file, JSON.stringify(data)); } catch (e) {} };
  return {
    backend: 'json',
    createUser({ username, passHash, profile }) {
      const lc = username.toLowerCase();
      if (data.users.some(u => u.username_lc === lc)) { const x = new Error('DUP'); x.code = 'DUP'; throw x; }
      const u = { id: data.nextId++, username, username_lc: lc, pass_hash: passHash, created: Date.now(), mmr: 1000, ranked_w: 0, ranked_l: 0, profile };
      data.users.push(u); save(); return clone(u);
    },
    userByName(lc) { const u = data.users.find(x => x.username_lc === lc); return u ? clone(u) : null; },
    userById(id) { const u = data.users.find(x => x.id === id); return u ? clone(u) : null; },
    saveProfile(id, profile) { const u = data.users.find(x => x.id === id); if (u) { u.profile = profile; save(); } },
    setPassword(id, hash) { const u = data.users.find(x => x.id === id); if (u) { u.pass_hash = hash; save(); } },
    setMMR(id, mmr, win) { const u = data.users.find(x => x.id === id); if (u) { u.mmr = mmr; if (win) u.ranked_w++; else u.ranked_l++; save(); } },
    newSession(userId) { const t = crypto.randomBytes(24).toString('hex'); data.sessions[t] = userId; save(); return t; },
    sessionUser(token) { return data.sessions[token] || null; },
    endSession(token) { delete data.sessions[token]; save(); },
    leaderboard(limit) { return data.users.slice().sort((a, b) => b.mmr - a.mmr).slice(0, limit).map(u => clone(u)); },
  };
}

let impl;
try {
  const Database = require('better-sqlite3');
  impl = makeSqlite(Database, DB_PATH);
  console.log('[db] better-sqlite3 at', DB_PATH);
} catch (e) {
  const jsonFile = DB_PATH.replace(/\.db$/, '') + '.json';
  impl = makeJson(jsonFile);
  console.log('[db] better-sqlite3 unavailable -> JSON store at', jsonFile, '(' + e.message.split('\n')[0] + ')');
}
module.exports = impl;
