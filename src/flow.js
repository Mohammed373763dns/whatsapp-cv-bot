// البوت بيعمل شغلة وحدة: الفحص المجاني للسيرة الذاتية
//   - الموظف هو اللي بيحكي مع الزبون (وبيطلب منه سيرته). البوت ما بيرد على الكلام
//   - لما الزبون يبعت ملف، الذكاء الاصطناعي بيقرأ المحادثة وبيقرر: هل انبعت عشان الفحص؟ وأي ملف بالزبط؟
//     (بعت سيرتين وقال "افحصوا آخر وحدة"، أو بعت السيرة كذا صورة...)
//   - إذا آه: البوت بيرد بالرد الآلي، بيفحص، والنتيجة بتطلع بالداشبورد (وبتنبعت لحالها بعد ربع ساعة)
// الفحص مرة وحدة لكل رقم (من الداشبورد بتقدر تمسح سجل البوت للرقم)
const fs = require('fs');
const path = require('path');
const db = require('./db');
const settings = require('./settings');
const config = require('./config');
const xai = require('./ai/xai');
const cv = require('./cv/checker');
const { scoreCv } = require('./cv/score');
const { friendlyError } = require('./shared/system');

const RECEIVED = 'cv_received';
// أي رقم وصل لهون (أو أبعد بالنظام القديم) أخد فحصه
const USED = new Set([RECEIVED, 'checked', 'awaiting_job_title', 'quoted', 'payment_requested', 'paid', 'delivered']);
const FILE_TYPES = new Set(['document', 'image']);
// رسائل حقيقية بس. الباقي (e2e_notification وإشعارات الواتس) ما بنخزنه ولا بيبين باللوحة
const REAL_TYPES = ['chat', 'image', 'document', 'ptt', 'audio', 'video', 'sticker', 'location', 'vcard', 'multi_vcard'];
const LABELS = { document: '📄 ملف', image: '📷 صورة', ptt: '🎤 رسالة صوتية', audio: '🎤 رسالة صوتية', video: '🎥 فيديو', sticker: 'ملصق', location: '📍 موقع', vcard: '👤 جهة اتصال', multi_vcard: '👤 جهات اتصال' };
// منستنى الزبون يخلص (كذا صورة، أو "افحصوا آخر وحدة" بعد الملفات) وبعدين منقرر مرة وحدة
const WAIT_AFTER_FILE_MS = 20e3;
const WAIT_AFTER_TEXT_MS = 8e3;
// الملفات اللي بتنحسب: آخر 6 ساعات
const FILES_WINDOW_SEC = 6 * 3600;
// حد لقرارات الـAI لكل رقم باليوم (عشان زبون بيبعت كثير ما يصرف)
const MAX_DECISIONS_PER_DAY = 8;

const normalize = (t) => String(t || '')
  .replace(/[ً-ٰٟ]/g, '')
  .replace(/[أإآ]/g, 'ا')
  .replace(/ة/g, 'ه')
  .replace(/ى/g, 'ي')
  .toLowerCase();

const wantsCheck = (text) => /فحص|افحص|يفحص|تفحص|نفحص|تقييم|تقيم|قيم سيرتي|check/.test(normalize(text));
const usedCheck = (chat) => USED.has(chat?.stage);

// رد للزبون: بيمرق من الإرسال الآمن (توقيت بشري و"عم يكتب...")
function reply(chatId, kind, text, sender, extra = {}) {
  const id = db.addReply({ chatId, scenario: kind, text, source: 'bot', ...extra });
  // النتيجة بتستناك بالداشبورد (sendDueResults بيبعتها لحالها بعد الوقت المحدد)
  if (kind !== 'result') sender.enqueue(id);
  return id;
}

// نتيجة ما بعتها ولا تجاهلتها خلال الوقت المحدد بتنبعت لحالها.
// نتيجة متأخرة أكثر من 3 ساعات عن وقتها (البوت كان طافي مثلاً) ما بتنبعت لحالها: بتضل لإلك
const MAX_LATE_SEC = 3 * 3600;
function sendDueResults(sender) {
  const { enabled, afterMin } = settings.get().autoSend;
  if (!enabled) return [];
  const due = db.now() - afterMin * 60;
  const ids = db.db
    .prepare(`SELECT id FROM replies WHERE scenario = 'result' AND status = 'pending' AND text != '' AND created <= ? AND created > ?`)
    .all(due, due - MAX_LATE_SEC)
    .map((r) => r.id);
  for (const id of ids) sender.enqueue(id);
  return ids;
}

