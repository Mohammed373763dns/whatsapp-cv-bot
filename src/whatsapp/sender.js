// الإرسال الآمن: طابور واحد، توقيت بشري، "عم يكتب..."، وحدود سرعة
const EventEmitter = require('events');
const fs = require('fs');
const db = require('../db');
const settings = require('../settings');
const { friendlyError } = require('../shared/system');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (min, max) => min + Math.random() * (max - min);

// الواتس ما رد؟ ما منضل نستنى للأبد: الرد بيصير "فشل" وبتقدر تعيد إرساله من اللوحة
const SEND_TIMEOUT_MS = 90e3;
function withTimeout(promise, ms, what) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`الواتس ما رد خلال ${Math.round(ms / 1000)} ثانية (${what})`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}
// markSeen و"عم يكتب" مش ضروريين: إذا علقوا منكمل
const quick = (p) => withTimeout(p, 10e3, 'quick').catch(() => {});

class SafeSender extends EventEmitter {
  constructor(wa) {
    super();
    this.wa = wa;
    this.queue = [];
    this.sentAt = []; // أوقات الإرسال لحساب الحدود
    this.running = false;
    this.retried = new Set(); // ردود انعادت مرة بعد ما جمد الواتس
    this.echoes = new Map(); // نصوص عم تنبعت من هون، عشان ما نفكرها رسالة الموظف من الجوال
  }

  // 1 = البوت، 2 = إنت من اللوحة، 0 = مش من هون (الموظف من الجوال)
  isBotEcho(m) {
    const key = `${m.chatId}|${m.body}`;
    const e = this.echoes.get(key);
    if (e && Date.now() - e.at < 180e3) {
      this.echoes.delete(key);
      return e.by;
    }
    return 0;
  }

  enqueue(replyId) {
    if (this.queue.includes(replyId)) return;
    db.setReplyStatus(replyId, 'queued', { queued_at: db.now() });
    this.queue.push(replyId);
    this._run();
  }

  async _waitForRateLimit() {
    const S = settings.get().safety;
    for (;;) {
      const t = Date.now();
      this.sentAt = this.sentAt.filter((x) => t - x < 24 * 3600e3);
      const lastMin = this.sentAt.filter((x) => t - x < 60e3).length;
      const lastHour = this.sentAt.filter((x) => t - x < 3600e3).length;
      if (lastMin < S.MAX_PER_MINUTE && lastHour < S.MAX_PER_HOUR && this.sentAt.length < S.MAX_PER_DAY) return;
      await sleep(15e3);
    }
  }

