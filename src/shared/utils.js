const fs = require('fs');
const path = require('path');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeJson(file, data) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function csvCell(value) {
  if (value === null || value === undefined) return '';
  const s = String(value).replace(/\r?\n/g, ' ');
  return /[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// BOM عشان Excel يقرأ العربي صح
function writeCsv(file, rows, columns) {
  ensureDir(path.dirname(file));
  const lines = [columns.join(',')];
  for (const row of rows) lines.push(columns.map((c) => csvCell(row[c])).join(','));
  fs.writeFileSync(file, '﻿' + lines.join('\n'), 'utf8');
}

const toIso = (ts) => (ts ? new Date(ts * 1000).toISOString() : null);

module.exports = { ensureDir, writeJson, readJson, writeCsv, toIso };
