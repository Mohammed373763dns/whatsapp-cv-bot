// دراسة المحادثات: وين الزبون بيشتري ووين بيوقف، اعتراضاته، وأسلوب كتابتك
// تحليل محلي بالكامل — ما بيستهلك ولا توكن
const path = require('path');
const config = require('../config');
const { readJson, writeJson, writeCsv } = require('../shared/utils');

const out = config.OUTPUT_DIR;
const chats = readJson(path.join(out, 'chats.json'));
const messages = readJson(path.join(out, 'messages.json'));
const salesRows = readJson(path.join(out, 'sales.json'));
const wonNames = new Set(salesRows.map((s) => s.name));

const RE = {
  price: /(\d{2,3})\s*(شيكل|شيقل|₪)|سعر|بتكلف/,
  deposit: /حجز الطلب|عربون|تسديد|ارفاق الاشعار|الدفع/,
  check: /يعطيك العافية|يعطيكي العافية|ملاحظات/,
  objection: /غالي|غالية|ما معي|مش معي|بفكر|بشوف|بعدين|برجعلك|مش هلأ|مش هلق|ما بقدر|خصم|اقل|أقل/,
};

// المراحل بالترتيب — آخر مرحلة وصلها الزبون بتحدد وين وقف
const STAGES = [
  ['greetingOnly', 'only greeting/button'],
  ['custText', 'chatted, no CV'],
  ['custSentCV', 'sent CV, no check'],
  ['freeCheck', 'after free check'],
  ['priceQuoted', 'after price'],
  ['depositAsked', 'after deposit request'],
];

const byChat = new Map();
for (const m of messages) {
  if (!byChat.has(m.chatId)) byChat.set(m.chatId, []);
  byChat.get(m.chatId).push(m);
}

const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? Math.round(s[Math.floor(s.length / 2)]) : null;
};

const rows = [];
const objections = [];
for (const c of chats) {
  if ((config.EXCLUDE_FROM_SALES || []).includes(c.name)) continue;
  const ms = (byChat.get(c.id) || []).sort((a, b) => a.timestamp - b.timestamp);
  const them = ms.filter((m) => !m.fromMe);
  if (!them.length) continue;

  const reached = {
    greetingOnly: true,
    custText: them.some((m) => m.type === 'chat'),
    custSentCV: them.some((m) => ['document', 'image'].includes(m.type)),
    freeCheck: ms.some((m) => m.fromMe && m.type === 'chat' && RE.check.test(m.body) && m.body.length > 300),
    priceQuoted: ms.some((m) => m.fromMe && RE.price.test(m.body)),
    depositAsked: ms.some((m) => m.fromMe && RE.deposit.test(m.body)),
  };
  const won = wonNames.has(c.name);
  const lastStage = [...STAGES].reverse().find(([k]) => reached[k])[1];

  // هل تابعت الزبون بعد ما سكت (رسالة منك بعد 6 ساعات من آخر رسالة إلك)؟
  const lastMine = ms.filter((m) => m.fromMe).pop();
  const lastTheirs = them[them.length - 1];
  const silentAfterMe = lastMine && lastMine.timestamp > lastTheirs.timestamp;
  const firstReply = ms.find((m) => m.fromMe && m.type === 'chat' && m.timestamp > them[0].timestamp);

  const objectionMsgs = them.filter((m) => RE.objection.test(m.body) && m.body.length < 200);
  if (!won) objections.push(...objectionMsgs.map((m) => m.body.replace(/\s+/g, ' ')));

  rows.push({
    name: c.name,
    phone: c.phone,
    result: won ? 'won' : 'lost',
    stoppedAt: won ? 'paid' : lastStage,
    messages: ms.length,
    firstReplyMin: firstReply ? Math.round((firstReply.timestamp - them[0].timestamp) / 60) : null,
    customerWentSilent: !won && silentAfterMe,
    objection: objectionMsgs.length ? objectionMsgs[0].body.replace(/\s+/g, ' ').slice(0, 120) : '',
    lastActivity: c.lastActivity,
  });
}

const won = rows.filter((r) => r.result === 'won');
const lost = rows.filter((r) => r.result === 'lost');
const countBy = (arr, key) => arr.reduce((a, r) => ((a[r[key]] = (a[r[key]] || 0) + 1), a), {});

// أسلوبك بالكتابة
const mine = messages.filter((m) => m.fromMe && m.type === 'chat' && m.body);
const lens = mine.map((m) => m.body.length);
const pct = (f) => Math.round((mine.filter(f).length / mine.length) * 100);
const templates = {};
for (const m of mine) templates[m.body.trim()] = (templates[m.body.trim()] || 0) + 1;

const study = {
  generatedAt: new Date().toISOString(),
  funnel: {
    conversations: rows.length,
    won: won.length,
    lost: lost.length,
    conversionRate: `${Math.round((won.length / rows.length) * 100)}%`,
    lostStoppedAt: countBy(lost, 'stoppedAt'),
    lostSilentAfterMyLastMsg: lost.filter((r) => r.customerWentSilent).length,
    lostWithExplicitObjection: lost.filter((r) => r.objection).length,
  },
  replySpeed: {
    medianFirstReplyMinWon: median(won.map((r) => r.firstReplyMin).filter((x) => x != null)),
    medianFirstReplyMinLost: median(lost.map((r) => r.firstReplyMin).filter((x) => x != null)),
  },
  style: {
    myTextMessages: mine.length,
    medianLength: median(lens),
    withEmojiPct: pct((m) => /\p{Extended_Pictographic}/u.test(m.body)),
    withCommaPct: pct((m) => /،/.test(m.body)),
    withQuestionPct: pct((m) => /[?؟]/.test(m.body)),
    topTemplates: Object.entries(templates)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 30)
      .map(([text, count]) => ({ count, text })),
  },
  objections,
};

writeJson(path.join(out, 'study.json'), study);
writeCsv(path.join(out, 'study_chats.csv'), rows, Object.keys(rows[0]));

const f = study.funnel;
console.log('\n===== Conversation study =====');
console.log(`Conversations: ${f.conversations} | won: ${f.won} | lost: ${f.lost} | conversion: ${f.conversionRate}`);
console.log('Where lost customers stopped:');
console.table(f.lostStoppedAt);
console.log(`Lost customers who went silent after your last message: ${f.lostSilentAfterMyLastMsg}`);
console.log(`Lost customers with an explicit objection: ${f.lostWithExplicitObjection}`);
console.log(`Your style: median ${study.style.medianLength} chars, emoji ${study.style.withEmojiPct}%`);
console.log(`DONE: ${out}/study.json and ${out}/study_chats.csv`);
