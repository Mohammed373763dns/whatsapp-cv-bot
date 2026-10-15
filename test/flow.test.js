process.env.BOT_DB_FILE = ':memory:';
process.env.XAI_API_KEY = ''; // بدون AI: القرار بالقاعدة الاحتياطية

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
const msg = (chatId, type, body = '', fromMe = false) =>
  flow.handle({ id: `m${++n}`, chatId, fromMe, type, body, timestamp: now() - 100 + n, name: 'زبون', filename: type === 'document' ? body : null }, sender, wa);
const kinds = () => sent.map((r) => r.scenario);
const result = (chatId) => db.db.prepare(`SELECT * FROM replies WHERE chat_id = ? AND scenario = 'result'`).get(chatId);
const tick = async (t, ms) => {
  t.mock.timers.tick(ms);
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

test('wantsCheck', () => {
  for (const t of ['بدي افحص سيرتي', 'فحص مجاني', 'ابعتلنا سيرتك الذاتية للفحص', 'ممكن تقييم للسيرة']) assert.ok(flow.wantsCheck(t), t);
  for (const t of ['مرحبا', 'بكم السيرة', 'شكرا']) assert.ok(!flow.wantsCheck(t), t);
});

test('the bot never answers plain talk (the employee does)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  sent.length = 0;
  await msg('a@c.us', 'chat', 'بدي افحص سيرتي');
  await msg('a@c.us', 'chat', 'بكم السيرة؟');
  await tick(t, 60e3);
  assert.deepStrictEqual(kinds(), []);
});

test('employee asked for the CV → customer sends it → ack + check, once per number', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  sent.length = 0;
  await msg('b@c.us', 'chat', 'بدي فحص مجاني');
  await msg('b@c.us', 'chat', 'اهلا وسهلا 🌷 ابعتلنا سيرتك الذاتية للفحص', true);
  await msg('b@c.us', 'document', 'cv.pdf');
  assert.deepStrictEqual(kinds(), [], 'waits for the customer to finish');
  await tick(t, 21e3);
  assert.deepStrictEqual(kinds(), ['ack']);
  assert.strictEqual(db.getChat('b@c.us').stage, flow.RECEIVED);
  // الملف ما نزل (wa وهمي) ← نتيجة فاضية بتستناك بالداشبورد
  assert.strictEqual(result('b@c.us').status, 'pending');

  await msg('b@c.us', 'document', 'cv2.pdf');
  await tick(t, 21e3);
  assert.deepStrictEqual(kinds(), ['ack'], 'once per number');
});

test('a file with no check context is ignored', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  sent.length = 0;
  await msg('c@c.us', 'chat', 'مرحبا هاي الشهادة');
  await msg('c@c.us', 'document', 'certificate.pdf');
  await tick(t, 21e3);
  assert.deepStrictEqual(kinds(), []);
  assert.ok(!result('c@c.us'));
});

test('several CVs → the last one is checked; CV pages as images → all images', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const checked = [];
  const wa2 = { downloadMedia: async (id) => (checked.push(id), null) };
  const send = (chatId, type, body = '', fromMe = false) =>
    flow.handle({ id: `m${++n}`, chatId, fromMe, type, body, timestamp: now() - 100 + n, name: 'زبون' }, sender, wa2);

  await send('d@c.us', 'chat', 'بدي افحص سيرتي');
  await send('d@c.us', 'document', 'old.pdf');
  await send('d@c.us', 'document', 'new.pdf');
  await send('d@c.us', 'chat', 'افحصوا اخر وحدة');
  await tick(t, 21e3);
  assert.deepStrictEqual(checked, [`m${n - 1}`]);

  checked.length = 0;
  await send('e@c.us', 'chat', 'فحص مجاني');
  await send('e@c.us', 'image');
  await send('e@c.us', 'image');
  await tick(t, 21e3);
  assert.deepStrictEqual(checked, [`m${n - 1}`, `m${n}`]);
});

test('after "reset bot record": the old checked CV is ignored, the new one is checked', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const checked = [];
  const wa2 = { downloadMedia: async (id) => (checked.push(id), null) };
  const send = (type, body = '') => flow.handle({ id: `m${++n}`, chatId: 'r@c.us', fromMe: false, type, body, timestamp: now() - 100 + n, name: 'زبون' }, sender, wa2);
  await send('chat', 'بدي افحص');
  await send('document', 'old.pdf');
  await tick(t, 21e3);
  assert.deepStrictEqual(checked, [`m${n}`]);

  // نفس اللي بيعمله زر "امسح سجل البوت"
  db.updateChat('r@c.us', { stage: 'new', files_since: now() - 100 + n });
  checked.length = 0;
  await send('chat', 'بدي افحص');
  await tick(t, 10e3);
  assert.deepStrictEqual(checked, [], 'no check on the old file');
  await send('document', 'new.pdf');
  await tick(t, 21e3);
  assert.deepStrictEqual(checked, [`m${n}`]);
});

test('muted number or bot off → nothing', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  sent.length = 0;
  db.saveChat({ id: 'f@c.us' });
  db.updateChat('f@c.us', { muted: 1 });
  await msg('f@c.us', 'chat', 'بدي افحص');
  await msg('f@c.us', 'document', 'cv.pdf');
  settings.update({ enabled: false });
  await msg('g@c.us', 'chat', 'بدي افحص');
  await msg('g@c.us', 'document', 'cv.pdf');
  await tick(t, 21e3);
  assert.deepStrictEqual(kinds(), []);
  settings.update({ enabled: true });
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
  const empty = add('', 30); // فحص فاشل: بدها إنت
  const ancient = add('ملاحظات', 15 + 4 * 60); // البوت كان طافي: ما بتنبعت لحالها
  const ids = flow.sendDueResults(sender);
  assert.ok(ids.includes(due));
  for (const id of [fresh, empty, ancient]) assert.ok(!ids.includes(id));

  settings.update({ autoSend: { enabled: false } });
  assert.deepStrictEqual(flow.sendDueResults(sender), []);
  settings.update({ autoSend: { enabled: true } });
});
