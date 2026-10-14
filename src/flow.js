// البوت بيعمل شغلة وحدة: الفحص المجاني للسيرة الذاتية
//   1) الزبون بيطلب فحص ("بدي افحص سيرتي" / "فحص مجاني") ← البوت: ابعت سيرتك
//   2) بيبعت الملف (بعد ما طلب) ← البوت: تمام الفريق رح يفحصها، وبيفحصها
//   3) نتيجة الفحص بتطلع بالداشبورد، وإنت بتبعتها (وإذا ما بعتها بتنبعت لحالها بعد ربع ساعة)
// الفحص مرة وحدة لكل رقم. أي رسالة تانية البوت ما بيرد عليها
const fs = require('fs');
const path = require('path');
const db = require('./db');
const settings = require('./settings');
const config = require('./config');
const cv = require('./cv/checker');
const { checkWithOpti } = require('./cv/opti');
const { toPdf } = require('./cv/convert');

const ASKED = 'awaiting_cv';
const RECEIVED = 'cv_received';
// أي رقم وصل لهون (أو أبعد بالنظام القديم) أخد فحصه
const USED = new Set([RECEIVED, 'checked', 'awaiting_job_title', 'quoted', 'payment_requested', 'paid', 'delivered']);
const FILE_TYPES = new Set(['document', 'image']);
// الزبون ممكن يبعت السيرة كذا صورة ورا بعض: بنستنى شوي ونفحصهم مع بعض
const COLLECT_MS = 8000;

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

const collecting = new Map(); // chatId → { files, timer }

function receiveFile(msg, sender, wa) {
  const c = collecting.get(msg.chatId);
  if (c) {
    c.files.push(msg);
    return;
  }
  db.updateChat(msg.chatId, { stage: RECEIVED });
  reply(msg.chatId, 'ack', settings.get().ackText, sender);
  const entry = { files: [msg] };
  collecting.set(msg.chatId, entry);
  entry.timer = setTimeout(() => {
    collecting.delete(msg.chatId);
    runCheck(msg.chatId, entry.files, wa, sender).catch((err) => failed(msg.chatId, `الفحص فشل: ${err.message}`));
  }, COLLECT_MS);
}

// الزبون أخد رسالة "الفريق رح يفحصها"، فإذا الفحص فشل بتطلعلك بالداشبورد تكتب النتيجة بإيدك
const failed = (chatId, note) => db.addReply({ chatId, scenario: 'result', text: '', source: 'bot', note });

async function runCheck(chatId, msgs, wa, sender) {
  const cfg = settings.get().cv;
  const files = [];
  for (const m of msgs) {
    const f = await wa.downloadMedia(m.id);
    if (f) files.push({ ...f, filename: f.filename || m.filename });
  }
  if (!files.length) return failed(chatId, 'ما قدرت أنزّل الملف — افتحه من الواتس وافحصه إنت');

  // برنامج الفحص (opti) بيعطي الدرجة والصورة، وبيقبل PDF بس — الورد والصور بتتحول PDF أول
  const browser = wa.client?.pupBrowser;
  const optiJob = cfg.useOpti && browser
    ? toPdf(browser, files)
      .then((pdf) => (pdf ? checkWithOpti(browser, pdf.buffer, { baseUrl: cfg.optiUrl, filename: pdf.filename, botKey: process.env.OPTI_BOT_KEY }) : { error: 'نوع الملف مش مدعوم' }))
      .catch((err) => ({ error: err.message }))
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
  const note = opti && !opti.error ? `الدرجة ${opti.score}%` : `بدون صورة الدرجة: ${opti?.error}`;
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
  if (db.db.prepare('SELECT 1 FROM messages WHERE id = ?').get(msg.id)) return;
  db.saveChat({ id: msg.chatId, name: msg.name, phone: msg.phone });
  const shown = msg.body || (msg.type === 'document' ? `📄 ${msg.filename || 'ملف'}` : msg.type === 'image' ? '📷 صورة' : '');
  db.saveMessage({ ...msg, body: shown });

  if (msg.fromMe) {
    if (sender.isBotEcho(msg)) db.db.prepare('UPDATE messages SET by_bot = 1 WHERE id = ?').run(msg.id);
    return;
  }
  if (!settings.get().enabled) return;

  const isFile = FILE_TYPES.has(msg.type);
  if (isFile && collecting.has(msg.chatId)) return receiveFile(msg, sender, wa);

  const chat = db.getChat(msg.chatId);
  if (usedCheck(chat)) return;

  // الملف بينفحص بس إذا الزبون طلب فحص قبله (أو كتب الطلب مع الملف)
  if (isFile && (chat.stage === ASKED || wantsCheck(msg.body))) return receiveFile(msg, sender, wa);

  if (msg.type === 'chat' && chat.stage !== ASKED && wantsCheck(msg.body)) {
    db.updateChat(msg.chatId, { stage: ASKED });
    reply(msg.chatId, 'ask', settings.get().askText, sender);
  }
}

module.exports = { handle, wantsCheck, usedCheck, sendDueResults, startAutoSend, ASKED, RECEIVED };
