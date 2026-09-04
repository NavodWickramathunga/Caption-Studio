/* ============================================================
   The store.

   SQLite, through the copy Node ships with — no native module to
   compile and nothing to install. One file on disk, which is the right
   size of database for a product with no customers yet and stays
   honest up to a few thousand.

   The one thing to know when deploying: this is a FILE. A host that
   throws the filesystem away between deploys (Vercel, Netlify
   functions) will throw the accounts away with it. Railway, Fly and
   Render all offer a mounted volume; point CAPTION_DB at it.
   ============================================================ */
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const FILE = process.env.CAPTION_DB || path.join(__dirname, '..', 'data', 'caption-studio.db');

fs.mkdirSync(path.dirname(FILE), { recursive: true });
const db = new DatabaseSync(FILE);

/* WAL lets a reader and a writer coexist, which matters the moment two
   requests arrive at once. */
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,          -- Google's stable subject id
    email         TEXT NOT NULL,
    name          TEXT,
    picture       TEXT,
    plan          TEXT NOT NULL DEFAULT 'free',
    created_at    INTEGER NOT NULL,
    last_seen_at  INTEGER NOT NULL
  );

  -- One row per billable call. Kept per call rather than per month so a
  -- disputed bill can be answered with the actual list.
  CREATE TABLE IF NOT EXISTS usage (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     TEXT NOT NULL REFERENCES users(id),
    kind        TEXT NOT NULL,               -- 'text' | 'tts'
    chars       INTEGER NOT NULL DEFAULT 0,  -- characters spoken, for tts
    cost_micros INTEGER NOT NULL DEFAULT 0,  -- our estimate, millionths of a dollar
    at          INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS usage_by_user_time ON usage (user_id, at);
`);

const now = () => Date.now();

/* Google is the source of truth for who someone is, so every sign-in
   refreshes the profile rather than trusting what we stored last time. */
function upsertUser(profile) {
  const t = now();
  db.prepare(`
    INSERT INTO users (id, email, name, picture, plan, created_at, last_seen_at)
    VALUES (?, ?, ?, ?, 'free', ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      email = excluded.email,
      name = excluded.name,
      picture = excluded.picture,
      last_seen_at = excluded.last_seen_at
  `).run(profile.id, profile.email, profile.name || null, profile.picture || null, t, t);
  return getUser(profile.id);
}

function getUser(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) || null;
}

function setPlan(id, plan) {
  db.prepare('UPDATE users SET plan = ? WHERE id = ?').run(plan, id);
  return getUser(id);
}

function recordUsage(userId, kind, chars, costMicros) {
  db.prepare('INSERT INTO usage (user_id, kind, chars, cost_micros, at) VALUES (?, ?, ?, ?, ?)')
    .run(userId, kind, chars | 0, Math.round(costMicros), now());
}

/* A calendar month is what a customer thinks a monthly allowance means,
   so the window is the start of this month rather than a rolling 30 days. */
function monthStart(d = new Date()) {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

function usageThisMonth(userId) {
  const since = monthStart();
  const row = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN kind = 'tts'  THEN 1 ELSE 0 END), 0) AS ttsCalls,
      COALESCE(SUM(CASE WHEN kind = 'tts'  THEN chars ELSE 0 END), 0) AS ttsChars,
      COALESCE(SUM(CASE WHEN kind = 'text' THEN 1 ELSE 0 END), 0) AS textCalls,
      COALESCE(SUM(cost_micros), 0) AS costMicros
    FROM usage WHERE user_id = ? AND at >= ?
  `).get(userId, since);
  return { ...row, since };
}

module.exports = {
  db, upsertUser, getUser, setPlan, recordUsage, usageThisMonth, monthStart, FILE
};
