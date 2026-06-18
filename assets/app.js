/* ============================================================
   CardSnap — 名片整理 PWA
   即時相機/連拍 + 對齊框 + 掃描互動;端上 OCR(Tesseract.js)
   多選批次 · 名片縮圖 · 匯入/匯出 · 名單管理
   純邏輯集中於 assets/core.js;資料存 localStorage(不上傳)
   ============================================================ */
'use strict';

const STORE_KEY = 'cardsnap.contacts.v1';
const { parseCard, toVCard, toCSV, parseCSV, parseVCards, mergeContacts, syncMerge } = window.CardSnapCore;
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

/* ---------- state ---------- */
let contacts = load();
let activeTag = null;
let query = '';
let editingId = null;
let lastOcrRaw = '';
let detailId = null;
let camStream = null;
let sortBy = 'recent';
let lastImage = '';        // 最近擷取的名片縮圖(dataURL)
let burstMode = false;     // 連拍(展場)模式
let burstCount = 0;
let recaptureId = null;    // 重拍:替換某張名片的照片
let selectMode = false;    // 多選模式
let selected = new Set();
let exportScope = null;    // null=全部;Set=僅選取

function load() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)) || []; }
  catch { return []; }
}
function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(contacts)); }
  catch (e) { toast('儲存空間已滿,請刪除部分名片或關閉照片'); }
  if (typeof schedulePush === 'function') schedulePush();
}

/* ---------- 影像壓縮(縮圖) ---------- */
function compressImage(source, max = 460, q = 0.6) {
  const sw = source.width || source.videoWidth || source.naturalWidth;
  const sh = source.height || source.videoHeight || source.naturalHeight;
  if (!sw || !sh) return '';
  const scale = Math.min(1, max / Math.max(sw, sh));
  const cw = Math.round(sw * scale), ch = Math.round(sh * scale);
  const cv = document.createElement('canvas'); cv.width = cw; cv.height = ch;
  cv.getContext('2d').drawImage(source, 0, 0, cw, ch);
  try { return cv.toDataURL('image/jpeg', q); } catch { return ''; }
}
function loadImage(url) {
  return new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = url; });
}

/* ============================================================
   擷取流程:相機/連拍/重拍 → 掃描互動 → OCR
   ============================================================ */
function openCapture() {
  burstMode = false; burstCount = 0; recaptureId = null;
  $('#burstToggle').classList.remove('on');
  $('#burstCount').classList.add('hidden');
  resetCapture();
  openModal('#captureModal');
  startCamera();
}

async function startCamera() {
  const ok = navigator.mediaDevices && navigator.mediaDevices.getUserMedia;
  if (!ok) { showFileFallback(); return; }
  try {
    camStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false
    });
    const v = $('#cameraVideo');
    v.srcObject = camStream;
    await v.play().catch(() => {});
    $('#cameraView').classList.remove('hidden');
    $('#dropzone').classList.add('hidden');
    $('#pickFallback').classList.remove('hidden');
  } catch (e) {
    showFileFallback();
  }
}

function showFileFallback() {
  $('#cameraView').classList.add('hidden');
  $('#pickFallback').classList.add('hidden');
  $('#dropzone').classList.remove('hidden');
}

function stopCamera() {
  if (camStream) { camStream.getTracks().forEach(t => t.stop()); camStream = null; }
  const v = $('#cameraVideo');
  if (v) v.srcObject = null;
}

function captureFromCamera() {
  const v = $('#cameraVideo');
  const vw = v.videoWidth, vh = v.videoHeight;
  if (!vw || !vh) { toast('相機尚未就緒,請稍候'); return; }
  const ar = 1.586;
  let cw = vw * 0.9, ch = cw / ar;
  if (ch > vh * 0.92) { ch = vh * 0.92; cw = ch * ar; }
  const cx = (vw - cw) / 2, cy = (vh - ch) / 2;
  const cv = $('#captureCanvas');
  cv.width = Math.round(cw); cv.height = Math.round(ch);
  cv.getContext('2d').drawImage(v, cx, cy, cw, ch, 0, 0, cv.width, cv.height);
  const dataUrl = cv.toDataURL('image/jpeg', 0.92);
  lastImage = compressImage(cv);
  if (!burstMode) stopCamera();
  $('#cameraView').classList.add('hidden');
  $('#pickFallback').classList.add('hidden');
  recognize(cv, dataUrl);
}

