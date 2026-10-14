// قراءة السيرة من الملف: النص + "حقائق" التصميم محسوبة بالكود (مجاناً بدل ما نبعت صور للموديل)
const path = require('path');

const PT_PER_INCH = 72;
const EMU_PER_INCH = 914400;

// ألوان رمادية/سودا/بيضا ما بتنحسب "ألوان تصميم"
function isColorful(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '');
  if (!m) return false;
  const [r, g, b] = m.slice(1).map((x) => parseInt(x, 16));
  return Math.max(r, g, b) - Math.min(r, g, b) > 40;
}

// صورة مربعة تقريباً وحجمها بين 0.6 و 3.5 إنش = غالباً صورة شخصية
const looksLikePhoto = (wIn, hIn) => wIn >= 0.6 && hIn >= 0.6 && wIn <= 3.5 && hIn <= 3.5 && wIn / hIn > 0.6 && wIn / hIn < 1.6;
const looksLikeIcon = (wIn, hIn) => wIn > 0 && hIn > 0 && wIn < 0.35 && hIn < 0.35;
// حروف بمنطقة الاستخدام الخاص = أيقونات خطوط (FontAwesome وغيره)
// ما عدا نقاط القوائم العادية من خط Symbol/Wingdings (• ▪ ➢ ✓ ...)
const PUA = /[-]/g;
const BULLETS = new Set(['', '', '', '', '', '', '', '', '']);
const countIcons = (t) => (t.match(PUA) || []).filter((c) => !BULLETS.has(c)).length;

const mul = (m1, m2) => [
  m1[0] * m2[0] + m1[2] * m2[1], m1[1] * m2[0] + m1[3] * m2[1],
  m1[0] * m2[2] + m1[2] * m2[3], m1[1] * m2[2] + m1[3] * m2[3],
  m1[0] * m2[4] + m1[2] * m2[5] + m1[4], m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
];

let pdfjsPromise = null;
function loadPdfjs() {
  if (!pdfjsPromise) {
    // pdfjs بيطبع تحذيرات عن الرسم (ما منحتاجه) — منسكتها وقت التحميل
    const warn = console.warn;
    const log = console.log;
    console.warn = console.log = () => {};
    pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs').finally(() => {
      console.warn = warn;
      console.log = log;
    });
  }
  return pdfjsPromise;
}

async function fromPdf(buffer, maxPages) {
  const pdfjs = await loadPdfjs();
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer), isEvalSupported: false, verbosity: 0 }).promise;
  const facts = { pages: doc.numPages, photo: false, icons: 0, colors: new Set() };
  const lines = [];

  for (let p = 1; p <= Math.min(doc.numPages, maxPages); p++) {
    const page = await doc.getPage(p);

    // النص: منجمع الكلمات حسب السطر (y)
    const tc = await page.getTextContent();
    const rows = new Map();
    for (const it of tc.items) {
      if (!it.str || !it.str.trim()) continue;
      const y = Math.round(it.transform[5]);
      if (!rows.has(y)) rows.set(y, []);
      rows.get(y).push(it);
    }
    for (const y of [...rows.keys()].sort((a, b) => b - a)) {
      lines.push(rows.get(y).sort((a, b) => a.transform[4] - b.transform[4]).map((i) => i.str).join(' ').replace(/\s+/g, ' ').trim());
    }

    // الحقائق: الصور وأحجامها، والألوان
    const ops = await page.getOperatorList();
    const O = pdfjs.OPS;
    let ctm = [1, 0, 0, 1, 0, 0];
    const stack = [];
    for (let i = 0; i < ops.fnArray.length; i++) {
      const fn = ops.fnArray[i];
      const args = ops.argsArray[i];
      if (fn === O.save) stack.push(ctm);
      else if (fn === O.restore) ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
      else if (fn === O.transform) ctm = mul(ctm, args);
      else if (fn === O.paintImageXObject || fn === O.paintInlineImageXObject || fn === O.paintImageMaskXObject) {
        const w = Math.hypot(ctm[0], ctm[1]) / PT_PER_INCH;
        const h = Math.hypot(ctm[2], ctm[3]) / PT_PER_INCH;
        if (p === 1 && looksLikePhoto(w, h)) facts.photo = true;
        if (looksLikeIcon(w, h)) facts.icons++;
      } else if (fn === O.setFillRGBColor || fn === O.setStrokeRGBColor) {
        const hex = typeof args[0] === 'string' ? args[0]
          : '#' + args.slice(0, 3).map((v) => Math.round(v > 1 ? v : v * 255).toString(16).padStart(2, '0')).join('');
        if (isColorful(hex)) facts.colors.add(hex.toLowerCase());
      }
    }
  }
  const text = lines.join('\n');
  facts.icons += countIcons(text);
  return { text: text.replace(PUA, ''), facts: { ...facts, colors: facts.colors.size } };
}

