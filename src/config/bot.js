// إعدادات البوت — النصوص بتقدر تعدلها كمان من الداشبورد
const path = require('path');
const { OUTPUT_DIR } = require('./index');

module.exports = {
  // لما الزبون يطلب فحص
  ASK_TEXT: 'اهلا وسهلا 🌷 ابعتلنا سيرتك الذاتية للفحص',
  // لما يبعت الملف
  ACK_TEXT: 'تمام، الفريق رح يفحصها ويزودك بالنتائج بأسرع وقت ممكن 🌷',

  // الحماية من الحظر
  SAFETY: {
    MIN_REPLY_DELAY_SEC: 4,  // أقل انتظار قبل الرد
    MAX_REPLY_DELAY_SEC: 15, // أكثر انتظار قبل الرد
    MAX_TYPING_SEC: 8,       // "عم يكتب..."
    MAX_PER_MINUTE: 6,
    MAX_PER_HOUR: 60,
    MAX_PER_DAY: 400,
  },

  DASHBOARD_PORT: 3000,
  DB_FILE: path.join(OUTPUT_DIR, 'bot.db'),
};
