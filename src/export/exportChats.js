// يسحب آخر N محادثة مع رسائلها ويحفظها في data/
const path = require('path');
const qrcode = require('qrcode-terminal');
const { Client, LocalAuth } = require('whatsapp-web.js');
const config = require('../config');
const { writeJson, writeCsv, toIso } = require('../shared/utils');

const client = new Client({
  authStrategy: new LocalAuth(), // يحفظ الجلسة، فما بتحتاج تمسح QR كل مرة
  puppeteer: {
    headless: true,
    args: ['--no-sandbox'],
    ...(config.BROWSER_PATH && { executablePath: config.BROWSER_PATH }),
  },
});

client.on('qr', (qr) => {
  console.log('\nScan this QR from WhatsApp > Linked devices > Link a device:\n');
  qrcode.generate(qr, { small: true });
});

let started = false;
let authAt = null;
let heartbeat = null;

client.on('authenticated', () => {
  if (authAt) return; // المكتبة أحياناً بتبعت الحدث أكثر من مرة
  authAt = Date.now();
  console.log('OK: logged in, syncing chats with your phone (may take a few minutes)...');

  // نبضة كل 15 ثانية عشان تعرف إنه شغّال، ولو حدث ready ما وصل نبدأ لحالنا
  heartbeat = setInterval(async () => {
    const secs = Math.round((Date.now() - authAt) / 1000);
    const state = await client.getState().catch(() => null);
    console.log(`... still syncing (${secs}s, state: ${state || 'loading'})`);
    if (state === 'CONNECTED' && secs >= 30) run('fallback');
  }, 15000);
});

client.on('loading_screen', (percent) => console.log(`Loading WhatsApp: ${percent}%`));
client.on('auth_failure', (msg) => {
  console.error('ERROR: login failed:', msg);
  process.exit(1);
});
client.on('disconnected', (reason) => console.log('Disconnected:', reason));

client.on('ready', () => run('ready'));

async function run(source) {
  if (started) return;
  started = true;
  clearInterval(heartbeat);
  if (source === 'fallback') console.log('(ready event did not fire, starting anyway)');
  try {
    await exportChats();
  } catch (err) {
    console.error('ERROR while exporting:', err);
    process.exitCode = 1;
  } finally {
    await client.destroy();
  }
}

// دوال المكتبة (getChats و fetchMessages) بتفشل مع نسخة واتساب ويب الحالية،
// فبنقرأ المحادثات والرسائل مباشرة من داخل الصفحة
function readChatList() {
  return client.pupPage.evaluate(() => {
    const { toPn } = window.require('WAWebLidMigrationUtils');
    return window
      .require('WAWebCollections')
      .Chat.getModelsArray()
      .map((c) => {
        let phone = c.id.server === 'c.us' ? c.id.user : null;
        try {
          phone = phone || toPn(c.id)?.user || null;
        } catch {}
        return {
          id: c.id._serialized,
          server: c.id.server,
          name: c.formattedTitle || c.name || c.contact?.pushname || phone || c.id.user,
          phone,
          t: c.t || 0,
          archived: !!c.archive,
          unreadCount: c.unreadCount || 0,
        };
      });
  });
}

// واتساب ويب بيستلم من الجوال جزء من التاريخ بس. هاي الدالة بتطلب من الجوال
// رسائل أقدم (نفس زر "Click here to get older messages from your phone")
// وبترجع true إذا وصل شي جديد
function requestOlderFromPhone(chatId, limit) {
  return client.pupPage.evaluate(
    async (chatId, limit) => {
      const chat = window.require('WAWebCollections').Chat.get(chatId);
      const { loadEarlierMsgs } = window.require('WAWebChatLoadMessages');
      const count = () => chat.msgs.getModelsArray().length;
      const drain = async () => {
        while (count() < limit) {
          const loaded = await loadEarlierMsgs({ chat }).catch(() => null);
          if (!loaded || !loaded.length) break;
        }
      };

      await drain();
      // 0 = في رسائل أقدم لسا على الجوال
      if (chat.endOfHistoryTransferType !== 0 || count() >= limit) return false;

      const before = count();
      await window
        .require('WAWebSendNonMessageDataRequest')
        .sendPeerDataOperationRequest(
          window.require('WAWebProtobufsE2E.pb').Message$PeerDataOperationRequestType.HISTORY_SYNC_ON_DEMAND,
          { chatId: chat.id }
        );
      for (let i = 0; i < 12 && count() === before; i++) {
        await new Promise((r) => setTimeout(r, 1500));
        await drain();
      }
      return count() > before;
    },
    chatId,
    limit
  );
}

