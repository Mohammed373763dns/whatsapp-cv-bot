// تشغيل البوت: واتساب + الفحص المجاني + الإرسال الآمن + الداشبورد
require('./shared/env').loadEnv();
const { WhatsApp } = require('./whatsapp/client');
const { SafeSender } = require('./whatsapp/sender');
const flow = require('./flow');
const xai = require('./ai/xai');
const dashboard = require('./dashboard/server');
const db = require('./db');

const wa = new WhatsApp();
const sender = new SafeSender(wa);

wa.on('status', (s) => console.log(`WhatsApp: ${s}`));
wa.on('message', (msg) => {
  if (!msg.fromMe) console.log(`<- ${msg.phone || msg.chatId} [${msg.type}] ${(msg.body || '').slice(0, 60)}`);
  flow.handle(msg, sender, wa).catch((err) => console.error('handle error:', err));
});
sender.on('sent', (r) => console.log(`-> ${r.chat_id} [${r.scenario}] ${r.text.slice(0, 60)}`));

// نتائج الفحص اللي ما انبعتت قبل ما يطفي البوت بترجع لعندك تراجعها، وردود النظام القديم بتنلغى
db.db.prepare(`UPDATE replies SET scenario = 'result' WHERE scenario = 'B2'`).run();
db.db.prepare(`UPDATE replies SET status = 'pending' WHERE status = 'queued' AND scenario = 'result'`).run();
db.db.prepare(`UPDATE replies SET status = 'dismissed' WHERE status IN ('pending', 'queued', 'handoff') AND scenario != 'result'`).run();

// إشعارات الواتس (e2e_notification...) اللي انخزنت قبل: بتنشال، والأرقام اللي ما ضل إلها ولا رسالة بتختفي من اللوحة
const real = flow.REAL_TYPES.map((x) => `'${x}'`).join(', ');
db.db.prepare(`DELETE FROM messages WHERE type NOT IN (${real})`).run();
db.db.prepare(`DELETE FROM chats WHERE id NOT IN (SELECT chat_id FROM messages) AND id NOT IN (SELECT chat_id FROM replies)`).run();

require('./shared/system').startMemoryLog();
xai.loadPricing();
dashboard.start({ wa, sender });
flow.startAutoSend(sender);

// الرام ضلت فوق 88% مرتين ورا بعض (10 دقايق) والبوت فاضي: منعيد تشغيل الواتس عشان يفضّي الرام.
// الجلسة بتضل (ما في كود جديد)، وبياخد تقريباً 20 ثانية
const { memory } = require('./shared/system');
const checkBrowser = require('./cv/browser');
let highMemory = 0;
setInterval(() => {
  const m = memory();
  highMemory = m?.percent >= 88 ? highMemory + 1 : 0;
  if (highMemory < 2 || !wa.ready || sender.queue.length || checkBrowser.busy()) return;
  highMemory = 0;
  console.log(`memory ${m.percent}% while idle — restarting WhatsApp to free memory`);
  wa.restart('free memory');
}, 5 * 60e3).unref();
wa.start();

// متصفح الواتس علق (Runtime.evaluate timed out وغيرها) كان يوقّع البرنامج كله.
// هلق بنسجل الخطأ وبنعيد تشغيل الواتس بس، والداشبورد والطابور بيضلوا شغالين
const BROWSER_STUCK = /timed out|Target closed|Session closed|detached|Protocol error|Execution context was destroyed/i;
function onCrash(err) {
  const message = err?.message || String(err);
  console.error('unexpected error:', message);
  if (BROWSER_STUCK.test(message)) wa._retry(`browser stopped responding: ${message.slice(0, 80)}`);
}
process.on('unhandledRejection', onCrash);
process.on('uncaughtException', onCrash);

async function shutdown() {
  console.log('\nStopping...');
  await wa.stop();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
