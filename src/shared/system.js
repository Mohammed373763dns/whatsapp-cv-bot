// الرام والمتصفح على السيرفر
const fs = require('fs');

// إعدادات Chromium اللي بتقلل الرام على السيرفر (متصفح الواتس ومتصفح الفحص)
const CHROMIUM_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage', // /dev/shm صغير بالحاويات
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  '--disable-default-apps',
  '--disable-sync',
  '--mute-audio',
  '--disable-features=Translate,MediaRouter,OptimizationHints',
  // Chrome بيكتب سبب الانهيار هون، ومنطبع منه بس السطور المهمة (watchBrowser)
  '--enable-logging=stderr',
  '--v=0',
];

// سطور Chrome اللي بتشرح ليش انهارت الصفحة (الباقي ضجيج)
const CRASH_LINE = /FATAL|crash|Out of memory|OOM|Received signal|Check failed|shared memory|shm|renderer.*(exit|kill|gone)|GPU process/i;
function watchBrowser(browser, label) {
  const proc = browser?.process?.();
  if (proc?.stderr) {
    let last = 0;
    proc.stderr.on('data', (chunk) => {
      for (const line of String(chunk).split('\n')) {
        if (!CRASH_LINE.test(line) || /non-fatal|fburl.com/i.test(line) || Date.now() - last < 200) continue;
        last = Date.now();
        console.error(`[${label} chrome] ${line.trim().slice(0, 300)}`);
      }
    });
  }
  browser.version().then((v) => console.log(`${label} browser: ${v}`)).catch(() => {});
}

const read = (f) => {
  try {
    return fs.readFileSync(f, 'utf8').trim();
  } catch {
    return null;
  }
};

// استهلاك الحاوية كلها (البوت + المتصفحات) من cgroup. على اللابتوب بيرجع null
function memory() {
  const used = Number(read('/sys/fs/cgroup/memory.current') || read('/sys/fs/cgroup/memory/memory.usage_in_bytes'));
  const rawMax = read('/sys/fs/cgroup/memory.max') || read('/sys/fs/cgroup/memory/memory.limit_in_bytes');
  if (!used) return null;
  const max = rawMax && rawMax !== 'max' && Number(rawMax) < 2 ** 50 ? Number(rawMax) : null;
  const mb = (b) => Math.round(b / 1048576);
  return { usedMb: mb(used), limitMb: max ? mb(max) : null, percent: max ? Math.round((used / max) * 100) : null };
}

const memoryText = (m = memory()) => (m ? `${m.usedMb}MB${m.limitMb ? ` / ${m.limitMb}MB (${m.percent}%)` : ''}` : 'unknown');

// كل دقيقة بالـlogs، عشان نعرف إذا الرام هي السبب لما الواتس يعلق
function startMemoryLog() {
  if (!memory()) return;
  console.log(`memory: ${memoryText()}`);
  setInterval(() => console.log(`memory: ${memoryText()}`), 60e3).unref();
}

// أخطاء المتصفح بالإنجليزي ← جملة مفهومة باللوحة
function friendlyError(message) {
  const m = String(message || '');
  if (/timed out|ما رد خلال|Target closed|Session closed|crash/i.test(m)) {
    const mem = memory();
    const full = mem?.percent >= 85 ? ` (الرام ${mem.percent}% مليانة)` : '';
    return `صفحة الواتس على السيرفر ما ردت${full}. البوت أعاد تشغيلها، جرب كمان شوي`;
  }
  if (/net::|ENOTFOUND|ECONNRESET|fetch failed/i.test(m)) return 'مشكلة بالإنترنت على السيرفر';
  return m.slice(0, 200);
}

module.exports = { CHROMIUM_ARGS, watchBrowser, memory, memoryText, startMemoryLog, friendlyError };
