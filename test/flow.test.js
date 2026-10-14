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
const msg = (chatId, type, body = '') => flow.handle({ id: `m${++n}`, chatId, fromMe: false, type, body, timestamp: n, name: 'زبون' }, sender, wa);
const kinds = () => sent.map((r) => r.scenario);

test('wantsCheck', () => {
  for (const t of ['بدي افحص سيرتي', 'فحص مجاني', 'بدي أفحص سيرتي الذاتية', 'ممكن تقييم للسيرة', 'Check my cv']) assert.ok(flow.wantsCheck(t), t);
  for (const t of ['مرحبا', 'بكم السيرة', 'شكرا']) assert.ok(!flow.wantsCheck(t), t);
});

test('ignores anything that is not a check request', async () => {
  sent.length = 0;
  await msg('a@c.us', 'chat', 'مرحبا');
  await msg('a@c.us', 'chat', 'بكم السيرة الذاتية؟');
  await msg('a@c.us', 'document');
  assert.deepStrictEqual(kinds(), []);
});

test('request → ask for CV → file → ack, once per number', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  sent.length = 0;
  await msg('b@c.us', 'chat', 'فحص مجاني');
  assert.deepStrictEqual(kinds(), ['ask']);
  assert.strictEqual(sent[0].text, settings.get().askText);

  await msg('b@c.us', 'chat', 'بدي افحص'); // طلب تاني قبل الملف: ما بيكرر
  assert.deepStrictEqual(kinds(), ['ask']);

  await msg('b@c.us', 'document');
  await msg('b@c.us', 'image'); // صفحة تانية بنفس اللحظة: ما في رد تاني
  assert.deepStrictEqual(kinds(), ['ask', 'ack']);
  assert.strictEqual(db.getChat('b@c.us').stage, flow.RECEIVED);

  t.mock.timers.tick(10000);
  await new Promise((r) => setImmediate(r));
  // الملف ما نزل (wa وهمي) ← نتيجة فاضية بتستناك بالداشبورد، ما بتنبعت للزبون
  const result = db.db.prepare(`SELECT * FROM replies WHERE chat_id = 'b@c.us' AND scenario = 'result'`).get();
  assert.strictEqual(result.status, 'pending');
  assert.ok(result.note);

  await msg('b@c.us', 'chat', 'بدي افحص سيرة تانية');
  await msg('b@c.us', 'document');
  assert.deepStrictEqual(kinds(), ['ask', 'ack'], 'once per number');
});

test('file with the request in its caption is checked right away', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  sent.length = 0;
  await msg('c@c.us', 'document', 'بدي افحص سيرتي');
  assert.deepStrictEqual(kinds(), ['ack']);
});

test('result waits for review, then sends itself after the delay', () => {
  db.saveChat({ id: 'e@c.us' });
  const add = (text, ageMin) => {
    const id = db.addReply({ chatId: 'e@c.us', scenario: 'result', text, source: 'bot' });
    db.db.prepare('UPDATE replies SET created = ? WHERE id = ?').run(db.now() - ageMin * 60, id);
    return id;
  };
  const fresh = add('ملاحظات', 5);
  const due = add('ملاحظات', 16);
  const empty = add('', 30); // فحص فاشل: بدها إنت
  const ancient = add('ملاحظات', 15 + 4 * 60); // البوت كان طافي: ما بتنبعت لحالها
  sent.length = 0;
  const ids = flow.sendDueResults(sender);
  assert.ok(ids.includes(due));
  for (const id of [fresh, empty, ancient]) assert.ok(!ids.includes(id));

  settings.update({ autoSend: { enabled: false } });
  assert.deepStrictEqual(flow.sendDueResults(sender), []);
  settings.update({ autoSend: { enabled: true } });
});

test('bot off → no replies', async () => {
  settings.update({ enabled: false });
  sent.length = 0;
  await msg('d@c.us', 'chat', 'فحص مجاني');
  assert.deepStrictEqual(kinds(), []);
  settings.update({ enabled: true });
});
