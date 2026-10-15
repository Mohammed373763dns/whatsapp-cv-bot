// الداشبورد: صفحة وحدة + API صغير. على اللابتوب محلي بس، وعلى Railway بكلمة سر
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const QRCode = require('qrcode');
const db = require('../db');
const config = require('../config');
const settings = require('../settings');
const { DASHBOARD_PORT } = require('../config/bot');
const flow = require('../flow');

const mediaUrl = (p) => (p ? `/media/${path.basename(p)}` : null);

// نتائج الفحص اللي بتستنى تبعتها (أو فشلت وبدها إنت)
function results() {
  return db.db
    .prepare(
      `SELECT r.id, r.chat_id, r.text, r.note, r.attachment, r.status, r.created, r.queued_at, c.name, c.phone
       FROM replies r JOIN chats c ON c.id = r.chat_id
       WHERE r.scenario = 'result' AND r.status IN ('pending', 'queued', 'failed') ORDER BY r.created DESC`
    )
    .all()
    .map(({ attachment, ...r }) => ({ ...r, image: mediaUrl(attachment) }));
}

// حالة الرقم عند البوت
function botStatus(c) {
  if (c.muted) return 'muted';
  if (c.result_sent) return 'sent';
  if (flow.usedCheck(c)) return 'checked';
  return 'new';
}

// كل الأرقام والمحادثات (الأحدث فوق)
function chatList(q = '') {
  const like = `%${q.trim()}%`;
  return db.db
    .prepare(
      `SELECT c.id, c.name, c.phone, c.stage, c.muted, c.last_in, c.last_out,
         (SELECT body FROM messages m WHERE m.chat_id = c.id ORDER BY ts DESC LIMIT 1) AS last_body,
         (SELECT from_me FROM messages m WHERE m.chat_id = c.id ORDER BY ts DESC LIMIT 1) AS last_from_me,
         EXISTS (SELECT 1 FROM replies r WHERE r.chat_id = c.id AND r.scenario = 'result' AND r.status = 'sent') AS result_sent,
         EXISTS (SELECT 1 FROM replies r WHERE r.chat_id = c.id AND r.scenario = 'result' AND r.status IN ('pending', 'failed')) AS waiting
       FROM chats c
       WHERE EXISTS (SELECT 1 FROM messages m WHERE m.chat_id = c.id)
         AND (? = '%%' OR c.name LIKE ? OR c.phone LIKE ?)
       ORDER BY MAX(COALESCE(c.last_in, 0), COALESCE(c.last_out, 0)) DESC LIMIT 300`
    )
    .all(like, like, like)
    .map((c) => ({ ...c, status: botStatus(c) }));
}

function chatDetail(id) {
  const chat = chatList().find((c) => c.id === id) || db.getChat(id);
  if (!chat) return { error: 'المحادثة مش موجودة' };
  const replies = db.db
    .prepare(`SELECT id, scenario, text, note, status, created, queued_at, attachment FROM replies WHERE chat_id = ? AND status IN ('pending', 'queued', 'failed') ORDER BY id`)
    .all(id)
    .map(({ attachment, ...r }) => ({ ...r, image: mediaUrl(attachment) }));
  return { chat: { ...chat, status: botStatus(chat) }, messages: db.history(id, 300), replies };
}

async function state(wa, sender) {
  const s = settings.get();
  return {
    whatsapp: { ready: !!wa.ready, status: wa.status, account: wa.account || null, qr: wa.qr ? await QRCode.toDataURL(wa.qr, { margin: 1, width: 260 }) : null },
    enabled: s.enabled,
    autoSend: s.autoSend,
    ackText: s.ackText,
    queue: sender.queue.length,
    memory: require('../shared/system').memory(),
    results: results(),
  };
}

// كلمة سر للداشبورد (لازمة على السيرفر): المتصفح بيطلبها مرة وبيحفظها
function authorized(req, password) {
  if (!password) return true;
  const m = /^Basic (.+)$/.exec(req.headers.authorization || '');
  if (!m) return false;
  const given = Buffer.from(Buffer.from(m[1], 'base64').toString().replace(/^[^:]*:/, ''));
  const want = Buffer.from(password);
  return given.length === want.length && crypto.timingSafeEqual(given, want);
}

