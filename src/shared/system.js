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
  '--no-zygote',
  '--disable-extensions',
  '--disable-background-networking',
  '--disable-default-apps',
  '--disable-sync',
  '--mute-audio',
  '--renderer-process-limit=2',
  '--disable-features=site-per-process,Translate,MediaRouter,OptimizationHints',
];

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

module.exports = { CHROMIUM_ARGS, memory, memoryText, startMemoryLog, friendlyError };
