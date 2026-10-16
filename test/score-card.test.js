const test = require('node:test');
const assert = require('node:assert');
const { drawCard, isArabic, criterionName, tuneCriteria } = require('../src/cv/score');

const criteria = [
  { name_en: 'Professional summary', score: 70 },
  { name_en: 'Formatting', score: 40 },
];

test('isArabic follows the CV text', () => {
  assert.strictEqual(isArabic('محمد خبرة في المحاسبة واللغة العربية والخبرة العملية'), true);
  assert.strictEqual(isArabic('John Smith professional experience in accounting'), false);
});

test('Arabic card names the leftover English criteria', () => {
  assert.strictEqual(criterionName({ name_en: 'Work experience structure' }, true), 'تنسيق الخبرات المهنية');
  assert.strictEqual(criterionName({ name_en: 'ATS template capability' }, true), 'قابلية تخطي أنظمة الفرز');
});

test('ATS pass score drops to 75 when the CV has no numbers', () => {
  const rows = tuneCriteria([
    { name_en: 'Quantified achievements', score: 12 },
    { name_en: 'ATS template capability', score: 88 },
    { name_en: 'Education', score: 80 },
  ]);
  assert.strictEqual(rows[1].score, 75);
  assert.strictEqual(rows[2].score, 80);
  const kept = tuneCriteria([
    { name_en: 'Quantified achievements', score: 70 },
    { name_en: 'ATS template capability', score: 88 },
  ]);
  assert.strictEqual(kept[1].score, 88);
});

test('the score card draws in English and in Arabic RTL', async () => {
  const en = await drawCard({ score: 64, criteria, ats: 'Medium', rtl: false });
  const ar = await drawCard({ score: 64, criteria, ats: 'Medium', rtl: true });
  assert.ok(en[0] === 0xff && en[1] === 0xd8);
  assert.ok(ar[0] === 0xff && ar[1] === 0xd8);
  assert.ok(en.length > 5000 && ar.length > 5000);
});
