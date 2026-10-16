const test = require('node:test');
const assert = require('node:assert');
const { drawCard, isArabic } = require('../src/cv/score');

const criteria = [
  { name_en: 'Professional summary', score: 70 },
  { name_en: 'Formatting', score: 40 },
];

test('isArabic follows the CV text', () => {
  assert.strictEqual(isArabic('محمد خبرة في المحاسبة واللغة العربية والخبرة العملية'), true);
  assert.strictEqual(isArabic('John Smith professional experience in accounting'), false);
});

test('the score card draws in English and in Arabic RTL', async () => {
  const en = await drawCard({ score: 64, criteria, ats: 'Medium', rtl: false });
  const ar = await drawCard({ score: 64, criteria, ats: 'Medium', rtl: true });
  assert.ok(en[0] === 0xff && en[1] === 0xd8);
  assert.ok(ar[0] === 0xff && ar[1] === 0xd8);
  assert.ok(en.length > 5000 && ar.length > 5000);
});
