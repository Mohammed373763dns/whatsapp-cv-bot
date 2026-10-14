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

xai.loadPricing();
dashboard.start({ wa, sender });
flow.startAutoSend(sender);
wa.start();

async function shutdown() {
  console.log('\nStopping...');
  await wa.stop();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
