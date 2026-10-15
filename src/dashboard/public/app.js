// صفحة وحدة: حالة الواتس، تشغيل/إيقاف، نتائج الفحص، كل المحادثات، والإعدادات
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const enc = encodeURIComponent;

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
  t._timer = setTimeout(() => (t.hidden = true), 3000);
}

const typingIn = (el) => el.contains(document.activeElement) && /TEXTAREA|INPUT/.test(document.activeElement.tagName);

// بيرسم بس إذا تغيّر شي، وما بيرسم فوق كتابتك
function patch(el, html) {
  if (!el || el.__html === html || typingIn(el)) return false;
  el.innerHTML = html;
  el.__html = html;
  return true;
}

const ago = (ts) => {
  if (!ts) return '';
  const s = Math.floor(Date.now() / 1000) - ts;
  if (s < 60) return 'هلأ';
  if (s < 3600) return `قبل ${Math.floor(s / 60)} د`;
  if (s < 86400) return `قبل ${Math.floor(s / 3600)} س`;
  return new Date(ts * 1000).toLocaleDateString('ar', { day: 'numeric', month: 'short' });
};
const hhmm = (ts) => new Date(ts * 1000).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
const dayOf = (ts) => new Date(ts * 1000).toLocaleDateString('ar', { weekday: 'long', day: 'numeric', month: 'long' });
const who = (c) => esc(c.name || (c.phone ? '+' + c.phone : 'زبون'));
const STATUS = {
  new: ['', 'ما انفحص'],
  checked: ['warn', 'انفحص'],
  sent: ['ok', 'انبعتت النتيجة'],
  muted: ['', '🔇 البوت ساكت'],
};
const tag = (s) => `<span class="tag ${STATUS[s][0]}">${STATUS[s][1]}</span>`;

// "بتنبعت لحالها بعد 12 د" — نفس حساب السيرفر (بعد 3 ساعات تأخير ما بتنبعت لحالها)
function autoIn(r, a) {
  if (!a?.enabled || !r.text || r.status !== 'pending') return '';
  const left = r.created + a.afterMin * 60 - Math.floor(Date.now() / 1000);
  if (left < -3 * 3600) return '';
  return `<div class="note">⏱ ${left > 60 ? `بتنبعت لحالها بعد ${Math.ceil(left / 60)} د` : 'بتنبعت لحالها هلأ'}</div>`;
}

let S = null; // آخر حالة من السيرفر

function resultCard(r, withName = true) {
  return `<div class="card result" data-id="${r.id}">
    ${withName ? `<div class="head"><button class="btn sm" data-open="${esc(r.chat_id)}">${who(r)}</button><span class="muted">${ago(r.created)}</span></div>` : ''}
    ${r.image ? `<img src="${esc(r.image)}" alt="صورة درجة الفحص">` : ''}
    ${r.text ? '' : `<p class="note warn">${esc(r.note || 'الفحص ما زبط')} — اكتب النتيجة بإيدك وابعتها</p>`}
    ${r.status === 'failed' ? `<p class="note warn">${esc(r.note)}</p>` : ''}
    <textarea rows="8">${esc(r.text)}</textarea>
    ${r.text && r.note ? `<div class="note">${esc(r.note)}</div>` : ''}
    ${autoIn(r, S?.autoSend)}
    <div class="row">
      <button class="btn primary" data-send ${r.status === 'queued' ? 'disabled' : ''}>${r.status === 'queued' ? 'عم ينبعت...' : 'ابعت للزبون'}</button>
      <button class="btn" data-dismiss>تجاهل</button>
    </div>
  </div>`;
}

/* ------------------------------ الحالة والنتائج ------------------------------ */
const WA = { ready: 'واتساب متصل', qr: 'امسح الكود من الجوال', starting: 'عم يشتغل...', syncing: 'عم يزامن...', logging_out: 'عم يسجل خروج...' };

