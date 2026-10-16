process.env.BOT_DB_FILE = ':memory:';
process.env.XAI_API_KEY = '';

const test = require('node:test');
const assert = require('node:assert');
const db = require('../src/db');
const settings = require('../src/settings');
const flow = require('../src/flow');

const sent = [];
const sender = { enqueue: (id) => sent.push(db.getReply(id)), isBotEcho: () => false };
const wa = { downloadMedia: async () => null };
let n = 0;
const now = () => db.now();
const msg = (chatId, type, body = '', extra = {}) =>
  flow.handle({
    id: `m${++n}`,
    chatId,
    fromMe: false,
    type,
    body,
    timestamp: now() - 100 + n,
    name: 'مستخدم',
    phone: '962799000000',
    filename: type === 'document' ? body : null,
    ...extra,
  }, sender, wa);
const texts = () => sent.map((r) => r.text);
const tick = async (t, ms) => {
  t.mock.timers.tick(ms);
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};

test('parsePhone', () => {
  assert.strictEqual(flow.parsePhone('962791112233'), '962791112233');
  assert.strictEqual(flow.parsePhone('+962 79 111 2233'), '962791112233');
  assert.strictEqual(flow.parsePhone('0791112233', '962799000000'), '962791112233');
  assert.strictEqual(flow.parsePhone('مرحبا'), null);
  assert.strictEqual(flow.parsePhone('0791112233'), null);
});

test('wantsCheck', () => {
  for (const s of ['بدي افحص سيرتي', 'فحص مجاني', 'check']) assert.ok(flow.wantsCheck(s), s);
  for (const s of ['مرحبا', 'شكرا']) assert.ok(!flow.wantsCheck(s), s);
});

test('plain talk and a file from the bot account get no reply', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  sent.length = 0;
  await msg('a@c.us', 'chat', 'مرحبا');
  await flow.handle({ id: `m${++n}`, chatId: 'me@c.us', fromMe: true, type: 'document', body: 'cv.pdf', timestamp: now(), filename: 'cv.pdf' }, sender, wa);
  await tick(t, 20e3);
  assert.deepStrictEqual(texts(), []);
});

test('a file asks the user for the owner number, then says the check is running', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  sent.length = 0;
  await msg('b@c.us', 'document', 'cv.pdf');
  assert.deepStrictEqual(texts(), [], 'waits so several pages count as one file');
  await tick(t, 9e3);
  assert.deepStrictEqual(texts().slice(0, 2), ['شو رقم صاحب الملف؟', 'جاري الفحص']);
  assert.ok(sent.slice(0, 2).every((r) => r.pace === 'now'));
  assert.ok(texts().every((s) => sent[texts().indexOf(s)].chat_id === 'b@c.us'));
  assert.ok(texts().some((s) => s.includes('ما قدرنا نكمل')));
});

test('the send button is queued to the user, and their tap delivers the check to the owner number', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  sent.length = 0;
  await msg('u@c.us', 'document', 'cv.pdf');
  await msg('u@c.us', 'chat', '0791112233');
  await tick(t, 9e3);
  const job = db.db.prepare(`SELECT * FROM file_checks WHERE chat_id = 'u@c.us'`).get();
  assert.strictEqual(job.owner_phone, '962791112233');

  const replyId = db.addReply({ chatId: 'u@c.us', scenario: 'result', text: 'نتيجة الفحص', source: 'bot' });
  db.db.prepare(`UPDATE file_checks SET status = 'checking' WHERE id = ?`).run(job.id);
  flow.settleJob(job.id, { replyId }, sender);

  const offer = sent.find((r) => r.scenario === 'offer');
  assert.ok(offer, 'button message exists');
  assert.strictEqual(offer.chat_id, 'u@c.us', 'the button goes to the user, not the bot account');
  assert.ok(offer.text.includes('962791112233'));
  const buttons = JSON.parse(offer.buttons);
  assert.strictEqual(buttons[0].body, 'أرسل الفحص لهذا الرقم');
  assert.ok(sent.some((r) => r.id === replyId && r.chat_id === 'u@c.us'), 'the result itself is sent to the user');

  sent.length = 0;
  await msg('u@c.us', 'buttons_response', 'أرسل الفحص لهذا الرقم', { selectedId: buttons[0].id });
  const forwarded = sent.find((r) => r.scenario === 'result');
  assert.strictEqual(forwarded.chat_id, '962791112233@c.us');
  assert.strictEqual(forwarded.text, 'نتيجة الفحص');
  assert.ok(sent.some((r) => r.chat_id === 'u@c.us' && r.text.includes('تم إرسال الفحص')));
});

