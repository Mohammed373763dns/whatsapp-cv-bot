// الاتصال بواتساب: تسجيل الدخول، استقبال الرسائل الجديدة، الإرسال، وتنزيل الوسائط
// دوال المكتبة (getChats, getChat, حدث ready) بتفشل مع نسخة واتساب ويب الحالية،
// فبنتعامل مع الصفحة مباشرة عبر WAWebCollections
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const qrcode = require('qrcode-terminal');
const { Client, LocalAuth } = require('whatsapp-web.js');
const config = require('../config');
const { CHROMIUM_ARGS, memoryText, watchBrowser } = require('../shared/system');

const READY_FALLBACK_SEC = 30;
const STARTUP_TIMEOUT_MS = 4 * 60e3; // إذا ما اتصل خلال 4 دقايق (وما في QR بيستنى) منعيد المحاولة
const MAX_RETRY_DELAY_MS = 2 * 60e3;
const IMAGE_TRY_MS = 40e3;

function withTimeout(promise, ms, what) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what}: no answer from WhatsApp page in ${ms / 1000}s`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

// إذا البوت انطفى فجأة (تحديث على Railway مثلاً) المتصفح بيترك أقفال بمجلد الجلسة،
// وبالمرة الجاية بيرفض يفتح ("profile in use"). منمسحها قبل كل تشغيل
function clearBrowserLocks() {
  const dir = path.join(config.AUTH_DIR, 'session');
  for (const f of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    try {
      fs.rmSync(path.join(dir, f), { force: true });
    } catch {}
  }
}

class WhatsApp extends EventEmitter {
  constructor() {
    super();
    this.status = 'stopped';
    this.qr = null;      // آخر كود QR (للداشبورد)
    this.account = null; // الرقم المربوط
    this.ready = false;
    this.pageErrors = []; // آخر أخطاء صفحة الواتس (بتنطبع لما الإرسال يفشل)
  }

  _setStatus(s) {
    this.status = s;
    this.emit('status', s);
  }

  _createClient() {
    this.ready = false;
    this._authAt = null;
    this._settingUp = false;
    clearBrowserLocks();
    this.client = new Client({
      authStrategy: new LocalAuth({ dataPath: config.AUTH_DIR }),
      webVersionCache: { type: 'local', path: config.CACHE_DIR },
      puppeteer: {
        headless: true,
        // السيرفر أبطأ من اللابتوب: صفحة الواتس ممكن تاخد وقت لترد (الافتراضي 3 دقايق وكان يوقّع البوت)
        protocolTimeout: 300e3,
        // على السيرفر: ذاكرة مشتركة صغيرة وما في كرت شاشة
        args: CHROMIUM_ARGS,
        ...(config.BROWSER_PATH && { executablePath: config.BROWSER_PATH }),
      },
    });
    this.client.on('vote_update', (vote) => {
      const key = vote.parentMsgKey;
      let parentId = null;
      if (typeof key === 'string') parentId = key;
      else if (key?._serialized) parentId = key._serialized;
      else if (key?.remote && key.id) {
        const remote = key.remote._serialized || key.remote;
        parentId = `${key.fromMe ? 'true' : 'false'}_${remote}_${key.id}`;
      }
      if (!(vote.selectedOptions || []).length) return;
      const voter = vote.voter;
      const chatId = voter?._serialized || (typeof voter === 'string' ? voter : null);
      this.emit('vote', { parentId, chatId });
    });
    this.client.on('qr', (qr) => {
      this.qr = qr;
      this._setStatus('qr');
      console.log('\nScan this QR from WhatsApp > Linked devices > Link a device (or open the dashboard):\n');
      qrcode.generate(qr, { small: true });
    });
    this.client.on('authenticated', () => this._onAuthenticated());
    this.client.on('ready', () => this._setup());
    this.client.on('disconnected', (reason) => {
      this.ready = false;
      this._setStatus(`disconnected: ${reason}`);
      if (this._relinking) return;
      // تسجيل خروج من الجوال: الجلسة القديمة ما عادت تنفع. منمسحها ومنبلّش من جديد فبيطلع QR على طول
      // (قبل كان يرجع يجرب بالجلسة القديمة ويعلق على "عم يزامن" وما يطلع كود)
      if (/LOGOUT|UNPAIRED|CONFLICT/i.test(String(reason))) return this.relink(false);
      this._retry(`disconnected: ${reason}`);
    });
  }

  start() {
    clearTimeout(this._retryTimer);
    clearTimeout(this._watchdog);
    this._createClient();
    this._setStatus('starting');
    // واتساب ويب أحياناً بيعلق وهو بيحمّل — بدل ما يضل عالق للأبد منعيد المحاولة
    this._watchdog = setTimeout(() => {
      if (!this.ready && this.status !== 'qr') this._retry('stuck while starting');
    }, STARTUP_TIMEOUT_MS);
    return this.client.initialize().catch((err) => this._retry(err.message));
  }

  // بيسكّر المتصفح وبيعيد المحاولة، والانتظار بيطول كل مرة (15ث، 30ث، 60ث، 120ث)
  async _retry(reason) {
    if (this._retrying) return;
    this._retrying = true;
    clearTimeout(this._watchdog);
    this.ready = false;
    this._attempts = (this._attempts || 0) + 1;
    // 3 مرات ورا بعض ما قدر يتصل (وما طلع QR): الجلسة خربانة. منمسحها عشان يطلع كود ربط جديد
    const stuck = /stuck while starting/.test(reason);
    this._stuckCount = stuck ? (this._stuckCount || 0) + 1 : 0;
    if (this._stuckCount >= 3) {
      console.error('WhatsApp could not connect 3 times in a row — clearing the session so a new QR shows up');
      this._stuckCount = 0;
      this._retrying = false;
      return this.relink(false);
    }
    const delay = Math.min(15e3 * 2 ** (this._attempts - 1), MAX_RETRY_DELAY_MS);
    console.error(`WhatsApp failed (${reason}). Retrying in ${delay / 1000}s...`);
    this._setStatus(`retrying: ${reason}`);
    await this.stop();
    this._retryTimer = setTimeout(() => {
      this._retrying = false;
      this.start();
    }, delay);
  }

  // إعادة تشغيل عادية (مش فشل): بدون انتظار متزايد
  async restart(reason) {
    if (this._retrying || this._relinking) return;
    this._retrying = true;
    clearTimeout(this._watchdog);
    this._setStatus(`restarting: ${reason}`);
    await this.stop();
    this._retrying = false;
    return this.start();
  }

  // تسكير المتصفح. إذا علق (صفحة جامدة) ما منستنى للأبد: بعد 15 ثانية منقتله
  async stop() {
    this.ready = false;
    const client = this.client;
    if (!client) return;
    const proc = client.pupBrowser?.process?.();
    await withTimeout(client.destroy(), 15e3, 'destroy').catch(() => {});
    if (proc && proc.exitCode === null) {
      try {
        proc.kill('SIGKILL');
      } catch {}
    }
  }

  // تسجيل خروج الرقم الحالي وربط رقم جديد: الجلسة بتنمسح وبيطلع QR جديد بالداشبورد
  // logout=false لما الرقم أصلاً طلع (من الجوال) أو الجلسة خربانة
  async relink(logout = true) {
    if (this._relinking) return;
    this._relinking = true;
    this._attempts = 0;
    this._stuckCount = 0;
    clearTimeout(this._retryTimer);
    clearTimeout(this._watchdog);
    this._setStatus('logging_out');
    if (logout) await withTimeout(this.client.logout(), 10e3, 'logout').catch(() => {});
    await this.stop();
    try {
      fs.rmSync(path.join(config.AUTH_DIR, 'session'), { recursive: true, force: true });
    } catch (err) {
      console.error('could not clear WhatsApp session:', err.message);
    }
    this.account = null;
    this.qr = null;
    this._relinking = false;
    this._retrying = false;
    console.log('WhatsApp session cleared — waiting for a new QR');
    return this.start();
  }

  _onAuthenticated() {
    if (this._authAt) return; // المكتبة بتبعت الحدث أكثر من مرة
    this._authAt = Date.now();
    this.qr = null;
    this._setStatus('syncing');
    const client = this.client; // إذا انعاد التشغيل، المؤقت القديم بيوقف
    const timer = setInterval(async () => {
      if (this.ready || client !== this.client) return clearInterval(timer);
      const state = await this.client.getState().catch(() => null);
      if (state === 'CONNECTED' && Date.now() - this._authAt > READY_FALLBACK_SEC * 1000) {
        clearInterval(timer);
        this._setup();
      }
    }, 5000);
  }

  async _setup() {
    if (this.ready || this._settingUp) return;
    this._settingUp = true;
    try {
      await this._attach();
    } catch (err) {
      this._settingUp = false;
      return this._retry(`setup: ${err.message}`);
    }
    clearTimeout(this._watchdog);
    this._attempts = 0;
    this.ready = true;
    this._settingUp = false;
    this._setStatus('ready');
    this._catchUp().catch((err) => console.error('catch-up failed:', err.message));
  }

  // الرسائل اللي وصلت والبوت لسا عم يشتغل كانت بتضيع: بنرجع لآخر 15 دقيقة،
  // وأي محادثة آخر رسالة فيها من الزبون بنعالجها (العقل بيتجاهل اللي انعالج قبل)
  async _catchUp(minutes = 15) {
    const missed = await this.client.pupPage.evaluate((minutes) => {
      const C = window.require('WAWebCollections');
      const { toPn } = window.require('WAWebLidMigrationUtils');
      const since = Date.now() / 1000 - minutes * 60;
      const out = [];
      for (const chat of C.Chat.getModelsArray()) {
        if (!chat.t || chat.t < since || ['g.us', 'broadcast', 'newsletter'].includes(chat.id.server)) continue;
        const msgs = chat.msgs.getModelsArray().filter((m) => !m.isNotification);
        const last = msgs[msgs.length - 1];
        if (!last || last.id.fromMe || last.t < since) continue;
        let phone = chat.id.server === 'c.us' ? chat.id.user : null;
        try {
          phone = phone || toPn(chat.id)?.user || null;
        } catch {}
        out.push({
          id: last.id.toString(),
          chatId: chat.id._serialized,
          fromMe: false,
          type: last.type,
          body: ['chat', 'buttons_response', 'template_button_reply'].includes(last.type) ? last.body || '' : last.caption || '',
          timestamp: last.t,
          name: chat.formattedTitle || last.notifyName || null,
          phone,
          filename: last.filename || null,
          mimetype: last.mimetype || null,
          duration: Number(last.duration) || 0,
          selectedId: last.selectedButtonId || null,
        });
      }
      return out;
    }, minutes);
    if (missed.length) console.log(`Catching up on ${missed.length} message(s) that arrived while starting`);
    for (const m of missed) this.emit('message', m);
  }

  async _attach() {
    const page = this.client.pupPage;
    if (!this.client.pupBrowser.__watched) {
      this.client.pupBrowser.__watched = true;
      watchBrowser(this.client.pupBrowser, 'whatsapp');
    }

    // أخطاء جوا صفحة الواتس: منخزن آخر 50 (بدون ما نعبي الـlogs)، ومنطبعها بس لما إرسال يفشل
    if (!page.__botErrors) {
      page.__botErrors = true;
      const keep = (type, text) => {
        this.pageErrors.push({ at: Date.now(), type, text: String(text).slice(0, 300) });
        if (this.pageErrors.length > 50) this.pageErrors.shift();
      };
      page.on('console', (m) => ['error', 'warn'].includes(m.type()) && keep(m.type(), m.text()));
      page.on('pageerror', (err) => keep('pageerror', err.message));
      page.on('requestfailed', (r) => keep('request', `${r.failure()?.errorText} ${r.url().slice(0, 120)}`));
      // صفحة الواتس ماتت (غالباً خلصت الرام): منعيد تشغيلها على طول بدل ما كل رسالة تستنى 90 ثانية
      page.on('error', (err) => {
        keep('crash', err.message);
        console.error(`WhatsApp page crashed: ${err.message} · memory ${memoryText()}`);
        this._retry('WhatsApp page crashed (usually out of memory)');
      });
    }

    this.account = await page
      .evaluate(() => {
        const U = window.require('WAWebUserPrefsMeUser');
        const me = U.getMaybeMePnUser() || U.getMaybeMeLidUser();
        const conn = window.require('WAWebConnModel').Conn;
        return { phone: me?.user || null, name: conn?.pushname || null, platform: conn?.platform || null };
      })
      .catch(() => null);

    // كل رسالة جديدة (منك أو من الزبون) بتوصل لهون
    await page.exposeFunction('__botOnMessage', (m) => this.emit('message', m)).catch(() => {});
    await page.evaluate(() => {
      if (window.__botListening) return;
      window.__botListening = true;
      const C = window.require('WAWebCollections');
      const { toPn } = window.require('WAWebLidMigrationUtils');
      C.Msg.on('add', (m) => {
        if (!m.isNewMsg || m.isNotification || m.id.remote.server === 'g.us' || m.id.remote.server === 'broadcast') return;
        const chat = C.Chat.get(m.id.remote);
        let phone = m.id.remote.server === 'c.us' ? m.id.remote.user : null;
        try {
          phone = phone || toPn(m.id.remote)?.user || null;
        } catch {}
        window.__botOnMessage({
          id: m.id.toString(),
          chatId: m.id.remote._serialized,
          fromMe: m.id.fromMe,
          type: m.type,
          body: ['chat', 'buttons_response', 'template_button_reply'].includes(m.type) ? m.body || '' : m.caption || '',
          timestamp: m.t,
          name: chat?.formattedTitle || m.notifyName || null,
          phone,
          filename: m.filename || null,
          mimetype: m.mimetype || null,
          duration: Number(m.duration) || 0,
          selectedId: m.selectedButtonId || null,
        });
      });
    });
  }

  // "عم يكتب..."
  typing(chatId, on = true) {
    return this.client.pupPage.evaluate(
      (chatId, on) => {
        const wid = window.require('WAWebWidFactory').createWid(chatId);
        const S = window.require('WAWebChatStateBridge');
        return on ? S.sendChatStateComposing(wid) : S.sendChatStatePaused(wid);
      },
      chatId,
      on
    );
  }

  // تعليم الرسائل كمقروءة
  markSeen(chatId) {
    return this.client.pupPage.evaluate(async (chatId) => {
      const chat = window.require('WAWebCollections').Chat.get(chatId);
      if (!chat) return false;
      // لازم نكون "متصلين" عشان تبيّن العلامة الزرقا و"عم يكتب..." عند الزبون
      window.require('WAWebStreamModel').Stream.markAvailable();
      await window.require('WAWebUpdateUnreadChatAction').sendSeen({ chat, threadId: undefined });
      return true;
    }, chatId);
  }

  sendText(chatId, text, { linkPreview = false } = {}) {
    return this.client.pupPage.evaluate(
      async (chatId, text, linkPreview) => {
        const chat = await window.WWebJS.getChat(chatId, { getAsModel: false });
        if (!chat) throw new Error('chat not found');
        const msg = await window.WWebJS.sendMessage(chat, text, linkPreview ? { linkPreview: true } : {});
        return msg ? msg.id.toString() : null;
      },
      chatId,
      text,
      linkPreview
    );
  }

  // رابط الدعوة من الإعدادات → جروب البوت عضو فيه
  async groupByInvite(code) {
    if (!this._groupIds) this._groupIds = new Map();
    if (this._groupIds.has(code)) return this._groupIds.get(code);
    const id = await this.client.pupPage.evaluate(async (code) => {
      const idOf = (info) => info?.id?._serialized || info?.gid?._serialized || info?.groupId?._serialized || (typeof info?.id === 'string' ? info.id : null);
      try {
        const info = await window.require('WAWebGroupQueryJob').queryGroupInvite(code);
        const gid = idOf(info);
        if (gid) return gid;
      } catch {}
      const groups = window.require('WAWebCollections').Chat.getModelsArray().filter((c) => c.id?.server === 'g.us');
      let fetchCode;
      try {
        fetchCode = window.require('WAWebMexFetchGroupInviteCodeJob').fetchMexGroupInviteCode;
      } catch {}
      if (!fetchCode) return null;
      for (const g of groups) {
        try {
          const res = await fetchCode(g.id._serialized || g.id);
          if ((typeof res === 'string' ? res : res?.code) === code) return g.id._serialized;
        } catch {}
      }
      return null;
    }, code);
    if (id) this._groupIds.set(code, id);
    return id || null;
  }

  // خيار واحد يضغطه المستخدم. واتساب بعرضه، بعكس أزرار الرد اللي ما عادت تبيّن
  sendPoll(chatId, title, options) {
    return this.client.pupPage.evaluate(
      async (chatId, title, options) => {
        const chat = await window.WWebJS.getChat(chatId, { getAsModel: false });
        if (!chat) throw new Error('chat not found');
        const msg = await window.WWebJS.sendMessage(chat, '', {
          poll: {
            pollName: title,
            pollOptions: options.map((name, localId) => ({ name, localId })),
            options: { allowMultipleAnswers: false },
          },
        });
        return msg ? msg.id.toString() : null;
      },
      chatId,
      title,
      options
    );
  }

  // زر عند المستخدم (مو عند رقم البوت). ضغطة الزر بترجع رسالة فيها selectedButtonId
  sendButtons(chatId, text, buttons) {
    return this.client.pupPage.evaluate(
      async (chatId, text, buttons) => {
        const chat = await window.WWebJS.getChat(chatId, { getAsModel: false });
        if (!chat) throw new Error('chat not found');
        const formatted = buttons.map((b) => ({
          buttonId: String(b.id),
          buttonText: { displayText: b.body },
          type: 1,
        }));
        const msg = await window.WWebJS.sendMessage(chat, '', {
          buttons: { type: 'chat', body: text, buttons: formatted },
        });
        return msg ? msg.id.toString() : null;
      },
      chatId,
      text,
      buttons
    );
  }

  // بعد ما يخلص الرد بنرجع "غير متصل" زي ما بتسكّر الواتس
  goOffline() {
    return this.client.pupPage.evaluate(() => window.require('WAWebStreamModel').Stream.markUnavailable());
  }

  // صورة مع نص (مثلاً صورة الفحص من برنامجك)
  // محاولتين: مباشرة من الصفحة، وإذا فشلت بطريقة المكتبة نفسها
  // كل محاولة إلها 40 ثانية لحالها (قبل: الأولى كانت تعلق وتاكل كل الوقت، والتانية ما تنجرب أبداً).
  // إذا فشلوا الاتنين منطبع بالـlogs أخطاء صفحة الواتس اللي صارت وقت الإرسال، عشان نعرف السبب
  async sendImage(chatId, buffer, mimetype = 'image/jpeg', caption = '') {
    const since = Date.now();
    const kb = Math.round(buffer.length / 1024);
    const attempt = async (name, fn) => {
      const t = Date.now();
      try {
        const id = await withTimeout(fn(), IMAGE_TRY_MS, name);
        console.log(`image sent (${name}) in ${Math.round((Date.now() - t) / 1000)}s · ${kb}KB`);
        return id;
      } catch (err) {
        console.error(`image (${name}) failed after ${Math.round((Date.now() - t) / 1000)}s: ${err.message}`);
        throw err;
      }
    };
    try {
      return await attempt('direct', () => this._sendImageDirect(chatId, buffer, mimetype, caption));
    } catch (first) {
      try {
        const { MessageMedia } = require('whatsapp-web.js');
        const media = new MessageMedia(mimetype, buffer.toString('base64'), 'cv-check.jpg');
        return await attempt('library', () => this.client.sendMessage(chatId, media, { caption, sendSeen: false }).then((m) => m?.id?._serialized || null));
      } catch (second) {
        this._dumpPageErrors(since);
        throw new Error(`${first.message} | ${second.message}`);
      }
    }
  }

  // أخطاء صفحة الواتس من وقت معيّن (للتشخيص)
  _dumpPageErrors(since) {
    const errs = this.pageErrors.filter((e) => e.at >= since);
    console.error(`memory now: ${memoryText()}`);
    if (!errs.length) return console.error('WhatsApp page: no errors logged during the send (the page just did not answer)');
    console.error(`WhatsApp page errors during the send (${errs.length}):`);
    for (const e of errs.slice(-15)) console.error(`  [${e.type}] ${e.text}`);
  }

  _sendImageDirect(chatId, buffer, mimetype, caption) {
    return this.client.pupPage.evaluate(
      async (chatId, data, mimetype, caption) => {
        const chat = await window.WWebJS.getChat(chatId, { getAsModel: false });
        if (!chat) throw new Error('chat not found');
        const media = { mimetype, data, filename: 'cv-check.jpg', filesize: Math.round((data.length * 3) / 4) };
        const msg = await window.WWebJS.sendMessage(chat, '', { media, caption });
        return msg ? msg.id.toString() : null;
      },
      chatId,
      buffer.toString('base64'),
      mimetype,
      caption
    );
  }

  // تنزيل صورة/ملف/فويس → { buffer, mimetype, filename } أو null
  async downloadMedia(msgId) {
    const r = await this.client.pupPage.evaluate(async (msgId) => {
      const C = window.require('WAWebCollections');
      const msg = C.Msg.get(msgId) || (await C.Msg.getMessagesById([msgId]))?.messages?.[0];
      if (!msg || !msg.mediaData || msg.mediaData.mediaStage === 'REUPLOADING') return null;
      if (msg.mediaData.mediaStage !== 'RESOLVED') {
        await msg.downloadMedia({ downloadEvenIfExpensive: true, rmrReason: 1 });
      }
      if (msg.mediaData.mediaStage.includes('ERROR') || msg.mediaData.mediaStage === 'FETCHING') return null;
      const noop = { addAnnotations() { return this; }, addPoint() { return this; } };
      const data = await window.require('WAWebDownloadManager').downloadManager.downloadAndMaybeDecrypt({
        directPath: msg.directPath,
        encFilehash: msg.encFilehash,
        filehash: msg.filehash,
        mediaKey: msg.mediaKey,
        mediaKeyTimestamp: msg.mediaKeyTimestamp,
        type: msg.type,
        signal: new AbortController().signal,
        downloadQpl: noop,
      });
      return { data: await window.WWebJS.arrayBufferToBase64Async(data), mimetype: msg.mimetype, filename: msg.filename };
    }, msgId);
    return r ? { buffer: Buffer.from(r.data, 'base64'), mimetype: r.mimetype, filename: r.filename } : null;
  }
}

module.exports = { WhatsApp };
