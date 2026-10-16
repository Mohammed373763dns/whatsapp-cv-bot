// البوت بيعمل شغلة وحدة: فحص الملف اللي بينبعتله
//   - أي ملف → "شو رقم صاحب الملف؟" وبيستنى الرقم. بعد الرقم: "جاري الفحص"
//   - لما يخلص: النتيجة للمستخدم فوراً، ومعها زر (استطلاع بخيار واحد، لأن واتساب ما بعرض أزرار الرد) يحوّل الفحص لرقم صاحب الملف
//   - الكلام العادي ما بيرد عليه. كل رقم بقدر يبعت كم ملف ما بدّه، وكل ملف بينفحص
const fs = require('fs');
const path = require('path');
const db = require('./db');
const settings = require('./settings');
const config = require('./config');
const cv = require('./cv/checker');
const { scoreCv } = require('./cv/score');
const { friendlyError } = require('./shared/system');

const RECEIVED = 'cv_received';
// أي رقم وصل لهون (أو أبعد بالنظام القديم) أخد فحصه
const USED = new Set([RECEIVED, 'checked', 'awaiting_job_title', 'quoted', 'payment_requested', 'paid', 'delivered']);
const FILE_TYPES = new Set(['document', 'image']);
// رسائل حقيقية بس. الباقي (e2e_notification وإشعارات الواتس) ما بنخزنه ولا بيبين باللوحة
const REAL_TYPES = ['chat', 'image', 'document', 'ptt', 'audio', 'video', 'sticker', 'location', 'vcard', 'multi_vcard', 'buttons_response', 'template_button_reply'];
const LABELS = { document: '📄 ملف', image: '📷 صورة', ptt: '🎤 رسالة صوتية', audio: '🎤 رسالة صوتية', video: '🎥 فيديو', sticker: 'ملصق', location: '📍 موقع', vcard: '👤 جهة اتصال', multi_vcard: '👤 جهات اتصال' };
// ثواني قليلة بس عشان كم صورة لنفس الملف تنفحص مع بعض، وبعدين السؤال والفحص فوراً
const FILE_WAIT_MS = 2e3;
const ASK_PHONE = 'شو رقم صاحب الملف؟';
const CHECKING = 'جاري الفحص';
const SEND_BUTTON = 'أرسل الفحص لهذا الرقم';
const COUNTRY_CODES = ['970', '972', '962', '966', '971', '965', '968', '974', '973', '964', '963', '961', '967', '249', '212', '213', '216', '218', '20', '90', '44', '49', '33', '1'];

const normalize = (t) => String(t || '')
  .replace(/[ً-ٰٟ]/g, '')
  .replace(/[أإآ]/g, 'ا')
  .replace(/ة/g, 'ه')
  .replace(/ى/g, 'ي')
  .toLowerCase();

const wantsCheck = (text) => /فحص|افحص|يفحص|تفحص|نفحص|تقييم|تقيم|قيم سيرتي|check/.test(normalize(text));
const usedCheck = (chat) => USED.has(chat?.stage);

