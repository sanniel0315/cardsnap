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
let autoCapture = true;    // 對齊後自動擷取
let detectRAF = null, detectCanvas = null, prevGrid = null, stableHits = 0, camReadyAt = 0, autoLocking = false;
let recaptureSide = 0;     // 重拍/拍背面:0=正面 1=背面
const SETTINGS_KEY = 'cardsnap.settings';
let settings = loadSettings();
let selectMode = false;    // 多選模式
let selected = new Set();
let exportScope = null;    // null=全部;Set=僅選取

function load() {
  let arr = [];
  try { arr = JSON.parse(localStorage.getItem(STORE_KEY)) || []; } catch { arr = []; }
  return arr.map(migrate);
}
/* 舊資料 → 新欄位(多電話 phones[]、雙面 images[]、分組 group) */
function migrate(c) {
  if (!Array.isArray(c.images)) c.images = c.image ? [c.image] : [];
  if (c.images.length && !c.image) c.image = c.images[0];
  if (!Array.isArray(c.phones)) c.phones = c.phone ? [{ label: '手機', value: c.phone }] : [];
  if (c.phones.length && !c.phone) c.phone = c.phones[0].value;
  if (typeof c.group !== 'string') c.group = '';
  if (typeof c.source !== 'string') c.source = '';
  return c;
}
/* phones[] → 同步主電話 + 去空白 */
function syncPhones(c) {
  c.phones = (c.phones || []).filter(p => (p.value || '').trim());
  c.phone = c.phones.length ? c.phones[0].value.trim() : '';
  return c;
}
function loadSettings() {
  const def = { sortBy: 'recent', listMain: 'name', ocrLang: 'chi_tra+eng', groupOnSave: false };
  try { return Object.assign(def, JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}); }
  catch { return def; }
}
function saveSettings() { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) {} }
function allGroups() {
  const s = new Set();
  contacts.forEach(c => { if (c.group) s.add(c.group); });
  return [...s].sort((a, b) => a.localeCompare(b, 'zh-Hant'));
}
function fmtDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
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
    camReadyAt = Date.now() + 800; startAutoDetect();
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
  stopAutoDetect();
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

