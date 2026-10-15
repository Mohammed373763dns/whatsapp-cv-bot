// الإعدادات اللي بتتعدل من الداشبورد. القيم الافتراضية هون،
// واللي بتغيّره بينحفظ بقاعدة البيانات وبيغلب الافتراضي
const defaults = require('../config/bot');
const db = require('../db');
const { DEFAULT_CV_PROMPT } = require('../cv/prompt');

const DEFAULTS = {
  enabled: true,          // البوت شغّال؟
  // نتيجة الفحص بتستناك تراجعها، وإذا ما بعتها خلال afterMin دقيقة بتنبعت لحالها
  autoSend: { enabled: true, afterMin: 15 },
  ackText: defaults.ACK_TEXT,
  safety: defaults.SAFETY,
  ai: {
    enabled: true,
    dailyBudgetUsd: Number(process.env.DAILY_AI_BUDGET_USD || 1),
  },
  cv: {
    // reasoning: نفس السعر بس أدق بكثير (بالتجربة: ما غلط بالجنس وما اخترع ملاحظات)
    model: 'grok-4.20-0309-reasoning',
    maxPages: 3,           // أول كم صفحة بنقرأ
    maxImages: 3,          // للسير المرسلة كصور
    maxOutputTokens: 2500, // موديل reasoning بيحتاج مساحة للتفكير
    // برنامج الفحص تبعك: بيعطي الدرجة وصورة النتيجة اللي بتنرفق مع رسالة الفحص
    useOpti: true,
    optiUrl: 'https://opti-company.vercel.app',
    scoreLine: 'تقييم سيرتك الذاتية {score}%',
    prompt: DEFAULT_CV_PROMPT,
  },
};

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
function merge(base, over) {
  if (!isObj(base) || !isObj(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const k of Object.keys(over)) out[k] = merge(base[k], over[k]);
  return out;
}

let cache = null;

function get() {
  if (!cache) cache = merge(DEFAULTS, db.getSetting('config', {}));
  return cache;
}

// بيحفظ بس القيم اللي بتختلف عن الافتراضي، عشان أي تحديث للافتراضي يوصل
function update(patch) {
  const next = merge(db.getSetting('config', {}), patch);
  db.setSetting('config', next);
  cache = null;
  return get();
}

module.exports = { get, update, DEFAULTS };