function startAutoSend(sender) {
  setInterval(() => sendDueResults(sender), 30e3);
}

// ---------------------------------------------------------------------------
// القرار: هل الملف للفحص؟ وأي ملف؟
// ---------------------------------------------------------------------------
// ملفات الزبون اللي لسا ما انفحصت: آخر 6 ساعات، وبعد آخر فحص أو آخر "مسح سجل البوت"
// (قبل: بعد المسح كان البوت يفحص السيرة القديمة اللي انفحصت قبل بدل الجديدة)
function pendingFiles(chatId) {
  const since = Math.max(db.now() - FILES_WINDOW_SEC, db.getChat(chatId)?.files_since || 0);
  return db.db
    .prepare(`SELECT id, type, body, ts FROM messages WHERE chat_id = ? AND from_me = 0 AND type IN ('document', 'image') AND ts > ? ORDER BY ts`)
    .all(chatId, since);
}
// بعد الفحص: كل الملفات لحد هون بتصير "قديمة"
const markChecked = (chatId) => db.updateChat(chatId, { stage: RECEIVED, files_since: db.now() });

const DECIDE_PROMPT = `انت مساعد لشركة بتعمل فحص مجاني للسير الذاتية على واتساب. الموظف بيحكي مع الزبون، وانت بتقرأ آخر المحادثة وبتقرر إذا الزبون بعت سيرته الذاتية عشان الفحص المجاني، وأي ملف لازم ينفحص.

- check: الزبون بعت سيرة ذاتية بسياق الفحص (هو طلب فحص، أو الموظف طلب منه يبعت سيرته للفحص، أو بعتها وحكى افحصوها).
  اختار الملفات اللي لازم تنفحص:
  * لو بعت أكتر من سيرة وحدد وحدة (مثلاً "افحصوا آخر وحدة" أو "الانجليزي") اختار هي بس.
  * لو بعت السيرة كذا صورة (صفحات من نفس السيرة) اختار كل الصور.
  * لو بعت أكتر من نسخة وما حدد اختار آخر نسخة.
- wait: الزبون لسا ما خلص أو مش واضح (مثلاً حكى رح يبعت نسخة معدلة، أو سأل سؤال وما بيّن أي ملف).
- ignore: الملفات مش سيرة للفحص (شهادة، صورة إشعار دفع، صورة شخصية، ملف بعتو لشغل تاني مش فحص...).

رجّع JSON بس بدون أي كلام تاني:
{"action":"check|wait|ignore","files":[أرقام الملفات],"reason":"سبب قصير بالعربي"}`;

function conversationText(chatId, files) {
  const num = new Map(files.map((f, i) => [f.id, i + 1]));
  return db.history(chatId, 25).map((m) => {
    const who = !m.from_me ? 'الزبون' : m.by_bot === 1 ? 'البوت' : 'الموظف';
    if (num.has(m.id)) return `${who}: [ملف ${num.get(m.id)}: ${m.type === 'image' ? 'صورة' : m.body.replace(/^📄 /, '')}]`;
    if (FILE_TYPES.has(m.type)) return `${who}: [ملف قديم انفحص قبل، تجاهله: ${m.body}]`;
    return `${who}: ${m.body}`;
  }).join('\n');
}

async function askAi(chatId, files) {
  if (!xai.available() || !process.env.XAI_MODEL_FAST) return null;
  try {
    const { text } = await xai.chat({
      purpose: 'check_decision',
      maxTokens: 200,
      temperature: 0,
      messages: [
        { role: 'system', content: DECIDE_PROMPT },
        { role: 'user', content: `المحادثة (الأقدم فوق):\n${conversationText(chatId, files)}\n\nعدد الملفات: ${files.length}` },
      ],
    });
    const d = JSON.parse(text.match(/\{[\s\S]*\}/)[0]);
    if (!['check', 'wait', 'ignore'].includes(d.action)) return null;
    return { action: d.action, files: (d.files || []).map(Number), reason: String(d.reason || '') };
  } catch (err) {
    console.error('decision AI failed:', err.message);
    return null;
  }
}

