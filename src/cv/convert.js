// برنامج الفحص تبعك بيقبل PDF بس — فبنحوّل الورد والصور لـ PDF قبل ما نرفعها:
//   Word → PDF عن طريق Microsoft Word نفسه (نفس التصميم بالزبط، فالدرجة ما بتتأثر) — وعلى السيرفر LibreOffice
//   صور → PDF عن طريق المتصفح (كل صورة صفحة)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const WORD_TIMEOUT_MS = 90e3;

// على السيرفر (لينكس) ما في Word: LibreOffice بيعمل نفس الشغلة
function libreOfficeToPdf(buffer, filename) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'word-'));
  const ext = path.extname(filename).toLowerCase() || '.docx';
  const input = path.join(dir, `cv${ext}`);
  const output = path.join(dir, 'cv.pdf');
  fs.writeFileSync(input, buffer);
  // بروفايل خاص لكل تحويل عشان تحويلين بنفس الوقت ما يتعارضوا
  const args = [`-env:UserInstallation=file://${path.join(dir, 'profile')}`, '--headless', '--convert-to', 'pdf', '--outdir', dir, input];
  return new Promise((resolve, reject) => {
    execFile('soffice', args, { timeout: WORD_TIMEOUT_MS }, (err) => {
      try {
        if (err || !fs.existsSync(output)) return reject(new Error(`تحويل الورد فشل${err ? `: ${err.message.split('\n')[0]}` : ''}`));
        resolve(fs.readFileSync(output));
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });
}

function wordToPdf(buffer, filename = 'cv.docx') {
  if (process.platform !== 'win32') return libreOfficeToPdf(buffer, filename);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'word-'));
  const ext = path.extname(filename).toLowerCase() || '.docx';
  const input = path.join(dir, `cv${ext}`);
  const output = path.join(dir, 'cv.pdf');
  fs.writeFileSync(input, buffer);

  // 17 = wdFormatPDF
  const script = `
    $ErrorActionPreference = 'Stop'
    $w = New-Object -ComObject Word.Application
    $w.Visible = $false
    $w.DisplayAlerts = 0
    try {
      $d = $w.Documents.Open('${input}', $false, $true)
      $d.SaveAs([ref]'${output}', [ref]17)
      $d.Close([ref]0)
    } finally { $w.Quit() }`;

  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: WORD_TIMEOUT_MS }, (err) => {
      try {
        if (err || !fs.existsSync(output)) return reject(new Error(`تحويل الورد فشل${err ? `: ${err.message.split('\n')[0]}` : ''}`));
        resolve(fs.readFileSync(output));
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });
}

async function imagesToPdf(browser, images) {
  const page = await browser.newPage();
  try {
    const html = `<!doctype html><html><head><style>
      @page { size: A4; margin: 0 }
      body { margin: 0 }
      .p { width: 210mm; height: 297mm; display: flex; align-items: center; justify-content: center; page-break-after: always; overflow: hidden }
      .p:last-child { page-break-after: auto }
      img { max-width: 100%; max-height: 100%; object-fit: contain }
    </style></head><body>${images
      .map((im) => `<div class="p"><img src="data:${im.mimetype || 'image/jpeg'};base64,${im.buffer.toString('base64')}"></div>`)
      .join('')}</body></html>`;
    await page.setContent(html, { waitUntil: 'load' });
    return Buffer.from(await page.pdf({ format: 'A4', printBackground: true }));
  } finally {
    await page.close().catch(() => {});
  }
}

// برنامج الفحص بيقرأ النص بس (ما فيه OCR)، فالصورة لحالها ما بتنفع:
// Grok بيقرأ نص السيرة من الصور حرفياً كـ HTML بسيط، والمتصفح بيعمل منه PDF فيه نص حقيقي
async function imagesToTextPdf(browser, images) {
  const xai = require('../ai/xai');
  const { text } = await xai.chat({
    purpose: 'image_to_text',
    model: process.env.XAI_MODEL_FAST,
    maxTokens: 4000,
    temperature: 0,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'text',
          text: 'هاي صور سيرة ذاتية. انسخ كل النص اللي فيها حرفياً بنفس الترتيب و بنفس اللغة بدون أي تعديل أو تلخيص أو إضافة. ' +
            'رجّع HTML بسيط بس (h1 للاسم، h2 لعناوين الأقسام، p للفقرات، ul/li للنقاط) بدون أي شرح وبدون ```.',
        },
        ...images.map((im) => xai.imagePart(im.buffer, im.mimetype || 'image/jpeg', 'high')),
      ],
    }],
  });
  const body = text.replace(/^```(html)?|```$/g, '').trim();
  const rtl = /[؀-ۿ]/.test(body.replace(/<[^>]+>/g, '').slice(0, 400));
  const page = await browser.newPage();
  try {
    await page.setContent(`<!doctype html><html dir="${rtl ? 'rtl' : 'ltr'}"><head><meta charset="utf-8"><style>
      @page { size: A4; margin: 18mm }
      body { font-family: Arial, Tahoma, sans-serif; font-size: 11pt; line-height: 1.45; color: #111 }
      h1 { font-size: 20pt; margin: 0 0 6pt } h2 { font-size: 13pt; margin: 12pt 0 4pt; border-bottom: 1px solid #999 }
      p, li { margin: 2pt 0 }
    </style></head><body>${body}</body></html>`, { waitUntil: 'load' });
    return Buffer.from(await page.pdf({ format: 'A4', printBackground: true }));
  } finally {
    await page.close().catch(() => {});
  }
}

const isPdf = (f) => f.mimetype === 'application/pdf' || /\.pdf$/i.test(f.filename || '');
const isWord = (f) => /\.(docx?|rtf|odt)$/i.test(f.filename || '') || /wordprocessingml|msword/.test(f.mimetype || '');
const isImage = (f) => (f.mimetype || '').startsWith('image/');

// أي ملف سيرة (أو مجموعة صور) → { buffer, filename } بصيغة PDF
async function toPdf(browser, files) {
  const pdf = files.find(isPdf);
  if (pdf) return { buffer: pdf.buffer, filename: pdf.filename || 'cv.pdf' };
  const word = files.find(isWord);
  if (word) return { buffer: await wordToPdf(word.buffer, word.filename), filename: (word.filename || 'cv').replace(/\.\w+$/, '') + '.pdf' };
  const images = files.filter(isImage);
  if (images.length) return { buffer: await imagesToTextPdf(browser, images), filename: 'cv-images.pdf' };
  return null;
}

module.exports = { toPdf, wordToPdf, imagesToPdf, imagesToTextPdf };
