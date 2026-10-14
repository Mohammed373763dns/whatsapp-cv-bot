// تصليح من مكتبة whatsapp-web.js (commit 064a3d5، مش منشور على npm لسا):
// إرسال الصور كان يفشل بـ "Data passed to getter must include an id property"
// لأنه حقل __x_id تبع الميديا بيتعارض مع id الرسالة. بيشتغل لحاله بعد npm install
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'node_modules', 'whatsapp-web.js', 'src', 'util', 'Injected', 'Utils.js');
if (!fs.existsSync(file)) process.exit(0);

let src = fs.readFileSync(file, 'utf8');
const MARK = 'if (message.__x_id) {';
if (src.includes(MARK)) {
  console.log('whatsapp-web.js media patch: already applied');
  process.exit(0);
}

const anchor = '            ...extraOptions,\n        };\n\n        // Bot\'s won\'t reply if canonicalUrl is set (linking)';
if (!src.replace(/\r\n/g, '\n').includes(anchor)) {
  console.warn('whatsapp-web.js media patch: anchor not found (library changed?) — skipped');
  process.exit(0);
}
src = src.replace(/\r\n/g, '\n').replace(
  anchor,
  anchor.replace(
    "        // Bot's",
    '        // MediaData private __x_id collides with Msg id (upstream fix 064a3d5)\n' +
      '        if (message.__x_id) {\n            delete message.__x_id;\n        }\n        // Bot\'s'
  )
);
fs.writeFileSync(file, src);
console.log('whatsapp-web.js media patch: applied');