async function recognize(source, previewUrl) {
  // 重拍:只替換照片,不做 OCR
  if (recaptureId) {
    const c = contacts.find(x => x.id === recaptureId);
    if (c) { c.image = lastImage || c.image; save(); render(); }
    recaptureId = null; closeModal('#captureModal'); toast('已更新名片照片'); return;
  }
  $('#preview').src = previewUrl;
  $('#dropzone').classList.add('hidden');
  $('#scanStage').classList.remove('hidden');
  $('#scanStage').classList.remove('done');
  $('#ocrStatus').classList.remove('hidden');
  $('#ocrText').textContent = '辨識中…';
  try {
    if (typeof Tesseract === 'undefined') throw new Error('OCR 引擎尚未載入,請檢查網路');
    const { data } = await Tesseract.recognize(source, 'chi_tra+eng', {
      logger: m => {
        if (m.status === 'recognizing text')
          $('#ocrText').textContent = `辨識中… ${Math.round(m.progress * 100)}%`;
        else
          $('#ocrText').textContent = m.status === 'loading language traineddata' ? '載入語言模型…' : '處理中…';
      }
    });
    lastOcrRaw = (data.text || '').trim();
    $('#scanStage').classList.add('done');
    $('#ocrText').textContent = '辨識完成';
    await new Promise(r => setTimeout(r, 420));
    const fields = parseCard(lastOcrRaw);

    // 連拍模式:自動建檔,回到相機繼續
    if (burstMode) {
      if (fields.name || fields.company || fields.phone || fields.email) {
        contacts.unshift({ id: uid(), created: Date.now(), updated: Date.now(), favorite: false, raw: lastOcrRaw, image: lastImage, ...fields });
        save(); render(); burstCount++;
        $('#burstCount').textContent = `已建 ${burstCount} 張`;
        toast(`已建檔(${burstCount})`);
      } else {
        toast('這張沒辨識到,略過');
      }
      lastImage = '';
      resetCaptureKeepBurst();
      startCamera();
      return;
    }

    closeModal('#captureModal');
    openEdit(null, fields, lastOcrRaw);
    if (!lastOcrRaw) toast('沒辨識到文字,請手動填寫或重拍');
  } catch (e) {
    toast('辨識失敗:' + e.message);
    resetCapture();
    startCamera();
  }
}

async function runOCR(file) {
  const url = URL.createObjectURL(file);
  try { const img = await loadImage(url); lastImage = compressImage(img); } catch { lastImage = ''; }
  recognize(url, url);
}

function resetCapture() {
  stopCamera();
  $('#cameraView').classList.add('hidden');
  $('#dropzone').classList.add('hidden');
  $('#pickFallback').classList.add('hidden');
  $('#scanStage').classList.add('hidden');
  $('#scanStage').classList.remove('done');
  $('#ocrStatus').classList.add('hidden');
  $('#preview').removeAttribute('src');
  $('#fileInput').value = '';
}
function resetCaptureKeepBurst() {
  $('#scanStage').classList.add('hidden');
  $('#scanStage').classList.remove('done');
  $('#ocrStatus').classList.add('hidden');
  $('#preview').removeAttribute('src');
}

/* ============================================================
   匯入(CSV / vCard / JSON)+ 去重合併
   ============================================================ */