async function fromDocx(buffer) {
  const mammoth = require('mammoth');
  const JSZip = require('jszip');
  const { value: text } = await mammoth.extractRawText({ buffer });

  const zip = await JSZip.loadAsync(buffer);
  const xml = (await zip.file('word/document.xml')?.async('string')) || '';
  const app = (await zip.file('docProps/app.xml')?.async('string')) || '';
  const pages = Number((app.match(/<Pages>(\d+)<\/Pages>/) || [])[1]) || null;

  const facts = { pages, photo: false, icons: 0, colors: new Set() };
  for (const m of xml.matchAll(/<wp:extent cx="(\d+)" cy="(\d+)"/g)) {
    const w = Number(m[1]) / EMU_PER_INCH;
    const h = Number(m[2]) / EMU_PER_INCH;
    if (looksLikePhoto(w, h)) facts.photo = true;
    if (looksLikeIcon(w, h)) facts.icons++;
  }
  for (const m of xml.matchAll(/<w:(?:color|shd)[^>]*w:(?:val|fill)="([0-9A-Fa-f]{6})"/g)) {
    if (isColorful(m[1])) facts.colors.add(m[1].toLowerCase());
  }
  facts.icons += countIcons(text);
  return { text: text.replace(PUA, ''), facts: { ...facts, colors: facts.colors.size } };
}

// صفحات PDF لصور JPEG بدقة متوسطة (~108 DPI بدل 200 بالبوت القديم)
async function renderPdf(buffer, maxPages, scale = 1.5) {
  const pdfjs = await loadPdfjs();
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer), isEvalSupported: false, verbosity: 0 }).promise;
  const images = [];
  for (let p = 1; p <= Math.min(doc.numPages, maxPages); p++) {
    const page = await doc.getPage(p);
    const viewport = page.getViewport({ scale });
    const { canvas, context } = doc.canvasFactory.create(Math.ceil(viewport.width), Math.ceil(viewport.height));
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: context, canvas, viewport }).promise;
    images.push(canvas.toBuffer('image/jpeg', 75));
  }
  return images;
}

// حقائق من النص نفسه (حتى لو العربي مقطّع شوي، كلمات المستوى والعناوين بتضل مبيّنة)
// عشان ما نصدّق الموديل لما يحكي "مش كاتب مستواك" أو "قسّم المهارات" وهي مكتوبة
const LEVEL = /متوسط|ممتاز|جيد|مبتدئ|اللغة ال[اأإ]?ل?[اأ]?م|لغة ام|native|fluent|good|intermediate|advanced|beginner|excellent|proficient|mother tongue|basic|\b[abc][12]\b/i;
const SKILL_HEAD = /^(المهارات|مهارات|skills)\s*$/i;
const SKILL_SUB = /برامج|البرامج|الانظمة|األنظمة|الأنظمة|المهنية|الشخصية|التقنية|الفنية|التخصصية|الادارية|اإلدارية|الإدارية|الناعمة|technical|soft|hard|software|tools|professional|personal|computer|interpersonal/i;
const MAIN_HEAD = /^(اللغات|languages|الدورات|courses|المراجع|المعرفين|references|التعليم|المؤهالت|المؤهلات|education|الخبرات|experience|الجوائز|awards|certificates|الشهادات)/i;

function textFacts(text) {
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const langAt = lines.findIndex((l) => /^(اللغات|languages)(?![؀-ۿa-z])/i.test(l));
  const langLines = langAt < 0 ? [] : lines.slice(langAt + 1, langAt + 7);
  const skillAt = lines.findIndex((l) => SKILL_HEAD.test(l));
  let subs = 0;
  if (skillAt >= 0) {
    for (const l of lines.slice(skillAt + 1, skillAt + 25)) {
      if (MAIN_HEAD.test(l)) break;
      if (l.split(/\s+/).length <= 4 && SKILL_SUB.test(l)) subs++;
    }
  }
  return {
    langLevels: langAt < 0 ? null : langLines.some((l) => LEVEL.test(l)),
    skillsSectioned: skillAt < 0 ? null : subs >= 2,
  };
}

const arabicRatio = (t) => {
  const letters = (t.match(/\p{L}/gu) || []).length;
  return letters ? (t.match(/[؀-ۿ]/g) || []).length / letters : 0;
};

// بيقرر أرخص طريقة دقيقة:
//   text   = نص الملف (إنجليزي PDF، أو أي Word) — الأرخص
//   images = صور الصفحات (PDF عربي لأنه نصه بيطلع مقطّع، أو ملف ممسوح بدون نص)
// بيرجع { kind: 'text'|'images'|'unsupported', text?, images?, facts? }
async function extract({ buffer, mimetype, filename }, maxPages) {
  const ext = path.extname(filename || '').toLowerCase();
  if (mimetype === 'application/pdf' || ext === '.pdf') {
    const { text, facts } = await fromPdf(buffer, maxPages);
    Object.assign(facts, textFacts(text));
    if (text.length < 300 || arabicRatio(text) > 0.3) {
      return { kind: 'images', images: await renderPdf(buffer, maxPages), facts };
    }
    return { kind: 'text', text, facts };
  }
  if (ext === '.docx' || (mimetype || '').includes('wordprocessingml')) {
    const r = await fromDocx(buffer);
    Object.assign(r.facts, textFacts(r.text));
    return { kind: 'text', ...r };
  }
  return { kind: 'unsupported' };
}

module.exports = { extract, renderPdf, textFacts };