test('a second file is checked too, and أرسل works like the button', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  sent.length = 0;
  await msg('c@c.us', 'document', 'one.pdf');
  await tick(t, 9e3);
  await msg('c@c.us', 'document', 'two.pdf');
  await tick(t, 9e3);
  assert.strictEqual(texts().filter((s) => s === 'شو رقم صاحب الملف؟').length, 2);

  const job = db.db.prepare(`SELECT * FROM file_checks WHERE chat_id = 'c@c.us' ORDER BY id DESC LIMIT 1`).get();
  const replyId = db.addReply({ chatId: 'c@c.us', scenario: 'result', text: 'نتيجة', source: 'bot' });
  db.db.prepare(`UPDATE file_checks SET status = 'ready', reply_id = ?, owner_phone = ? WHERE id = ?`).run(replyId, '970599111222', job.id);
  sent.length = 0;
  await msg('c@c.us', 'chat', 'أرسل');
  assert.ok(!sent.some((r) => r.scenario === 'result'), 'no phone was waiting and no offer yet');

  db.db.prepare(`UPDATE file_checks SET status = 'offer' WHERE id = ?`).run(job.id);
  await msg('c@c.us', 'chat', 'أرسل');
  assert.strictEqual(sent.find((r) => r.scenario === 'result').chat_id, '970599111222@c.us');
});

test('muted number or bot off → nothing', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  sent.length = 0;
  db.saveChat({ id: 'f@c.us' });
  db.updateChat('f@c.us', { muted: 1 });
  await msg('f@c.us', 'document', 'cv.pdf');
  settings.update({ enabled: false });
  await msg('g@c.us', 'document', 'cv.pdf');
  await tick(t, 9e3);
  assert.deepStrictEqual(texts(), []);
  settings.update({ enabled: true });
});

test('a check message with pace now is sent without the human delay', async () => {
  const { SafeSender } = require('../src/whatsapp/sender');
  const sentTexts = [];
  const wa = {
    ready: true,
    sendText: async (id, text) => {
      sentTexts.push(text);
      return 'wa-1';
    },
    markSeen: () => new Promise(() => {}),
    typing: () => new Promise(() => {}),
  };
  db.saveChat({ id: 'fast@c.us', phone: '970599000000' });
  const id = db.addReply({ chatId: 'fast@c.us', scenario: 'checking', text: 'جاري الفحص', source: 'bot', pace: 'now' });
  const fast = new SafeSender(wa);
  fast.enqueue(id);
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(sentTexts, ['جاري الفحص']);
  assert.strictEqual(db.getReply(id).status, 'sent');
});

test('result waits for review, then sends itself after the delay', () => {
  db.saveChat({ id: 'h@c.us' });
  const add = (text, ageMin) => {
    const id = db.addReply({ chatId: 'h@c.us', scenario: 'result', text, source: 'bot' });
    db.db.prepare('UPDATE replies SET created = ? WHERE id = ?').run(db.now() - ageMin * 60, id);
    return id;
  };
  const fresh = add('ملاحظات', 5);
  const due = add('ملاحظات', 16);
  const empty = add('', 30);
  const ancient = add('ملاحظات', 15 + 4 * 60);
  const ids = flow.sendDueResults(sender);
  assert.ok(ids.includes(due));
  for (const id of [fresh, empty, ancient]) assert.ok(!ids.includes(id));

  settings.update({ autoSend: { enabled: false } });
  assert.deepStrictEqual(flow.sendDueResults(sender), []);
  settings.update({ autoSend: { enabled: true } });
});