async function importFromFile(file) {
  try {
    const text = await file.text();
    const fn = (file.name || '').toLowerCase();
    let parsed = [];
    if (fn.endsWith('.json') || /^\s*[\[{]/.test(text)) {
      const j = JSON.parse(text); parsed = Array.isArray(j) ? j : (j.contacts || []);
    } else if (fn.endsWith('.vcf') || /BEGIN:VCARD/i.test(text)) {
      parsed = parseVCards(text);
    } else {
      parsed = parseCSV(text);
    }
    if (!parsed.length) { toast('檔案沒有可匯入的名片'); return; }
    const incoming = parsed.map(p => ({
      id: p.id || uid(), created: p.created || Date.now(), updated: p.updated || p.created || Date.now(), favorite: !!p.favorite, image: p.image || '',
      name: p.name || '', company: p.company || '', title: p.title || '', phone: p.phone || '',
      email: p.email || '', website: p.website || '', address: p.address || '',
      tags: Array.isArray(p.tags) ? p.tags : (p.tags ? String(p.tags).split(/[;,，、]/).map(t => t.trim()).filter(Boolean) : []),
      note: p.note || ''
    }));
    const res = mergeContacts(contacts, incoming);
    contacts = res.merged; save(); render();
    toast(`匯入 ${res.added} 筆` + (res.skipped ? `,略過重複 ${res.skipped} 筆` : ''));
  } catch (e) {
    toast('匯入失敗:' + e.message);
  }
  $('#importInput').value = '';
}

function openManual() {
  openEdit(null, {}, '');
  $('#editTitle').textContent = '手動新增名片';
}

/* ============================================================
   名單渲染
   ============================================================ */
function allTags() {
  const s = new Set();
  contacts.forEach(c => (c.tags || []).forEach(t => s.add(t)));
  return [...s].sort();
}

const SORTERS = {
  recent:  (a, b) => (b.favorite ? 1 : 0) - (a.favorite ? 1 : 0) || (b.created || 0) - (a.created || 0),
  name:    (a, b) => (b.favorite ? 1 : 0) - (a.favorite ? 1 : 0) || String(a.name || '').localeCompare(String(b.name || ''), 'zh-Hant'),
  company: (a, b) => (b.favorite ? 1 : 0) - (a.favorite ? 1 : 0) || String(a.company || '').localeCompare(String(b.company || ''), 'zh-Hant'),
};
function filtered() {
  const q = query.trim().toLowerCase();
  return contacts.filter(c => {
    if (activeTag && !(c.tags || []).includes(activeTag)) return false;
    if (!q) return true;
    return [c.name, c.company, c.title, c.phone, c.email, c.note, ...(c.tags || [])]
      .filter(Boolean).join(' ').toLowerCase().includes(q);
  }).sort(SORTERS[sortBy] || SORTERS.recent);
}

function initials(name) {
  if (!name) return '？';
  return /[A-Za-z]/.test(name[0]) ? name.slice(0, 2).toUpperCase() : name.slice(0, 1);
}

const CHECK_SVG = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 10 3.5 3.5L15 7"/></svg>';

function render() {
  document.body.classList.toggle('select-mode', selectMode);
  const data = filtered();
  $('#countLabel').textContent = `共 ${contacts.length} 張名片` + (activeTag ? ` · #${activeTag}` : '');
  $('#empty').classList.toggle('hidden', contacts.length !== 0);

  const tags = allTags();
  $('#tagChips').innerHTML = tags.map(t =>
    `<span class="chip ${t === activeTag ? 'active' : ''}" data-tag="${esc(t)}">#${esc(t)}</span>`).join('');
  $$('#tagChips .chip').forEach(ch => ch.onclick = () => {
    activeTag = ch.dataset.tag === activeTag ? null : ch.dataset.tag; render();
  });

  const list = $('#list');
  list.innerHTML = data.map(c => `
    <div class="contact ${selected.has(c.id) ? 'selected' : ''}" data-id="${c.id}">
      <div class="sel-box">${CHECK_SVG}</div>
      ${c.image ? `<img class="avatar avatar-img" src="${c.image}" alt="">` : `<div class="avatar">${esc(initials(c.name))}</div>`}
      <div class="c-main">
        <div class="c-name">${esc(c.name || '未命名')} ${c.favorite ? '<span class="star">★</span>' : ''}</div>
        <div class="c-sub">${esc([c.title, c.company].filter(Boolean).join(' · ') || c.phone || c.email || '—')}</div>
        ${(c.tags || []).length ? `<div class="c-tags">${c.tags.map(t => `<span class="c-tag">${esc(t)}</span>`).join('')}</div>` : ''}
      </div>
      <div class="c-quick">
        ${c.phone ? `<a href="tel:${esc(c.phone)}" title="撥打" onclick="event.stopPropagation()"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3.5h3l1.3 3.2-1.7 1.2a9 9 0 0 0 3.8 3.8l1.2-1.7L16.5 14v3a1 1 0 0 1-1.1 1A12.5 12.5 0 0 1 4 6.6 1 1 0 0 1 5 3.5"/></svg></a>` : ''}
        ${c.email ? `<a href="mailto:${esc(c.email)}" title="寄信" onclick="event.stopPropagation()"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="4.5" width="15" height="11" rx="2"/><path d="m3 6 7 5 7-5"/></svg></a>` : ''}
      </div>
    </div>`).join('');
  $$('#list .contact').forEach(el => el.onclick = () => {
    if (selectMode) toggleSelect(el.dataset.id);
    else openDetail(el.dataset.id);
  });
}

/* ============================================================
   多選批次
   ============================================================ */
function toggleSelect(id) {
  if (selected.has(id)) selected.delete(id); else selected.add(id);
  render(); updateSelectBar();
}
function enterSelect() {
  selectMode = true; selected.clear();
  $('#selectBar').classList.remove('hidden');
  render(); updateSelectBar();
}
function exitSelect() {
  selectMode = false; selected.clear();
  $('#selectBar').classList.add('hidden');
  render();
}
function updateSelectBar() { $('#selCount').textContent = `已選 ${selected.size}`; }
function selectAll() { filtered().forEach(c => selected.add(c.id)); render(); updateSelectBar(); }
function batchDelete() {
  if (!selected.size) { toast('尚未選取'); return; }
  if (confirm(`刪除選取的 ${selected.size} 張名片?`)) {
    contacts = contacts.filter(c => !selected.has(c.id));
    save(); exitSelect(); toast('已刪除');
  }
}
function batchTag() {
  if (!selected.size) { toast('尚未選取'); return; }
  const t = prompt('輸入要加上的標籤'); if (!t) return;
  const tag = t.trim(); if (!tag) return;
  contacts.forEach(c => { if (selected.has(c.id)) { c.tags = c.tags || []; if (!c.tags.includes(tag)) c.tags.push(tag); } });
  save(); render(); updateSelectBar(); toast(`已加標籤 #${tag}`);
}
function batchExport() {
  if (!selected.size) { toast('尚未選取'); return; }
  exportScope = new Set(selected);
  $('#expCount').textContent = selected.size;
  openModal('#exportModal');
}

/* ============================================================
   編輯 / 儲存
   ============================================================ */
function openEdit(id, fields, raw) {
  editingId = id;
  const c = id ? contacts.find(x => x.id === id) : (fields || {});
  $('#editTitle').textContent = id ? '編輯名片' : '確認名片資料';
  $('#f_name').value = c.name || '';
  $('#f_company').value = c.company || '';
  $('#f_title').value = c.title || '';
  $('#f_phone').value = c.phone || '';
  $('#f_email').value = c.email || '';
  $('#f_website').value = c.website || '';
  $('#f_address').value = c.address || '';
  $('#f_tags').value = (c.tags || []).join(', ');
  $('#f_note').value = c.note || '';
  $('#rawText').textContent = raw || c.raw || '(無)';
  $('#btnDelete').classList.toggle('hidden', !id);
  openModal('#editModal');
}

function saveEdit() {
  const data = {
    name: $('#f_name').value.trim(),
    company: $('#f_company').value.trim(),
    title: $('#f_title').value.trim(),
    phone: $('#f_phone').value.trim(),
    email: $('#f_email').value.trim(),
    website: $('#f_website').value.trim(),
    address: $('#f_address').value.trim(),
    tags: $('#f_tags').value.split(',').map(t => t.trim()).filter(Boolean),
    note: $('#f_note').value.trim(),
    updated: Date.now(),
  };
  if (!data.name && !data.company && !data.phone && !data.email) {
    toast('至少填入姓名、公司、電話或 email 其中之一'); return;
  }
  if (editingId) {
    const c = contacts.find(x => x.id === editingId);
    Object.assign(c, data);
  } else {
    contacts.unshift({ id: uid(), created: Date.now(), favorite: false, raw: lastOcrRaw, image: lastImage, ...data });
  }
  save(); render(); closeModal('#editModal'); resetCapture();
  toast(editingId ? '已更新' : '已建檔');
  editingId = null; lastOcrRaw = ''; lastImage = '';
}

/* ============================================================
   詳情 / 分享 / 重拍
   ============================================================ */
function openDetail(id) {
  detailId = id;
  const c = contacts.find(x => x.id === id);
  if (!c) return;
  $('#d_name').textContent = c.name || '名片';
  const row = (label, val, href) => val ? `
    <div class="detail-row"><span class="dl">${label}</span>
    <span class="dv">${href ? `<a href="${esc(href)}">${esc(val)}</a>` : esc(val)}</span></div>` : '';
  $('#detailBody').innerHTML =
    (c.image ? `<img class="detail-img" src="${c.image}" alt="名片">` : '') +
    `<div class="detail-row"><span class="dl">標記</span><span class="dv">
       <span class="link-btn" id="favToggle" style="cursor:pointer">${c.favorite ? '★ 已收藏' : '☆ 收藏'}</span></span></div>` +
    row('公司', c.company) + row('職稱', c.title) +
    row('電話', c.phone, c.phone ? `tel:${c.phone}` : '') +
    row('Email', c.email, c.email ? `mailto:${c.email}` : '') +
    row('網站', c.website, c.website ? (/^https?:/.test(c.website) ? c.website : 'https://' + c.website) : '') +
    row('地址', c.address) +
    ((c.tags || []).length ? `<div class="detail-row"><span class="dl">標籤</span><span class="dv">${c.tags.map(t => `<span class="c-tag">${esc(t)}</span>`).join(' ')}</span></div>` : '') +
    row('備註', c.note);
  $('#favToggle').onclick = () => { c.favorite = !c.favorite; save(); render(); openDetail(id); };

  try {
    if (typeof QRCode !== 'undefined') {
      QRCode.toCanvas($('#qrCanvas'), toVCard(c), { width: 180, margin: 1 }, () => {});
      $('#qrWrap').classList.remove('hidden');
    }
  } catch { $('#qrWrap').classList.add('hidden'); }
  openModal('#detailModal');
}

function recaptureFor(id) {
  recaptureId = id;
  burstMode = false;
  closeModal('#detailModal');
  resetCapture();
  openModal('#captureModal');
  startCamera();
}

/* ============================================================
   匯出格式(可全部或僅選取)
   ============================================================ */
function exportData(fmt) {
  const list = exportScope ? contacts.filter(c => exportScope.has(c.id)) : contacts;
  if (!list.length) { toast('沒有可匯出的名片'); return; }
  let blob, fn;
  if (fmt === 'vcf') {
    blob = new Blob([list.map(toVCard).join('\n')], { type: 'text/vcard' });
    fn = 'cardsnap.vcf';
  } else if (fmt === 'json') {
    blob = new Blob([JSON.stringify(list, null, 2)], { type: 'application/json' });
    fn = 'cardsnap-backup.json';
  } else {
    blob = new Blob([toCSV(list)], { type: 'text/csv' });
    fn = 'cardsnap.csv';
  }
  download(blob, fn);
  closeModal('#exportModal');
  toast(`已匯出 ${list.length} 張 (${fmt.toUpperCase()})`);
  const wasScoped = !!exportScope; exportScope = null;
  if (wasScoped && selectMode) exitSelect();
}

function download(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function shareContact(c) {
  const text = [c.name, c.title, c.company, c.phone, c.email, c.website].filter(Boolean).join('\n');
  if (navigator.share) {
    try { await navigator.share({ title: c.name || '名片', text }); return; } catch {}
  }
  try { await navigator.clipboard.writeText(text); toast('已複製名片資訊到剪貼簿'); }
  catch { toast('此瀏覽器不支援分享'); }
}

/* ============================================================
   Google Drive 同步(存於使用者自己的 Drive · appDataFolder)
   ============================================================ */
const GOOGLE_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
let driveToken = '';
let driveTokenClient = null;
let drivePushT = null;

function googleClientId() {
  return (window.CARDSNAP_CONFIG && window.CARDSNAP_CONFIG.googleClientId) || '';
}

function setSyncState(s) {
  const b = $('#btnSync'); if (!b) return;
  b.classList.toggle('syncing', s === 'syncing');
  b.classList.toggle('synced', s === 'synced');
  b.title = s === 'syncing' ? '同步中…' : (s === 'synced' ? '已同步' : (googleClientId() ? '雲端同步' : '雲端同步(尚未設定)'));
}

function initDrive() {
  if (!googleClientId()) { setSyncState('idle'); return; }
  if (typeof google === 'undefined' || !google.accounts || !google.accounts.oauth2) { setTimeout(initDrive, 600); return; }
  driveTokenClient = google.accounts.oauth2.initTokenClient({
    client_id: googleClientId(),
    scope: GOOGLE_SCOPE,
    callback: (resp) => {
      if (resp && resp.access_token) { driveToken = resp.access_token; doSync(); }
      else { setSyncState('idle'); toast('Google 授權未完成'); }
    },
  });
  setSyncState('idle');
}

function signInAndSync() {
  if (!googleClientId()) { toast('雲端同步尚未設定(需填入 Google Client ID)'); return; }
  if (!driveTokenClient) { initDrive(); toast('同步初始化中,請再按一次'); return; }
  if (driveToken) doSync();
  else driveTokenClient.requestAccessToken({ prompt: '' });
}

async function driveApi(url, opts) {
  const r = await fetch(url, Object.assign({ headers: { Authorization: 'Bearer ' + driveToken } }, opts || {}));
  if (r.status === 401) { driveToken = ''; throw new Error('授權過期,請再按一次同步'); }
  if (!r.ok) throw new Error('Drive 錯誤 ' + r.status);
  return r;
}

async function doSync() {
  if (!driveToken) { signInAndSync(); return; }
  setSyncState('syncing');
  try {
    const q = encodeURIComponent("name='cardsnap.json'");
    const lr = await driveApi(`https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&fields=files(id,name)&q=${q}`);
    const lj = await lr.json();
    const file = (lj.files || [])[0];
    let remote = [];
    if (file) {
      const dr = await driveApi(`https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`);
      const dj = await dr.json().catch(() => ({}));
      remote = Array.isArray(dj) ? dj : (dj.contacts || []);
    }
    contacts = syncMerge(contacts, remote); save(); render();
    const body = JSON.stringify({ version: 1, updatedAt: Date.now(), contacts });
    if (file) {
      await driveApi(`https://www.googleapis.com/upload/drive/v3/files/${file.id}?uploadType=media`,
        { method: 'PATCH', headers: { Authorization: 'Bearer ' + driveToken, 'Content-Type': 'application/json' }, body });
    } else {
      const meta = { name: 'cardsnap.json', parents: ['appDataFolder'] };
      const form = new FormData();
      form.append('metadata', new Blob([JSON.stringify(meta)], { type: 'application/json' }));
      form.append('file', new Blob([body], { type: 'application/json' }));
      await driveApi('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', { method: 'POST', body: form });
    }
    setSyncState('synced'); toast('已與 Google Drive 同步');
  } catch (e) {
    setSyncState('idle'); toast('同步失敗:' + e.message);
  }
}

function schedulePush() {
  if (!driveToken) return;
  clearTimeout(drivePushT);
  drivePushT = setTimeout(doSync, 2500);
}

/* ============================================================
   UI helpers
   ============================================================ */
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m])); }
function openModal(sel) { $(sel).classList.remove('hidden'); }
function closeModal(sel) { if (sel === '#captureModal') stopCamera(); $(sel).classList.add('hidden'); }
let toastT;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.add('hidden'), 2200); }

