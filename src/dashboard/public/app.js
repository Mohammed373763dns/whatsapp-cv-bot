// صفحة وحدة: حالة الواتس، تشغيل/إيقاف، نتائج الفحص، آخر الطلبات، ورسائل البوت
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

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

// بيرسم بس إذا تغيّر شي، وما بيرسم فوق كتابتك
function patch(el, html) {
  if (el.__html === html || el.contains(document.activeElement) && /TEXTAREA|INPUT/.test(document.activeElement.tagName)) return;
  el.innerHTML = html;
  el.__html = html;
}

const ago = (ts) => {
  if (!ts) return '';
  const s = Math.floor(Date.now() / 1000) - ts;
  if (s < 60) return 'هلأ';
  if (s < 3600) return `قبل ${Math.floor(s / 60)} د`;
  if (s < 86400) return `قبل ${Math.floor(s / 3600)} س`;
  return new Date(ts * 1000).toLocaleDateString('ar', { day: 'numeric', month: 'short' });
};
// "بتنبعت لحالها بعد 12 د" — نفس حساب السيرفر (بعد 3 ساعات تأخير ما بتنبعت لحالها)
function autoIn(r, a) {
  if (!a.enabled || !r.text || r.status !== 'pending') return '';
  const left = r.created + a.afterMin * 60 - Math.floor(Date.now() / 1000);
  if (left < -3 * 3600) return '';
  return `<div class="note">⏱ ${left > 60 ? `بتنبعت لحالها بعد ${Math.ceil(left / 60)} د` : 'بتنبعت لحالها هلأ'}</div>`;
}
const who = (c) => esc(c.name || (c.phone ? '+' + c.phone : 'زبون'));

const WA = { ready: 'واتساب متصل', qr: 'امسح الكود من الجوال', starting: 'عم يشتغل...', syncing: 'عم يزامن...', logging_out: 'عم يسجل خروج...' };

function render(s) {
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
  patch($('#results'), s.results.length
    ? s.results.map((r) => `<div class="card result" data-id="${r.id}">
        <div class="head"><b>${who(r)}</b><span class="muted">${ago(r.created)}</span></div>
        ${r.image ? `<img src="${esc(r.image)}" alt="صورة درجة الفحص">` : ''}
        ${r.text ? '' : `<p class="note warn">${esc(r.note || 'الفحص ما زبط')} — اكتب النتيجة بإيدك وابعتها</p>`}
        ${r.status === 'failed' ? `<p class="note warn">${esc(r.note)}</p>` : ''}
        <textarea rows="8">${esc(r.text)}</textarea>
        ${r.text && r.note ? `<div class="note">${esc(r.note)}</div>` : ''}
        ${autoIn(r, s.autoSend)}
        <div class="row">
          <button class="btn primary" data-send ${r.status === 'queued' ? 'disabled' : ''}>${r.status === 'queued' ? 'عم ينبعت...' : 'ابعت للزبون'}</button>
          <button class="btn" data-dismiss>تجاهل</button>
        </div>
      </div>`).join('')
    : '<div class="card empty">ما في نتائج بتستنى 👌</div>');

  const status = (c) => c.stage === 'awaiting_cv' ? 'بانتظار السيرة' : c.sent ? 'انبعتت النتيجة' : 'وصلت السيرة';
  patch($('#recent'), s.recent.length
    ? s.recent.map((c) => `<div class="item">
        <div><b>${who(c)}</b> <span class="muted">${ago(c.last_in)}</span></div>
        <div class="row" style="margin:0;align-items:center">
          <span class="tag">${status(c)}</span>
          ${c.stage !== 'awaiting_cv' ? `<button class="btn sm" data-reset="${esc(c.id)}" title="الرقم بيقدر يطلب فحص كمان مرة">فحص تاني</button>` : ''}
        </div>
      </div>`).join('')
    : '<div class="empty">لسا ما حدا طلب فحص</div>');

  // خانات الإعدادات بتتعبى أول مرة بس (عشان ما تمسح اللي عم تكتبه)
  if (!$('#askText').dataset.loaded) {
    $('#askText').value = s.askText;
    $('#ackText').value = s.ackText;
    $('#askText').dataset.loaded = '1';
  }
  $('#autoSend').checked = s.autoSend.enabled;
  if (document.activeElement !== $('#afterMin')) $('#afterMin').value = s.autoSend.afterMin;
}

async function refresh() {
  try {
    render(await api('/api/state'));
  } catch {
    patch($('#wa'), '<span class="dot bad"></span>البوت مش شغّال — شغّله من الـ cmd بـ npm run bot');
  }
}

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
  await api('/api/settings', { askText: $('#askText').value, ackText: $('#ackText').value });
  toast('انحفظت الرسائل');
};
$('#relink').onclick = async () => {
  if (!confirm('أكيد بدك تفصل الرقم الحالي وتربط رقم جديد؟')) return;
  await api('/api/whatsapp/relink', {});
  toast('امسح الكود الجديد لما يطلع');
};

document.addEventListener('click', async (e) => {
  const card = e.target.closest('.result');
  if (card && e.target.matches('[data-send]')) {
    const r = await api(`/api/replies/${card.dataset.id}/send`, { text: $('textarea', card).value });
    if (r.error) return toast(r.error, true);
    toast('عم تنبعت للزبون');
    document.activeElement.blur();
    refresh();
  }
  if (card && e.target.matches('[data-dismiss]')) {
    await api(`/api/replies/${card.dataset.id}/dismiss`, {});
    refresh();
  }
  const reset = e.target.dataset.reset;
  if (reset) {
    await api(`/api/chats/${encodeURIComponent(reset)}/reset`, {});
    toast('الرقم بيقدر يطلب فحص كمان مرة');
    refresh();
  }
});

refresh();
setInterval(refresh, 4000);