// بدون AI (مطفي أو خلص السقف): إذا انحكى عن الفحص بآخر المحادثة → آخر ملف
// (وإذا آخر ملف صورة: كل الصور اللي انبعتت معها، لأنها غالباً صفحات نفس السيرة)
function fallbackDecision(chatId, files) {
  const talkedAboutCheck = db.history(chatId, 15).some((m) => m.type === 'chat' && wantsCheck(m.body));
  if (!talkedAboutCheck) return { action: 'ignore', files: [], reason: 'ما انحكى عن فحص (بدون AI)' };
  const last = files[files.length - 1];
  const picked = last.type === 'image'
    ? files.map((f, i) => [f, i + 1]).filter(([f]) => f.type === 'image' && last.ts - f.ts <= 120).map(([, n]) => n)
    : [files.length];
  return { action: 'check', files: picked, reason: 'انحكى عن الفحص (بدون AI)' };
}

const timers = new Map();
const decisionsToday = new Map(); // chatId → { day, n }

function schedule(chatId, ms, sender, wa) {
  clearTimeout(timers.get(chatId));
  timers.set(chatId, setTimeout(() => {
    timers.delete(chatId);
    decide(chatId, sender, wa).catch((err) => console.error('decide error:', err.message));
  }, ms));
}

function underDailyLimit(chatId) {
  const day = new Date().toDateString();
  const c = decisionsToday.get(chatId);
  const n = c && c.day === day ? c.n : 0;
  if (n >= MAX_DECISIONS_PER_DAY) return false;
  decisionsToday.set(chatId, { day, n: n + 1 });
  return true;
}

async function decide(chatId, sender, wa) {
  const chat = db.getChat(chatId);
  if (!settings.get().enabled || !chat || chat.muted || usedCheck(chat)) return null;
  const files = pendingFiles(chatId);
  if (!files.length || !underDailyLimit(chatId)) return null;

  const d = (await askAi(chatId, files)) || fallbackDecision(chatId, files);
  console.log(`decision ${chatId}: ${d.action} ${JSON.stringify(d.files)} — ${d.reason}`);
  // ممكن الموظف فحص بإيده أو الرقم انسكت واحنا بنستنى الـAI
  const fresh = db.getChat(chatId);
  if (d.action !== 'check' || fresh.muted || usedCheck(fresh)) return d;

  let picked = d.files.map((n) => files[n - 1]).filter(Boolean);
  if (!picked.length) picked = [files[files.length - 1]];
  markChecked(chatId);
  reply(chatId, 'ack', settings.get().ackText, sender);
  runCheck(chatId, picked, wa, sender, d.reason).catch((err) => failed(chatId, `الفحص فشل: ${friendlyError(err.message)}`));
  return d;
}

// فحص بإيدك من الداشبورد (بدون الرد الآلي)
function checkNow(chatId, msgIds, sender, wa) {
  const rows = msgIds.map((id) => db.db.prepare(`SELECT id, type, body, ts FROM messages WHERE id = ? AND chat_id = ?`).get(id, chatId)).filter(Boolean);
  if (!rows.length) return { error: 'الملف مش موجود' };
  markChecked(chatId);
  runCheck(chatId, rows, wa, sender, 'فحص من الداشبورد').catch((err) => failed(chatId, `الفحص فشل: ${friendlyError(err.message)}`));
  return { ok: true };
}

// ---------------------------------------------------------------------------
// الفحص
// ---------------------------------------------------------------------------
// الزبون أخد رسالة "الفريق رح يفحصها"، فإذا الفحص فشل بتطلعلك بالداشبورد تكتب النتيجة بإيدك
const failed = (chatId, note) => db.addReply({ chatId, scenario: 'result', text: '', source: 'bot', note });

