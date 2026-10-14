// فحص السيرة الذاتية — نفس منطق services/cv-checker بس أرخص بكثير:
//   1) نقرأ نص الملف بدل صور 200 DPI (لما النص سليم)
//   2) حقائق التصميم (صفحات، صورة، أيقونات، ألوان) محسوبة بالكود مجاناً
//   3) الصور بس للـPDF العربي/الممسوح أو لما الزبون يبعت صور، وبحد أقصى صفحات قليلة
//   4) موديل أرخص + سقف للرد + البرومبت الطويل ثابت بالأول عشان الكاش
const settings = require('../settings');
const xai = require('../ai/xai');
const { extract } = require('./extract');

// التاريخ بالرسالة (مش بالبرومبت الثابت) عشان ما يخرب الكاش، وعشان ما يحكي عن تواريخ 2026 إنها مستقبلية
// والسير العربية بتنقرأ من اليمين لليسار: "07/2026 – 01/2025" يعني من 01/2025 لـ 07/2026 مش مقلوبة
const userPrompt = () => `تاريخ اليوم ${new Date().toISOString().slice(0, 10)}. اي تاريخ قبله ماضي مش مستقبل.
بالسير العربية الفترة بتنقرأ من اليمين لليسار: "07/2026 – 01/2025" يعني من 01/2025 لـ 07/2026 و هاد سليم مش مقلوب.
ممنوع تعلّق إنو التواريخ مقلوبة أو بترتيب غلط. و تداخل الخبرات طبيعي (شغلتين بنفس الوقت) ما تعلق عليه.
هاي سيرتي الذاتية، افحصها واحكيلي ملاحظاتك.`;
const yesNo = (v) => (v === true ? 'موجودة' : v === false ? 'مش موجودة' : 'غير معروف');

// عمود واحد بدون جداول = تصميم سليم، حتى لو في قائمة قصيرة (زي المهارات) مقسومة لعمودين
const cleanLayout = (f) => f.columns === false && f.tables === false;
function layoutText(f) {
  if (f.tables) return 'فيه جداول';
  if (f.columns) return 'مقسومة لأعمدة';
  if (cleanLayout(f)) return 'عمود واحد بدون جداول. قائمة قصيرة مقسومة لعمودين (زي المهارات) مش نظام أعمدة — ممنوع ترفض التصميم بسبب أعمدة أو جداول';
  return 'غير معروف';
}

function factsText(f) {
  if (!f) return 'حقائق محسوبة: غير معروف';
  return [
    'حقائق محسوبة:',
    `- عدد الصفحات: ${f.pages ?? 'غير معروف'}`,
    `- صورة شخصية: ${yesNo(f.photo)}`,
    `- أيقونات: ${f.icons > 0 ? `موجودة (${f.icons})` : 'مش موجودة'}`,
    `- عدد ألوان التصميم (غير الأسود والرمادي): ${f.colors ?? 'غير معروف'}`,
    `- مستوى اللغات: ${f.langLevels === true ? 'مكتوب (ممنوع تعلق عليه)' : f.langLevels === false ? 'مش مكتوب' : 'غير معروف'}`,
    `- المهارات: ${f.skillsSectioned === true ? 'مقسمة لأقسام (ممنوع تعلق عليها)' : 'غير معروف'}`,
    `- تخطيط الصفحة: ${layoutText(f)}`,
  ].join('\n');
}