function renderState(s) {
  S = s;
  const key = (s.whatsapp.status || '').split(':')[0];
  const dot = key === 'ready' ? 'ok' : /disconnected|retrying/.test(key) ? 'bad' : '';
  const acct = s.whatsapp.account?.phone ? ` · +${esc(s.whatsapp.account.phone)}` : '';
  patch($('#wa'), `<span class="dot ${dot}"></span>${esc(WA[key] || s.whatsapp.status)}${acct}`);

  $('#enabled').checked = s.enabled;
  $('#enabled-label').textContent = s.enabled ? 'البوت شغّال' : 'البوت موقّف';

  patch($('#qr'), s.whatsapp.qr
    ? `<div class="card qr"><b>اربط الواتس</b><p class="muted">من الجوال: الإعدادات ← الأجهزة المرتبطة ← ربط جهاز</p><img src="${s.whatsapp.qr}" alt="QR" width="260" height="260"></div>`
    : '');

  $('#count').textContent = s.results.length || '';
  patch($('#results'), s.results.length ? s.results.map((r) => resultCard(r)).join('') : '<div class="card empty">ما في نتائج بتستنى 👌</div>');

  // خانات الإعدادات بتتعبى أول مرة بس (عشان ما تمسح اللي عم تكتبه)
  if (!$('#ackText').dataset.loaded) {
    $('#ackText').value = s.ackText;
    $('#ackText').dataset.loaded = '1';
  }
  $('#autoSend').checked = s.autoSend.enabled;
  if (document.activeElement !== $('#afterMin')) $('#afterMin').value = s.autoSend.afterMin;
}

/* ------------------------------ المحادثات ------------------------------ */
let openId = null;
try { openId = sessionStorage.getItem('chat'); } catch {}

async function renderList() {
  const list = await api(`/api/chats?q=${enc($('#q').value)}`);
  patch($('#items'), list.length
    ? list.map((c) => `<button class="item ${c.id === openId ? 'on' : ''}" data-open="${esc(c.id)}">
        <div class="line1"><b>${who(c)}</b><span class="muted">${ago(Math.max(c.last_in || 0, c.last_out || 0))}</span></div>
        <div class="line1"><span class="prev">${c.last_from_me ? '✓ ' : ''}${esc(c.last_body)}</span>${c.waiting ? '<span class="tag warn">نتيجة بتستنى</span>' : tag(c.status)}</div>
      </button>`).join('')
    : '<div class="empty">ما في محادثات</div>');
}

const isFileMsg = (m) => !m.from_me && (m.type === 'document' || m.type === 'image');

async function renderDetail() {
  const box = $('#detail');
  if (!openId) return;
  const d = await api(`/api/chats/${enc(openId)}`);
  if (d.error) {
    openId = null;
    box.innerHTML = '<div class="empty">اختار محادثة من القائمة</div>';
    return;
  }
  // الهيكل بينبني مرة لكل محادثة (عشان خانة الكتابة ما تنمسح)
  if (box.dataset.chat !== openId) {
    box.dataset.chat = openId;
    box.innerHTML = `<div class="dhead" id="dhead"></div><div class="msgs" id="msgs"></div>
      <div class="compose"><textarea id="compose" rows="1" placeholder="اكتب رسالة للزبون..."></textarea><button class="btn primary" id="send-msg">ابعت</button></div>`;
  }
  const c = d.chat;
  patch($('#dhead'), `<div class="line1" style="display:flex;justify-content:space-between;gap:8px;align-items:center">
      <div><b>${who(c)}</b> ${c.phone ? `<span class="muted" dir="ltr">+${esc(c.phone)}</span>` : ''}</div>${tag(c.status)}</div>
    <div class="row">
      <button class="btn sm" data-mute="${c.muted ? 0 : 1}">${c.muted ? '🔈 شغّل البوت مع هالرقم' : '🔇 سكّت البوت مع هالرقم'}</button>
      <button class="btn sm" data-reset title="الرقم بيرجع جديد وبيقدر ينفحص مرة كمان. المحادثة بتضل">امسح سجل البوت</button>
      <button class="btn sm danger" data-delete title="بتنحذف من اللوحة بس، مش من الواتس">احذف من اللوحة</button>
    </div>`);

  let lastDay = '';
  const msgs = d.messages.map((m) => {
    const day = dayOf(m.ts);
    const sep = day !== lastDay ? `<div class="day">${day}</div>` : '';
    lastDay = day;
    const by = !m.from_me ? '' : m.by_bot ? 'البوت' : 'الموظف';
    return `${sep}<div class="msg ${m.from_me ? 'out' : ''}">${esc(m.body || `[${m.type}]`)}
      <div class="meta">${by ? `<span>${by}</span>` : ''}<span>${hhmm(m.ts)}</span>${isFileMsg(m) ? `<button class="btn sm" data-check="${esc(m.id)}">افحص هاد الملف</button>` : ''}</div></div>`;
  }).join('');
  const el = $('#msgs');
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  const changed = patch(el, (msgs || '<div class="empty">ما في رسائل</div>') + d.replies.filter((r) => r.scenario === 'result').map((r) => resultCard({ ...r, chat_id: c.id, name: c.name, phone: c.phone }, false)).join(''));
  if (changed && (atBottom || el.__first !== openId)) {
    el.scrollTop = el.scrollHeight;
    el.__first = openId;
  }
}

