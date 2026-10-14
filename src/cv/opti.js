// فحص السيرة ببرنامجك (cv-builder → opti-company.vercel.app/check-cv):
// بنرفع الـPDF بنفس الصفحة اللي بتستخدمها إنت، بنستنى النتيجة، بنقرأ الدرجة وبناخد صورة
// ملاحظة: صفحة الفحص العامة بتسمح 12 فحص بالساعة لكل اتصال
const fs = require('fs');
const os = require('os');
const path = require('path');
const { renderPdf } = require('./extract');

const RESULT_TIMEOUT_MS = 150e3;
// الصورة مقصوصة شريط فوق بس (الدرجة + النظرة العامة + أول المعاينة) زي ما بتقصها إنت
const CROP_HEIGHT = 300;

// botKey: نفس OPTI_BOT_KEY اللي على Vercel — بيلغي حد الـ12 بالساعة للبوت بس
async function checkWithOpti(browser, pdfBuffer, { baseUrl, filename = 'cv.pdf', botKey } = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opti-'));
  const file = path.join(tmpDir, filename.replace(/[^\w.\-]+/g, '_').replace(/(\.pdf)?$/i, '.pdf'));
  fs.writeFileSync(file, pdfBuffer);
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
    if (botKey) await page.setExtraHTTPHeaders({ 'X-Opti-Bot-Key': botKey });
    await page.goto(`${baseUrl.replace(/\/$/, '')}/check-cv`, { waitUntil: 'networkidle2', timeout: 60e3 });
    const input = await page.waitForSelector('#pdf-input', { timeout: 30e3 });
    await input.uploadFile(file); // الصفحة بتبلش الفحص لحالها لما ينختار الملف

    // يا النتيجة يا رسالة خطأ (مثلاً خلص حد الـ12 بالساعة)
    const outcome = await Promise.race([
      page.waitForFunction(() => location.pathname === '/check-cv/result', { timeout: RESULT_TIMEOUT_MS }).then(() => 'result'),
      page.waitForFunction(() => {
        const e = document.getElementById('cv-check-error');
        return e && e.textContent.trim().length > 0 ? e.textContent.trim() : false;
      }, { timeout: RESULT_TIMEOUT_MS }).then((h) => h.jsonValue()).then((msg) => `error:${msg}`),
    ]);
    if (outcome !== 'result') throw new Error(`برنامج الفحص: ${outcome.slice(6)}`);

    await page.waitForFunction(() => /\d/.test(document.getElementById('overall-num')?.textContent || ''), { timeout: 30e3 });
    // معاينة السيرة: الصفحة بترسمها على canvas (بتطلع حلوة بالصورة) — بنستناها لحد 15 ثانية
    const drawn = await page
      .waitForFunction(() => {
        const wrap = document.getElementById('pdf-preview-canvas-wrap');
        const c = document.getElementById('pdf-preview-canvas');
        return wrap && !wrap.hidden && c && c.width > 50;
      }, { timeout: 15e3 })
      .then(() => true)
      .catch(() => false);
    // ما زبطت (بيطلع عارض PDF مكبّر أو أسود)؟ منرسم الصفحة الأولى بأنفسنا ومنحطها مكانه
    if (!drawn) {
      const [first] = await renderPdf(pdfBuffer, 1, 1.4).catch(() => []);
      if (first) {
        await page.evaluate((src) => {
          const shell = document.getElementById('pdf-preview-shell');
          if (shell) shell.innerHTML = `<img src="${src}" style="display:block;width:100%;border:1px solid #e5e7eb;border-radius:8px;background:#fff">`;
        }, `data:image/jpeg;base64,${first.toString('base64')}`);
      }
    }
    await new Promise((r) => setTimeout(r, 2000)); // أنيميشن الدائرة
    const score = await page.$eval('#overall-num', (el) => Number(el.textContent.replace(/[^\d]/g, '')));

    // نفس اللقطة اللي بتاخدها إنت: الدرجة + اللمحة السريعة + معاينة السيرة
    const box = await page.$eval('#result-triptych', (el) => {
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top + window.scrollY, width: r.width, height: r.height };
    });
    const image = await page.screenshot({
      type: 'jpeg',
      quality: 85,
      clip: { x: box.x, y: box.y, width: box.width, height: Math.min(box.height, CROP_HEIGHT) },
      captureBeyondViewport: true,
    });
    return { score, image };
  } finally {
    await page.close().catch(() => {});
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

module.exports = { checkWithOpti };
