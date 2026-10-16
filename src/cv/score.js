// الدرجة وصورة الفحص من موقعك (opti) بدون Chrome:
//   - الملف بينبعت مباشرة لـ API الموقع (/ai/public/analyze-cv) — نفس اللي بتستخدمه صفحة الفحص
//   - الصورة: البوت بيرسم كرت الدرجة لحاله (الدرجة + المعايير + معاينة أول صفحة من السيرة)
// قبل كان البوت يفتح Chrome تاني ويصوّر صفحة النتيجة، وهاد كان ياكل الرام ويجمّد الواتس
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const JSZip = require('jszip');
const { renderPdf } = require('./extract');
const { wordToPdf } = require('./convert');

const API_TIMEOUT_MS = 150e3;
let running = 0;
const busy = () => running > 0;

const isPdf = (f) => f.mimetype === 'application/pdf' || /\.pdf$/i.test(f.filename || '');
const isDocx = (f) => /\.docx$/i.test(f.filename || '') || /wordprocessingml/.test(f.mimetype || '');
const isWord = (f) => isDocx(f) || /\.(doc|rtf|odt)$/i.test(f.filename || '') || /msword/.test(f.mimetype || '');
const isImage = (f) => (f.mimetype || '').startsWith('image/');

// ---------------------------------------------------------------------------
// السيرة كصور: Grok بيقرأ النص، ومنعمل منه ملف Word بسيط (الموقع بيقرأ PDF أو Word نصي بس)
// ---------------------------------------------------------------------------
// الموديل أحياناً بيرفض ينسخ نص فيه بيانات شخصية: منوضّحله إنها سيرة الزبون نفسه بعتها للفحص،
// وإذا رفض منجرب موديل الفحص
const REFUSAL = /can't help|cannot help|can not help|unable to (help|assist)|I'm sorry|لا أستطيع|ما بقدر/i;
async function imagesToText(images) {
  const xai = require('../ai/xai');
  const settings = require('../settings');
  const ask = (model) => xai.chat({
    purpose: 'image_to_text',
    model,
    maxTokens: 4000,
    temperature: 0,
    messages: [
      { role: 'system', content: 'You are an OCR transcription tool for a CV-review service. The customer sent photos of their own résumé and asked us to review it. Transcribe the text exactly as written, same language and order, one line per line. Output only the text.' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Transcribe this résumé (the customer asked for a free CV check).' },
          ...images.map((im) => xai.imagePart(im.buffer, im.mimetype || 'image/jpeg', 'high')),
        ],
      },
    ],
  }).then((r) => r.text.replace(/^```\w*|```$/g, '').trim());
  let text = await ask(process.env.XAI_MODEL_FAST);
  if (text.length < 150 || REFUSAL.test(text.slice(0, 120))) text = await ask(settings.get().cv.model);
  if (text.length < 150 || REFUSAL.test(text.slice(0, 120))) throw new Error('ما قدرت أقرأ نص السيرة من الصور');
  return text;
}

const xmlEsc = (s) => s.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
async function textToDocx(text) {
  const rtl = /[؀-ۿ]/.test(text.slice(0, 400));
  const paras = text.split('\n').map((line) => `<w:p>${rtl ? '<w:pPr><w:bidi/></w:pPr>' : ''}<w:r>${rtl ? '<w:rPr><w:rtl/></w:rPr>' : ''}<w:t xml:space="preserve">${xmlEsc(line)}</w:t></w:r></w:p>`).join('');
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paras}</w:body></w:document>`);
  return zip.generateAsync({ type: 'nodebuffer' });
}

// الملف اللي بينبعت للموقع + صورة المعاينة
async function prepare(files) {
  const pdf = files.find(isPdf);
  if (pdf) return { upload: { buffer: pdf.buffer, filename: pdf.filename || 'cv.pdf', type: 'application/pdf' }, preview: () => firstPage(pdf.buffer) };
  const word = files.find(isWord);
  if (word && isDocx(word)) {
    return {
      upload: { buffer: word.buffer, filename: word.filename || 'cv.docx', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
      preview: () => wordToPdf(word.buffer, word.filename).then(firstPage),
    };
  }
  if (word) { // .doc / .rtf: الموقع بيقبل docx بس، فبنحوّله PDF
    const buffer = await wordToPdf(word.buffer, word.filename);
    return { upload: { buffer, filename: 'cv.pdf', type: 'application/pdf' }, preview: () => firstPage(buffer) };
  }
  const images = files.filter(isImage);
  if (images.length) {
    const text = await imagesToText(images);
    const docx = await textToDocx(text);
    return { upload: { buffer: docx, filename: 'cv-from-images.docx', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }, preview: async () => images[0].buffer, text };
  }
  return null;
}

const firstPage = async (pdfBuffer) => (await renderPdf(pdfBuffer, 1, 1.4))[0];

async function analyze(baseUrl, upload, botKey) {
  const form = new FormData();
  form.append('pdf', new Blob([upload.buffer], { type: upload.type }), upload.filename);
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/ai/public/analyze-cv`, {
    method: 'POST',
    body: form,
    headers: botKey ? { 'X-Opti-Bot-Key': botKey } : {},
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || typeof data.overall_score !== 'number') throw new Error(`موقع الفحص: ${data.hint_ar || data.error || `HTTP ${res.status}`}`);
  return data;
}

