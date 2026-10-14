// دليل المبيعات: الـAI بيقرأ محادثاتك اللي انتهت ببيعة (وعينة من اللي ما اشترت)
// وبيطلع منها: كيف بتجاوب، كيف بتتعامل مع الاعتراضات، وكيف بتسكّر البيعة
// بيتشغل مرة وحدة (npm run playbook) وبينحفظ بـ data/playbook.md — البوت بيقرأه بكل رد
require('../shared/env').loadEnv();
const fs = require('fs');
const path = require('path');
const config = require('../config');
const { readJson } = require('../shared/utils');
const xai = require('../ai/xai');

const out = config.OUTPUT_DIR;
const WON_CHATS = 35;
const LOST_CHATS = 15;
const CHARS_PER_CHAT = 2200;

function transcript(msgs) {
  const lines = msgs
    .filter((m) => m.type === 'chat' && (m.body || '').trim())
    .map((m) => `${m.fromMe ? 'محمد' : 'الزبون'}: ${m.body.replace(/\s+/g, ' ').slice(0, 300)}`);
  let text = lines.join('\n');
  if (text.length > CHARS_PER_CHAT) text = text.slice(0, CHARS_PER_CHAT) + '\n...';
  return text;
}

async function main() {
  const chats = readJson(path.join(out, 'chats.json'));
  const messages = readJson(path.join(out, 'messages.json'));
  const won = new Set(readJson(path.join(out, 'sales.json')).map((s) => s.name));

  const byChat = new Map();
  for (const m of messages) {
    if (!byChat.has(m.chatId)) byChat.set(m.chatId, []);
    byChat.get(m.chatId).push(m);
  }
  const conv = chats
    .map((c) => ({ c, msgs: (byChat.get(c.id) || []).sort((a, b) => a.timestamp - b.timestamp) }))
    .filter((x) => x.msgs.filter((m) => m.type === 'chat').length >= 6);

  const wonConv = conv.filter((x) => won.has(x.c.name)).sort((a, b) => b.msgs.length - a.msgs.length).slice(0, WON_CHATS);
  // الخسرانة: اللي وصلت لمرحلة السعر أو الدفع (بتعلّمنا وين بتوقف)
  const lostConv = conv
    .filter((x) => !won.has(x.c.name) && x.msgs.some((m) => m.fromMe && /شيكل|الدفع|حجز/.test(m.body || '')))
    .sort((a, b) => b.msgs.length - a.msgs.length)
    .slice(0, LOST_CHATS);

  const corpus = [
    ...wonConv.map((x, i) => `### محادثة ناجحة ${i + 1}\n${transcript(x.msgs)}`),
    ...lostConv.map((x, i) => `### محادثة ما انتهت ببيعة ${i + 1}\n${transcript(x.msgs)}`),
  ].join('\n\n');

  await xai.loadPricing();
  const { text, usd } = await xai.chat({
    purpose: 'playbook',
    model: 'grok-4.20-0309-reasoning',
    maxTokens: 6000,
    temperature: 0.2,
    messages: [
      {
        role: 'system',
        content: `انت مدير مبيعات خبير. قدامك محادثات واتساب حقيقية لمحمد من شركة أوبتي (كتابة و فحص السير الذاتية).
اكتب "دليل مبيعات" عملي و قصير لبوت رح يرد بدال محمد بنفس أسلوبه. بالعامية الفلسطينية و بدون مقدمات.
اعتمد بس على اللي بالمحادثات. اقتبس جمل محمد الحقيقية اللي نجحت حرفياً.
الأقسام (كل قسم نقاط قصيرة):
1. كيف بيبلّش محمد مع الزبون و كيف بيعرف شو بده
2. أكثر الأسئلة اللي بيسألها الزباين و أحسن رد لمحمد على كل واحد
3. الاعتراضات (غالي / بفكر / ما معي / مش واثق) و شو اللي اشتغل
4. كيف بيوصل للدفع و بيسكّر البيعة
5. أخطاء بالمحادثات اللي ما انتهت ببيعة و شو كان لازم ينعمل
6. قواعد أسلوب محمد (طول الرسالة، كلمات بيستخدمها، شو بيتجنب)
بحد أقصى 700 كلمة.
ممنوع منعاً باتاً تكتب: أي سعر أو مبلغ، أي خصم أو نسبة، دفع جزئي أو 50%، مدة تسليم، هدايا أو خدمات زيادة (زي الموقع الشخصي)، أرقام حسابات. هاي بتتغير و البوت بياخدها من الإعدادات. لو الجملة الحقيقية فيها سعر اكتب [السعر] بدله.
بدون إيموجي و بدون تنسيق markdown (لا ** ولا #). عناوين الأقسام سطر عادي.`,
      },
      { role: 'user', content: corpus },
    ],
  });

  fs.writeFileSync(path.join(out, 'playbook.md'), text.trim() + '\n');
  console.log(text);
  console.log(`\nDONE: ${wonConv.length} won + ${lostConv.length} lost chats · $${usd.toFixed(4)} · saved to ${out}/playbook.md`);
}

main().catch((err) => {
  console.error('ERROR:', err.message);
  process.exit(1);
});
