// إعدادات البوت — عدّلها حسب حاجتك
const fs = require('fs');
const path = require('path');

// على Railway: STORAGE_DIR = مسار الـVolume، فجلسة الواتس وقاعدة البيانات بيضلوا بعد كل تحديث
const STORAGE = process.env.STORAGE_DIR || null;

module.exports = {
  // عدد المحادثات (الأحدث أولاً). Infinity = كل المحادثات
  CHAT_LIMIT: Infinity,
  // عدد الرسائل من كل محادثة. Infinity = كل الرسائل المتاحة
  MESSAGES_PER_CHAT: Infinity,
  // تضمين القروبات؟
  INCLUDE_GROUPS: false,
  // تضمين المحادثات المؤرشفة؟
  INCLUDE_ARCHIVED: true,
  // نطلب من الجوال الرسائل القديمة اللي ما وصلت لواتساب ويب (أبطأ بس أكمل)
  FETCH_OLDER_FROM_PHONE: true,
  // كل طلب بيجيب حوالي 50 رسالة
  MAX_PHONE_REQUESTS_PER_CHAT: 40,
  // محادثات ما بتنحسب كبيعات (رقمك، الفريق...)
  EXCLUDE_FROM_SALES: ["محمد ابو عقلين"],
  // مجلد حفظ النتائج
  OUTPUT_DIR: STORAGE ? path.join(STORAGE, "data") : "data",
  // جلسة الواتس (عشان ما تمسح الـQR كل مرة)
  AUTH_DIR: STORAGE ? path.join(STORAGE, "auth") : ".wwebjs_auth",
  CACHE_DIR: STORAGE ? path.join(STORAGE, "cache") : ".wwebjs_cache",
  // مسار المتصفح: على السيرفر Google Chrome (من الـDockerfile)، وعلى اللابتوب Edge
  BROWSER_PATH: findBrowser(),
};

// أول متصفح موجود فعلاً. إذا المسار بالإعدادات غلط ما بيوقف البوت: بيدور بالأماكن المعروفة
function findBrowser() {
  const candidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    ...(process.platform === "win32"
      ? ["C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"]
      : ["/usr/bin/google-chrome-stable", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"]),
  ].filter(Boolean);
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) console.error(`No browser found (looked in: ${candidates.join(", ")})`);
  else if (process.env.PUPPETEER_EXECUTABLE_PATH && found !== process.env.PUPPETEER_EXECUTABLE_PATH) console.error(`Browser not at ${process.env.PUPPETEER_EXECUTABLE_PATH}, using ${found}`);
  return found || null;
}
