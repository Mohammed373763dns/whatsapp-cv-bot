// يقدّر عدد البيعات والمبالغ من المحادثات (تقدير، مش محاسبة دقيقة)
const path = require('path');
const config = require('../config');
const { readJson, writeCsv, writeJson } = require('../shared/utils');

const out = config.OUTPUT_DIR;
const chats = readJson(path.join(out, 'chats.json'));
const messages = readJson(path.join(out, 'messages.json'));

const PAID_RE = /حولت|حوّلت|تم التحويل|حولتلك|حولتك|ارسلت المبلغ|دفعت|تم الدفع|سددت|بعتت المبلغ/;
const PAY_REQ_RE = /تسديد|حول|ادفع|الدفع|حجز الطلب|الاشعار|الإشعار/;
const SAMPLE_MIN_CHATS = 3; // ملف انبعت لـ3 محادثات أو أكثر = نموذج مش تسليم

const toEn = (s) => s.replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d));

// السعر = آخر مبلغ (15 شيكل أو أكثر) ذكرته أنا، مع تجاهل "بدل X"
function lastQuotedPrice(msgs) {
  let price = null;
  for (const m of msgs) {
    if (!m.fromMe) continue;
    const text = toEn(m.body).replace(/بدل\s*(من\s*)?\d+/g, '');
    for (const match of text.matchAll(/(\d{2,3})\s*(?:شيكل|شيقل|₪)/g)) {
      const n = Number(match[1]);
      if (n >= 15 && n <= 500) price = n;
    }
  }
  return price;
}

const byChat = new Map();
for (const m of messages) {
  if (!byChat.has(m.chatId)) byChat.set(m.chatId, []);
  byChat.get(m.chatId).push(m);
}

const fileChats = {};
for (const m of messages) {
  if (m.fromMe && m.type === 'document') {
    (fileChats[m.body] = fileChats[m.body] || new Set()).add(m.chatId);
  }
}
const isDelivery = (m) =>
  m.fromMe && m.type === 'document' && /\.(pdf|docx?)$/i.test(m.body) &&
  fileChats[m.body].size < SAMPLE_MIN_CHATS;

const sales = [];
for (const chat of chats) {
  if ((config.EXCLUDE_FROM_SALES || []).includes(chat.name)) continue;
  const msgs = (byChat.get(chat.id) || []).sort((a, b) => a.timestamp - b.timestamp);
  const delivered = msgs.filter(isDelivery);
  const paidMsg = msgs.find((m) => !m.fromMe && PAID_RE.test(m.body));

  let requested = false;
  let receipt = false;
  for (const m of msgs) {
    if (m.fromMe && PAY_REQ_RE.test(m.body)) requested = true;
    else if (requested && !m.fromMe && m.type === 'image') receipt = true;
  }

  if (!delivered.length && !paidMsg) continue;

  const evidence = [];
  if (delivered.length) evidence.push('delivered file');
  if (paidMsg) evidence.push('customer confirmed payment');
  if (receipt) evidence.push('receipt image');

  const price = lastQuotedPrice(msgs);
  const when = (delivered[0] || paidMsg).date;
  sales.push({
    name: chat.name,
    phone: chat.phone,
    date: when.slice(0, 10),
    estimatedPrice: price,
    confidence: delivered.length && (paidMsg || receipt) ? 'high' : 'medium',
    evidence: evidence.join(' + '),
  });
}

sales.sort((a, b) => a.date.localeCompare(b.date));
const priced = sales.filter((s) => s.estimatedPrice);
const total = priced.reduce((a, s) => a + s.estimatedPrice, 0);

const byMonth = {};
for (const s of sales) {
  const k = s.date.slice(0, 7);
  byMonth[k] = byMonth[k] || { sales: 0, shekels: 0 };
  byMonth[k].sales++;
  byMonth[k].shekels += s.estimatedPrice || 0;
}

const summary = {
  sales: sales.length,
  highConfidence: sales.filter((s) => s.confidence === 'high').length,
  withPrice: priced.length,
  withoutPrice: sales.length - priced.length,
  estimatedTotalShekels: total,
  averagePrice: priced.length ? Math.round(total / priced.length) : null,
  byMonth,
};

writeCsv(path.join(out, 'sales.csv'), sales, Object.keys(sales[0] || { name: 0 }));
writeJson(path.join(out, 'sales_summary.json'), summary);
writeJson(path.join(out, 'sales.json'), sales);

console.log('\n===== Sales estimate =====');
console.log(`Sales: ${summary.sales} (high confidence: ${summary.highConfidence})`);
console.log(`Estimated total: ${total} ILS from ${priced.length} sales with a known price`);
console.log(`Sales without a detected price: ${summary.withoutPrice}`);
console.log(`Average price: ${summary.averagePrice} ILS`);
console.table(byMonth);
console.log(`DONE: details in ${out}/sales.csv`);