// نفس sanitize_report بالبوت القديم: بدون تشكيل ولا فواصل ولا نقطة آخر الجملة
// قواعد أسلوبك اللي ما منعتمد فيها على الموديل لحاله
// ملاحظات بنشيلها بالكود لأنها غلط أو ما بدك اياها — بتنشال من السطر (الجزء المفصول بـ /)
const DROP = [
  /بدل القائمة الطويلة/, // المسمى الطويل تحت الاسم مش غلط
  /تكرار (كتير )?(بالمهارات|زي)|اكتبي? كل مهارة مرة وحدة/, // تكرار المهارات
];
// ملاحظات بتنشال لما الحقائق المحسوبة من الملف بتقول إنها غلط
const DROP_IF = [
  [(f) => f.langLevels === true, /مستوا?ك|مستوى (اللغة|كل لغة)/],
  [(f) => f.skillsSectioned === true, /تقسمي? المهارات|نظام اقسام/],
  [(f) => f.pages > 0 && f.pages < 3, /سيرتك واصلة/],
  // الصفحة عمود واحد بدون جداول ولا أيقونات: ما في سبب يخلي التصميم "مش مناسب"
  [(f) => cleanLayout(f) && !f.icons, /التصميم (لل?[اأ]سف )?مش مناسب|التصميم مرفوض|التنسيق مرفوض|التنسيق (لل?[اأ]سف )?مش مناسب/],
];
// خاتمة أو تشجيع بآخر الفحص (ممنوعة)
const CLOSING = /^(خلصت|عدلي? هال|ابعثلي|ابعتيلي النسخة|ابعتلي النسخة|بالتوفيق|موفق)/;

function dropFalse(paras, facts) {
  const rules = [...DROP, ...DROP_IF.filter(([when]) => when(facts)).map(([, re]) => re)];
  return paras
    .map((p) => p
      .split('\n')
      .map((line) => {
        const parts = line.split(/\s+\/\s+/);
        const kept = parts.filter((part) => !rules.some((re) => re.test(part)));
        if (kept.length === parts.length) return line;
        if (!kept.length) return '';
        // "اول نقطة" أو "قسم المهارات" كانوا بالجزء اللي انشال — منرجعهم لأول الباقي
        const head = kept[0] === parts[0] ? '' : (parts[0].match(/^(اول نقطة )?(قسم [؀-ۿ]+ )?/) || [''])[0];
        return head + kept.join(' / ').replace(/^و\s*/, '');
      })
      .filter(Boolean)
      .join('\n'))
    .filter((p) => p && !CLOSING.test(p));
}