async function readMessages(chatId, limit) {
  if (config.FETCH_OLDER_FROM_PHONE) {
    for (let round = 0; round < config.MAX_PHONE_REQUESTS_PER_CHAT; round++) {
      const gotMore = await requestOlderFromPhone(chatId, limit).catch(() => false);
      if (!gotMore) break;
    }
  }

  return client.pupPage.evaluate(
    async (chatId, limit) => {
      const chat = window.require('WAWebCollections').Chat.get(chatId);
      if (!chat) return [];
      const visible = () => chat.msgs.getModelsArray().filter((m) => !m.isNotification);

      // نحمّل رسائل أقدم لحتى نوصل للعدد المطلوب أو يخلص التاريخ
      while (visible().length < limit) {
        const loaded = await window
          .require('WAWebChatLoadMessages')
          .loadEarlierMsgs({ chat })
          .catch(() => null);
        if (!loaded || !loaded.length) break;
      }

      return visible()
        .sort((a, b) => a.t - b.t)
        .slice(-limit)
        .map((m) => ({
          id: m.id.toString(),
          timestamp: m.t,
          fromMe: m.id.fromMe,
          author: m.author?._serialized || null,
          type: m.type,
          hasMedia: !!m.mediaData || ['image', 'video', 'audio', 'ptt', 'document', 'sticker'].includes(m.type),
          body: m.type === 'chat' ? m.body || '' : m.caption || '',
        }));
    },
    chatId,
    limit
  );
}

const fmtTime = (ms) => {
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`;
};

// سطر تقدم واحد بيتحدث مكانه: [██████░░░░] 40/499 8% | 1234 msgs | 3m 10s | ETA 36m
function printProgress(done, total, msgCount, skipped, startedAt) {
  const width = 25;
  const filled = Math.round((done / total) * width);
  const elapsed = Date.now() - startedAt;
  const eta = (elapsed / done) * (total - done);
  const line =
    `[${'#'.repeat(filled)}${'-'.repeat(width - filled)}] ${done}/${total} ` +
    `${Math.round((done / total) * 100)}% | ${msgCount} msgs` +
    (skipped ? ` | ${skipped} skipped` : '') +
    ` | ${fmtTime(elapsed)} | ETA ${fmtTime(eta)}`;
  process.stdout.write('\r' + line.padEnd(90));
}

async function exportChats() {
  console.log('OK: bot ready, fetching chats...');

  const chats = (await readChatList())
    .filter((c) => c.t && ['c.us', 'lid', 'g.us'].includes(c.server))
    .filter((c) => config.INCLUDE_GROUPS || c.server !== 'g.us')
    .filter((c) => config.INCLUDE_ARCHIVED || !c.archived)
    .sort((a, b) => b.t - a.t)
    .slice(0, config.CHAT_LIMIT);
  console.log(`Exporting ${chats.length} most recent chats...`);

  const chatRows = [];
  const messageRows = [];
  const startedAt = Date.now();
  let skipped = 0;

  for (const [i, chat] of chats.entries()) {
    let messages = [];
    try {
      messages = await readMessages(chat.id, config.MESSAGES_PER_CHAT);
    } catch {
      skipped++;
    }

    const msgs = messages.map((m) => ({
      chatId: chat.id,
      chatName: chat.name,
      ...m,
      date: toIso(m.timestamp),
      author: m.author || (m.fromMe ? 'me' : chat.id),
    }));

    chatRows.push({
      id: chat.id,
      name: chat.name,
      phone: chat.phone,
      isGroup: chat.server === 'g.us',
      archived: chat.archived,
      unreadCount: chat.unreadCount,
      lastActivity: toIso(chat.t),
      fetchedMessages: msgs.length,
    });
    messageRows.push(...msgs);
    printProgress(i + 1, chats.length, messageRows.length, skipped, startedAt);
  }
  process.stdout.write('\n');

  const out = config.OUTPUT_DIR;
  writeJson(path.join(out, 'chats.json'), chatRows);
  writeJson(path.join(out, 'messages.json'), messageRows);
  writeCsv(path.join(out, 'chats.csv'), chatRows, Object.keys(chatRows[0] || {}));
  writeCsv(path.join(out, 'messages.csv'), messageRows, Object.keys(messageRows[0] || {}));

  console.log(`\nDONE: saved ${chatRows.length} chats and ${messageRows.length} messages to ${out}/`);
}

client.initialize();