function openChat(id) {
  openId = id;
  try { sessionStorage.setItem('chat', id); } catch {}
  $('#items').__html = null;
  renderList();
  renderDetail();
  if (window.innerWidth < 860) $('#detail').scrollIntoView({ behavior: 'smooth' });
}

async function refresh() {
  try {
    renderState(await api('/api/state'));
    await Promise.all([renderList(), renderDetail()]);
  } catch {
    patch($('#wa'), '<span class="dot bad"></span>البوت مش شغّال');
  }
}

/* ------------------------------ الأزرار ------------------------------ */
$('#enabled').onchange = async (e) => {
  await api('/api/settings', { enabled: e.target.checked });
  refresh();
};
$('#autoSend').onchange = (e) => api('/api/settings', { autoSend: { enabled: e.target.checked } });
$('#afterMin').onchange = async (e) => {
  await api('/api/settings', { autoSend: { afterMin: Number(e.target.value) } });
  toast('انحفظ');
};
$('#save').onclick = async () => {
  await api('/api/settings', { ackText: $('#ackText').value });
  toast('انحفظ الرد الآلي');
};
$('#relink').onclick = async () => {
  if (!confirm('أكيد بدك تفصل الرقم الحالي وتربط رقم جديد؟')) return;
  await api('/api/whatsapp/relink', {});
  toast('امسح الكود الجديد لما يطلع');
};
let searchTimer;
$('#q').oninput = () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(renderList, 250);
};

document.addEventListener('click', async (e) => {
  const t = e.target.closest('button');
  if (!t) return;
  const card = t.closest('.result');
  const done = (r, msg) => {
    if (r?.error) return toast(r.error, true);
    if (msg) toast(msg);
    document.activeElement.blur();
    refresh();
  };

  if (t.dataset.open) return openChat(t.dataset.open);
  if (card && t.hasAttribute('data-send')) return done(await api(`/api/replies/${card.dataset.id}/send`, { text: $('textarea', card).value }), 'عم تنبعت للزبون');
  if (card && t.hasAttribute('data-dismiss')) return done(await api(`/api/replies/${card.dataset.id}/dismiss`, {}));
  if (!openId) return;
  const base = `/api/chats/${enc(openId)}`;
  if (t.dataset.mute) return done(await api(`${base}/mute`, { muted: t.dataset.mute === '1' }), t.dataset.mute === '1' ? 'البوت ساكت مع هالرقم' : 'البوت رجع يشتغل مع هالرقم');
  if (t.hasAttribute('data-reset')) {
    if (!confirm('مسح سجل البوت لهاد الرقم؟ الرقم بيرجع جديد وبيقدر ينفحص مرة كمان.')) return;
    return done(await api(`${base}/reset`, {}), 'انمسح سجل البوت');
  }
  if (t.hasAttribute('data-delete')) {
    if (!confirm('حذف المحادثة من اللوحة؟ (رسائل الواتس نفسها ما بتنمسح)')) return;
    await api(`${base}/delete`, {});
    openId = null;
    $('#detail').dataset.chat = '';
    $('#detail').innerHTML = '<div class="empty">اختار محادثة من القائمة</div>';
    return done(null, 'انحذفت من اللوحة');
  }
  if (t.dataset.check) {
    if (!confirm('أفحص هاد الملف؟ النتيجة بتطلعلك تراجعها قبل ما تنبعت.')) return;
    return done(await api(`${base}/check`, { msgIds: [t.dataset.check] }), 'عم ينفحص... النتيجة بتطلع بعد شوي');
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
