// متصفح منفصل لفحص السيرة (برنامج opti وتحويل الصور لـ PDF).
// قبل كان الفحص يشتغل بنفس متصفح الواتس، وعلى السيرفر الضعيف كان يجمّد صفحة الواتس
// (الرسائل ما تنبعت: Runtime.callFunctionOn timed out). هلق بيفتح للفحص وبيتسكّر بعده
const config = require('../config');
const { CHROMIUM_ARGS } = require('../shared/system');

let chain = Promise.resolve(); // فحص واحد بالمرة عشان الرام
let running = 0;
const busy = () => running > 0;

function withBrowser(fn) {
  running++;
  const run = chain.then(async () => {
    const puppeteer = require('puppeteer');
    const browser = await puppeteer.launch({
      headless: true,
      protocolTimeout: 180e3,
      args: CHROMIUM_ARGS,
      ...(config.BROWSER_PATH && { executablePath: config.BROWSER_PATH }),
    });
    try {
      return await fn(browser);
    } finally {
      await browser.close().catch(() => {});
    }
  });
  chain = run.catch(() => {});
  run.finally(() => running--).catch(() => {});
  return run;
}

module.exports = { withBrowser, busy };