/* ---------- 對齊偵測:自動擷取 ---------- */
function stopAutoDetect() {
  if (detectRAF) { cancelAnimationFrame(detectRAF); detectRAF = null; }
  prevGrid = null; stableHits = 0; autoLocking = false;
  const f = document.querySelector('.cam-frame');
  if (f) f.classList.remove('aiming', 'locked');
}
function startAutoDetect() {
  stopAutoDetect();
  if (!autoCapture) return;
  if (!detectCanvas) detectCanvas = document.createElement('canvas');
  let last = 0;
  const loop = (t) => {
    detectRAF = requestAnimationFrame(loop);
    if (t - last < 120) return; last = t;
    if (autoLocking || !autoCapture) return;
    const cv = $('#cameraView');
    if (!cv || cv.classList.contains('hidden')) return;     // OCR/掃描中暫停
    const v = $('#cameraVideo');
    if (!v || !v.videoWidth || Date.now() < camReadyAt) return;
    const m = analyzeFrame(v);
    if (!m) return;
    const detailed = m.detail > 11;                          // 框內有名片內容(文字/邊緣)
    const stable = prevGrid ? gridDiff(prevGrid, m.grid) < 7 : false;  // 手持穩定
    prevGrid = m.grid;
    if (detailed && stable) stableHits++; else stableHits = Math.max(0, stableHits - 1);
    const f = document.querySelector('.cam-frame');
    if (f) f.classList.toggle('aiming', stableHits >= 2);
    if (stableHits >= 5) lockAndCapture();
  };
  detectRAF = requestAnimationFrame(loop);
}
function analyzeFrame(v) {
  const vw = v.videoWidth, vh = v.videoHeight; if (!vw) return null;
  const ar = 1.586; let cw = vw * 0.9, ch = cw / ar;
  if (ch > vh * 0.92) { ch = vh * 0.92; cw = ch * ar; }
  const cx = (vw - cw) / 2, cy = (vh - ch) / 2;
  const DW = 160, DH = Math.round(DW / ar), c = detectCanvas;
  c.width = DW; c.height = DH;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(v, cx, cy, cw, ch, 0, 0, DW, DH);
  let px; try { px = ctx.getImageData(0, 0, DW, DH).data; } catch (e) { return null; }
  const N = DW * DH, g = new Float32Array(N);
  for (let i = 0; i < N; i++) { const o = i * 4; g[i] = 0.299 * px[o] + 0.587 * px[o + 1] + 0.114 * px[o + 2]; }
  let sum = 0, cnt = 0;
  for (let y = 0; y < DH; y++) for (let x = 0; x < DW - 1; x++) { sum += Math.abs(g[y * DW + x + 1] - g[y * DW + x]); cnt++; }
  for (let y = 0; y < DH - 1; y++) for (let x = 0; x < DW; x++) { sum += Math.abs(g[(y + 1) * DW + x] - g[y * DW + x]); cnt++; }
  const detail = sum / cnt;
  const GX = 8, GY = 8, grid = new Float32Array(GX * GY);
  for (let gy = 0; gy < GY; gy++) for (let gx = 0; gx < GX; gx++) {
    let s = 0, n = 0;
    const x0 = Math.floor(gx * DW / GX), x1 = Math.floor((gx + 1) * DW / GX);
    const y0 = Math.floor(gy * DH / GY), y1 = Math.floor((gy + 1) * DH / GY);
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { s += g[y * DW + x]; n++; }
    grid[gy * GX + gx] = n ? s / n : 0;
  }
  return { detail, grid };
}
function gridDiff(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / a.length; }
function lockAndCapture() {
  autoLocking = true;
  if (detectRAF) { cancelAnimationFrame(detectRAF); detectRAF = null; }
  const f = document.querySelector('.cam-frame');
  if (f) { f.classList.remove('aiming'); f.classList.add('locked'); }
  setTimeout(() => { captureFromCamera(); }, 280);
}