// ---------------------------------------------------------------------------
// كرت الدرجة (بدل صورة صفحة النتيجة)
// ---------------------------------------------------------------------------
const W = 1200;
const H = 680;
const FONT = '"Segoe UI", "Liberation Sans", "DejaVu Sans", Arial, sans-serif';
const AR_FONT = '"Noto Naskh Arabic", "Noto Sans Arabic", "Noto Sans", "DejaVu Sans", "Segoe UI", Arial, sans-serif';
const colorFor = (s) => (s >= 80 ? '#16a34a' : s >= 60 ? '#d97706' : '#dc2626');
const isArabic = (text) => {
  const t = String(text || '').slice(0, 2500);
  const ar = (t.match(/[؀-ۿ]/g) || []).length;
  const lat = (t.match(/[A-Za-z]/g) || []).length;
  return ar >= 15 && ar >= lat;
};

const CRITERIA_AR = {
  'personal & contact information': 'المعلومات الشخصية والتواصل',
  'professional summary': 'الملخص المهني',
  'work experience': 'الخبرات العملية',
  'work experience in detail': 'تفاصيل الخبرات',
  'quantified achievements': 'الإنجازات بالأرقام',
  'ats language compatibility': 'توافق لغة ATS',
  'ats keyword compatibility': 'توافق كلمات ATS',
  formatting: 'التنسيق',
  'skills organization': 'تنظيم المهارات',
  'spelling & grammar': 'الإملاء والقواعد',
  education: 'التعليم',
  skills: 'المهارات',
};

