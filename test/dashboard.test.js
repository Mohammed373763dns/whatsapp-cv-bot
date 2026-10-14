process.env.BOT_DB_FILE = ':memory:';
process.env.DASHBOARD_PORT = '3014';
process.env.XAI_API_KEY = '';

const test = require('node:test');
const assert = require('node:assert');
const db = require('../src/db');
const settings = require('../src/settings');
const dashboard = require('../src/dashboard/server');

const queued = [];
const server = dashboard.start({ wa: { status: 'ready' }, sender: { queue: [], enqueue: (id) => queued.push(id) } });
const api = (url, body) =>
  fetch(`http://127.0.0.1:3014${url}`, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}).then((r) => r.json());

test.before(() => new Promise((r) => server.once('listening', r)));
test.after(() => server.close());

test('pending result shows up, can be edited and sent', async () => {
  db.saveChat({ id: 't@c.us', name: 'تجربة', phone: '970' });
  db.saveMessage({ id: 'm1', chatId: 't@c.us', fromMe: false, type: 'document', body: '📄 cv.pdf', timestamp: 100 });
  db.updateChat('t@c.us', { stage: 'cv_received' });
  const id = db.addReply({ chatId: 't@c.us', scenario: 'result', text: 'ملاحظات', source: 'bot' });

  const s = await api('/api/state');
  assert.strictEqual(s.results.length, 1);
  assert.strictEqual(s.recent[0].id, 't@c.us');

  await api(`/api/replies/${id}/send`, { text: 'ملاحظات معدلة' });
  assert.strictEqual(queued.at(-1), id);
  assert.strictEqual(db.getReply(id).text, 'ملاحظات معدلة');
});

test('empty result cannot be sent', async () => {
  const id = db.addReply({ chatId: 't@c.us', scenario: 'result', text: '', source: 'bot', note: 'فشل' });
  assert.ok((await api(`/api/replies/${id}/send`, {})).error);
  await api(`/api/replies/${id}/dismiss`, {});
  assert.strictEqual(db.getReply(id).status, 'dismissed');
});

test('reset lets a number ask again; settings save', async () => {
  await api(`/api/chats/${encodeURIComponent('t@c.us')}/reset`, {});
  assert.strictEqual(db.getChat('t@c.us').stage, 'new');

  await api('/api/settings', { enabled: false, askText: 'ابعت سيرتك', ackText: '  ' });
  assert.strictEqual(settings.get().enabled, false);
  assert.strictEqual(settings.get().askText, 'ابعت سيرتك');
  assert.ok(settings.get().ackText.length > 2, 'empty text is ignored');
});
