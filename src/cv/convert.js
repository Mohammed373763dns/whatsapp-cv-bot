// تحويل الورد لـ PDF (للمعاينة بكرت الدرجة، ولملفات .doc اللي الموقع ما بيقبلها):
//   على اللابتوب Microsoft Word نفسه، وعلى السيرفر LibreOffice
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const WORD_TIMEOUT_MS = 90e3;

// على السيرفر (لينكس) ما في Word: LibreOffice بيعمل نفس الشغلة
function libreOfficeToPdf(buffer, filename) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'word-'));
  const ext = path.extname(filename).toLowerCase() || '.docx';
  const input = path.join(dir, `cv${ext}`);
  const output = path.join(dir, 'cv.pdf');
  fs.writeFileSync(input, buffer);
  // بروفايل خاص لكل تحويل عشان تحويلين بنفس الوقت ما يتعارضوا
  const args = [`-env:UserInstallation=file://${path.join(dir, 'profile')}`, '--headless', '--convert-to', 'pdf', '--outdir', dir, input];
  return new Promise((resolve, reject) => {
    execFile('soffice', args, { timeout: WORD_TIMEOUT_MS }, (err) => {
      try {
        if (err || !fs.existsSync(output)) return reject(new Error(`تحويل الورد فشل${err ? `: ${err.message.split('\n')[0]}` : ''}`));
        resolve(fs.readFileSync(output));
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });
}

function wordToPdf(buffer, filename = 'cv.docx') {
  if (process.platform !== 'win32') return libreOfficeToPdf(buffer, filename);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'word-'));
  const ext = path.extname(filename).toLowerCase() || '.docx';
  const input = path.join(dir, `cv${ext}`);
  const output = path.join(dir, 'cv.pdf');
  fs.writeFileSync(input, buffer);

  // 17 = wdFormatPDF
  const script = `
    $ErrorActionPreference = 'Stop'
    $w = New-Object -ComObject Word.Application
    $w.Visible = $false
    $w.DisplayAlerts = 0
    try {
      $d = $w.Documents.Open('${input}', $false, $true)
      $d.SaveAs([ref]'${output}', [ref]17)
      $d.Close([ref]0)
    } finally { $w.Quit() }`;

  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: WORD_TIMEOUT_MS }, (err) => {
      try {
        if (err || !fs.existsSync(output)) return reject(new Error(`تحويل الورد فشل${err ? `: ${err.message.split('\n')[0]}` : ''}`));
        resolve(fs.readFileSync(output));
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });
}

module.exports = { wordToPdf };
