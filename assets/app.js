/* ============================================================
   CardSnap — 名片整理 PWA
   即時相機/連拍 + 對齊框 + 掃描互動;端上 OCR(Tesseract.js)
   多選批次 · 名片縮圖 · 匯入/匯出 · 名單管理
   純邏輯集中於 assets/core.js;資料存 localStorage(不上傳)
   ============================================================ */
'use strict';

const STORE_KEY = 'cardsnap.contacts.v1';
const { parseCard, toVCard, toCSV, parseCSV, parseVCards, mergeContacts, syncMerge, contactKey } = window.CardSnapCore;
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

/* ---------- state ---------- */
let contacts = load();
let tombstones = loadTombstones();
let activeTag = null;
let activeGroup = null;   // null=全部, ''=未分組, 其他=分組名
let groupTarget = null;
let query = '';
let editingId = null;
let lastOcrRaw = '';
let detailId = null;
let favView = false;   // 桌面側欄「收藏」檢視
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
const TOMB_KEY = 'cardsnap.tombstones';
let settings = loadSettings();
let selectMode = false;    // 多選模式
let selected = new Set();
let exportScope = null;    // null=全部;Set=僅選取

function isJunkContact(x) {
  if (!x) return true;
  const blob = [x.name, x.company, x.title, x.address, x.note, x.website].join(' ');
  if (/\uFFFD/.test(blob)) return true;                       // � 解碼失敗
  if (/[\x00-\x08\x0E-\x1F]/.test(blob)) return true;        // 控制字元
  if (/PK\x03\x04|sharedStrings|xl\/worksheets|Content_Types|<\?xml/i.test(blob)) return true; // Excel/zip 殘骸
  const name = String(x.name || '').trim();
  const company = String(x.company || '').trim();
  if (!name && !company) return true;                         // 空白名片
  return false;
}
function dropJunk(arr) { return (Array.isArray(arr) ? arr : []).filter(c => !isJunkContact(c)); }

function load() {
  let arr = [];
  try { arr = JSON.parse(localStorage.getItem(STORE_KEY)) || []; } catch { arr = []; }
  return dropJunk(arr.map(migrate));
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
  const def = { sortBy: 'recent', listMain: 'name', ocrLang: 'chi_tra+eng', fontSize: 'md', pinHash: '', cloudOcr: true, ocrEndpoint: 'https://ocr.name-car-box.com', drivePhotos: true, forceEndpoint: false, storageMode: 'cloud' };
  try { return Object.assign(def, JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}); }
  catch { return def; }
}
function saveSettings() { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) {} }
function loadTombstones() { try { return JSON.parse(localStorage.getItem(TOMB_KEY)) || []; } catch { return []; } }
function saveTombstones() { try { localStorage.setItem(TOMB_KEY, JSON.stringify(tombstones)); } catch (e) {} }
function addTombstone(c) { if (!c) return; try { tombstones.push({ k: contactKey(c), ts: Date.now() }); } catch (e) {} }
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
function compressImage(source, max = 1000, q = 0.72) {
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

/* 雲端 OCR(Google Vision 代理) */
const CLOUD_OCR_URL = '/.netlify/functions/ocr';
const OCR_LANG_HINTS = {
  'chi_tra+eng': ['zh-Hant', 'en'], 'chi_sim+eng': ['zh-Hans', 'en'],
  'eng': ['en'], 'jpn+eng': ['ja', 'en'],
};
let cloudOcrDown = false;   // 此次 session 已知雲端不可用 → 不再嘗試,直接本機
async function srcToBase64(source, max = 1600, q = 0.85) {
  let img = source;
  if (typeof source === 'string') img = await loadImage(source);
  const sw = img.width || img.videoWidth || img.naturalWidth;
  const sh = img.height || img.videoHeight || img.naturalHeight;
  const scale = Math.min(1, max / Math.max(sw, sh || 1));
  const cw = Math.max(1, Math.round(sw * scale)), ch = Math.max(1, Math.round(sh * scale));
  const c = document.createElement('canvas'); c.width = cw; c.height = ch;
  c.getContext('2d').drawImage(img, 0, 0, cw, ch);
  return c.toDataURL('image/jpeg', q).split(',')[1];
}
function normalizeRemoteFields(f) {
  if (!f || typeof f !== 'object') return null;
  const out = {
    name: f.name || '', company: f.company || '', title: f.title || '',
    email: f.email || '', website: f.website || '', address: f.address || '',
    fax: f.fax || '', taxId: f.taxId || f.tax_id || f.vat || '', note: f.note || '',
  };
  let phones = [];
  if (Array.isArray(f.phones)) {
    phones = f.phones.map(p => typeof p === 'string'
      ? { label: '電話', value: p }
      : { label: p.label || p.type || '電話', value: p.value || p.number || '' }).filter(p => p.value);
  } else if (f.phone) phones = [{ label: '手機', value: f.phone }];
  out.phones = phones;
  out.phone = phones.length ? phones[0].value : (f.phone || '');
  return (out.name || out.company || out.phone || out.email) ? out : null;
}
function normEndpoint(u) {
  u = (u || '').trim().replace(/\/+$/, '');
  if (u && !/\/ocr$/i.test(u)) u += '/ocr';
  return u;
}
async function remoteOCR(source) {
  const b64 = await srcToBase64(source);
  const langHints = OCR_LANG_HINTS[settings.ocrLang] || ['zh-Hant', 'en'];
  const custom = settings.ocrEndpoint && settings.ocrEndpoint.trim();
  const url = custom ? normEndpoint(custom) : CLOUD_OCR_URL;
  const ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
  const killer = setTimeout(() => { if (ctrl) ctrl.abort(); }, 35000);
  try {
    const r = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: b64, langHints }), signal: ctrl ? ctrl.signal : undefined,
    });
    if ((r.status === 404 || r.status === 501) && !custom) { cloudOcrDown = true; const j = await r.json().catch(() => ({})); throw new Error(j.error || '雲端未設定'); }
    if (!r.ok) throw new Error('辨識服務 ' + r.status);
    const j = await r.json();
    if (j.error) throw new Error(j.error);
    return { text: (j.text || '').trim(), fields: normalizeRemoteFields(j.fields) };
  } finally { clearTimeout(killer); }
}

