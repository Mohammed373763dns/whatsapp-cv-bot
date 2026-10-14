// يحلل البيانات المسحوبة (بدون اتصال بواتساب) ويطلع تقرير
const path = require('path');
const config = require('../config');
const { readJson, writeJson, writeCsv } = require('../shared/utils');

const out = config.OUTPUT_DIR;
const chats = readJson(path.join(out, 'chats.json'));
const messages = readJson(path.join(out, 'messages.json'));

const STOPWORDS = new Set(
  ('في من على الى إلى عن مع هذا هذه ذلك اللي الي انا أنا انت إنت هو هي احنا نحن ' +
    'و او أو ما لا لم لن ان إن أن كان يا بس شو ليش كيف هيك كمان عشان لما مش ' +
    'the a an and or to of in on is it you i me my for that this be are was')
    .split(/\s+/)
);

const byChat = new Map();
for (const m of messages) {
  if (!byChat.has(m.chatId)) byChat.set(m.chatId, []);
  byChat.get(m.chatId).push(m);
}

// إحصائيات لكل محادثة
const chatStats = chats.map((c) => {
  const msgs = (byChat.get(c.id) || []).sort((a, b) => a.timestamp - b.timestamp);
  const sent = msgs.filter((m) => m.fromMe).length;

  // متوسط وقت ردّي على الطرف الثاني (بالدقائق)
  const replyGaps = [];
  for (let i = 1; i < msgs.length; i++) {
    if (msgs[i].fromMe && !msgs[i - 1].fromMe) {
      replyGaps.push((msgs[i].timestamp - msgs[i - 1].timestamp) / 60);
    }
  }
  const last = msgs[msgs.length - 1];

  return {
    name: c.name,
    isGroup: c.isGroup,
    total: msgs.length,
    sent,
    received: msgs.length - sent,
    avgReplyMinutes: replyGaps.length
      ? Math.round(replyGaps.reduce((a, b) => a + b, 0) / replyGaps.length)
      : null,
    awaitingMyReply: Boolean(last && !last.fromMe && !c.isGroup),
    unreadCount: c.unreadCount,
    lastActivity: c.lastActivity,
  };
});

// توزيع حسب الساعة واليوم ونوع الرسالة والكلمات
const hours = Array(24).fill(0);
const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const days = Object.fromEntries(dayNames.map((d) => [d, 0]));
const types = {};
const words = {};

for (const m of messages) {
  const d = new Date(m.timestamp * 1000);
  hours[d.getHours()]++;
  days[dayNames[d.getDay()]]++;
  types[m.type] = (types[m.type] || 0) + 1;

  for (const w of m.body.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) || []) {
    if (!STOPWORDS.has(w)) words[w] = (words[w] || 0) + 1;
  }
}

const top = (obj, n) =>
  Object.entries(obj)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([key, count]) => ({ key, count }));

const sentTotal = messages.filter((m) => m.fromMe).length;
const report = {
  generatedAt: new Date().toISOString(),
  summary: {
    chats: chats.length,
    groups: chats.filter((c) => c.isGroup).length,
    messages: messages.length,
    sent: sentTotal,
    received: messages.length - sentTotal,
    awaitingMyReply: chatStats.filter((c) => c.awaitingMyReply).length,
  },
  mostActiveChats: [...chatStats].sort((a, b) => b.total - a.total).slice(0, 10),
  awaitingMyReply: chatStats.filter((c) => c.awaitingMyReply).map((c) => c.name),
  messagesByHour: hours,
  messagesByDay: days,
  messageTypes: types,
  topWords: top(words, 30),
};

writeJson(path.join(out, 'report.json'), report);
writeCsv(path.join(out, 'chat_stats.csv'), chatStats, Object.keys(chatStats[0] || {}));

// ملخص في الترمينال
const s = report.summary;
console.log('\n===== Analysis summary =====');
console.log(`Chats: ${s.chats} (groups: ${s.groups})`);
console.log(`Messages: ${s.messages} | sent: ${s.sent} | received: ${s.received}`);
console.log(`Chats waiting for your reply: ${s.awaitingMyReply}`);
console.log(`Most active hour: ${hours.indexOf(Math.max(...hours))}:00`);
console.log('\nTop 10 most active chats:');
console.table(
  report.mostActiveChats.map((c) => ({
    name: c.name, total: c.total, sent: c.sent, received: c.received, avgReplyMin: c.avgReplyMinutes,
  }))
);
console.log('Top words: see "topWords" in report.json');
console.log(`\nDONE: full report in ${out}/report.json and ${out}/chat_stats.csv`);