/* ============================================================
   事件綁定
   ============================================================ */
function bind() {
  $('#fab').onclick = openCapture;
  $('#shutter').onclick = captureFromCamera;
  $('#pickFallback').onclick = () => $('#fileInput').click();
  $('#dropzone').onclick = () => $('#fileInput').click();
  $('#fileInput').onchange = e => { if (e.target.files[0]) runOCR(e.target.files[0]); };

  // 連拍模式
  $('#burstToggle').onclick = () => {
    burstMode = !burstMode; burstCount = 0;
    $('#burstToggle').classList.toggle('on', burstMode);
    $('#burstCount').classList.toggle('hidden', !burstMode);
    $('#burstCount').textContent = '已建 0 張';
    toast(burstMode ? '連拍模式:拍完自動建檔' : '已關閉連拍');
  };

  // drag & drop(桌機後備)
  const dz = $('#dropzone');
  ['dragover', 'dragenter'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.remove('drag'); }));
  dz.addEventListener('drop', e => { const f = e.dataTransfer.files[0]; if (f) runOCR(f); });

  // 關閉鈕 / 點背景關閉
  $$('[data-close]').forEach(b => b.onclick = () => closeModal('#' + b.closest('.modal').id));
  $$('.modal').forEach(m => m.addEventListener('click', e => { if (e.target === m) closeModal('#' + m.id); }));

  // 搜尋
  $('#btnSearch').onclick = () => { $('#searchBar').classList.toggle('hidden'); if (!$('#searchBar').classList.contains('hidden')) $('#searchInput').focus(); };
  $('#searchInput').oninput = e => { query = e.target.value; render(); };
  $('#searchClear').onclick = () => { query = ''; $('#searchInput').value = ''; render(); };

  // 編輯
  $('#btnSave').onclick = saveEdit;
  $('#btnDelete').onclick = () => {
    if (editingId && confirm('確定刪除這張名片?')) {
      contacts = contacts.filter(c => c.id !== editingId);
      save(); render(); closeModal('#editModal'); editingId = null; toast('已刪除');
    }
  };

  // 詳情動作
  $('#btnEdit').onclick = () => { closeModal('#detailModal'); openEdit(detailId); };
  $('#btnShare').onclick = () => shareContact(contacts.find(c => c.id === detailId));
  $('#btnRecapture').onclick = () => recaptureFor(detailId);
  $('#btnVcard').onclick = () => { const c = contacts.find(x => x.id === detailId); download(new Blob([toVCard(c)], { type: 'text/vcard' }), `${c.name || 'card'}.vcf`); };

  // 匯出 / 匯入 / 手動 / 排序
  $('#btnExport').onclick = () => { exportScope = null; $('#expCount').textContent = contacts.length; openModal('#exportModal'); };
  $$('.export-opt').forEach(b => b.onclick = () => exportData(b.dataset.fmt));
  $('#btnImport').onclick = () => $('#importInput').click();
  $('#importInput').onchange = e => { if (e.target.files[0]) importFromFile(e.target.files[0]); };
  $('#manualAdd').onclick = () => { closeModal('#captureModal'); openManual(); };
  $('#sortSelect').onchange = e => { sortBy = e.target.value; render(); };

  // 多選批次
  $('#btnSelect').onclick = () => selectMode ? exitSelect() : enterSelect();
  $('#selAll').onclick = selectAll;
  $('#selTag').onclick = batchTag;
  $('#selExport').onclick = batchExport;
  $('#selDelete').onclick = batchDelete;
  $('#selDone').onclick = exitSelect;

  // 雲端同步
  $('#btnSync').onclick = signInAndSync;

  // Esc 關閉
  document.addEventListener('keydown', e => { if (e.key === 'Escape') $$('.modal:not(.hidden)').forEach(m => closeModal('#' + m.id)); });
}

/* ---------- service worker ---------- */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}

/* ---------- init ---------- */
bind();
render();
initDrive();