/* OCR 前處理:放大 + 灰階 + 對比拉伸,提高辨識率 */
function preprocess(src) {
  const sw = src.width || src.videoWidth || src.naturalWidth;
  const sh = src.height || src.videoHeight || src.naturalHeight;
  if (!sw || !sh) return src;
  const scale = Math.min(2.5, Math.max(1, 1600 / Math.max(sw, sh)));
  const cw = Math.round(sw * scale), ch = Math.round(sh * scale);
  const c = document.createElement('canvas'); c.width = cw; c.height = ch;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(src, 0, 0, cw, ch);
  let id; try { id = ctx.getImageData(0, 0, cw, ch); } catch (e) { return c; }
  const d = id.data; let sum = 0;
  for (let i = 0; i < d.length; i += 4) { const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; d[i] = d[i + 1] = d[i + 2] = g; sum += g; }
  const mean = sum / (d.length / 4), k = 1.35;
  for (let i = 0; i < d.length; i += 4) { let v = (d[i] - mean) * k + mean; v = v < 0 ? 0 : v > 255 ? 255 : v; d[i] = d[i + 1] = d[i + 2] = v; }
  ctx.putImageData(id, 0, 0);
  return c;
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
    let text = null, remoteFields = null, usedEngine = '';
    const customEp = settings.ocrEndpoint && settings.ocrEndpoint.trim();
    const useRemote = customEp || (settings.cloudOcr !== false && !cloudOcrDown);
    // 1) 遠端高精準(自訂本機/GPU 伺服器 或 雲端 Vision)
    if (useRemote) {
      try {
        $('#ocrText').textContent = customEp ? '高精準辨識中(本機 GPU)…' : '雲端高精準辨識中…';
        const r = await remoteOCR(source);
        text = r.text; remoteFields = r.fields;
        usedEngine = customEp ? '本機 GPU' : '雲端 Vision';
      } catch (e) {
        text = null;
        // 只用本機:失敗就停,不退回(讓你確定有沒有走地端)
        if (customEp && settings.forceEndpoint) {
          toast('本機 OCR 連線失敗,已停止(設定為只用本機):' + (e && e.message ? e.message : e));
          $('#ocrStatus').classList.add('hidden');
          resetCapture(); startCamera();
          return;
        }
        toast((cloudOcrDown ? '辨識服務尚未設定' : '高精準辨識連線失敗') + ',改用本機辨識');
      }
    }
    // 2) 本機 Tesseract 後備
    if (text === null) {
      if (typeof Tesseract === 'undefined') throw new Error('OCR 引擎尚未載入,請檢查網路');
      let ocrSrc = source;
      try { if (typeof source === 'string') ocrSrc = await loadImage(source); ocrSrc = preprocess(ocrSrc); } catch (e) { ocrSrc = source; }
      const { data } = await Tesseract.recognize(ocrSrc, settings.ocrLang || 'chi_tra+eng', {
        logger: m => {
          if (m.status === 'recognizing text')
            $('#ocrText').textContent = `辨識中… ${Math.round(m.progress * 100)}%`;
          else
            $('#ocrText').textContent = m.status === 'loading language traineddata' ? '載入語言模型…' : '處理中…';
        }
      });
      text = (data.text || '').trim();
      usedEngine = '本機 Tesseract';
    }
    lastOcrRaw = text;
    $('#scanStage').classList.add('done');
    $('#ocrText').textContent = '辨識完成';
    await new Promise(r => setTimeout(r, 420));
    const fields = remoteFields || parseCard(lastOcrRaw);
    if (usedEngine && !burstMode) toast('辨識來源:' + usedEngine);

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
function cleanCardName(s) {
  if (!s) return '';
  const parts = String(s).split(/[-\uFF0D\u2014]/).map(t => t.trim()).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : String(s).trim();
}
// 解析 Excel(.xlsx/.xls)。優先支援 CamCard 匯出(無標題列、固定欄位、姓名為「公司-職稱-人名」)。
async function parseSpreadsheet(file) {
  if (typeof XLSX === 'undefined') { toast('Excel 解析元件載入中,請再按一次匯入'); return []; }
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });
  if (!rows.length) return [];
  const get = (r, i) => (r[i] == null ? '' : String(r[i]).trim());
  const looksCamCard = rows.some(r => {
    const b = get(r, 1);
    return b === '姓名' || /[-\uFF0D\u2014].*[-\uFF0D\u2014]/.test(b);
  });
  if (looksCamCard) {
    const out = [];
    for (const r of rows) {
      const nameRaw = get(r, 1) || get(r, 2);
      if (!nameRaw || nameRaw === '姓名') continue;
      const name = cleanCardName(nameRaw) || get(r, 46);
      const mobile = get(r, 15), office = get(r, 18), fax = get(r, 21);
      const phones = [];
      if (mobile) phones.push({ label: '手機', value: mobile });
      if (office) phones.push({ label: '市話', value: office });
      out.push({
        name, company: get(r, 6) || get(r, 9), title: get(r, 11) || get(r, 8),
        email: get(r, 24), website: get(r, 40), fax,
        phone: mobile || office, phones,
        address: (get(r, 29) + ' ' + get(r, 30)).trim(), tags: [], note: ''
      });
    }
    return out;
  }
  return parseCSV(XLSX.utils.sheet_to_csv(ws));
}

