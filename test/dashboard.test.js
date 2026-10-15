process.env.BOT_DB_FILE = ':memory:';
process.env.DASHBOARD_PORT = '3014';
process.env.XAI_API_KEY = '';

const test = require('node:test');
const assert = require('node:assert');
const db = require('../src/db');
const settings = require('../src/settings');
const dashboard = require('../src/dashboard/server');

const queued = [];
const server = dashboard.start({ wa: { status: 'ready', downloadMedia: async () => null }, sender: { queue: [], enqueue: (id) => queued.push(id), cancelForChat() {} } });
const api = (url, body) =>
  fetch(`http://127.0.0.1:3014${url}`, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}).then((r) => r.json());
const id = encodeURIComponent('t@c.us');

test.before(() => new Promise((r) => server.once('listening', r)));
test.after(() => server.close());

test('every chat is listed, with its messages and pending result', async () => {
  db.saveChat({ id: 't@c.us', name: 'تجربة', phone: '970' });
  db.saveMessage({ id: 'm1', chatId: 't@c.us', fromMe: false, type: 'document', body: '📄 cv.pdf', timestamp: 100 });
  db.saveChat({ id: 'u@c.us', name: 'تاني', phone: '971' });
  db.saveMessage({ id: 'm2', chatId: 'u@c.us', fromMe: false, type: 'chat', body: 'مرحبا', timestamp: 50 });
  db.updateChat('t@c.us', { stage: 'cv_received' });
  const rid = db.addReply({ chatId: 't@c.us', scenario: 'result', text: 'ملاحظات', source: 'bot' });

  const list = await api('/api/chats');
  assert.deepStrictEqual(list.map((c) => c.id), ['t@c.us', 'u@c.us']);
  assert.strictEqual(list[0].status, 'checked');
  assert.strictEqual((await api('/api/chats?q=تاني')).length, 1);

  const d = await api(`/api/chats/${id}`);
  assert.strictEqual(d.messages.length, 1);
  assert.strictEqual(d.replies[0].id, rid);
  assert.strictEqual((await api('/api/state')).results.length, 1);

  await api(`/api/replies/${rid}/send`, { text: 'ملاحظات معدلة' });
  assert.strictEqual(queued.at(-1), rid);
  assert.strictEqual(db.getReply(rid).text, 'ملاحظات معدلة');
});

test('mute, reset (bot record) and delete (from the panel)', async () => {
  await api(`/api/chats/${id}/mute`, { muted: true });
  assert.strictEqual((await api(`/api/chats/${id}`)).chat.status, 'muted');
  await api(`/api/chats/${id}/mute`, { muted: false });

  await api(`/api/chats/${id}/reset`, {});
  assert.strictEqual(db.getChat('t@c.us').stage, 'new');
  assert.strictEqual(db.db.prepare(`SELECT COUNT(*) n FROM replies WHERE chat_id = 't@c.us'`).get().n, 0);
  assert.strictEqual((await api(`/api/chats/${id}`)).messages.length, 1, 'messages kept');

  await api(`/api/chats/${id}/delete`, {});
  assert.deepStrictEqual((await api('/api/chats')).map((c) => c.id), ['u@c.us']);
});

test('manual message, manual check, empty result, settings', async () => {
  await api('/api/chats/u%40c.us/send', { text: 'اهلا' });
  assert.strictEqual(db.getReply(queued.at(-1)).text, 'اهلا');

  assert.ok((await api('/api/chats/u%40c.us/check', { msgIds: ['m2'] })).ok);
  assert.strictEqual(db.getChat('u@c.us').stage, 'cv_received');

  const empty = db.addReply({ chatId: 'u@c.us', scenario: 'result', text: '', source: 'bot', note: 'فشل' });
  assert.ok((await api(`/api/replies/${empty}/send`, {})).error);

  await api('/api/settings', { enabled: false, ackText: '  ', autoSend: { afterMin: 20 } });
  assert.strictEqual(settings.get().enabled, false);
  assert.ok(settings.get().ackText.length > 2, 'empty text is ignored');
  assert.strictEqual(settings.get().autoSend.afterMin, 20);
});