async function recognize(source, previewUrl) {
  // 重拍:只替換照片,不做 OCR
  if (recaptureId) {
    const c = contacts.find(x => x.id === recaptureId);
    if (c) {
      c.images = c.images || [];
      c.images[recaptureSide] = lastImage || c.images[recaptureSide];
      c.image = c.images[0] || c.image;
      c.updated = Date.now(); save(); render();
    }
    const side = recaptureSide; recaptureId = null; recaptureSide = 0;
    closeModal('#captureModal'); toast(side ? '已更新背面照片' : '已更新名片照片');
    if (c) openDetail(c.id);
    return;
  }
  $('#preview').src = previewUrl;
  $('#dropzone').classList.add('hidden');
  $('#scanStage').classList.remove('hidden');
  $('#scanStage').classList.remove('done');
  $('#ocrStatus').classList.remove('hidden');
  $('#ocrText').textContent = '辨識中…';
  try {
    if (typeof Tesseract === 'undefined') throw new Error('OCR 引擎尚未載入,請檢查網路');
    const { data } = await Tesseract.recognize(source, settings.ocrLang || 'chi_tra+eng', {
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
        contacts.unshift(migrate({ id: uid(), created: Date.now(), updated: Date.now(), favorite: false, raw: lastOcrRaw, image: lastImage, source: '拍照', ...fields }));
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


/* ---------- 多電話編輯 ---------- */
const PHONE_LABELS = ['手機', '市話', '傳真', '其他'];
function phoneRow(label, value) {
  const opts = PHONE_LABELS.map(l => `<option ${l === label ? 'selected' : ''}>${l}</option>`).join('');
  return `<div class="ph-row"><select class="ph-label">${opts}</select>` +
    `<input class="ph-val" type="tel" value="${esc(value || '')}" placeholder="0912-345-678">` +
    `<button type="button" class="ph-del" title="移除">×</button></div>`;
}
function renderPhones(phones) {
  const wrap = $('#phonesWrap');
  const list = (phones && phones.length) ? phones : [{ label: '手機', value: '' }];
  wrap.innerHTML = list.map(p => phoneRow(p.label, p.value)).join('');
  bindPhoneRows();
}
function bindPhoneRows() {
  $$('#phonesWrap .ph-del').forEach(b => b.onclick = () => {
    const rows = $$('#phonesWrap .ph-row');
    if (rows.length <= 1) { b.closest('.ph-row').querySelector('.ph-val').value = ''; return; }
    b.closest('.ph-row').remove();
  });
}
function readPhones() {
  return $$('#phonesWrap .ph-row').map(r => ({
    label: r.querySelector('.ph-label').value,
    value: r.querySelector('.ph-val').value.trim()
  })).filter(p => p.value);
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
const ICON_CALL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4h3l1.5 4-2 1.4a10 10 0 0 0 4.6 4.6l1.4-2 4 1.5v3a1 1 0 0 1-1.1 1A15 15 0 0 1 5 5.1 1 1 0 0 1 6 4"/></svg>';
const ICON_MAP = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s7-6.3 7-11a7 7 0 1 0-14 0c0 4.7 7 11 7 11"/><circle cx="12" cy="10" r="2.6"/></svg>';
const ICON_SHARE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="2.6"/><circle cx="6" cy="12" r="2.6"/><circle cx="18" cy="19" r="2.6"/><path d="m8.3 10.7 7.4-4.4M8.3 13.3l7.4 4.4"/></svg>';
const ICON_EDIT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 5.5l4 4M4 20l1-4 11-11 4 4-11 11z"/></svg>';
const ICON_CALL_SM = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3.5h3l1.3 3.2-1.7 1.2a9 9 0 0 0 3.8 3.8l1.2-1.7L16.5 14v3a1 1 0 0 1-1.1 1A12.5 12.5 0 0 1 4 6.6 1 1 0 0 1 5 3.5"/></svg>';
const ICON_SMS = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 5.5A1.5 1.5 0 0 1 4.5 4h11A1.5 1.5 0 0 1 17 5.5v6A1.5 1.5 0 0 1 15.5 13H8l-4 3v-3H4.5A1.5 1.5 0 0 1 3 11.5z"/></svg>';

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
        <div class="c-name">${esc(settings.listMain === 'company' ? (c.company || c.name || '未命名') : (c.name || '未命名'))} ${c.favorite ? '<span class="star">★</span>' : ''}</div>
        <div class="c-sub">${esc((settings.listMain === 'company' ? [c.name, c.title] : [c.title, c.company]).filter(Boolean).join(' · ') || c.phone || c.email || '—')}</div>
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
  renderPhones(c.phones && c.phones.length ? c.phones : (c.phone ? [{ label: '手機', value: c.phone }] : []));
  $('#f_email').value = c.email || '';
  $('#f_website').value = c.website || '';
  $('#f_address').value = c.address || '';
  $('#groupList').innerHTML = allGroups().map(g => `<option value="${esc(g)}">`).join('');
  $('#f_group').value = c.group || '';
  $('#f_tags').value = (c.tags || []).join(', ');
  $('#f_note').value = c.note || '';
  $('#rawText').textContent = raw || c.raw || '(無)';
  $('#btnDelete').classList.toggle('hidden', !id);
  openModal('#editModal');
}

function saveEdit() {
  const phones = readPhones();
  const data = {
    name: $('#f_name').value.trim(),
    company: $('#f_company').value.trim(),
    title: $('#f_title').value.trim(),
    phones: phones,
    phone: phones.length ? phones[0].value : '',
    email: $('#f_email').value.trim(),
    website: $('#f_website').value.trim(),
    address: $('#f_address').value.trim(),
    group: $('#f_group').value.trim(),
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
    contacts.unshift(migrate({ id: uid(), created: Date.now(), favorite: false, raw: lastOcrRaw,
      image: lastImage, images: lastImage ? [lastImage] : [], source: lastImage ? '拍照' : '手動', ...data }));
  }
  save(); render(); closeModal('#editModal'); resetCapture();
  toast(editingId ? '已更新' : '已建檔');
  editingId = null; lastOcrRaw = ''; lastImage = '';
}

/* ============================================================
   詳情 / 分享 / 重拍
   ============================================================ */
function mapsHref(addr) { return 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(addr); }

function openDetail(id) {
  detailId = id;
  const c = contacts.find(x => x.id === id);
  if (!c) return;
  $('#d_name').textContent = c.name || c.company || '名片';
  const imgs = (c.images && c.images.length) ? c.images : (c.image ? [c.image] : []);

  let carousel = '';
  if (imgs.length) {
    carousel = `<div class="dc-carousel" id="dcCar">
      <div class="dc-track" id="dcTrack">${imgs.map(u => `<img src="${u}" alt="名片">`).join('')}</div>
      ${imgs.length > 1 ? `<div class="dc-dots">${imgs.map((_, i) => `<i data-i="${i}" class="${i === 0 ? 'on' : ''}"></i>`).join('')}</div>` : ''}
    </div>`;
  }

  const summary = `<div class="dc-summary">
    ${c.image ? `<img class="dc-ava" src="${c.image}" alt="">` : `<div class="dc-ava dc-ava-txt">${esc(initials(c.name || c.company))}</div>`}
    <div class="dc-sum-main">
      <div class="dc-sum-name">${esc(c.name || '未命名')}${c.favorite ? ' <span class="star">★</span>' : ''}</div>
      ${c.company ? `<div class="dc-sum-sub">${esc(c.company)}</div>` : ''}
      ${c.title ? `<div class="dc-sum-sub muted">${esc(c.title)}</div>` : ''}
    </div>
  </div>`;

  const phone0 = (c.phones && c.phones.length) ? c.phones[0].value : c.phone;
  const actions = `<div class="dc-actions">
    <a class="dc-act ${phone0 ? '' : 'off'}" ${phone0 ? `href="tel:${esc(phone0)}"` : ''}><span class="dc-act-ic ic-call">${ICON_CALL}</span>電話</a>
    <a class="dc-act ${c.address ? '' : 'off'}" ${c.address ? `href="${mapsHref(c.address)}" target="_blank" rel="noopener"` : ''}><span class="dc-act-ic ic-map">${ICON_MAP}</span>地址</a>
    <button class="dc-act" id="dcShare"><span class="dc-act-ic ic-share">${ICON_SHARE}</span>分享</button>
    <button class="dc-act" id="dcEdit"><span class="dc-act-ic ic-edit">${ICON_EDIT}</span>編輯</button>
  </div>`;

  const rows = [];
  if (c.group) rows.push(`<div class="dc-row"><span class="dc-label">分組</span><span class="dc-val">${esc(c.group)}</span></div>`);
  const phs = (c.phones && c.phones.length) ? c.phones : (c.phone ? [{ label: '手機', value: c.phone }] : []);
  phs.forEach(p => {
    rows.push(`<div class="dc-row"><span class="dc-label">${esc(p.label || '電話')}</span>` +
      `<span class="dc-val"><a href="tel:${esc(p.value)}">${esc(p.value)}</a></span>` +
      `<span class="dc-row-acts"><a href="tel:${esc(p.value)}" title="撥打">${ICON_CALL_SM}</a><a href="sms:${esc(p.value)}" title="簡訊">${ICON_SMS}</a></span></div>`);
  });
  if (c.email) rows.push(`<div class="dc-row"><span class="dc-label">Email</span><span class="dc-val"><a href="mailto:${esc(c.email)}">${esc(c.email)}</a></span></div>`);
  if (c.website) { const w = /^https?:/.test(c.website) ? c.website : 'https://' + c.website; rows.push(`<div class="dc-row"><span class="dc-label">網站</span><span class="dc-val"><a href="${esc(w)}" target="_blank" rel="noopener">${esc(c.website)}</a></span></div>`); }
  if (c.address) rows.push(`<div class="dc-row"><span class="dc-label">地址</span><span class="dc-val"><a href="${mapsHref(c.address)}" target="_blank" rel="noopener">${esc(c.address)}</a></span></div>`);
  if ((c.tags || []).length) rows.push(`<div class="dc-row"><span class="dc-label">標籤</span><span class="dc-val">${c.tags.map(t => `<span class="c-tag">${esc(t)}</span>`).join(' ')}</span></div>`);

  const meta = `建檔 ${fmtDate(c.created)}${c.source ? ' · 來源:' + esc(c.source) : ''}`;
  const noteBlock = `<div class="dc-note"><div class="dc-label">備註</div>` +
    `<div class="dc-note-body">${c.note ? esc(c.note) : '<span class="muted">尚無備註</span>'}</div>` +
    `<div class="dc-meta">${meta}</div></div>`;

  $('#detailBody').innerHTML = carousel + summary + actions +
    `<div class="dc-fav"><span class="link-btn" id="favToggle">${c.favorite ? '★ 已收藏' : '☆ 收藏'}</span>` +
    `<span class="link-btn" id="dcReFront">重拍正面</span>` +
    `<span class="link-btn" id="dcBack">${imgs.length > 1 ? '重拍背面' : '加拍背面'}</span></div>` +
    `<div class="dc-rows">${rows.join('')}</div>` + noteBlock;

  $('#favToggle').onclick = () => { c.favorite = !c.favorite; save(); render(); openDetail(id); };
  $('#dcEdit').onclick = () => { closeModal('#detailModal'); openEdit(id); };
  $('#dcShare').onclick = () => shareContact(c);
  $('#dcReFront').onclick = () => recaptureFor(id, 0);
  $('#dcBack').onclick = () => recaptureFor(id, 1);

  const track = $('#dcTrack');
  if (track && imgs.length > 1) {
    let idx = 0; const dots = $$('#dcCar .dc-dots i');
    const go = i => { idx = Math.max(0, Math.min(imgs.length - 1, i)); track.style.transform = `translateX(-${idx * 100}%)`; dots.forEach((d, k) => d.classList.toggle('on', k === idx)); };
    dots.forEach(d => d.onclick = () => go(+d.dataset.i));
    let sx = null;
    track.addEventListener('touchstart', e => sx = e.touches[0].clientX, { passive: true });
    track.addEventListener('touchend', e => { if (sx == null) return; const dx = e.changedTouches[0].clientX - sx; if (Math.abs(dx) > 40) go(idx + (dx < 0 ? 1 : -1)); sx = null; });
  }

  try {
    if (typeof QRCode !== 'undefined') {
      QRCode.toCanvas($('#qrCanvas'), toVCard(c), { width: 180, margin: 1 }, () => {});
      $('#qrWrap').classList.remove('hidden');
    }
  } catch { $('#qrWrap').classList.add('hidden'); }
  openModal('#detailModal');
}

function recaptureFor(id, side = 0) {
  recaptureId = id;
  recaptureSide = side;
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
let syncing = false;     // 防重入:同步進行中
let syncSignal = null;   // 逾時中止用

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
  else driveTokenClient.requestAccessToken();
}

async function driveApi(url, opts) {
  const r = await fetch(url, Object.assign({ headers: { Authorization: 'Bearer ' + driveToken }, signal: syncSignal }, opts || {}));
  if (r.status === 401) { driveToken = ''; throw new Error('授權過期,請再按一次同步'); }
  if (!r.ok) throw new Error('Drive 錯誤 ' + r.status);
  return r;
}

async function doSync() {
  if (!driveToken) { signInAndSync(); return; }
  if (syncing) return;                    // 已在同步,避免重疊讓 icon 卡住
  syncing = true;
  setSyncState('syncing');
  const ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
  syncSignal = ctrl ? ctrl.signal : null;
  const killer = setTimeout(() => { if (ctrl) ctrl.abort(); }, 20000);  // 20s 逾時
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
    contacts = syncMerge(contacts, remote); try { localStorage.setItem(STORE_KEY, JSON.stringify(contacts)); } catch (e) {} render();
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
    setSyncState('synced'); markSynced(); toast('已與 Google Drive 同步');
  } catch (e) {
    setSyncState('idle');
    toast(e && e.name === 'AbortError' ? '同步逾時,請檢查網路後再試一次' : ('同步失敗:' + (e && e.message ? e.message : e)));
  } finally {
    clearTimeout(killer);
    syncSignal = null;
    syncing = false;                       // 一定還原,spinner 不會卡住
  }
}

function schedulePush() {
  if (!driveToken) return;
  clearTimeout(drivePushT);
  drivePushT = setTimeout(doSync, 2500);
}

function fmtSyncTime(ts) {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return (sameDay ? '' : (d.getMonth() + 1) + '/' + d.getDate() + ' ') + hh + ':' + mm;
}
function showSyncStatus(ts) {
  const el = $('#syncStatus'); if (!el) return;
  el.textContent = '雲端已連結 · 上次同步 ' + fmtSyncTime(ts);
  el.classList.remove('hidden');
}
function markSynced() {
  const t = Date.now();
  try { localStorage.setItem('cardsnap.lastSync', String(t)); } catch (e) {}
  showSyncStatus(t);
}
function initSyncStatus() {
  const v = localStorage.getItem('cardsnap.lastSync');
  if (v) showSyncStatus(Number(v));
}

/* ============================================================
   UI helpers
   ============================================================ */
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m])); }
/* ============================================================
   設定
   ============================================================ */
