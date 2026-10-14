// إعدادات البوت — عدّلها حسب حاجتك
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
  // مسار المتصفح: على السيرفر Chromium (من الـDockerfile)، وعلى اللابتوب Edge
  BROWSER_PATH: process.env.PUPPETEER_EXECUTABLE_PATH
    || (process.platform === "win32" ? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe" : null),
};