function readBody(req) {
  return new Promise((resolve) => {
    let s = '';
    req.on('data', (c) => (s += c));
    req.on('end', () => {
      try {
        resolve(s ? JSON.parse(s) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function start({ wa, sender }) {
  const pub = (f) => path.join(__dirname, 'public', f);
  // Railway بيعطي PORT: الداشبورد بتصير أونلاين، فبدون كلمة سر ما منشغّلها
  const isPublic = Boolean(process.env.PORT);
  const password = process.env.DASHBOARD_PASSWORD || '';
  if (isPublic && !password) {
    console.error('DASHBOARD_PASSWORD is not set — the dashboard will refuse every request. Add it in Railway → Variables.');
  }

  const routes = {
    'GET /api/state': () => state(wa, sender),
    'POST /api/settings': (b) => {
      const patch = {};
      if (typeof b.enabled === 'boolean') patch.enabled = b.enabled;
      if (typeof b.ackText === 'string' && b.ackText.trim()) patch.ackText = b.ackText.trim();
      if (b.autoSend) {
        patch.autoSend = {};
        if (typeof b.autoSend.enabled === 'boolean') patch.autoSend.enabled = b.autoSend.enabled;
        const min = Number(b.autoSend.afterMin);
        if (Number.isFinite(min) && min >= 0 && min <= 1440) patch.autoSend.afterMin = Math.round(min);
      }
      settings.update(patch);
      return { ok: true };
    },
    'POST /api/whatsapp/relink': () => {
      wa.relink();
      return { ok: true };
    },
  };

  const chatId = (m) => decodeURIComponent(m[1]);
  const actions = [
    [/^GET \/api\/chats$/, (m, b, q) => chatList(q.get('q') || '')],
    [/^GET \/api\/chats\/([^/]+)$/, (m) => chatDetail(chatId(m))],
    // مسح سجل البوت: الرقم بيرجع جديد (بيقدر ينفحص مرة كمان)، والمحادثة نفسها بتضل
    [/^POST \/api\/chats\/([^/]+)\/reset$/, (m) => {
      const id = chatId(m);
      sender.cancelForChat(id);
      // الملفات اللي قبل المسح ما بتنحسب: البوت بيستنى سيرة جديدة
      db.updateChat(id, { stage: 'new', files_since: db.now() });
      db.db.prepare('DELETE FROM replies WHERE chat_id = ?').run(id);
      return { ok: true };
    }],
    // حذف المحادثة من اللوحة (رسائل الواتس نفسها ما بتنمسح). لو الزبون بعت كمان بترجع تبيّن
    [/^POST \/api\/chats\/([^/]+)\/delete$/, (m) => {
      const id = chatId(m);
      sender.cancelForChat(id);
      for (const t of ['messages', 'replies']) db.db.prepare(`DELETE FROM ${t} WHERE chat_id = ?`).run(id);
      db.db.prepare('DELETE FROM chats WHERE id = ?').run(id);
      return { ok: true };
    }],
    [/^POST \/api\/chats\/([^/]+)\/mute$/, (m, b) => {
      db.updateChat(chatId(m), { muted: b.muted ? 1 : 0 });
      return { ok: true };
    }],
    [/^POST \/api\/chats\/([^/]+)\/check$/, (m, b) => flow.checkNow(chatId(m), [].concat(b.msgIds || []), sender, wa)],
    // رسالة منك من الداشبورد (بتمرق من الإرسال الآمن)
    [/^POST \/api\/chats\/([^/]+)\/send$/, (m, b) => {
      const text = String(b.text || '').trim();
      if (!text) return { error: 'اكتب الرسالة' };
      sender.enqueue(db.addReply({ chatId: chatId(m), scenario: 'manual', text, source: 'manual' }));
      return { ok: true };
    }],
    [/^POST \/api\/replies\/(\d+)\/send$/, (m, b) => {
      const r = db.getReply(Number(m[1]));
      if (!r) return { error: 'not found' };
      const text = String(b.text ?? r.text).trim();
      if (!text) return { error: 'اكتب نتيجة الفحص قبل ما تبعت' };
      if (text !== r.text) db.setReplyStatus(r.id, r.status, { text, edited: 1 });
      sender.enqueue(r.id);
      return { ok: true };
    }],
    [/^POST \/api\/replies\/(\d+)\/dismiss$/, (m) => {
      db.setReplyStatus(Number(m[1]), 'dismissed');
      return { ok: true };
    }],
  ];

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const key = `${req.method} ${url.pathname}`;
    // فحص صحة لـ Railway (بدون كلمة سر وبدون أي بيانات)
    if (key === 'GET /health') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end('ok');
    }
    if ((isPublic && !password) || !authorized(req, password)) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="dashboard", charset="UTF-8"', 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end(isPublic && !password ? 'DASHBOARD_PASSWORD is not set' : 'كلمة السر غلط');
    }
    try {
      const asset = { 'GET /': ['index.html', 'text/html'], 'GET /app.css': ['app.css', 'text/css'], 'GET /app.js': ['app.js', 'text/javascript'] }[key];
      if (asset) {
        res.writeHead(200, { 'Content-Type': `${asset[1]}; charset=utf-8`, 'Cache-Control': 'no-store' });
        return res.end(fs.readFileSync(pub(asset[0])));
      }
      // صور الدرجة (من data/media بس، بدون مسارات)
      const media = /^GET \/media\/([\w.-]+\.jpg)$/.exec(key);
      if (media) {
        const file = path.join(config.OUTPUT_DIR, 'media', media[1]);
        if (!fs.existsSync(file)) {
          res.writeHead(404);
          return res.end();
        }
        res.writeHead(200, { 'Content-Type': 'image/jpeg' });
        return res.end(fs.readFileSync(file));
      }
      const body = req.method === 'POST' ? await readBody(req) : {};
      let result;
      if (routes[key]) result = await routes[key](body);
      else {
        const hit = actions.find(([re]) => re.test(key));
        if (hit) result = await hit[1](key.match(hit[0]), body, url.searchParams);
      }
      if (result === undefined) {
        res.writeHead(404);
        return res.end();
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  });

  const port = Number(process.env.PORT || process.env.DASHBOARD_PORT) || DASHBOARD_PORT;
  server.listen(port, isPublic ? '0.0.0.0' : '127.0.0.1', () => console.log(`Dashboard: http://localhost:${port}`));
  return server;
}

module.exports = { start };
