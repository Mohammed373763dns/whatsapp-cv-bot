// الإرسال الآمن: طابور واحد، توقيت بشري، "عم يكتب..."، وحدود سرعة
const EventEmitter = require('events');
const fs = require('fs');
const db = require('../db');
const settings = require('../settings');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (min, max) => min + Math.random() * (max - min);

class SafeSender extends EventEmitter {
  constructor(wa) {
    super();
    this.wa = wa;
    this.queue = [];
    this.sentAt = []; // أوقات الإرسال لحساب الحدود
    this.running = false;
    this.echoes = new Map(); // نصوص البوت اللي عم تنبعت، عشان ما نفكرها رسالة منك
  }

  isBotEcho(m) {
    const key = `${m.chatId}|${m.body}`;
    const t = this.echoes.get(key);
    if (t && Date.now() - t < 120e3) {
      this.echoes.delete(key);
      return true;
    }
    return false;
  }

  enqueue(replyId) {
    if (this.queue.includes(replyId)) return;
    db.setReplyStatus(replyId, 'queued');
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
          db.setReplyStatus(id, 'sent', { sent_at: db.now() });
          this.emit('sent', db.getReply(id));
        } catch (err) {
          console.error('send failed:', err.message);
          db.setReplyStatus(id, 'failed', { note: `فشل الإرسال: ${err.message}`.slice(0, 500) });
        }
      }
    } finally {
      this.running = false;
    }
  }

  async _deliver(reply) {
    const S = settings.get().safety;
    const { chat_id: chatId, text } = reply;
    // النتيجة إنت كبست عليها "ابعت" فبتطلع بسرعة. ردود البوت بتستنى شوي زي الإنسان
    const [min, max] = reply.scenario === 'result' ? [1, 3] : [S.MIN_REPLY_DELAY_SEC, S.MAX_REPLY_DELAY_SEC];
    await this.wa.markSeen(chatId).catch(() => {});
    await sleep(rand(min, max) * 1000);
    await this._waitForRateLimit();
    await this.wa.typing(chatId, true).catch(() => {});
    await sleep(Math.max(1.5, Math.min(text.length / rand(7, 13), S.MAX_TYPING_SEC)) * 1000);

    // صورة الدرجة فوق ونص الفحص تحتها برسالة وحدة
    if (reply.attachment && fs.existsSync(reply.attachment)) {
      const image = fs.readFileSync(reply.attachment);
      this.echoes.set(`${chatId}|${text}`, Date.now());
      try {
        await this.wa.sendImage(chatId, image, 'image/jpeg', text);
        this.sentAt.push(Date.now());
        return;
      } catch (err) {
        // الواتس رفض النص الطويل تحت الصورة؟ الصورة لحال والنص بعدها
        console.error('caption send failed, sending image alone:', err.message);
        await this.wa.sendImage(chatId, image, 'image/jpeg', '').catch((e) => console.error('image send failed:', e.message));
        await sleep(rand(2, 4) * 1000);
      }
    }
    this.echoes.set(`${chatId}|${text}`, Date.now());
    await this.wa.sendText(chatId, text);
    this.sentAt.push(Date.now());
    setTimeout(() => {
      if (!this.queue.length) this.wa.goOffline?.().catch(() => {});
    }, rand(60, 150) * 1000);
  }

  // بيلغي أي رسالة لهاد الرقم لسا ما انبعتت (لما تمسح سجله أو تحذفه من الداشبورد)
  cancelForChat(chatId) {
    db.db.prepare(`UPDATE replies SET status = 'dismissed' WHERE chat_id = ? AND status IN ('pending', 'queued')`).run(chatId);
    this.queue = this.queue.filter((id) => db.getReply(id)?.chat_id !== chatId);
  }
}

module.exports = { SafeSender };