function openSettings() {
  $('#set_sort').value = settings.sortBy;
  $('#set_listmain').value = settings.listMain;
  $('#set_ocr').value = settings.ocrLang;
  openModal('#settingsModal');
}
function applySettings() {
  settings.sortBy = $('#set_sort').value;
  settings.listMain = $('#set_listmain').value;
  settings.ocrLang = $('#set_ocr').value;
  saveSettings();
  sortBy = settings.sortBy;
  const ss = $('#sortSelect'); if (ss) ss.value = sortBy;
  render();
  closeModal('#settingsModal');
  toast('設定已儲存');
}

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
  $('#autoToggle').onclick = () => {
    autoCapture = !autoCapture;
    $('#autoToggle').classList.toggle('on', autoCapture);
    if (autoCapture) { toast('自動擷取:對齊後自動拍'); startAutoDetect(); }
    else { toast('已關閉自動擷取,改用快門'); stopAutoDetect(); }
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
  $('#btnShare').onclick = () => shareContact(contacts.find(c => c.id === detailId));
  $('#btnVcard').onclick = () => { const c = contacts.find(x => x.id === detailId); download(new Blob([toVCard(c)], { type: 'text/vcard' }), `${c.name || 'card'}.vcf`); };
  // 新增電話列
  $('#addPhone').onclick = () => { $('#phonesWrap').insertAdjacentHTML('beforeend', phoneRow('手機', '')); bindPhoneRows(); };
  // 設定
  $('#btnSettings').onclick = openSettings;
  $('#setSave').onclick = applySettings;

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
sortBy = settings.sortBy || 'recent';
bind();
{ const ss = $('#sortSelect'); if (ss) ss.value = sortBy; }
render();
initDrive();
initSyncStatus();