  async _run() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length) {
        if (!this.wa.ready) {
          await sleep(5e3);
          continue;
        }
        const id = this.queue.shift();
        const reply = db.getReply(id);
        if (!reply || reply.status !== 'queued') continue;
        try {
          await this._deliver(reply);
          this.retried.delete(id);
          db.setReplyStatus(id, 'sent', { sent_at: db.now() });
          this.emit('sent', db.getReply(id));
        } catch (err) {
          console.error(`send failed: ${err.message} · memory ${require('../shared/system').memoryText()}`);
          // صفحة الواتس جمدت: منعيد تشغيل الواتس ومنجرب مرة كمان قبل ما نعتبرها فشلت
          if (/timed out|ما رد خلال/.test(err.message) && !this.retried.has(id)) {
            this.retried.add(id);
            this.queue.unshift(id);
            this.wa._retry?.('send timed out — WhatsApp page is frozen');
            continue;
          }
          this.retried.delete(id);
          db.setReplyStatus(id, 'failed', { note: `${reply.note ? `${reply.note} · ` : ''}فشل الإرسال: ${friendlyError(err.message)}`.slice(0, 500) });
        }
      }
    } finally {
      this.running = false;
    }
  }

  async _deliver(reply) {
    const S = settings.get().safety;
    const { chat_id: chatId, text } = reply;
    const echo = { at: Date.now(), by: reply.source === 'manual' ? 2 : 1 };
    // النتيجة إنت كبست عليها "ابعت" فبتطلع بسرعة. ردود البوت بتستنى شوي زي الإنسان
    const [min, max] = reply.scenario === 'result' ? [1, 3] : [S.MIN_REPLY_DELAY_SEC, S.MAX_REPLY_DELAY_SEC];
    await quick(this.wa.markSeen(chatId));
    await sleep(rand(min, max) * 1000);
    await this._waitForRateLimit();
    await quick(this.wa.typing(chatId, true));
    await sleep(Math.max(1.5, Math.min(text.length / rand(7, 13), S.MAX_TYPING_SEC)) * 1000);

    // الزر بينبعت لمحادثة المستخدم. إذا الواتس رفض الأزرار، النص بينبعت لحاله و"أرسل" بتكفي
    if (reply.buttons) {
      let buttons = [];
      try {
        buttons = JSON.parse(reply.buttons);
      } catch {}
      if (buttons.length && this.wa.sendButtons) {
        this.echoes.set(`${chatId}|${text}`, echo);
        try {
          const msgId = await withTimeout(this.wa.sendButtons(chatId, text, buttons), SEND_TIMEOUT_MS, 'الزر');
          this.sentAt.push(Date.now());
          this._record(reply, msgId, 'chat', text, echo.by);
          return;
        } catch (err) {
          console.error('button failed, sending the text without it:', err.message);
        }
      }
    }

    // صورة الدرجة فوق ونص الفحص تحتها برسالة وحدة
    if (reply.attachment && fs.existsSync(reply.attachment)) {
      const image = fs.readFileSync(reply.attachment);
      this.echoes.set(`${chatId}|${text}`, echo);
      try {
        // sendImage نفسها بتجرب طريقتين (40 ثانية لكل وحدة)
        const msgId = await withTimeout(this.wa.sendImage(chatId, image, 'image/jpeg', text), SEND_TIMEOUT_MS + 15e3, 'صورة الفحص');
        this.sentAt.push(Date.now());
        this._record(reply, msgId, 'image', `📷 صورة الفحص\n${text}`, echo.by);
        return;
      } catch (err) {
        // الصورة ما زبطت: الزبون ما بيستنى، النص بينبعت لحاله على طول والسبب بيطلع باللوحة
        console.error('result image failed, sending the text without it:', err.message);
        db.setReplyStatus(reply.id, 'queued', { note: `${reply.note ? `${reply.note} · ` : ''}صورة الدرجة ما انبعتت: ${friendlyError(err.message)}`.slice(0, 500) });
        reply.note = db.getReply(reply.id).note;
      }
    }
    this.echoes.set(`${chatId}|${text}`, echo);
    const msgId = await withTimeout(this.wa.sendText(chatId, text), SEND_TIMEOUT_MS, 'الرسالة');
    this.sentAt.push(Date.now());
    this._record(reply, msgId, 'chat', text, echo.by);
    setTimeout(() => {
      if (!this.queue.length) this.wa.goOffline?.().catch(() => {});
    }, rand(60, 150) * 1000);
  }

  // الرسالة اللي انبعتت بتنحفظ بمحادثة اللوحة على طول. نفس id تبع الواتس، فإذا الواتس رجّعها كمان ما بتتكرر
  _record(reply, msgId, type, body, by) {
    const id = msgId || `sent-${reply.id}`;
    if (db.db.prepare('SELECT 1 FROM messages WHERE id = ?').get(id) || db.sentRecently(reply.chat_id, body)) return;
    db.saveMessage({ id, chatId: reply.chat_id, fromMe: true, type, body, timestamp: db.now(), byBot: by });
  }

  // بيلغي أي رسالة لهاد الرقم لسا ما انبعتت (لما تمسح سجله أو تحذفه من الداشبورد)
  cancelForChat(chatId) {
    db.db.prepare(`UPDATE replies SET status = 'dismissed' WHERE chat_id = ? AND status IN ('pending', 'queued')`).run(chatId);
    this.queue = this.queue.filter((id) => db.getReply(id)?.chat_id !== chatId);
  }
}

module.exports = { SafeSender };