async function importFromFile(file) {
  try {
    const fn = (file.name || '').toLowerCase();
    let parsed = [];
    if (fn.endsWith('.xlsx') || fn.endsWith('.xls')) {
      parsed = await parseSpreadsheet(file);
    } else {
      const text = await file.text();
      if (fn.endsWith('.json') || /^\s*[\[{]/.test(text)) {
        const j = JSON.parse(text); parsed = Array.isArray(j) ? j : (j.contacts || []);
      } else if (fn.endsWith('.vcf') || /BEGIN:VCARD/i.test(text)) {
        parsed = parseVCards(text);
      } else {
        parsed = parseCSV(text);
      }
    }
    if (!parsed.length) { toast('檔案沒有可匯入的名片'); return; }
    const incoming = parsed.map(p => migrate({
      id: p.id || uid(), created: p.created || Date.now(), updated: p.updated || p.created || Date.now(), favorite: !!p.favorite,
      image: p.image || '', images: Array.isArray(p.images) ? p.images : (p.image ? [p.image] : []),
      name: p.name || '', company: p.company || '', title: p.title || '',
      phone: p.phone || '', phones: Array.isArray(p.phones) ? p.phones : undefined,
      email: p.email || '', website: p.website || '', address: p.address || '',
      fax: p.fax || '', taxId: p.taxId || p.tax_id || '', group: p.group || '',
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
    if (favView && !c.favorite) return false;
    if (activeGroup !== null) { if (activeGroup === '') { if (c.group) return false; } else if (c.group !== activeGroup) return false; }
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
const ICON_DL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12m0 0 4-4m-4 4-4-4"/><path d="M5 19h14"/></svg>';
const ICON_TRASH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m2 0v12a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V7"/></svg>';
const ICON_CAM_UP = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.5A1.5 1.5 0 0 1 4.5 7H7l1.2-1.8h7.6L18 7h1.5A1.5 1.5 0 0 1 21 8.5v9A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5z"/><path d="M12 16v-4m0 0-1.7 1.7M12 12l1.7 1.7"/></svg>';
const ICON_DETAIL_EMPTY = '<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><rect x="7" y="12" width="34" height="24" rx="4"/><circle cx="17" cy="22" r="3.5"/><path d="M12 31c1.4-3 3.4-4.5 5-4.5s3.6 1.5 5 4.5" stroke-linecap="round"/><path d="M28 20h9M28 25h7" stroke-linecap="round"/></svg>';

function renderGroupSelect() {
  const sel = $('#groupSelect'); if (!sel) return;
  const groups = allGroups();
  if (activeGroup && activeGroup !== '' && !groups.includes(activeGroup)) activeGroup = null;
  const counts = {}; contacts.forEach(c => { const g = c.group || ''; counts[g] = (counts[g] || 0) + 1; });
  let html = `<option value="__all">全部分組 (${contacts.length})</option>`;
  groups.forEach(g => { html += `<option value="g:${esc(g)}">${esc(g)} (${counts[g] || 0})</option>`; });
  if (counts['']) html += `<option value="__none">未分組 (${counts['']})</option>`;
  sel.innerHTML = html;
  sel.value = activeGroup === null ? '__all' : (activeGroup === '' ? '__none' : 'g:' + activeGroup);
  const eb = $('#btnGroupEdit'); if (eb) eb.classList.toggle('hidden', !(activeGroup && activeGroup !== ''));
}

function render() {
  document.body.classList.toggle('select-mode', selectMode);
  const data = filtered();
  const _filterOn = activeTag || activeGroup !== null || query.trim();
  $('#countLabel').textContent = `共 ${contacts.length} 張` + (_filterOn ? ` · 符合 ${data.length}` : '名片');
  renderGroupSelect();
  $('#empty').classList.toggle('hidden', contacts.length !== 0);

  const tags = allTags();
  $('#tagChips').innerHTML = tags.map(t =>
    `<span class="chip ${t === activeTag ? 'active' : ''}" data-tag="${esc(t)}">#${esc(t)}</span>`).join('');
  $$('#tagChips .chip').forEach(ch => ch.onclick = () => {
    activeTag = ch.dataset.tag === activeTag ? null : ch.dataset.tag; render();
  });

  const list = $('#list');
  if (window.matchMedia('(min-width: 980px)').matches) renderDesktop(list, data);
  else renderCards(list, data);
}

function renderCards(list, data) {
  list.classList.remove('as-table');
  list.innerHTML = data.map(c => `
    <div class="contact ${selected.has(c.id) ? 'selected' : ''}" data-id="${c.id}">
      <div class="sel-box">${CHECK_SVG}</div>
      ${c.image ? `<img class="avatar avatar-img" src="${c.image}" alt="">` : `<div class="avatar">${esc(initials(c.name))}</div>`}
      <div class="c-main">
        <div class="c-name">${esc(settings.listMain === 'company' ? (c.company || c.name || '未命名') : (c.name || '未命名'))} ${c.favorite ? '<span class="star">★</span>' : ''}</div>
        <div class="c-sub">${esc((settings.listMain === 'company' ? [c.name, c.title] : [c.title, c.company]).filter(Boolean).join(' · ') || c.phone || c.email || '—')}</div>
        ${(c.group || (c.tags || []).length) ? `<div class="c-tags">${c.group ? `<span class="c-group">${esc(c.group)}</span>` : ''}${(c.tags || []).map(t => `<span class="c-tag">${esc(t)}</span>`).join('')}</div>` : ''}
      </div>
      <div class="c-quick">
        ${c.phone ? `<a href="tel:${esc(c.phone)}" title="撥打" onclick="event.stopPropagation()"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3.5h3l1.3 3.2-1.7 1.2a9 9 0 0 0 3.8 3.8l1.2-1.7L16.5 14v3a1 1 0 0 1-1.1 1A12.5 12.5 0 0 1 4 6.6 1 1 0 0 1 5 3.5"/></svg></a>` : ''}
        ${c.email ? `<a href="mailto:${esc(c.email)}" title="寄信" onclick="event.stopPropagation()"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="4.5" width="15" height="11" rx="2"/><path d="m3 6 7 5 7-5"/></svg></a>` : ''}
      </div>
    </div>`).join('');
  $$('#list .contact').forEach(el => el.onclick = () => {
    if (selectMode) toggleSelect(el.dataset.id); else openDetail(el.dataset.id);
  });
}

/* ---------- CamCard 風三欄桌面版 ---------- */
function groupCounts() {
  const m = new Map(); let none = 0, fav = 0;
  contacts.forEach(c => { if (c.favorite) fav++; if (c.group) m.set(c.group, (m.get(c.group) || 0) + 1); else none++; });
  return { groups: [...m.entries()].sort((a, b) => a[0].localeCompare(b[0], 'zh-Hant')), none, fav };
}
function deskSideHTML() {
  const gc = groupCounts();
  const item = (label, count, active, attr) =>
    `<button class="dk-g ${active ? 'on' : ''}" ${attr}><span class="dk-g-name">${esc(label)}</span><span class="dk-g-n">${count}</span></button>`;
  let h = `<div class="dk-side-h">分組</div>`;
  h += item('全部名片', contacts.length, activeGroup === null && !favView, 'data-g="__all"');
  h += item('收藏', gc.fav, favView, 'data-g="__fav"');
  gc.groups.forEach(([name, n]) => h += item(name, n, !favView && activeGroup === name, `data-g="g:${esc(name)}"`));
  if (gc.none) h += item('未分組', gc.none, !favView && activeGroup === '', 'data-g="__none"');
  return h;
}
function deskListHTML(data) {
  if (!data.length) return `<div class="dk-empty">這個分組沒有名片</div>`;
  return data.map(c => `<button class="dk-card ${c.id === detailId ? 'on' : ''}" data-id="${c.id}">
    ${c.image ? `<img class="dk-av" src="${c.image}" alt="">` : `<span class="dk-av dk-av-txt">${esc(initials(c.name || c.company))}</span>`}
    <span class="dk-card-main"><span class="dk-card-name">${esc(c.name || c.company || '未命名')}${c.favorite ? ' <span class="star">★</span>' : ''}</span>
    <span class="dk-card-sub">${esc([c.company, c.title].filter(Boolean).join(' · ') || c.phone || c.email || '—')}</span></span>
    ${c.group ? `<span class="dk-card-g">${esc(c.group)}</span>` : ''}
  </button>`).join('');
}
function deskDetailHTML(c) {
  if (!c) return `<div class="dk-d-empty"><div class="dk-d-empty-ic">${ICON_DETAIL_EMPTY}</div><p>從中間清單選一張名片<br>右側看完整資訊</p></div>`;
  const imgs = (c.images && c.images.length) ? c.images : (c.image ? [c.image] : []);
  const phs = (c.phones && c.phones.length) ? c.phones : (c.phone ? [{ label: '手機', value: c.phone }] : []);
  const row = (label, valHTML) => `<div class="dk-d-row"><span class="dk-d-l">${esc(label)}</span><span class="dk-d-v">${valHTML}</span></div>`;
  let rows = '';
  phs.forEach(p => rows += row(p.label || '電話', `<a href="tel:${esc(p.value)}">${esc(p.value)}</a>`));
  if (c.fax) rows += row('傳真', esc(c.fax));
  if (c.taxId) rows += row('統編', esc(c.taxId));
  if (c.email) rows += row('Email', `<a href="mailto:${esc(c.email)}">${esc(c.email)}</a>`);
  if (c.website) { const w = /^https?:/.test(c.website) ? c.website : 'https://' + c.website; rows += row('網站', `<a href="${esc(w)}" target="_blank" rel="noopener">${esc(c.website)}</a>`); }
  if (c.address) rows += row('地址', `<a href="${mapsHref(c.address)}" target="_blank" rel="noopener">${esc(c.address)}</a>`);
  if (c.group) rows += row('分組', esc(c.group));
  if ((c.tags || []).length) rows += row('標籤', c.tags.map(t => `<span class="c-tag">${esc(t)}</span>`).join(' '));
  return `<div class="dk-d-head">
      ${c.image ? `<img class="dk-d-ava" src="${c.image}" alt="">` : `<span class="dk-d-ava dk-d-ava-txt">${esc(initials(c.name || c.company))}</span>`}
      <div class="dk-d-htext"><div class="dk-d-name">${esc(c.name || '未命名')}${c.favorite ? ' <span class="star">★</span>' : ''}</div>
      ${c.company ? `<div class="dk-d-sub">${esc(c.company)}</div>` : ''}${c.title ? `<div class="dk-d-sub muted">${esc(c.title)}</div>` : ''}</div>
    </div>
    <div class="dk-d-imgs">${imgs.map((u, i) => `<div class="dk-ph"><img src="${u}" alt="名片"><button class="dk-ph-btn" data-photo="${i}">更換</button></div>`).join('')}<button class="dk-ph-add" data-photo="${imgs.length}">${ICON_CAM_UP}<span>${imgs.length ? '加一張' : '上傳名片照'}</span></button></div>
    <div class="dk-d-acts">
      <button class="dk-act" data-act="edit">${ICON_EDIT}<span>編輯</span></button>
      <button class="dk-act" data-act="fav">${c.favorite ? '★' : '☆'}<span>收藏</span></button>
      <button class="dk-act" data-act="share">${ICON_SHARE}<span>分享</span></button>
      <button class="dk-act" data-act="vcard">${ICON_DL}<span>vCard</span></button>
      <button class="dk-act danger" data-act="del">${ICON_TRASH}<span>刪除</span></button>
    </div>
    <div class="dk-d-rows">${rows}</div>
    ${c.note ? `<div class="dk-d-note"><div class="dk-d-l">備註</div><div>${esc(c.note)}</div></div>` : ''}
    <div class="dk-d-meta">建檔 ${fmtDate(c.created)}${c.source ? ' · 來源:' + esc(c.source) : ''}</div>`;
}
function renderDesktop(list, data) {
  list.classList.remove('as-table'); list.classList.add('as-desk');
  if (!data.find(c => c.id === detailId)) detailId = data.length ? data[0].id : null;
  const cur = contacts.find(c => c.id === detailId);
  list.innerHTML = `<div class="desk"><aside class="dk-side">${deskSideHTML()}</aside>` +
    `<div class="dk-list">${deskListHTML(data)}</div>` +
    `<div class="dk-detail">${deskDetailHTML(cur)}</div></div>`;
  // 側欄分組
  $$('#list .dk-g').forEach(b => b.onclick = () => {
    const g = b.dataset.g;
    favView = (g === '__fav');
    activeGroup = g === '__all' || g === '__fav' ? null : (g === '__none' ? '' : g.slice(2));
    render();
  });
  // 中間清單
  $$('#list .dk-card').forEach(b => b.onclick = () => { detailId = b.dataset.id; render(); });
  // 右側動作
  const dEl = $('#list .dk-detail');
  if (dEl && cur) dEl.querySelectorAll('.dk-act').forEach(btn => btn.onclick = () => {
    const a = btn.dataset.act, c = cur;
    if (a === 'edit') openEdit(c.id);
    else if (a === 'fav') { c.favorite = !c.favorite; save(); render(); }
    else if (a === 'share') shareContact(c);
    else if (a === 'vcard') download(new Blob([toVCard(c)], { type: 'text/vcard' }), `${c.name || 'card'}.vcf`);
    else if (a === 'del') { if (confirm('確定刪除這張名片?')) { addTombstone(c); contacts = contacts.filter(x => x.id !== c.id); saveTombstones(); detailId = null; save(); render(); toast('已刪除'); } }
  });
  if (dEl && cur) dEl.querySelectorAll('[data-photo]').forEach(b => b.onclick = () => pickCardPhoto(cur.id, parseInt(b.dataset.photo, 10) || 0));
}

function renderTable(list, data) {
  list.classList.add('as-table');
  const arrow = k => sortBy === k ? ' ▾' : '';
  const rows = data.map(c => `
    <tr class="trow ${selected.has(c.id) ? 'selected' : ''}" data-id="${c.id}">
      <td class="t-sel"><span class="sel-box">${CHECK_SVG}</span></td>
      <td class="t-ava">${c.image ? `<img class="tav" src="${c.image}" alt="">` : `<span class="tav tav-txt">${esc(initials(c.name))}</span>`}</td>
      <td class="t-name">${esc(c.name || '未命名')}${c.favorite ? ' <span class="star">★</span>' : ''}</td>
      <td>${esc(c.company || '')}</td>
      <td>${esc(c.title || '')}</td>
      <td class="t-mail">${c.email ? `<a href="mailto:${esc(c.email)}" onclick="event.stopPropagation()">${esc(c.email)}</a>` : ''}</td>
      <td>${c.phone ? `<a href="tel:${esc(c.phone)}" onclick="event.stopPropagation()">${esc(c.phone)}</a>` : ''}</td>
      <td>${c.group ? `<span class="c-group">${esc(c.group)}</span>` : ''}</td>
      <td class="t-date">${fmtDate(c.created)}</td>
    </tr>`).join('');
  list.innerHTML = `<table class="ctable"><thead><tr>
    <th class="t-sel"></th><th></th>
    <th class="sortable" data-sort="name">姓名${arrow('name')}</th>
    <th class="sortable" data-sort="company">公司${arrow('company')}</th>
    <th>職位</th><th>Email</th><th>電話</th><th>分組</th>
    <th class="sortable" data-sort="recent">建檔${arrow('recent')}</th>
    </tr></thead><tbody>${rows}</tbody></table>`;
  $$('#list .trow').forEach(el => el.onclick = () => {
    if (selectMode) toggleSelect(el.dataset.id); else openDetail(el.dataset.id);
  });
  $$('#list thead th.sortable').forEach(th => th.onclick = () => {
    sortBy = th.dataset.sort; const ss = $('#sortSelect'); if (ss) ss.value = sortBy; render();
  });
}

/* ---------- 合併重複名片 ---------- */
function mergeInto(a, b) {
  ['company', 'title', 'email', 'website', 'address', 'fax', 'taxId', 'group', 'note'].forEach(k => { if (!a[k] && b[k]) a[k] = b[k]; });
  if (!a.image && b.image) a.image = b.image;
  a.images = [...new Set([...(a.images || []), ...(b.images || [])])].filter(Boolean);
  a.phones = a.phones || [];
  const seen = new Set(a.phones.map(p => (p.value || '').replace(/\D/g, '')));
  (b.phones || []).forEach(p => { const d = (p.value || '').replace(/\D/g, ''); if (d && !seen.has(d)) { a.phones.push(p); seen.add(d); } });
  if (a.phones.length) a.phone = a.phones[0].value;
  a.tags = [...new Set([...(a.tags || []), ...(b.tags || [])])];
  a.favorite = a.favorite || b.favorite;
}
function mergeDuplicates() {
  const before = contacts.length;
  const seen = new Map(); const out = [];
  for (const c of contacts) {
    const k = contactKey(c);
    if (k && seen.has(k)) mergeInto(seen.get(k), c);
    else { out.push(c); if (k) seen.set(k, c); }
  }
  const removed = before - out.length;
  if (removed <= 0) { toast('沒有發現重複名片'); return; }
  if (!confirm(`找到 ${removed} 筆重複,合併保留一張(欄位會互補)?`)) return;
  contacts = out; save(); render(); toast(`已合併 ${removed} 筆重複`);
}

/* ============================================================
   分組管理
   ============================================================ */
function renameGroup(old) {
  if (!old) return;
  const nn = prompt(`將分組「${old}」改名為(留空=移除此分組):`, old);
  if (nn === null) return;
  const name = nn.trim();
  let n = 0;
  contacts.forEach(c => { if (c.group === old) { c.group = name; n++; } });
  activeGroup = name || null;
  save(); render();
  toast(name ? `已將 ${n} 張改到「${name}」` : `已移除分組(${n} 張改為未分組)`);
}
function openGroupModal() {
  if (!selected.size) { toast('尚未選取'); return; }
  groupTarget = null;
  const wrap = $('#groupOptions');
  wrap.innerHTML = `<button class="grp-chip" data-g="__none">未分組</button>` +
    allGroups().map(g => `<button class="grp-chip" data-g="${esc(g)}">${esc(g)}</button>`).join('');
  $$('#groupOptions .grp-chip').forEach(b => b.onclick = () => {
    $$('#groupOptions .grp-chip').forEach(x => x.classList.remove('on'));
    b.classList.add('on'); groupTarget = b.dataset.g; $('#newGroupInput').value = '';
  });
  $('#newGroupInput').value = '';
  openModal('#groupModal');
}
function applyGroupMove() {
  const typed = $('#newGroupInput').value.trim();
  if (typed) groupTarget = typed;
  if (groupTarget === null) { toast('請選擇或輸入分組'); return; }
  const val = groupTarget === '__none' ? '' : groupTarget;
  let n = 0;
  contacts.forEach(c => { if (selected.has(c.id)) { c.group = val; n++; } });
  save(); render(); closeModal('#groupModal'); exitSelect();
  toast(`已將 ${n} 張移動到${val ? '「' + val + '」' : '未分組'}`);
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
    contacts.forEach(c => { if (selected.has(c.id)) addTombstone(c); });
    contacts = contacts.filter(c => !selected.has(c.id));
    saveTombstones(); save(); exitSelect(); toast('已刪除');
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
  $('#f_taxId').value = c.taxId || '';
  $('#f_fax').value = c.fax || '';
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
    fax: $('#f_fax').value.trim(),
    taxId: $('#f_taxId').value.trim(),
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
  if (c.fax) rows.push(`<div class="dc-row"><span class="dc-label">傳真</span><span class="dc-val">${esc(c.fax)}</span></div>`);
  if (c.taxId) rows.push(`<div class="dc-row"><span class="dc-label">統編</span><span class="dc-val">${esc(c.taxId)}</span></div>`);
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
    `<span class="link-btn" id="dcBack">${imgs.length > 1 ? '重拍背面' : '加拍背面'}</span>` +
    `<span class="link-btn" id="dcUpload">上傳照片</span></div>` +
    `<div class="dc-rows">${rows.join('')}</div>` + noteBlock;

  $('#favToggle').onclick = () => { c.favorite = !c.favorite; save(); render(); openDetail(id); };
  $('#dcEdit').onclick = () => { closeModal('#detailModal'); openEdit(id); };
  $('#dcShare').onclick = () => shareContact(c);
  $('#dcUpload').onclick = () => pickCardPhoto(id, (c.images && c.images.length) ? c.images.length : 0);
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

let photoTargetId = null, photoTargetSlot = 0;
function pickCardPhoto(id, slot) { photoTargetId = id; photoTargetSlot = slot || 0; const inp = $('#cardPhotoInput'); if (inp) { inp.value = ''; inp.click(); } }
async function storeCardPhoto(file) {
  if (!file || !photoTargetId) return;
  const c = contacts.find(x => x.id === photoTargetId); if (!c) return;
  try {
    const url = URL.createObjectURL(file);
    const img = await loadImage(url);
    const data = compressImage(img, 1100, 0.74);
    URL.revokeObjectURL(url);
    if (!data) { toast('圖片讀取失敗'); return; }
    c.images = Array.isArray(c.images) ? c.images : (c.image ? [c.image] : []);
    c.images[photoTargetSlot] = data;
    c.image = c.images[0] || data;
    c.updated = Date.now();
    save(); render();
    const dm = $('#detailModal');
    if (dm && !dm.classList.contains('hidden') && detailId === c.id) openDetail(c.id);
    toast('名片照片已更新');
  } catch (e) { toast('上傳失敗:' + e.message); }
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
const GOOGLE_SCOPE = 'https://www.googleapis.com/auth/drive.appdata https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile';
let driveToken = '';
let driveUser = null;   // 登入的 Google 帳號(name/email/picture)
let driveTokenClient = null;
let drivePushT = null;
let driveFolderId = '';   // Drive 可見資料夾「CardSnap 名片」id
let syncing = false;     // 防重入:同步進行中
let syncSignal = null;   // 逾時中止用
let cloudToken = '';
let cloudUser = null;
let cloudTokenClient = null;
let cloudPushT = null;
function storageMode() { return (typeof settings !== 'undefined' && settings && settings.storageMode) || 'cloud'; }

function googleClientId() {
  return (window.CARDSNAP_CONFIG && window.CARDSNAP_CONFIG.googleClientId) || '';
}

/* ---------- navbar:時鐘 / 登入者 / 登出 ---------- */
function updateClock() {
  const el = $('#navClock'); if (!el) return;
  const d = new Date(), days = ['日', '一', '二', '三', '四', '五', '六'];
  const p = n => String(n).padStart(2, '0');
  el.textContent = `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} (週${days[d.getDay()]}) ${p(d.getHours())}:${p(d.getMinutes())}`;
}
async function fetchDriveUser() {
  try {
    const r = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { Authorization: 'Bearer ' + driveToken } });
    if (r.ok) { driveUser = await r.json(); renderNavUser(); }
  } catch (e) {}
}
function renderNavUser() {
  const el = $('#navUser'); if (!el) return;
  const drive = storageMode() === 'drive';
  const u = drive ? (driveToken && driveUser) : (cloudToken && cloudUser);
  if (u) {
    const name = u.name || u.email || '使用者';
    const ava = u.picture
      ? `<img class="nu-ava" src="${esc(u.picture)}" alt="" referrerpolicy="no-referrer">`
      : `<span class="nu-ava nu-ava-txt">${esc((name[0] || '?').toUpperCase())}</span>`;
    el.innerHTML = `${ava}<span class="nu-name" title="${esc(u.email || '')}">${esc(name)}</span>` +
      `<button class="nu-logout" id="navLogout" title="登出">登出</button>`;
    const lo = $('#navLogout'); if (lo) lo.onclick = logout;
  } else {
    el.innerHTML = `<button class="nu-login" id="navLogin">登入</button>`;
    const li = $('#navLogin'); if (li) li.onclick = signIn;
  }
}
function logout() {
  try { if (driveToken && typeof google !== 'undefined' && google.accounts && google.accounts.oauth2) google.accounts.oauth2.revoke(driveToken, () => {}); } catch (e) {}
  driveToken = ''; driveUser = null; cloudToken = ''; cloudUser = null;
  contacts = []; tombstones = [];
  try { localStorage.removeItem('cardsnap.authed'); localStorage.setItem(STORE_KEY, '[]'); localStorage.removeItem(TOMB_KEY); localStorage.removeItem('cardsnap.owner'); } catch (e) {}
  setSyncState('idle'); render(); renderNavUser(); toast('已登出'); showLogin();
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
      if (resp && resp.access_token) { driveToken = resp.access_token; try { localStorage.setItem('cardsnap.authed', '1'); } catch (e) {} closeLogin(); fetchDriveUser(); doSync(); }
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

/* ---------- 雲端模式:存「我的系統」(擁有者 Drive,經 /api/sync) ---------- */
function initCloud() {
  if (!googleClientId()) return;
  if (typeof google === 'undefined' || !google.accounts || !google.accounts.oauth2) { setTimeout(initCloud, 600); return; }
  cloudTokenClient = google.accounts.oauth2.initTokenClient({
    client_id: googleClientId(),
    scope: 'https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile',
    callback: async (resp) => {
      if (resp && resp.access_token) {
        cloudToken = resp.access_token;
        try { localStorage.setItem('cardsnap.authed', '1'); } catch (e) {}
        closeLogin();
        await fetchCloudUser();
        const email = (cloudUser && cloudUser.email) ? String(cloudUser.email).toLowerCase() : '';
        let prevOwner = null; try { prevOwner = localStorage.getItem('cardsnap.owner'); } catch (e) {}
        if (email && prevOwner && prevOwner !== email) {
          contacts = []; tombstones = [];
          try { localStorage.setItem(STORE_KEY, '[]'); localStorage.removeItem(TOMB_KEY); } catch (e) {}
          render();
        }
        if (email) { try { localStorage.setItem('cardsnap.owner', email); } catch (e) {} }
        cloudSync();
      } else { setSyncState('idle'); toast('登入未完成'); }
    },
  });
}
function cloudSignIn() {
  if (!googleClientId()) { toast('登入尚未設定'); return; }
  if (!cloudTokenClient) { initCloud(); toast('初始化中,請再按一次'); return; }
  if (cloudToken) cloudSync(); else cloudTokenClient.requestAccessToken();
}
async function fetchCloudUser() {
  try {
    const r = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { Authorization: 'Bearer ' + cloudToken } });
    if (r.ok) { cloudUser = await r.json(); renderNavUser(); }
  } catch (e) {}
}
async function cloudSync() {
  if (!cloudToken || syncing) return;
  syncing = true; setSyncState('syncing');
  const killer = setTimeout(() => { syncing = false; setSyncState('idle'); }, 25000);
  try {
    const r = await fetch('/api/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: cloudToken, contacts, tombstones }) });
    const j = await r.json().catch(() => ({}));
    if (r.status === 501) { toast('雲端後端尚未啟用(管理員需設定密鑰)'); setSyncState('idle'); return; }
    if (!r.ok || j.error) throw new Error(j.error || ('HTTP ' + r.status));
    if (Array.isArray(j.tombstones)) { tombstones = j.tombstones; saveTombstones(); }
    if (Array.isArray(j.contacts)) { contacts = dropJunk(j.contacts.map(migrate)); try { localStorage.setItem(STORE_KEY, JSON.stringify(contacts)); } catch (e) {} render(); }
    setSyncState('synced'); markSynced();
    try { if (cloudUser && cloudUser.email) localStorage.setItem('cardsnap.owner', String(cloudUser.email).toLowerCase()); } catch (e) {}
  } catch (e) { setSyncState('idle'); toast('雲端同步失敗:' + e.message); }
  finally { clearTimeout(killer); syncing = false; }
}
function signIn() { if (storageMode() === 'drive') signInAndSync(); else cloudSignIn(); }

async function driveApi(url, opts) {
  const r = await fetch(url, Object.assign({ headers: { Authorization: 'Bearer ' + driveToken }, signal: syncSignal }, opts || {}));
  if (r.status === 401) { driveToken = ''; throw new Error('授權過期,請再按一次同步'); }
  if (!r.ok) throw new Error('Drive 錯誤 ' + r.status);
  return r;
}

const DRIVE_FOLDER_NAME = 'CardSnap 名片';
async function ensureDriveFolder() {
  if (driveFolderId) return driveFolderId;
  const q = encodeURIComponent(`mimeType='application/vnd.google-apps.folder' and name='${DRIVE_FOLDER_NAME}' and trashed=false`);
  const lr = await driveApi(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)`);
  const lj = await lr.json();
  if (lj.files && lj.files[0]) { driveFolderId = lj.files[0].id; return driveFolderId; }
  const meta = { name: DRIVE_FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' };
  const cr = await driveApi('https://www.googleapis.com/drive/v3/files?fields=id',
    { method: 'POST', headers: { Authorization: 'Bearer ' + driveToken, 'Content-Type': 'application/json' }, body: JSON.stringify(meta) });
  const cj = await cr.json(); driveFolderId = cj.id; return driveFolderId;
}
async function driveUploadImage(dataUrl, name, folderId) {
  const blob = await (await fetch(dataUrl)).blob();
  const meta = { name, parents: [folderId] };
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(meta)], { type: 'application/json' }));
  form.append('file', blob);
  const r = await driveApi('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', { method: 'POST', body: form });
  const j = await r.json(); return j.id;
}
// 把尚未上傳的名片照片放進 Drive 可見資料夾(盡力而為,失敗不影響資料同步)
async function pushPhotosToDrive() {
  if (settings.drivePhotos === false) return;
  try {
    const folder = await ensureDriveFolder();
    let n = 0;
    for (const c of contacts) {
      const img = (c.images && c.images[0]) || c.image;
      if (img && !c.drivePhoto) {
        try { c.drivePhoto = await driveUploadImage(img, (c.name || 'card') + '-' + c.id + '.jpg', folder); n++; }
        catch (e) { /* 略過這張 */ }
        if (n >= 20) break;   // 單次上限,避免太久
      }
    }
  } catch (e) { /* 資料夾/scope 失敗 → 略過 */ }
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
    contacts = dropJunk(syncMerge(contacts, remote)); try { localStorage.setItem(STORE_KEY, JSON.stringify(contacts)); } catch (e) {} render();
    await pushPhotosToDrive();   // 上傳照片到可見資料夾,id 寫回 contacts 一併存
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
  if (storageMode() === 'drive') { if (!driveToken) return; clearTimeout(drivePushT); drivePushT = setTimeout(doSync, 2500); }
  else { if (!cloudToken) return; clearTimeout(cloudPushT); cloudPushT = setTimeout(cloudSync, 2500); }
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
function pinHash(p) { let h = 5381; const str = String(p || ''); for (let i = 0; i < str.length; i++) { h = ((h << 5) + h) + str.charCodeAt(i); h |= 0; } return 'h' + (h >>> 0).toString(36); }
function applyFontSize() { document.body.classList.remove('fs-sm', 'fs-md', 'fs-lg'); document.body.classList.add('fs-' + (settings.fontSize || 'md')); }
function humanSize(n) { return n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : (n / 1024).toFixed(0) + ' KB'; }
function storageBytes() {
  let n = 0;
  try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.indexOf('cardsnap') === 0) n += (localStorage.getItem(k) || '').length + k.length; } } catch (e) {}
  return n * 2; // UTF-16
}
function updateStorage() { const el = $('#storageUsage'); if (el) el.textContent = humanSize(storageBytes()); }

/* 應用加鎖 */
function showLock() { const ov = $('#lockScreen'); if (!ov) return; ov.classList.remove('hidden'); const i = $('#lockInput'); if (i) { i.value = ''; setTimeout(() => i.focus(), 120); } $('#lockErr').classList.add('hidden'); }
function tryUnlock() {
  const v = $('#lockInput').value;
  if (pinHash(v) === settings.pinHash) { $('#lockScreen').classList.add('hidden'); }
  else { $('#lockErr').classList.remove('hidden'); $('#lockInput').value = ''; $('#lockInput').focus(); }
}

async function testEndpoint() {
  const url = ($('#set_endpoint').value || '').trim();
  if (!url) { toast('請先填入伺服器網址'); return; }
  const base = url.replace(/\/ocr\/?$/, '/');
  toast('測試連線中…');
  try {
    const ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    const k = setTimeout(() => { if (ctrl) ctrl.abort(); }, 12000);
    const r = await fetch(base, { signal: ctrl ? ctrl.signal : undefined });
    clearTimeout(k);
    const j = await r.json().catch(() => ({}));
    if (j && j.ok) toast('連線成功 · 模型 ' + (j.model || '?'));
    else if (r.ok) toast('已連線(但回應格式非預期)');
    else toast('連線回應 ' + r.status);
  } catch (e) { toast('連線失敗:' + (e && e.name === 'AbortError' ? '逾時' : (e && e.message ? e.message : e))); }
}

function openSettings() {
  $('#set_sort').value = settings.sortBy;
  $('#set_listmain').value = settings.listMain;
  $('#set_ocr').value = settings.ocrLang;
  $('#set_font').value = settings.fontSize || 'md';
  $('#set_lock').checked = !!settings.pinHash;
  $('#set_cloud').checked = settings.cloudOcr !== false;
  $('#set_endpoint').value = settings.ocrEndpoint || 'https://ocr.name-car-box.com'; $('#set_endpoint').readOnly = true;
  $('#set_drivephotos').checked = settings.drivePhotos !== false;
  $('#set_force').checked = !!settings.forceEndpoint;
  if ($('#set_storage')) $('#set_storage').value = settings.storageMode || 'cloud';
  updateStorage();
  openModal('#settingsModal');
}
function applySettings() {
  settings.sortBy = $('#set_sort').value;
  settings.listMain = $('#set_listmain').value;
  settings.ocrLang = $('#set_ocr').value;
  settings.fontSize = $('#set_font').value;
  settings.cloudOcr = $('#set_cloud').checked;
  settings.ocrEndpoint = 'https://ocr.name-car-box.com';   // 系統鎖定,不開放修改
  settings.drivePhotos = $('#set_drivephotos').checked;
  settings.forceEndpoint = $('#set_force').checked;
  if ($('#set_storage')) settings.storageMode = $('#set_storage').value;
  renderNavUser();
  cloudOcrDown = false;
  saveSettings();
  applyFontSize();
  sortBy = settings.sortBy;
  const ss = $('#sortSelect'); if (ss) ss.value = sortBy;
  render();
  closeModal('#settingsModal');
  toast('設定已儲存');
}

function showLogin() { const o = $('#loginScreen'); if (o) o.classList.remove('hidden'); }
function closeLogin() { try { localStorage.setItem('cardsnap.loginSeen', '1'); } catch (e) {} const o = $('#loginScreen'); if (o) o.classList.add('hidden'); }

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
      const _c = contacts.find(x => x.id === editingId); if (_c) addTombstone(_c);
      contacts = contacts.filter(c => c.id !== editingId);
      saveTombstones(); save(); render(); closeModal('#editModal'); editingId = null; toast('已刪除');
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
  if ($('#endpointTest')) $('#endpointTest').onclick = testEndpoint;
  $('#set_lock').onchange = e => {
    if (e.target.checked) {
      const p = prompt('設定 4-6 位數解鎖密碼:');
      if (!p || !/^\d{4,6}$/.test(p)) { e.target.checked = false; toast('請輸入 4-6 位數字'); return; }
      if (prompt('再次輸入確認:') !== p) { e.target.checked = false; toast('兩次輸入不一致'); return; }
      settings.pinHash = pinHash(p); saveSettings(); toast('已啟用應用加鎖');
    } else {
      const p = prompt('輸入目前密碼以關閉加鎖:');
      if (pinHash(p || '') !== settings.pinHash) { e.target.checked = true; toast('密碼錯誤'); return; }
      settings.pinHash = ''; saveSettings(); toast('已關閉應用加鎖');
    }
  };
  $('#clearPhotos').onclick = () => {
    if (!confirm('清除所有名片照片?文字資料會保留。')) return;
    contacts.forEach(c => { c.image = ''; c.images = []; });
    save(); render(); updateStorage(); toast('已清除所有照片');
  };
  $('#wipeAll').onclick = () => {
    if (!confirm('確定清空全部名片資料?此動作無法復原。')) return;
    if (!confirm('再次確認:真的要刪除全部名片?')) return;
    contacts.forEach(addTombstone); contacts = []; saveTombstones(); save(); render(); updateStorage(); toast('已清空全部資料');
  };
  // 登入畫面(UI)
  if ($('#loginContinue')) {
    $('#loginContinue').onclick = () => { toast('請用下方「使用 Google 繼續」登入'); };
    $('#loginGoogle').onclick = () => { if (typeof signIn === 'function') signIn(); };
    $('#loginMs').onclick = () => toast('Microsoft 登入即將推出,請改用 Google');
    $('#loginSso').onclick = () => toast('SSO 登入即將推出,請改用 Google');
    $('#loginForgot').onclick = () => toast('密碼重設即將推出');
    $('#loginSignup').onclick = () => toast('用 Google 登入即可開始使用');
    const _sk = $('#loginSkip'); if (_sk) _sk.style.display = 'none';
  }
  $('#lockBtn').onclick = tryUnlock;
  $('#lockInput').addEventListener('keydown', e => { if (e.key === 'Enter') tryUnlock(); });

  // 匯出 / 匯入 / 手動 / 排序
  $('#btnExport').onclick = () => { exportScope = null; $('#expCount').textContent = contacts.length; openModal('#exportModal'); };
  $$('.export-opt').forEach(b => b.onclick = () => exportData(b.dataset.fmt));
  $('#btnImport').onclick = () => $('#importInput').click();
  $('#importInput').onchange = e => { if (e.target.files[0]) importFromFile(e.target.files[0]); };
  if ($('#cardPhotoInput')) $('#cardPhotoInput').onchange = e => { if (e.target.files[0]) storeCardPhoto(e.target.files[0]); };
  $('#manualAdd').onclick = () => { closeModal('#captureModal'); openManual(); };
  $('#sortSelect').onchange = e => { sortBy = e.target.value; render(); };
  $('#groupSelect').onchange = e => { const v = e.target.value; activeGroup = v === '__all' ? null : (v === '__none' ? '' : v.slice(2)); render(); };
  $('#btnGroupEdit').onclick = () => renameGroup(activeGroup);
  $('#selGroup').onclick = openGroupModal;
  $('#groupApply').onclick = applyGroupMove;

  // 多選批次
  $('#btnSelect').onclick = () => selectMode ? exitSelect() : enterSelect();
  if ($('#btnDedup')) $('#btnDedup').onclick = mergeDuplicates;
  $('#selAll').onclick = selectAll;
  $('#selTag').onclick = batchTag;
  $('#selExport').onclick = batchExport;
  $('#selDelete').onclick = batchDelete;
  $('#selDone').onclick = exitSelect;

  // 雲端同步
  $('#btnSync').onclick = signIn;

  // Esc 關閉
  document.addEventListener('keydown', e => { if (e.key === 'Escape') $$('.modal:not(.hidden)').forEach(m => closeModal('#' + m.id)); });
}

/* ---------- service worker ---------- */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}

let _rzT, _wasDesk = window.matchMedia('(min-width: 980px)').matches;
window.addEventListener('resize', () => {
  clearTimeout(_rzT);
  _rzT = setTimeout(() => { const d = window.matchMedia('(min-width: 980px)').matches; if (d !== _wasDesk) { _wasDesk = d; render(); } }, 150);
});

/* ---------- init ---------- */
sortBy = settings.sortBy || 'recent';
applyFontSize();
bind();
{ const ss = $('#sortSelect'); if (ss) ss.value = sortBy; }
render();
if (!localStorage.getItem('cardsnap.authed') && (typeof googleClientId !== 'function' || googleClientId())) showLogin();
if (settings.pinHash) showLock();
initDrive();
initCloud();
initSyncStatus();
updateClock(); setInterval(updateClock, 30000);
renderNavUser();
