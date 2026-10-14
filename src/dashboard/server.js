// الداشبورد: سيرفر محلي بس (127.0.0.1) — صفحة وحدة + API صغير
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

// نتائج الفحص اللي بتستنى تبعتها (أو فشلت وبدها إنت)
function results() {
  return db.db
    .prepare(
      `SELECT r.id, r.chat_id, r.text, r.note, r.attachment, r.status, r.created, c.name, c.phone
       FROM replies r JOIN chats c ON c.id = r.chat_id
       WHERE r.scenario = 'result' AND r.status IN ('pending', 'queued', 'failed') ORDER BY r.created DESC`
    )
    .all()
    .map((r) => ({ ...r, image: r.attachment ? `/media/${path.basename(r.attachment)}` : null, attachment: undefined }));
}

// آخر الأرقام اللي طلبت فحص
function recent() {
  return db.db
    .prepare(
      `SELECT id, name, phone, stage, last_in FROM chats
       WHERE stage IN ('${flow.ASKED}', '${flow.RECEIVED}', 'checked') ORDER BY COALESCE(last_in, 0) DESC LIMIT 30`
    )
    .all()
    .map((c) => ({
      ...c,
      sent: !!db.db.prepare(`SELECT 1 FROM replies WHERE chat_id = ? AND scenario = 'result' AND status = 'sent'`).get(c.id),
    }));
}

async function state(wa, sender) {
  const s = settings.get();
  return {
    whatsapp: { status: wa.status, account: wa.account || null, qr: wa.qr ? await QRCode.toDataURL(wa.qr, { margin: 1, width: 260 }) : null },
    enabled: s.enabled,
    autoSend: s.autoSend,
    askText: s.askText,
    ackText: s.ackText,
    queue: sender.queue.length,
    results: results(),
    recent: recent(),
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
      if (b.autoSend) {
        patch.autoSend = {};
        if (typeof b.autoSend.enabled === 'boolean') patch.autoSend.enabled = b.autoSend.enabled;
        const min = Number(b.autoSend.afterMin);
        if (Number.isFinite(min) && min >= 0 && min <= 1440) patch.autoSend.afterMin = Math.round(min);
      }
      for (const k of ['askText', 'ackText']) if (typeof b[k] === 'string' && b[k].trim()) patch[k] = b[k].trim();
      settings.update(patch);
      return { ok: true };
    },
    'POST /api/whatsapp/relink': () => {
      wa.relink();
      return { ok: true };
    },
  };

  const actions = [
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
    // الرقم بيرجع يقدر يطلب فحص كمان مرة
    [/^POST \/api\/chats\/([^/]+)\/reset$/, (m) => {
      db.updateChat(decodeURIComponent(m[1]), { stage: 'new' });
      return { ok: true };
    }],
  ];

  const server = http.createServer(async (req, res) => {
    const key = `${req.method} ${req.url.split('?')[0]}`;
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
        if (hit) result = await hit[1](key.match(hit[0]), body);
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
