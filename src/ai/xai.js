// اتصال واحد بـ Grok (xAI) لكل البوت: بيحسب التكلفة، بيسجلها، وبيحترم سقف الصرف اليومي
const db = require('../db');
const settings = require('../settings');

const BASE_URL = 'https://api.x.ai/v1';
// موديلات DeepSeek (ردود المحادثة) بتمرق من نفس المكان: نفس صيغة OpenAI بس عنوان ومفتاح تانيين
const DEEPSEEK_URL = 'https://api.deepseek.com';
const isDeepSeek = (model) => /^deepseek/i.test(model || '');

// السعر بالدولار لكل توكن، لكل موديل (بيتحدث من حساب xAI عند التشغيل)
const FALLBACK_PRICE = { in: 1.25e-6, cached: 0.2e-6, out: 2.5e-6 };
// DeepSeek V3.2 بالدولار لكل توكن (كاش = نفس بداية البرومبت)
const prices = { 'deepseek-chat': { in: 0.28e-6, cached: 0.028e-6, out: 0.42e-6 } };

async function loadPricing() {
  const key = process.env.XAI_API_KEY;
  if (!key) return;
  try {
    const res = await fetch(`${BASE_URL}/language-models`, { headers: { Authorization: `Bearer ${key}` } });
    const { models = [] } = await res.json();
    // xAI بترجع السعر بوحدة 1/100 سنت لكل مليون توكن
    for (const m of models) {
      prices[m.id] = {
        in: m.prompt_text_token_price / 1e10,
        cached: m.cached_prompt_text_token_price / 1e10,
        out: m.completion_text_token_price / 1e10,
      };
    }
  } catch {}
}

function budgetLeft() {
  return settings.get().ai.dailyBudgetUsd - db.aiSpentToday();
}

function available() {
  return Boolean(process.env.XAI_API_KEY) && settings.get().ai.enabled && budgetLeft() > 0;
}

// messages بصيغة OpenAI. بيرجع { text, usd } أو بيرمي خطأ
// x-grok-conv-id ثابت لكل نوع طلب بيرفع نسبة الكاش للبرومبت الطويل (أرخص 6 مرات)
// لما Grok يكون مضغوط ("at capacity") بنعيد المحاولة، وبعدين بنجرب موديل تاني بنفس السعر
const BUSY = /capacity|overloaded|rate limit|try again/i;
const BACKUP_MODELS = ['grok-4.3', 'grok-4.20-0309-reasoning'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function request(model, body, purpose) {
  const ds = isDeepSeek(model);
  const res = await fetch(`${ds ? DEEPSEEK_URL : BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${ds ? process.env.DEEPSEEK_API_KEY : process.env.XAI_API_KEY}`,
      'Content-Type': 'application/json',
      'x-grok-conv-id': `opti-${purpose}`,
    },
    body: JSON.stringify({ model, ...body }),
  }).catch((err) => ({ ok: false, status: 0, json: async () => ({ error: err.message }) }));
  const data = await res.json().catch(() => ({}));
  if (res.ok) return { data };
  const message = String(data.error?.message || data.error || `xAI HTTP ${res.status}`);
  return { error: message, busy: res.status === 0 || res.status === 429 || res.status >= 500 || BUSY.test(message) };
}

async function chat({ purpose, messages, maxTokens, temperature = 0.4, model = process.env.XAI_MODEL_FAST }) {
  if (!available()) throw new Error('AI disabled or daily budget reached');
  const body = { temperature, max_tokens: maxTokens, messages };
  // DeepSeek واقع؟ الزبون ما بيستنى: بنكمل على Grok
  const backups = isDeepSeek(model) ? [process.env.XAI_MODEL_FAST || 'grok-4.20-0309-non-reasoning'] : BACKUP_MODELS.filter((m) => m !== model);
  const attempts = [model, model, ...backups];

  let data = null;
  let lastError = null;
  for (const [i, m] of attempts.entries()) {
    const r = await request(m, body, purpose);
    if (r.data) {
      data = r.data;
      model = m;
      break;
    }
    lastError = r.error;
    if (!r.busy) break; // خطأ حقيقي (مفتاح، طلب غلط) — ما في داعي نعيد
    await sleep(1500 * (i + 1));
  }
  if (!data) throw new Error(lastError);

  const u = data.usage || {};
  const cached = u.prompt_tokens_details?.cached_tokens || u.prompt_cache_hit_tokens || 0;
  const input = u.prompt_tokens || 0;
  const output = u.completion_tokens || 0;
  const p = prices[model] || (isDeepSeek(model) ? prices['deepseek-chat'] : FALLBACK_PRICE);
  const usd = (input - cached) * p.in + cached * p.cached + output * p.out;
  db.logAi({ purpose, model, input, cached, output, usd });

  return { text: (data.choices?.[0]?.message?.content || '').trim(), usd };
}

const imagePart = (buffer, mimetype, detail = 'high') => ({
  type: 'image_url',
  image_url: { url: `data:${mimetype || 'image/jpeg'};base64,${buffer.toString('base64')}`, detail },
});

module.exports = { chat, available, budgetLeft, loadPricing, imagePart };