async function runCheck(chatId, msgs, wa, sender, why = '') {
  const cfg = settings.get().cv;
  const files = [];
  for (const m of msgs) {
    const f = await wa.downloadMedia(m.id);
    if (f) files.push({ ...f, filename: f.filename || (m.body || '').replace(/^📄 /, '') });
  }
  if (!files.length) return failed(chatId, 'ما قدرت أنزّل الملف — افتحه من الواتس وافحصه إنت');

  // الدرجة من API موقعك (opti) وكرت الدرجة بيترسم هون — بدون Chrome
  const optiJob = cfg.useOpti
    ? scoreCv(files, { baseUrl: cfg.optiUrl, botKey: process.env.OPTI_BOT_KEY }).catch((err) => ({ error: friendlyError(err.message) }))
    : Promise.resolve({ error: 'برنامج الفحص مطفي' });

  const [result, opti] = await Promise.all([cv.check({ files }), optiJob]);
  if (result.unsupported) return failed(chatId, `نوع الملف مش مدعوم: ${files[0].filename || files[0].mimetype}`);

  let text = result.text;
  let attachment = null;
  if (opti && !opti.error) {
    text = insertScore(text, opti.score, cfg.scoreLine);
    const dir = path.join(config.OUTPUT_DIR, 'media');
    fs.mkdirSync(dir, { recursive: true });
    attachment = path.join(dir, `check-${Date.now()}.jpg`);
    fs.writeFileSync(attachment, opti.image);
  }
  text = cv.withClosing(text, cfg.closing, opti && !opti.error ? opti.score : null);
  const note = [
    why,
    files.map((f) => f.filename || 'صورة').join('، '),
    opti && !opti.error ? `الدرجة ${opti.score}%` : `بدون صورة الدرجة: ${opti?.error}`,
  ].filter(Boolean).join(' · ');
  reply(chatId, 'result', text, sender, { note, attachment });
}

// "يعطيكي العافية استاذة داليا" ← وبعدها سطر الدرجة
function insertScore(text, score, template) {
  const line = template.replace('{score}', score);
  const paras = text.split(/\n\s*\n/);
  if (/^في عندك/.test(paras[1] || '')) paras[1] = `${line} و ${paras[1]}`;
  else paras.splice(1, 0, line);
  return paras.join('\n\n');
}

async function handle(msg, sender, wa) {
  // نفس الرسالة ما بتنعالج مرتين (البوت بيرجع يشيك على الرسائل بعد التشغيل)
  if (!REAL_TYPES.includes(msg.type)) return;
  if (db.db.prepare('SELECT 1 FROM messages WHERE id = ?').get(msg.id)) return;
  db.saveChat({ id: msg.chatId, name: msg.name, phone: msg.phone });
  const label = msg.type === 'document' ? `📄 ${msg.filename || 'ملف'}` : LABELS[msg.type] || '';
  // صورة أو ملف مع تعليق: منبيّن الاتنين
  const shown = msg.type === 'chat' ? msg.body : [label, msg.body].filter(Boolean).join('\n');
  // رسالة منك من اللوحة أو من البوت (مش من جوال الموظف)
  const echo = msg.fromMe ? sender.isBotEcho(msg) || 0 : 0;
  db.saveMessage({ ...msg, body: shown, byBot: echo });
  if (msg.fromMe) return;
  if (!settings.get().enabled) return;
  const chat = db.getChat(msg.chatId);
  if (chat.muted || usedCheck(chat)) return;

  // ملف جديد ← منستنى يخلص ومنقرر. كلام بعد ملفات ("افحصوا آخر وحدة") ← منقرر من جديد
  if (FILE_TYPES.has(msg.type)) schedule(msg.chatId, WAIT_AFTER_FILE_MS, sender, wa);
  else if (msg.type === 'chat' && (timers.has(msg.chatId) || pendingFiles(msg.chatId).length)) {
    schedule(msg.chatId, timers.has(msg.chatId) ? WAIT_AFTER_FILE_MS : WAIT_AFTER_TEXT_MS, sender, wa);
  }
}

module.exports = { REAL_TYPES, handle, decide, checkNow, wantsCheck, usedCheck, sendDueResults, startAutoSend, RECEIVED };
