import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { log } from "./logger.js";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export class Store {
  constructor(dbPath) {
    try {
      mkdirSync(dirname(dbPath), { recursive: true });
    } catch {
      /* cwd 可写即可 */
    }
    this.db = new DatabaseSync(dbPath);
    // 使用默认回滚日志（避免 WAL 在 Windows 上 process.exit 时的 libuv 断言）
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec("PRAGMA synchronous = NORMAL;");
    this._init();
  }

  _init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        user_id      INTEGER PRIMARY KEY,
        username     TEXT,
        first_name   TEXT,
        created_at   INTEGER NOT NULL,
        paused       INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS keywords (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id      INTEGER NOT NULL,
        keyword      TEXT NOT NULL,
        created_at   INTEGER NOT NULL,
        UNIQUE(user_id, keyword)
      );

      CREATE TABLE IF NOT EXISTS seen_posts (
        guid          TEXT PRIMARY KEY,
        first_seen_at INTEGER NOT NULL,
        title         TEXT
      );

      CREATE TABLE IF NOT EXISTS sent (
        user_id   INTEGER NOT NULL,
        guid      TEXT NOT NULL,
        keyword   TEXT,
        sent_at   INTEGER NOT NULL,
        PRIMARY KEY (user_id, guid)
      );

      CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_keywords_user ON keywords(user_id);
      CREATE INDEX IF NOT EXISTS idx_sent_user ON sent(user_id);
      CREATE INDEX IF NOT EXISTS idx_seen_time ON seen_posts(first_seen_at);
      CREATE INDEX IF NOT EXISTS idx_sent_time ON sent(sent_at);
    `);
    // 迁移：为旧表添加 boards / hit_count 列
    const cols = this.db.prepare("PRAGMA table_info(keywords)").all();
    const colNames = new Set(cols.map((c) => c.name));
    if (!colNames.has("boards")) {
      this.db.exec("ALTER TABLE keywords ADD COLUMN boards TEXT NOT NULL DEFAULT '*'");
    }
    if (!colNames.has("hit_count")) {
      this.db.exec("ALTER TABLE keywords ADD COLUMN hit_count INTEGER NOT NULL DEFAULT 0");
    }
  }

  // ---------- meta ----------
  getMeta(key, def = null) {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key);
    return row ? row.value : def;
  }
  setMeta(key, value) {
    this.db
      .prepare("INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, String(value));
  }

  // ---------- users ----------
  ensureUser(userId, username = null, firstName = null) {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO users(user_id, username, first_name, created_at, paused)
         VALUES(?, ?, ?, ?, 0)
         ON CONFLICT(user_id) DO UPDATE SET
           username = COALESCE(excluded.username, users.username),
           first_name = COALESCE(excluded.first_name, users.first_name)`,
      )
      .run(BigInt(userId), username, firstName, now);
  }
  userExists(userId) {
    const row = this.db.prepare("SELECT 1 FROM users WHERE user_id = ?").get(BigInt(userId));
    return !!row;
  }
  setPaused(userId, paused) {
    this.db.prepare("UPDATE users SET paused = ? WHERE user_id = ?").run(paused ? 1 : 0, BigInt(userId));
  }
  isPaused(userId) {
    const row = this.db.prepare("SELECT paused FROM users WHERE user_id = ?").get(BigInt(userId));
    return row ? row.paused === 1 : false;
  }
  countUsers() {
    return this.db.prepare("SELECT COUNT(*) AS c FROM users").get().c;
  }
  listUsers() {
    return this.db
      .prepare("SELECT user_id, username, first_name, created_at, paused FROM users ORDER BY created_at DESC")
      .all();
  }

  // ---------- keywords ----------
  addKeyword(userId, keyword) {
    const now = Date.now();
    try {
      const res = this.db
        .prepare("INSERT INTO keywords(user_id, keyword, created_at) VALUES(?, ?, ?)")
        .run(BigInt(userId), keyword, now);
      return Number(res.lastInsertRowid);
    } catch {
      return null; // 已存在
    }
  }
  getKeywordById(kwId) {
    return this.db
      .prepare("SELECT id, user_id, keyword, boards, hit_count FROM keywords WHERE id = ?")
      .get(kwId);
  }
  getKeywordBoardsById(kwId) {
    const row = this.db.prepare("SELECT boards FROM keywords WHERE id = ?").get(kwId);
    return row ? row.boards : "*";
  }
  setKeywordBoardsById(kwId, boards) {
    this.db.prepare("UPDATE keywords SET boards = ? WHERE id = ?").run(boards, kwId);
  }
  incrementHitCount(userId, keyword) {
    this.db
      .prepare("UPDATE keywords SET hit_count = hit_count + 1 WHERE user_id = ? AND keyword = ?")
      .run(BigInt(userId), keyword);
  }
  listKeywordsWithStats(userId) {
    return this.db
      .prepare("SELECT id, keyword, boards, hit_count FROM keywords WHERE user_id = ? ORDER BY id")
      .all(BigInt(userId));
  }
  removeKeyword(userId, keyword) {
    const res = this.db
      .prepare("DELETE FROM keywords WHERE user_id = ? AND keyword = ?")
      .run(BigInt(userId), keyword);
    return res.changes > 0;
  }
  listKeywords(userId) {
    const rows = this.db
      .prepare("SELECT keyword FROM keywords WHERE user_id = ? ORDER BY id")
      .all(BigInt(userId));
    return rows.map((r) => r.keyword);
  }
  countKeywords(userId) {
    return this.db.prepare("SELECT COUNT(*) AS c FROM keywords WHERE user_id = ?").get(BigInt(userId)).c;
  }

  /**
   * 返回所有「未暂停且有关键词」的用户及其关键词（含板块）。
   * [{ user_id, keywords: [{ keyword, boards }] }]
   */
  getActiveUsersWithKeywords() {
    const rows = this.db
      .prepare(
        `SELECT u.user_id AS user_id, k.keyword AS keyword, k.boards AS boards
           FROM users u
           JOIN keywords k ON k.user_id = u.user_id
          WHERE u.paused = 0
          ORDER BY u.user_id, k.id`,
      )
      .all();
    const map = new Map();
    for (const r of rows) {
      const uid = Number(r.user_id);
      if (!map.has(uid)) map.set(uid, []);
      map.get(uid).push({ keyword: r.keyword, boards: r.boards });
    }
    return Array.from(map.entries()).map(([user_id, keywords]) => ({ user_id, keywords }));
  }

  // ---------- seen / sent ----------
  countSeen() {
    return this.db.prepare("SELECT COUNT(*) AS c FROM seen_posts").get().c;
  }
  isNew(guid) {
    const row = this.db.prepare("SELECT 1 FROM seen_posts WHERE guid = ?").get(guid);
    return !row;
  }
  markSeen(guid, title = null) {
    this.db
      .prepare("INSERT OR IGNORE INTO seen_posts(guid, first_seen_at, title) VALUES(?, ?, ?)")
      .run(guid, Date.now(), title);
  }
  isSent(userId, guid) {
    const row = this.db
      .prepare("SELECT 1 FROM sent WHERE user_id = ? AND guid = ?")
      .get(BigInt(userId), guid);
    return !!row;
  }
  recordSent(userId, guid, keyword = null) {
    this.db
      .prepare("INSERT OR IGNORE INTO sent(user_id, guid, keyword, sent_at) VALUES(?, ?, ?, ?)")
      .run(BigInt(userId), guid, keyword, Date.now());
  }

  prune() {
    const now = Date.now();
    try {
      const s = this.db.prepare("DELETE FROM sent WHERE sent_at < ?").run(now - SEVEN_DAYS_MS);
      const p = this.db.prepare("DELETE FROM seen_posts WHERE first_seen_at < ?").run(now - THIRTY_DAYS_MS);
      if (s.changes || p.changes) {
        log.debug(`pruned sent=${s.changes} seen=${p.changes}`);
      }
    } catch (e) {
      log.warn(`prune 失败: ${e.message}`);
    }
  }

  // ---------- stats ----------
  stats() {
    return {
      users: this.countUsers(),
      keywords: this.db.prepare("SELECT COUNT(*) AS c FROM keywords").get().c,
      seen: this.countSeen(),
      sent: this.db.prepare("SELECT COUNT(*) AS c FROM sent").get().c,
      lastCheckAt: this.getMeta("last_check_at"),
      lastNewCount: Number(this.getMeta("last_new_count", "0")),
      totalPushed: Number(this.getMeta("total_pushed", "0")),
    };
  }

  close() {
    try {
      this.db.close();
    } catch {
      /* ignore */
    }
  }
}
