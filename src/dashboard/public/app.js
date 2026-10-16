// لوحة البوت — زي واتساب ويب: القائمة على جنب، المحادثة بالنص، ونتيجة الفحص تحت الرسائل
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const enc = encodeURIComponent;
const now = () => Math.floor(Date.now() / 1000);

const ICONS = {
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3 1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8 1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  back: '<path d="M9 6l6 6-6 6"/>',
  send: '<path d="M21 3L10 14M21 3l-7 18-4-7-7-4z"/>',
  mute: '<path d="M11 5L6 9H3v6h3l5 4z"/><path d="M22 9l-6 6M16 9l6 6"/>',
  sound: '<path d="M11 5L6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14"/>',
  reset: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/>',
};
const icon = (n) => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${ICONS[n]}</svg>`;

async function api(url, body) {
  const res = await fetch(url, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  return res.json();
}

function toast(text, err = false) {
  const t = $('#toast');
  t.textContent = text;
  t.className = 'toast' + (err ? ' err' : '');
  t.hidden = false;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => (t.hidden = true), err ? 5000 : 2500);
}

const typingIn = (el) => el.contains(document.activeElement) && /TEXTAREA|INPUT/.test(document.activeElement.tagName);
// بيرسم بس إذا تغيّر شي، وما بيرسم فوق كتابتك
function patch(el, html) {
  if (!el || el.__html === html || typingIn(el)) return false;
  el.innerHTML = html;
  el.__html = html;
  return true;
}

// نافذة تأكيد مصممة مع اللوحة (بدل confirm تبع المتصفح)
function ask(title, text, ok = 'تأكيد', danger = false) {
  const d = $('#confirm');
  $('#confirm-title').textContent = title;
  $('#confirm-text').textContent = text;
  const btn = $('#confirm-ok');
  btn.textContent = ok;
  btn.className = `btn ${danger ? 'danger-solid' : 'primary'}`;
  d.returnValue = '';
  d.showModal();
  return new Promise((resolve) => d.addEventListener('close', () => resolve(d.returnValue === 'yes'), { once: true }));
}

/* ------------------------------ تنسيق ------------------------------ */
// الأرقام بتنكتب من الشمال لليمين حتى جوا صفحة عربية (+972 56-830-7434 مش 56-830-7434 972+)
const looksLikePhone = (s) => /^[+\d][\d\s\-()]+$/.test(String(s || '').trim());
const phone = (p) => (p ? `<bdi dir="ltr">+${esc(p)}</bdi>` : '');
const nameOf = (c) => {
  if (c.name && !looksLikePhone(c.name)) return `<bdi>${esc(c.name)}</bdi>`;
  if (c.name) return `<bdi dir="ltr">${esc(c.name)}</bdi>`;
  return phone(c.phone) || 'زبون';
};
const initial = (c) => (c.name && !looksLikePhone(c.name) ? esc(c.name.trim()[0]) : '#');
const hhmm = (ts) => new Date(ts * 1000).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
const dayOf = (ts) => new Date(ts * 1000).toLocaleDateString('ar', { weekday: 'long', day: 'numeric', month: 'long' });
function when(ts) {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  if (d.toDateString() === new Date().toDateString()) return hhmm(ts);
  if (now() - ts < 6 * 86400) return d.toLocaleDateString('ar', { weekday: 'long' });
  return d.toLocaleDateString('ar', { day: 'numeric', month: 'short' });
}
const mins = (s) => (s < 60 ? 'أقل من دقيقة' : s < 3600 ? `${Math.round(s / 60)} د` : `${Math.round(s / 3600)} س`);

/* ------------------------------ الحالة ------------------------------ */
let S = null; // حالة السيرفر (الواتس، الإعدادات، النتائج)
let CHATS = [];
let filter = 'all';
let openId = null;
try { openId = sessionStorage.getItem('chat'); } catch {}

const BADGE = {
  wait: ['wait', 'نتيجة بتستنى'],
  sent: ['done', '✓ انبعتت'],
  checked: ['checked', 'انفحص'],
  muted: ['muted', '🔇 ساكت'],
  new: ['', ''],
};
const statusOf = (c) => (c.waiting ? 'wait' : c.status);
const FILTERS = [
  ['all', 'الكل', () => true],
  ['wait', 'بانتظارك', (c) => c.waiting],
  ['new', 'ما انفحص', (c) => c.status === 'new'],
  ['done', 'انفحص', (c) => c.status === 'checked' || c.status === 'sent'],
  ['muted', 'ساكت', (c) => c.status === 'muted'],
];

const WA = { ready: 'متصل', qr: 'بانتظار مسح الكود', starting: 'عم يشتغل...', syncing: 'عم يزامن...', logging_out: 'عم يسجل خروج...', retrying: 'عم يعيد الاتصال...', restarting: 'عم يعيد التشغيل...', stopped: 'مطفي' };

function renderBar() {
  const key = (S.whatsapp.status || '').split(':')[0];
  const dot = S.whatsapp.ready ? 'ok' : /disconnected|retrying/.test(key) ? 'bad' : '';
  // الرام على السيرفر: إذا قربت تخلص صفحة الواتس بتعلق، فمنبيّنها
  const m = S.memory;
  const mem = m?.percent ? `<span class="mem ${m.percent >= 85 ? 'high' : ''}" title="الرام المستخدمة على السيرفر: ${m.usedMb} من ${m.limitMb} ميجا">الرام ${m.percent}%</span>` : '';
  // سطر صغير تحت اسم البوت: حالة الواتس والرقم والرام (وإذا البوت موقّف بالأحمر)
  const off = S.enabled ? '' : '<span class="off">· البوت موقّف</span>';
  const acct = S.whatsapp.account?.phone ? `<span title="الرقم المربوط">· ${phone(S.whatsapp.account.phone)}</span>` : '';
  const relink = !S.whatsapp.ready && !S.whatsapp.qr && key !== 'logging_out' ? '<button class="pill-btn" data-relink>اعرض كود الربط</button>' : '';
  patch($('#wa'), `<span class="dot ${dot}"></span><span>${esc(WA[key] || S.whatsapp.status)}</span>${off || acct}${mem}${relink}`);
  $('#enabled').checked = S.enabled;
  $('#enabled').closest('.switch').title = S.enabled ? 'البوت شغّال — اكبس لتوقيفه' : 'البوت موقّف — اكبس لتشغيله';
  $('#req-count').textContent = S.pendingRequests || '';

  const qr = $('#qr');
  qr.hidden = !S.whatsapp.qr;
  if (S.whatsapp.qr) patch(qr, `<div class="qr-card"><b>اربط رقم الواتس</b><p>من الجوال: الإعدادات ← الأجهزة المرتبطة ← ربط جهاز، وامسح الكود</p><img src="${S.whatsapp.qr}" alt="كود QR"></div>`);

  if (!$('#ackText').dataset.loaded) {
    $('#ackText').value = S.ackText;
    $('#ackText').dataset.loaded = '1';
  }
  $('#autoSend').checked = S.autoSend.enabled;
  if (document.activeElement !== $('#afterMin')) $('#afterMin').value = S.autoSend.afterMin;
}

function renderList() {
  const count = (fn) => CHATS.filter(fn).length;
  const sel = $('#filter');
  if (document.activeElement !== sel) {
    patch(sel, FILTERS.map(([id, label, fn]) => `<option value="${id}">${label} (${count(fn)})</option>`).join(''));
    sel.value = filter;
  }
  const fn = FILTERS.find((f) => f[0] === filter)[2];
  const list = CHATS.filter(fn);
  patch($('#items'), list.length
    ? list.map((c) => {
      const [cls, label] = BADGE[statusOf(c)];
      return `<button class="item ${c.id === openId ? 'on' : ''}" data-open="${esc(c.id)}">
        <span class="avatar">${initial(c)}</span>
        <span class="main">
          <span class="l1"><span class="name">${nameOf(c)}</span><span class="time">${when(Math.max(c.last_in || 0, c.last_out || 0))}</span></span>
          <span class="l2"><span class="prev">${c.last_from_me ? '✓ ' : ''}${esc((c.last_body || '').split('\n')[0])}</span>${label ? `<span class="badge ${cls}">${label}</span>` : ''}</span>
        </span>
      </button>`;
    }).join('')
    : `<div class="list-empty">${filter === 'all' ? 'لسا ما في محادثات' : 'ما في محادثات هون'}</div>`);
}

/* ------------------------------ المحادثة ------------------------------ */
function bubble(m) {
  const src = !m.from_me ? '' : m.by_bot === 1 ? 'البوت' : m.by_bot === 2 ? 'إنت (من اللوحة)' : 'الموظف';
  const cls = !m.from_me ? '' : m.by_bot === 1 ? 'out bot' : 'out';
  const file = !m.from_me && (m.type === 'document' || m.type === 'image');
  return `<div class="msg ${cls}"><div class="txt">${esc(m.body || '')}</div>`
    + (file ? `<div class="act"><button class="link-btn" data-check="${esc(m.id)}">افحص هاد الملف</button></div>` : '')
    + `<div class="meta">${src ? `<span class="src">${src}</span>` : ''}<span>${hhmm(m.ts)}</span></div></div>`;
}

// رد آلي أو رسالة منك لسا ما انبعتت: بتبيّن بالمحادثة مع حالتها
function outgoing(r) {
  const failed = r.status === 'failed';
  const src = r.scenario === 'ack' ? 'البوت · الرد الآلي' : 'إنت (من اللوحة)';
  let state = '⏳ بتستنى دورها';
  if (r.status === 'queued') state = !S.whatsapp.ready ? '⏳ بتستنى الواتس يتصل' : `⏳ عم تنبعت${r.queued_at && now() - r.queued_at > 60 ? ` (صرلها ${mins(now() - r.queued_at)})` : ''}`;
  if (failed) state = 'ما انبعتت';
  return `<div class="msg out ${r.scenario === 'ack' ? 'bot' : ''} ${failed ? 'failed' : 'pending'}"><div class="txt">${esc(r.text)}</div>`
    + (failed ? `<div class="act"><button class="link-btn" data-retry="${r.id}">حاول مرة تانية</button></div>` : '')
    + `<div class="meta"><span class="src">${src}</span><span class="state">${state}</span></div></div>`;
}

function resultPanel(r) {
  const failed = r.status === 'failed';
  const queued = r.status === 'queued';
  const waited = queued && r.queued_at ? now() - r.queued_at : 0;
  let left = '';
  if (S.autoSend.enabled && r.text && r.status === 'pending') {
    const s = r.created + S.autoSend.afterMin * 60 - now();
    if (s > -3 * 3600) left = `<span class="countdown">⏱ ${s > 60 ? `بتنبعت لحالها بعد ${mins(s)}` : 'بتنبعت لحالها هلأ'}</span>`;
  }
  const score = (r.note || '').match(/الدرجة (\d+)%/);
  return `<div class="result ${failed || !r.text ? 'fail' : ''}" data-id="${r.id}">
    <div class="result-head"><b>نتيجة الفحص</b>${score ? `<span class="meta">الدرجة ${score[1]}%</span>` : ''}${left}</div>
    ${!r.text ? `<div class="alert warn">الفحص ما زبط: ${esc(r.note || '')}. اكتب النتيجة بإيدك وابعتها.</div>` : ''}
    ${failed ? `<div class="alert bad">ما انبعتت: ${esc((r.note || '').replace(/^.*فشل الإرسال: /, ''))}</div>` : ''}
    ${queued && !S.whatsapp.ready ? '<div class="alert warn">بتستنى الواتس يرجع يتصل وبتنبعت لحالها</div>' : ''}
    ${queued && S.whatsapp.ready && waited > 120 ? `<div class="alert warn">صرلها ${mins(waited)} عم تنبعت. إذا ما انبعتت خلال دقيقتين بتطلعلك "حاول مرة تانية"</div>` : ''}
    <div class="result-body">
      ${r.image ? `<img class="thumb" src="${esc(r.image)}" alt="صورة الدرجة" data-zoom>` : ''}
      <textarea rows="7" aria-label="نص نتيجة الفحص">${esc(r.text)}</textarea>
    </div>
    <div class="foot">
      <span class="note">${esc(r.note || '')}</span>
      <button class="btn" data-dismiss>تجاهل</button>
      <button class="btn primary" data-send ${queued ? 'disabled' : ''}>${queued ? 'عم تنبعت...' : failed ? 'حاول مرة تانية' : 'ابعت للزبون'}</button>
    </div>
  </div>`;
}

async function renderConv() {
  const box = $('#conv');
  if (!openId) return;
  const d = await api(`/api/chats/${enc(openId)}`);
  if (d.error) return closeChat();
  const c = d.chat;
  if (box.dataset.chat !== openId) {
    box.dataset.chat = openId;
    box.innerHTML = `<div class="conv-head" id="head"></div><div class="msgs" id="msgs"></div><div id="results"></div>
      <div class="composer"><textarea id="compose" rows="1" placeholder="اكتب رسالة للزبون"></textarea><button class="send-btn" id="send-msg" aria-label="ابعت">${icon('send')}</button></div>`;
  }
  patch($('#head'), `<button class="icon-btn back" data-back aria-label="رجوع">${icon('back')}</button>
    <span class="avatar">${initial(c)}</span>
    <div class="who"><b>${nameOf(c)}</b><small>${phone(c.phone)}</small></div>
    <button class="icon-btn ${c.muted ? 'on' : ''}" data-mute="${c.muted ? 0 : 1}" title="${c.muted ? 'البوت ساكت مع هالرقم — اكبس لتشغيله' : 'سكّت البوت مع هالرقم'}">${icon(c.muted ? 'mute' : 'sound')}</button>
    <button class="icon-btn" data-reset title="امسح سجل البوت (الرقم بيقدر ينفحص مرة كمان)">${icon('reset')}</button>
    <button class="icon-btn danger" data-delete title="احذف من اللوحة (مش من الواتس)">${icon('trash')}</button>`);

  let lastDay = '';
  const html = d.messages.map((m) => {
    const day = dayOf(m.ts);
    const sep = day !== lastDay ? `<div class="day">${day}</div>` : '';
    lastDay = day;
    return sep + bubble(m);
  }).join('') + d.replies.filter((r) => r.scenario !== 'result').map(outgoing).join('') || '<div class="conv-empty">ما في رسائل</div>';
  const el = $('#msgs');
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  // لوحة النتيجة أول: هي بتاخد مكان من الرسائل، فالسكرول لتحت لازم يصير بعدها
  const resultsChanged = patch($('#results'), d.replies.filter((r) => r.scenario === 'result').map(resultPanel).join(''));
  const msgsChanged = patch(el, html);
  if ((msgsChanged || resultsChanged) && (atBottom || el.__chat !== openId)) {
    el.scrollTop = el.scrollHeight;
    el.__chat = openId;
  }
}

function openChat(id) {
  openId = id;
  try { sessionStorage.setItem('chat', id); } catch {}
  $('#app').classList.add('show-conv');
  renderList();
  if (view === 'requests') renderRequests();
  renderConv();
}

function closeChat() {
  openId = null;
  try { sessionStorage.removeItem('chat'); } catch {}
  const box = $('#conv');
  box.dataset.chat = '';
  box.innerHTML = '<div class="conv-empty"><div class="big">💬</div><b>اختار محادثة</b></div>';
  $('#app').classList.remove('show-conv');
  renderList();
}

/* ------------------------------ الطلبات ------------------------------ */
let view = 'chats';
try { view = localStorage.getItem('view') || 'chats'; } catch {}

const REQ_STATUS = {
  checking: 'عم ينفحص',
  ready: 'جاهزة للمراجعة',
  sending: 'عم تنبعت',
  check_failed: 'الفحص فشل',
  send_failed: 'ما انبعتت',
  sent: 'انبعتت',
  dismissed: 'تجاهلتها',
};

function reqDetail(q) {
  const t = now();
  if (q.status === 'checking') return `صرلها ${mins(t - q.started)} عم تنفحص`;
  if (q.status === 'ready') {
    if (!S.autoSend.enabled) return 'بتستناك تراجعها وتبعتها';
    const left = q.r_created + S.autoSend.afterMin * 60 - t;
    if (left < -3 * 3600) return 'بتستناك تراجعها وتبعتها (فات وقت الإرسال التلقائي)';
    return left > 60 ? `بتنبعت لحالها بعد ${mins(left)}` : 'بتنبعت لحالها هلأ';
  }
  if (q.status === 'sending') return S.whatsapp.ready ? `عم تنبعت${q.queued_at ? ` من ${mins(t - q.queued_at)}` : ''}` : 'بتستنى الواتس يتصل';
  if (q.status === 'sent') return `انبعتت ${when(q.sent_at)}`;
  if (q.status === 'check_failed') return q.error || (q.r_note || '').replace(/^.*?الفحص فشل: /, '') || 'الفحص ما زبط';
  if (q.status === 'send_failed') return (q.r_note || '').replace(/^.*فشل الإرسال: /, '') || 'الإرسال فشل';
  return '';
}

// الطلبات بالعمود الجانبي (مكان قائمة المحادثات). الكبسة على الطلب بتفتح محادثته جنبه
async function renderRequests() {
  const filterVal = $('#req-filter').value;
  const q0 = $('#q').value.trim();
  const list = (await api(`/api/requests?filter=${enc(filterVal)}`))
    .filter((q) => !q0 || `${q.name || ''} ${q.phone || ''}`.includes(q0));
  const empty = { pending: 'ما في طلبات معلقة 👌', sent: 'لسا ما انبعتت ولا نتيجة', failed: 'ما في طلبات فشلت', dismissed: 'ما في طلبات متجاهلة' }[filterVal] || 'لسا ما في طلبات';
  patch($('#req-list'), list.length
    ? list.map((q) => {
      const bad = q.status === 'check_failed' || q.status === 'send_failed';
      return `<div class="req s-${q.status} ${q.chat_id === openId ? 'on' : ''}" role="button" tabindex="0" data-open="${esc(q.chat_id)}">
        <div class="l1"><b>${nameOf(q)}</b><span class="st ${q.status}">${REQ_STATUS[q.status]}</span><span class="time">${when(q.started)}</span></div>
        <span class="file">📄 ${esc(q.files || 'ملف')}</span>
        <div class="detail ${bad ? 'bad' : ''}">${esc(reqDetail(q))}</div>
        <div class="acts">${q.status === 'ready' ? `<button class="btn primary" data-send-now="${q.reply_id}">ابعت هلأ</button>` : ''}${q.status === 'check_failed' ? `<button class="btn primary" data-recheck="${q.id}">افحص مرة تانية</button>` : ''}${q.status === 'send_failed' ? `<button class="btn primary" data-retry="${q.reply_id}">حاول مرة تانية</button>` : ''}</div>
      </div>`;
    }).join('')
    : `<div class="list-empty">${empty}</div>`);
}

function setView(v) {
  view = v;
  try { localStorage.setItem('view', v); } catch {}
  $('#app').classList.toggle('view-requests', v === 'requests');
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.view === v));
  if (v === 'requests' && S) renderRequests();
}

let first = true;
async function refresh() {
  try {
    const [s, chats] = await Promise.all([api('/api/state'), api(`/api/chats?q=${enc($('#q').value)}`)]);
    S = s;
    CHATS = chats;
    renderBar();
    // أول مرة: إذا في نتيجة بتستناك منفتح محادثتها
    if (first && !openId && S.results.length && innerWidth > 860) openId = S.results[0].chat_id;
    first = false;
    renderList();
    if (view === 'requests') await renderRequests();
    await renderConv();
  } catch {
    patch($('#wa'), '<span class="dot bad"></span><span>اللوحة مش قادرة توصل للبوت</span>');
  }
}

/* ------------------------------ الأزرار ------------------------------ */
$('#open-settings').innerHTML = icon('gear');
$('#open-settings').onclick = () => $('#settings').showModal();
document.querySelectorAll('.tabs button').forEach((b) => (b.onclick = () => setView(b.dataset.view)));
$('#req-filter').onchange = (e) => {
  e.target.blur();
  renderRequests();
};
setView(view);
$('#enabled').onchange = async (e) => {
  await api('/api/settings', { enabled: e.target.checked });
  toast(e.target.checked ? 'البوت شغّال' : 'البوت موقّف — ما رح يفحص ولا يرد');
  refresh();
};
$('#autoSend').onchange = (e) => api('/api/settings', { autoSend: { enabled: e.target.checked } });
$('#afterMin').onchange = (e) => api('/api/settings', { autoSend: { afterMin: Number(e.target.value) } });
$('#save').onclick = async () => {
  await api('/api/settings', { ackText: $('#ackText').value, autoSend: { enabled: $('#autoSend').checked, afterMin: Number($('#afterMin').value) } });
  $('#settings').close();
  toast('انحفظت الإعدادات');
};
$('#relink').onclick = async () => {
  if (!(await ask('تغيير رقم الواتس', 'الرقم الحالي بينفصل عن البوت، وبيطلعلك كود جديد تمسحه من الجوال التاني.', 'افصل الرقم', true))) return;
  await api('/api/whatsapp/relink', {});
  $('#settings').close();
  toast('امسح الكود الجديد لما يطلع');
};
let searchTimer;
$('#q').oninput = () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(refresh, 250);
};
$('#lightbox').onclick = () => $('#lightbox').close();
$('#filter').onchange = (e) => {
  filter = e.target.value;
  e.target.blur();
  renderList();
};

document.addEventListener('keydown', (e) => {
  // Enter بيبعت الرسالة، و Shift+Enter سطر جديد
  if (e.target.id === 'compose' && e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    $('#send-msg').click();
  }
});

document.addEventListener('click', async (e) => {
  const t = e.target.closest('button, img[data-zoom], [data-open]');
  if (!t) return;
  const done = (r, msg) => {
    if (r?.error) return toast(r.error, true);
    if (msg) toast(msg);
    if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
    refresh();
  };
  if (t.dataset.zoom !== undefined && t.tagName === 'IMG') {
    $('img', $('#lightbox')).src = t.src;
    return $('#lightbox').showModal();
  }
  // (الفلتر صار قائمة منسدلة)
  if (t.dataset.open) return openChat(t.dataset.open);
  // صفحة الطلبات
  if (t.dataset.openChat) {
    setView('chats');
    return openChat(t.dataset.openChat);
  }
  if (t.dataset.sendNow) return done(await api(`/api/replies/${t.dataset.sendNow}/send`, {}), 'عم تنبعت للزبون');
  if (t.dataset.recheck) {
    if (!(await ask('فحص مرة تانية', 'البوت بيفحص نفس الملف مرة كمان، والنتيجة بتطلعلك تراجعها قبل ما تنبعت.', 'افحص'))) return;
    return done(await api(`/api/requests/${t.dataset.recheck}/recheck`, {}), 'عم ينفحص...');
  }
  if (t.hasAttribute('data-back')) return closeChat();

  const card = t.closest('.result');
  if (t.hasAttribute('data-relink')) {
    if (!(await ask('كود ربط جديد', 'الجلسة الحالية بتنمسح وبيطلع كود QR جديد خلال دقيقة تقريباً. امسحه من الجوال اللي بدك اياه.', 'اعرض الكود'))) return;
    return done(await api('/api/whatsapp/relink', {}), 'عم يجهز كود جديد...');
  }
  if (t.dataset.retry) return done(await api(`/api/replies/${t.dataset.retry}/send`, {}), 'عم تنبعت مرة كمان');
  if (card && t.hasAttribute('data-send')) {
    t.disabled = true;
    t.textContent = 'عم تنبعت...';
    return done(await api(`/api/replies/${card.dataset.id}/send`, { text: $('textarea', card).value }), 'عم تنبعت للزبون');
  }
  if (card && t.hasAttribute('data-dismiss')) {
    if (!(await ask('تجاهل نتيجة الفحص', 'النتيجة ما رح تنبعت للزبون. بتقدر تفحص الملف مرة تانية من زر "افحص هاد الملف".', 'تجاهل', true))) return;
    return done(await api(`/api/replies/${card.dataset.id}/dismiss`, {}), 'انتجاهلت');
  }
  if (!openId) return;
  const base = `/api/chats/${enc(openId)}`;
  if (t.dataset.mute) return done(await api(`${base}/mute`, { muted: t.dataset.mute === '1' }), t.dataset.mute === '1' ? 'البوت ساكت مع هالرقم' : 'البوت رجع يشتغل مع هالرقم');
  if (t.hasAttribute('data-reset')) {
    if (!(await ask('مسح سجل البوت', 'الرقم بيرجع كأنه جديد وبيقدر ينفحص مرة كمان. الملفات اللي بعتها قبل ما بتنحسب، والبوت بيستنى سيرة جديدة. المحادثة نفسها بتضل.', 'امسح السجل'))) return;
    return done(await api(`${base}/reset`, {}), 'انمسح سجل البوت');
  }
  if (t.hasAttribute('data-delete')) {
    if (!(await ask('حذف المحادثة من اللوحة', 'بتنحذف من اللوحة بس. رسائل الواتس نفسها ما بتنمسح، وإذا بعت الزبون كمان بترجع تبيّن.', 'احذف', true))) return;
    await api(`${base}/delete`, {});
    closeChat();
    return done(null, 'انحذفت من اللوحة');
  }
  if (t.dataset.check) {
    if (!(await ask('فحص الملف', 'البوت بيفحص هاد الملف بدون ما يبعت الرد الآلي، والنتيجة بتطلعلك هون تراجعها قبل ما تنبعت.', 'افحص'))) return;
    return done(await api(`${base}/check`, { msgIds: [t.dataset.check] }), 'عم ينفحص... النتيجة بتطلع خلال دقيقة تقريباً');
  }
  if (t.id === 'send-msg') {
    const text = $('#compose').value.trim();
    if (!text) return;
    const r = await api(`${base}/send`, { text });
    if (!r.error) $('#compose').value = '';
    return done(r, 'عم تنبعت');
  }
});

refresh();
setInterval(refresh, 4000);
