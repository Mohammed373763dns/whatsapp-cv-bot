// قاعدة البيانات: SQLite المدمج بـ Node (ملف واحد، بدون سيرفر ولا مكتبات)
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { DB_FILE } = require('../config/bot');

// BOT_DB_FILE بيخلي الاختبارات تستخدم قاعدة بيانات منفصلة
const file = process.env.BOT_DB_FILE || DB_FILE;
if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
const db = new DatabaseSync(file);

db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS chats (
    id TEXT PRIMARY KEY,
    name TEXT,
    phone TEXT,
    stage TEXT DEFAULT 'new',        -- آخر سيناريو وصلته المحادثة
    handoff INTEGER DEFAULT 0,       -- 1 = محوّلة إلك، البوت ما بيرد
    last_in INTEGER,                 -- آخر رسالة من الزبون
    last_out INTEGER,                -- آخر رسالة منك/من البوت
    followups_sent INTEGER DEFAULT 0,
    paid INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    chat_id TEXT,
    from_me INTEGER,
    type TEXT,
    body TEXT,
    ts INTEGER,
    by_bot INTEGER DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, ts);

  -- الردود اللي البوت جهّزها (مقترحة أو انبعتت)
  CREATE TABLE IF NOT EXISTS replies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT,
    scenario TEXT,
    intent TEXT,
    text TEXT,
    source TEXT,                     -- template | ai | followup
    status TEXT DEFAULT 'pending',   -- pending | queued | sent | dismissed | failed
    edited INTEGER DEFAULT 0,
    created INTEGER,
    sent_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_replies_status ON replies(status);

  CREATE TABLE IF NOT EXISTS ai_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER,
    purpose TEXT,
    model TEXT,
    input_tokens INTEGER,
    cached_tokens INTEGER,
    output_tokens INTEGER,
    usd REAL
  );

  -- طلبات الفحص: كل فحص (تلقائي أو من اللوحة) وحالته. الحالة النهائية من رد النتيجة (reply_id)
  CREATE TABLE IF NOT EXISTS requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT,
    msg_ids TEXT,                    -- JSON: رسائل الملفات (لإعادة الفحص)
    files TEXT,                      -- أسماء الملفات للعرض
    reason TEXT,                     -- ليش انفحص (قرار الـAI أو "من اللوحة")
    started INTEGER,
    finished INTEGER,
    reply_id INTEGER,
    error TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_requests_chat ON requests(chat_id);

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);

// أعمدة انضافت بعدين (للقواعد القديمة)
for (const sql of ['ALTER TABLE chats ADD COLUMN muted INTEGER DEFAULT 0', 'ALTER TABLE chats ADD COLUMN files_since INTEGER DEFAULT 0', 'ALTER TABLE replies ADD COLUMN note TEXT', 'ALTER TABLE replies ADD COLUMN queued_at INTEGER', 'ALTER TABLE replies ADD COLUMN attachment TEXT', 'ALTER TABLE replies ADD COLUMN pace TEXT', 'ALTER TABLE chats ADD COLUMN files_from INTEGER DEFAULT 0']) {
  try {
    db.exec(sql);
  } catch {}
}

const now = () => Math.floor(Date.now() / 1000);

const stmt = {
  upsertChat: db.prepare(`
    INSERT INTO chats (id, name, phone) VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name = COALESCE(excluded.name, chats.name),
                                  phone = COALESCE(excluded.phone, chats.phone)`),
  getChat: db.prepare('SELECT * FROM chats WHERE id = ?'),
  addMessage: db.prepare(`
    INSERT OR IGNORE INTO messages (id, chat_id, from_me, type, body, ts, by_bot)
    VALUES (?, ?, ?, ?, ?, ?, ?)`),
  history: db.prepare(`
    SELECT * FROM (SELECT * FROM messages WHERE chat_id = ? ORDER BY ts DESC LIMIT ?)
    ORDER BY ts ASC`),
  addReply: db.prepare(`
    INSERT INTO replies (chat_id, scenario, intent, text, source, status, created, note, attachment, pace)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  getSetting: db.prepare('SELECT value FROM settings WHERE key = ?'),
  setSetting: db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`),
};

module.exports = {
  db,
  now,

  saveChat(chat) {
    stmt.upsertChat.run(chat.id, chat.name || null, chat.phone || null);
  },
  getChat: (id) => stmt.getChat.get(id),
  updateChat(id, fields) {
    const keys = Object.keys(fields);
    if (!keys.length) return;
    db.prepare(`UPDATE chats SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
      .run(...keys.map((k) => fields[k]), id);
  },

  saveMessage(m) {
    stmt.addMessage.run(m.id, m.chatId, m.fromMe ? 1 : 0, m.type, m.body || '', m.timestamp, Number(m.byBot) || 0);
    this.updateChat(m.chatId, m.fromMe ? { last_out: m.timestamp } : { last_in: m.timestamp });
  },
  history: (chatId, limit = 20) => stmt.history.all(chatId, limit),

  addReply(r) {
    const info = stmt.addReply.run(r.chatId, r.scenario, r.intent || null, r.text, r.source, r.status || 'pending', now(), r.note || null, r.attachment || null, r.pace || null);
    return Number(info.lastInsertRowid);
  },
  getReply: (id) => db.prepare('SELECT * FROM replies WHERE id = ?').get(id),
  setReplyStatus(id, status, extra = {}) {
    const fields = { status, ...extra };
    const keys = Object.keys(fields);
    db.prepare(`UPDATE replies SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
      .run(...keys.map((k) => fields[k]), id);
  },

  logAi(u) {
    db.prepare(`INSERT INTO ai_usage (ts, purpose, model, input_tokens, cached_tokens, output_tokens, usd)
                VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(now(), u.purpose, u.model, u.input, u.cached, u.output, u.usd);
  },
  aiSpentToday() {
    const start = Math.floor(new Date().setHours(0, 0, 0, 0) / 1000);
    return db.prepare('SELECT COALESCE(SUM(usd), 0) AS usd FROM ai_usage WHERE ts >= ?').get(start).usd;
  },

  getSetting(key, fallback = null) {
    const row = stmt.getSetting.get(key);
    return row ? JSON.parse(row.value) : fallback;
  },
  setSetting(key, value) {
    stmt.setSetting.run(key, JSON.stringify(value));
  },
};