// رد للزبون: بيمرق من الإرسال الآمن (توقيت بشري و"عم يكتب...")
// نتيجة الفحص التلقائي بتنبعت على طول (deliver). فحص اللوحة بيستنى المراجعة
function reply(chatId, kind, text, sender, extra = {}) {
  const id = db.addReply({ chatId, scenario: kind, text, source: 'bot', ...extra, pace: extra.pace || 'now' });
  if (text && (extra.deliver || kind !== 'result')) sender.enqueue(id);
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
// رقم صاحب الملف + زر التحويل
// ---------------------------------------------------------------------------
const countryCode = (phone) => {
  const p = String(phone || '').replace(/\D/g, '');
  return COUNTRY_CODES.find((c) => p.startsWith(c)) || null;
};

// 962791234567 أو +962 79... أو رقم محلي 079... بمقدمة دولة اللي بعت الملف
function parsePhone(text, senderPhone) {
  const raw = String(text || '');
  const chunks = raw.match(/\d[\d\s().+-]{6,}\d/g) || [];
  let best = '';
  for (const c of chunks) {
    let d = c.replace(/\D/g, '');
    if (d.startsWith('00')) d = d.slice(2);
    if (d.length > best.length) best = d;
  }
  if (!best) {
    let d = raw.replace(/\D/g, '');
    if (d.startsWith('00')) d = d.slice(2);
    best = d;
  }
  if (!best) return null;
  if (best.startsWith('0')) {
    const cc = countryCode(senderPhone);
    if (!cc) return null;
    best = cc + best.replace(/^0+/, '');
  }
  if (best.length < 10 || best.length > 15) return null;
  return best;
}

const looksLikePhoneAttempt = (text) => String(text || '').replace(/\D/g, '').length >= 6;
const wantsForward = (text) => {
  const t = normalize(text).trim();
  return /^(ارسل|ابعت|ابعث|نعم)$/.test(t) || t.includes('ارسل الفحص');
};

const getJob = (id) => db.db.prepare('SELECT * FROM file_checks WHERE id = ?').get(id);
const jobWaitingPhone = (chatId) => db.db.prepare(
  `SELECT * FROM file_checks WHERE chat_id = ? AND owner_phone IS NULL AND status = 'awaiting_phone' ORDER BY id DESC LIMIT 1`
).get(chatId);
const openOffer = (chatId) => db.db.prepare(
  `SELECT * FROM file_checks WHERE chat_id = ? AND status = 'offer' ORDER BY id DESC LIMIT 1`
).get(chatId);

// فحص اللوحة: الملفات اللي قبل المسح ما بتنعاد
const markChecked = (chatId) => db.updateChat(chatId, { stage: RECEIVED, files_since: db.now() });

const batches = new Map();
function scheduleFiles(chatId, msgId, sender, wa) {
  const batch = batches.get(chatId) || { ids: [] };
  if (!batch.ids.includes(msgId)) batch.ids.push(msgId);
  clearTimeout(batch.timer);
  batch.timer = setTimeout(() => {
    batches.delete(chatId);
    startJob(chatId, batch.ids, sender, wa).catch((err) => console.error('check error:', err.message));
  }, FILE_WAIT_MS);
  batches.set(chatId, batch);
}

function rememberPhone(chatId, phone, sender, wa) {
  const job = jobWaitingPhone(chatId);
  if (!job) return false;
  db.db.prepare('UPDATE file_checks SET owner_phone = ? WHERE id = ?').run(phone, job.id);
  beginCheck(job.id, sender, wa).catch((err) => console.error('check error:', err.message));
  return true;
}

// زر الإرسال: واتساب ما بعرض أزرار الرد، فبنبعت استطلاع بخيار واحد والمستخدم بضغطه
function sendOffer(jobId, sender) {
  const job = getJob(jobId);
  if (!job?.owner_phone || job.status !== 'ready' || !job.reply_id) return;
  const updated = db.db.prepare(`UPDATE file_checks SET status = 'offer' WHERE id = ? AND status = 'ready'`).run(jobId);
  if (!updated.changes) return;
  reply(job.chat_id, 'offer', `إرسال نتيجة الفحص للرقم ${job.owner_phone}`, sender, {
    buttons: [{ id: `fwd:${jobId}`, body: SEND_BUTTON }],
  });
}

function onPollVote({ parentId, chatId } = {}, sender) {
  let job = parentId
    ? db.db.prepare(`SELECT * FROM file_checks WHERE offer_msg = ? AND status = 'offer'`).get(parentId)
    : null;
  if (!job && chatId) job = db.db.prepare(`SELECT * FROM file_checks WHERE chat_id = ? AND status = 'offer' ORDER BY id DESC LIMIT 1`).get(chatId);
  if (!job) return false;
  return forwardCheck(job.chat_id, job.id, sender);
}

function forwardCheck(chatId, jobId, sender) {
  const job = getJob(jobId);
  if (!job || job.chat_id !== chatId || job.status !== 'offer') return false;
  const result = db.getReply(job.reply_id);
  if (!result?.text) return false;
  const updated = db.db.prepare(`UPDATE file_checks SET status = 'forwarded' WHERE id = ? AND status = 'offer'`).run(jobId);
  if (!updated.changes) return false;
  const ownerId = `${job.owner_phone}@c.us`;
  db.saveChat({ id: ownerId, phone: job.owner_phone });
  reply(ownerId, 'result', result.text, sender, { attachment: result.attachment, note: `تحويل الفحص #${jobId}`, deliver: true });
  reply(chatId, 'ack', `تم إرسال الفحص للرقم ${job.owner_phone}`, sender);
  return true;
}

// الفحص خلص: النتيجة للي بعت الملف، والزر إذا الرقم وصل
function settleJob(jobId, out, sender) {
  const job = getJob(jobId);
  if (!job || job.status !== 'checking') return;
  const result = out?.replyId ? db.getReply(out.replyId) : null;
  if (!result?.text || out?.error) {
    db.db.prepare('UPDATE file_checks SET status = ?, reply_id = ? WHERE id = ?').run('failed', out?.replyId || null, jobId);
    if (!result?.text) reply(job.chat_id, 'ack', 'ما قدرنا نكمل الفحص، رح نرجعلك', sender);
    return;
  }
  db.db.prepare('UPDATE file_checks SET status = ?, reply_id = ? WHERE id = ?').run('ready', result.id, jobId);
  sender.enqueue(result.id);
  sendOffer(jobId, sender);
}

async function beginCheck(jobId, sender, wa) {
  const job = getJob(jobId);
  if (!job?.owner_phone) return;
  const updated = db.db.prepare(`UPDATE file_checks SET status = 'checking' WHERE id = ? AND status = 'awaiting_phone'`).run(jobId);
  if (!updated.changes) return;
  reply(job.chat_id, 'checking', CHECKING, sender);
  const ids = JSON.parse(job.msg_ids || '[]');
  const rows = ids
    .map((id) => db.db.prepare('SELECT id, type, body, ts FROM messages WHERE id = ? AND chat_id = ?').get(id, job.chat_id))
    .filter(Boolean);
  settleJob(jobId, await runCheck(job.chat_id, rows, wa, sender, 'ملف من الزبون'), sender);
}

async function startJob(chatId, msgIds, sender, wa) {
  if (!settings.get().enabled) return;
  const chat = db.getChat(chatId);
  if (!chat || chat.muted) return;
  const since = chat.files_since || 0;
  const rows = msgIds
    .map((id) => db.db.prepare('SELECT id, type, body, ts FROM messages WHERE id = ? AND chat_id = ?').get(id, chatId))
    .filter((m) => m && m.ts > since);
  if (!rows.length) return;

  const jobId = Number(db.db.prepare(`INSERT INTO file_checks (chat_id, msg_ids, status, created) VALUES (?, ?, 'awaiting_phone', ?)`)
    .run(chatId, JSON.stringify(rows.map((m) => m.id)), db.now()).lastInsertRowid);
  const early = db.history(chatId, 12).filter((m) => !m.from_me && m.type === 'chat' && m.ts >= rows[0].ts);
  let phone = null;
  for (const m of early) {
    phone = parsePhone(m.body, chat.phone);
    if (phone) break;
  }
  // الفحص ما بيبلّش إلا بعد الرقم. كل ملف جديد إله فحص لحاله
  if (!phone) {
    reply(chatId, 'ask_phone', ASK_PHONE, sender);
    return;
  }
  db.db.prepare('UPDATE file_checks SET owner_phone = ? WHERE id = ?').run(phone, jobId);
  await beginCheck(jobId, sender, wa);
}

// فحص بإيدك من الداشبورد (بدون الرد الآلي)
function checkNow(chatId, msgIds, sender, wa) {
  const rows = msgIds.map((id) => db.db.prepare(`SELECT id, type, body, ts FROM messages WHERE id = ? AND chat_id = ?`).get(id, chatId)).filter(Boolean);
  if (!rows.length) return { error: 'الملف مش موجود' };
  markChecked(chatId);
  runCheck(chatId, rows, wa, sender, 'فحص من الداشبورد');
  return { ok: true };
}

// ---------------------------------------------------------------------------
// الفحص
// ---------------------------------------------------------------------------
// الزبون أخد رسالة "الفريق رح يفحصها"، فإذا الفحص فشل بتطلعلك بالداشبورد تكتب النتيجة بإيدك
const failed = (chatId, note) => db.addReply({ chatId, scenario: 'result', text: '', source: 'bot', note });

// كل فحص بينسجل كطلب (صفحة "الطلبات" باللوحة)، وبيخلص يا بنتيجة يا بفشل — ما في طلب بيضل معلّق
async function runCheck(chatId, msgs, wa, sender, why = '') {
  const names = msgs.map((m) => (m.body || '').split('\n')[0].replace(/^📄 /, '') || 'ملف').join('، ');
  const reqId = Number(db.db.prepare('INSERT INTO requests (chat_id, msg_ids, files, reason, started) VALUES (?, ?, ?, ?, ?)')
    .run(chatId, JSON.stringify(msgs.map((m) => m.id)), names, why, db.now()).lastInsertRowid);
  const finish = (replyId, error = null) => {
    db.db.prepare('UPDATE requests SET finished = ?, reply_id = ?, error = ? WHERE id = ?').run(db.now(), replyId, error, reqId);
    return replyId;
  };
  try {
    const out = await checkFiles(chatId, msgs, wa, sender, why);
    finish(out.replyId, out.error || null);
    return out;
  } catch (err) {
    const note = `الفحص فشل: ${friendlyError(err.message)}`;
    return { replyId: finish(failed(chatId, note), note), error: note };
  }
}

// بيرجع { replyId, error? }
async function checkFiles(chatId, msgs, wa, sender, why) {
  const cfg = settings.get().cv;
  const fail = (note) => ({ replyId: failed(chatId, note), error: note });
  const files = [];
  for (const m of msgs) {
    const f = await wa.downloadMedia(m.id);
    if (f) files.push({ ...f, filename: f.filename || (m.body || '').replace(/^📄 /, '') });
  }
  if (!files.length) return fail('ما قدرت أنزّل الملف — افتحه من الواتس وافحصه إنت');

  // الدرجة من API موقعك (opti) وكرت الدرجة بيترسم هون — بدون Chrome
  const optiJob = cfg.useOpti
    ? scoreCv(files, { baseUrl: cfg.optiUrl, botKey: process.env.OPTI_BOT_KEY }).catch((err) => ({ error: friendlyError(err.message) }))
    : Promise.resolve({ error: 'برنامج الفحص مطفي' });

  const [result, opti] = await Promise.all([cv.check({ files }), optiJob]);
  if (result.unsupported) return fail(`نوع الملف مش مدعوم: ${files[0].filename || files[0].mimetype}`);

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
  return { replyId: reply(chatId, 'result', text, sender, { note, attachment }) };
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
  // رسالة البوت أو اللوحة انحفظت أصلاً لما انبعتت: ما منكررها
  if (echo && db.sentRecently(msg.chatId, shown)) return;
  db.saveMessage({ ...msg, body: shown, byBot: echo });
  // رسائلك إنت (رقم البوت) ما بنرد عليها: الزر والنتيجة للمستخدم اللي بعت الملف
  if (msg.fromMe) return;
  if (!settings.get().enabled) return;
  const chat = db.getChat(msg.chatId);
  if (chat.muted) return;

  const selected = String(msg.selectedId || '');
  if (/^fwd:\d+$/.test(selected)) {
    forwardCheck(msg.chatId, Number(selected.slice(4)), sender);
    return;
  }

  if (FILE_TYPES.has(msg.type)) {
    scheduleFiles(msg.chatId, msg.id, sender, wa);
    return;
  }
  if (!['chat', 'buttons_response', 'template_button_reply'].includes(msg.type)) return;

  const phone = parsePhone(msg.body, chat.phone);
  if (phone && rememberPhone(msg.chatId, phone, sender, wa)) return;
  const offer = openOffer(msg.chatId);
  if (offer && wantsForward(msg.body)) {
    forwardCheck(msg.chatId, offer.id, sender);
    return;
  }
  if (jobWaitingPhone(msg.chatId) && looksLikePhoneAttempt(msg.body)) {
    reply(msg.chatId, 'ask_phone', 'ابعت رقم صاحب الملف مع مقدمة الدولة، مثل: 962791234567', sender);
  }
}

module.exports = { REAL_TYPES, handle, checkNow, wantsCheck, usedCheck, sendDueResults, startAutoSend, RECEIVED, parsePhone, settleJob, onPollVote };