function enforceStyle(text, facts = {}) {
  const paras = dropFalse(text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean), facts || {});
  // ممنوع أي اقتراح عن لينكد ان أو الروابط: بنشيل الجزء اللي فيه (المفصول بـ /)، وإذا ما ضل شي بنشيل الملاحظة
  const LINKS = /لينكد|linkedin|linktr|linktree|رابط/i;
  const kept = paras
    .map((p) => {
      if (!LINKS.test(p)) return p;
      const parts = p.split(/\s+\/\s+/).filter((part) => !LINKS.test(part));
      if (!parts.length) return '';
      const wasFirst = /^اول نقطة/.test(p);
      const out = parts.join(' / ').replace(/^و\s*/, '');
      return wasFirst && !/^اول نقطة/.test(out) ? `اول نقطة ${out}` : out;
    })
    .filter(Boolean);
  // "اول نقطة اول نقطة" (تكرار من الموديل) ← مرة وحدة
  for (const [i, p] of kept.entries()) kept[i] = p.replace(/^(اول نقطة\s*){2,}/, 'اول نقطة ');
  // أول ملاحظة (بعد الافتتاح وسطر التنسيق) لازم تبلش بـ "اول نقطة"
  const first = kept.findIndex((p, i) => i >= 2 || (i === 1 && !/عدة اخطاء/.test(p)));
  // وبس هي — أي ملاحظة تانية بتبلش فيها بتنشال منها
  if (first > 0) {
    for (const [i, p] of kept.entries()) if (i !== first) kept[i] = p.replace(/^اول نقطة\s*/, '');
    if (!/^اول نقطة/.test(kept[first])) kept[first] = `اول نقطة ${kept[first]}`;
  }
  // "قسم التعليم / و لو عندك..." أو "قسم التعليم و لو عندك..." ← "قسم التعليم لو عندك..."
  for (const [i, p] of kept.entries()) {
    kept[i] = p
      .replace(/^((?:اول نقطة )?قسم [؀-ۿ]+(?: [؀-ۿ]+)?)\s*\/\s*(?:و\s+)?/, '$1 ')
      .replace(/^((?:اول نقطة )?قسم [؀-ۿ]+(?: [؀-ۿ]+)?)\s+و\s*(?=لو )/, '$1 ');
  }
  return kept
    .join('\n\n')
    .replace(/\s*&\s*/g, ' و ')
    .replace(/(^|[\s/])واحدة(?=$|[\s/])/gm, '$1وحدة') // بالعامي "وحدة" مش "واحدة"
    .replace(/فيه جدول(?![؀-ۿ])/g, 'فيه جداول')
    // الإنجليزي بحروف صغيرة زي ما الواحد بيكتب عالسريع (icdl, excel advanced) — إلا ATS و "الـ CV"
    .replace(/[A-Za-z][A-Za-z0-9+#.]*/g, (w) => (/^(ATS|CV)$/i.test(w) ? w.toUpperCase() : w.toLowerCase()));
}

// التنظيف أول (تشكيل، فواصل، **، "أول" بهمزة) وبعدين قواعد الأسلوب —
// قبل كان العكس، فـ "**أول نقطة" ما كانت تنعرف وتنزاد "اول نقطة" مرة تانية
function sanitize(text, facts) {
  const clean = String(text || '')
    .replace(/[\u064B-\u065F\u0670]/g, '')
    .replace(/\s*[\u060C\u066B]\s*/g, ' ') // بدون فواصل نهائياً
    .replace(/,(?=\s|$)/g, '')
    .replace(/\.(?=\s|$)/g, '')
    .replace(/\*\*|__|^#+\s*/gm, '')
    .replace(/(^|\s)[\u0623\u0625\u0622]ول نقطة/g, '$1اول نقطة')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ');
  return enforceStyle(clean, facts)
    // "بدل ما تكتب ... تكتب شو" ← "اكتب شو" (فعل أمر)
    .replace(/(بدل ما تكتبي?[^\n/]*?)\s+تكتبي شو/g, '$1 اكتبي شو')
    .replace(/(بدل ما تكتب[^\n/]*?)\s+تكتب شو/g, '$1 اكتب شو')
    // الملاحظة اللي بعد البيانات الشخصية بتنزل بسطر جديد يبلش بـ "وكمان"
    .replace(/[ \t]*\/[ \t]*وكمان\s+/g, '\nوكمان ')
    .trim();
}

// input: { files: [{ buffer, mimetype, filename }] } — ملف PDF/Word أو صورة أو أكثر
// بيرجع { text, usd, mode, facts } أو { unsupported: true }
async function check(input) {
  const cfg = settings.get().cv;
  const files = input.files || [];
  const images = files.filter((f) => (f.mimetype || '').startsWith('image/'));
  const doc = files.find((f) => !(f.mimetype || '').startsWith('image/'));

  let content;
  let mode;
  let facts = null;
  if (doc) {
    const ex = await extract(doc, cfg.maxPages);
    if (ex.kind === 'unsupported') return { unsupported: true };
    facts = ex.facts;
    if (ex.kind === 'text') {
      mode = 'text';
      content = `${userPrompt()}\n\nنص السيرة:\n${ex.text.slice(0, 12000)}\n\n${factsText(facts)}`;
    } else {
      mode = 'images';
      content = [
        { type: 'text', text: `${userPrompt()}\n\n${factsText(facts)}` },
        ...ex.images.slice(0, cfg.maxImages).map((b) => xai.imagePart(b, 'image/jpeg')),
      ];
    }
  } else if (images.length) {
    mode = 'images';
    content = [
      { type: 'text', text: userPrompt() },
      ...images.slice(0, cfg.maxImages).map((f) => xai.imagePart(f.buffer, f.mimetype)),
    ];
  } else {
    return { unsupported: true };
  }

  const { text, usd } = await xai.chat({
    purpose: 'cv_check',
    model: cfg.model,
    maxTokens: cfg.maxOutputTokens,
    temperature: 0.4,
    messages: [
      { role: 'system', content: cfg.prompt },
      { role: 'user', content },
    ],
  });
  return { text: sanitize(text, facts), usd, mode, facts };
}

module.exports = { check, sanitize };