function criterionName(c, rtl) {
  const en = String(c.name_en || c.name || '');
  if (!rtl) return en;
  return c.name_ar || c.nameAr || c.label_ar || CRITERIA_AR[en.toLowerCase()] || c.name || en;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function fitText(ctx, text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let t = text;
  while (t.length > 3 && ctx.measureText(`${t}…`).width > maxWidth) t = t.slice(0, -1);
  return `${t}…`;
}

async function drawCard({ score, criteria, ats, rtl = false }, previewBuffer) {
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  const font = rtl ? AR_FONT : FONT;
  ctx.fillStyle = '#f4f6f8';
  ctx.fillRect(0, 0, W, H);
  ctx.direction = rtl ? 'rtl' : 'ltr';

  const py = 36;
  const pw = 400;
  const ph = H - 72;
  const px = rtl ? W - 36 - pw : 36;
  ctx.fillStyle = '#ffffff';
  roundRect(ctx, px, py, pw, ph, 14);
  ctx.fill();
  ctx.fillStyle = '#6b7280';
  ctx.font = `600 15px ${font}`;
  ctx.textAlign = rtl ? 'right' : 'left';
  ctx.fillText(rtl ? 'معاينة السيرة' : 'CV PREVIEW', rtl ? px + pw - 20 : px + 20, py + 32);
  if (previewBuffer) {
    try {
      const img = await loadImage(previewBuffer);
      // الصورة بتعبّي المربع كله (بدون فراغ أبيض تحت): بتتكبّر لتغطيه، والزيادة بتنقص من الأطراف أو من تحت
      const bx = px + 20;
      const by = py + 50;
      const boxW = pw - 40;
      const boxH = ph - 70;
      const s = Math.max(boxW / img.width, boxH / img.height);
      const w = img.width * s;
      const h = img.height * s;
      ctx.save();
      roundRect(ctx, bx, by, boxW, boxH, 6);
      ctx.clip();
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(bx, by, boxW, boxH);
      ctx.drawImage(img, bx + (boxW - w) / 2, by, w, h); // من فوق (الاسم والبداية دايماً بيّنين)
      ctx.restore();
      ctx.strokeStyle = '#e5e7eb';
      ctx.lineWidth = 1;
      roundRect(ctx, bx, by, boxW, boxH, 6);
      ctx.stroke();
    } catch {}
  }

  const rx = rtl ? 36 : px + pw + 30;
  const rw = rtl ? px - 30 - 36 : W - rx - 36;
  ctx.fillStyle = '#ffffff';
  roundRect(ctx, rx, py, rw, 210, 14);
  ctx.fill();
  const r = 74;
  const cx = rtl ? rx + rw - 120 : rx + 120;
  const cy = py + 105;
  ctx.lineWidth = 16;
  ctx.lineCap = 'round';
  ctx.strokeStyle = '#e5e7eb';
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = colorFor(score);
  ctx.beginPath();
  ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + (Math.PI * 2 * Math.max(0, Math.min(score, 100))) / 100);
  ctx.stroke();
  ctx.fillStyle = '#111827';
  ctx.textAlign = 'center';
  ctx.direction = 'ltr';
  ctx.font = `700 50px ${FONT}`;
  ctx.fillText(String(score), cx, cy + 14);
  ctx.fillStyle = '#6b7280';
  ctx.font = `500 15px ${font}`;
  ctx.fillText(rtl ? 'من 100' : '/ 100', cx, cy + 40);
  const textX = rtl ? cx - r - 40 : cx + r + 40;
  ctx.textAlign = rtl ? 'right' : 'left';
  ctx.direction = rtl ? 'rtl' : 'ltr';
  ctx.fillStyle = '#6b7280';
  ctx.font = `600 15px ${font}`;
  ctx.fillText(rtl ? 'درجة ATS المرجّحة' : 'WEIGHTED ATS SCORE', textX, py + 70);
  ctx.fillStyle = '#111827';
  ctx.font = `700 34px ${font}`;
  const verdict = score >= 80 ? (rtl ? 'سيرة قوية' : 'Strong CV') : score >= 60 ? (rtl ? 'جيدة، تحتاج تعديل' : 'Good, needs edits') : (rtl ? 'تحتاج شغل' : 'Needs work');
  ctx.fillText(verdict, textX, py + 112);
  if (ats) {
    const level = /high/i.test(ats) ? 'high' : /medium|moderate/i.test(ats) ? 'medium' : 'low';
    ctx.fillStyle = colorFor(level === 'high' ? 90 : level === 'medium' ? 70 : 40);
    ctx.font = `600 18px ${font}`;
    const atsText = rtl
      ? `توافق ATS: ${{ high: 'عالي', medium: 'متوسط', low: 'منخفض' }[level]}`
      : `ATS compatibility: ${ats[0].toUpperCase()}${ats.slice(1)}`;
    ctx.fillText(atsText, textX, py + 148);
  }

  const ty = py + 230;
  const th = H - ty - 36;
  ctx.fillStyle = '#ffffff';
  roundRect(ctx, rx, ty, rw, th, 14);
  ctx.fill();
  ctx.fillStyle = '#6b7280';
  ctx.font = `600 15px ${font}`;
  ctx.textAlign = rtl ? 'right' : 'left';
  ctx.fillText(rtl ? 'المعايير' : 'CRITERIA', rtl ? rx + rw - 24 : rx + 24, ty + 32);
  const rows = (criteria || []).slice(0, 8);
  const rowH = Math.min(44, (th - 56) / Math.max(rows.length, 1));
  const nameW = 300;
  const barW = rw - 24 - nameW - 16 - 80;
  const barX = rtl ? rx + 70 : rx + 24 + nameW + 16;
  rows.forEach((c, i) => {
    const y = ty + 56 + i * rowH + rowH / 2;
    const s = Math.round(Number(c.score) || 0);
    ctx.fillStyle = '#374151';
    ctx.font = `500 17px ${font}`;
    ctx.direction = rtl ? 'rtl' : 'ltr';
    ctx.textAlign = rtl ? 'right' : 'left';
    ctx.fillText(fitText(ctx, criterionName(c, rtl), nameW), rtl ? rx + rw - 24 : rx + 24, y + 6);
    ctx.fillStyle = '#eef0f3';
    roundRect(ctx, barX, y - 6, barW, 12, 6);
    ctx.fill();
    const fillW = Math.max(12, (barW * s) / 100);
    ctx.fillStyle = colorFor(s);
    roundRect(ctx, rtl ? barX + barW - fillW : barX, y - 6, fillW, 12, 6);
    ctx.fill();
    ctx.fillStyle = '#111827';
    ctx.font = `700 17px ${FONT}`;
    ctx.direction = 'ltr';
    ctx.textAlign = rtl ? 'left' : 'right';
    ctx.fillText(String(s), rtl ? rx + 24 : rx + rw - 24, y + 6);
  });

  return canvas.toBuffer('image/jpeg', 90);
}

// بيرجع { score, image, data } أو بيرمي خطأ مفهوم
async function scoreCv(files, { baseUrl, botKey }) {
  running++;
  try {
    const prep = await prepare(files);
    if (!prep) throw new Error('نوع الملف مش مدعوم');
    const [data, preview] = await Promise.all([
      analyze(baseUrl, prep.upload, botKey),
      prep.preview().catch(() => null), // المعاينة مش ضرورية
    ]);
    const follow = require('../settings').get().cv.imageByLang !== false;
    const rtl = follow && isArabic(await languageSample(prep));
    const image = await drawCard({ score: data.overall_score, criteria: data.criteria, ats: data.ats_compatibility, rtl }, preview);
    return { score: data.overall_score, image, data };
  } finally {
    running--;
  }
}

async function languageSample(prep) {
  if (prep?.text) return prep.text;
  const { fromPdf, extract } = require('./extract');
  if (prep?.upload?.type === 'application/pdf') {
    try {
      return (await fromPdf(prep.upload.buffer, 1)).text || '';
    } catch {
      return '';
    }
  }
  if (/wordprocessingml/.test(prep?.upload?.type || '')) {
    try {
      return (await extract({ buffer: prep.upload.buffer, mimetype: prep.upload.type, filename: prep.upload.filename }, 1)).text || '';
    } catch {
      return '';
    }
  }
  return '';
}

module.exports = { scoreCv, drawCard, textToDocx, busy, isArabic };
