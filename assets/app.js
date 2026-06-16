/* ============================================================
   CardSnap — 名片整理 PWA
   端上 OCR (Tesseract.js) · 欄位解析 · 名單管理 · 匯出 / 分享
   資料儲存於瀏覽器 localStorage (隱私優先,不上傳)
   ============================================================ */
'use strict';

const STORE_KEY = 'cardsnap.contacts.v1';
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

/* ---------- state ---------- */
let contacts = load();
let activeTag = null;
let query = '';
let editingId = null;     // null = new
let lastOcrRaw = '';
let detailId = null;

function load() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)) || []; }
  catch { return []; }
}
function save() { localStorage.setItem(STORE_KEY, JSON.stringify(contacts)); }

/* ============================================================
   OCR 欄位解析 —— 從原始文字推斷名片欄位
   ============================================================ */
function parseCard(raw) {
  const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
  const flat = lines.join(' ');
  const out = { name:'', company:'', title:'', phone:'', email:'', website:'', address:'' };

  // email
  const em = flat.match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
  if (em) out.email = em[0].replace(/[，。、]$/, '');

  // website (避免抓到 email 的網域)
  const web = flat.match(/(?:https?:\/\/)?(?:www\.)[\w-]+\.[\w.\/-]+/i)
            || flat.match(/\b[\w-]+\.(?:com|net|org|io|co|tw|cn)(?:\.[a-z]{2})?\b/i);
  if (web && (!em || !em[0].includes(web[0]))) out.website = web[0];

  // phone (台灣/國際常見格式)
  const phones = flat.match(/(?:\+?\d[\d\s().-]{6,}\d)/g) || [];
  const phone = phones.map(p => p.trim()).find(p => p.replace(/\D/g,'').length >= 8);
  if (phone) out.phone = phone;

  // title 職稱關鍵字
  const titleKw = /(經理|總監|協理|執行長|董事|總經理|主任|工程師|設計師|顧問|專員|業務|處長|課長|副理|襄理|創辦|負責人|CEO|CTO|CFO|COO|Manager|Director|Engineer|Designer|Founder|President|Sales|Consultant|Lead|Head)/i;
  // company 關鍵字
  const compKw = /(股份有限公司|有限公司|企業|科技|工作室|事務所|集團|實業|國際|Inc\.?|Ltd\.?|LLC|Corp\.?|Company|Co\.,?|Technolog|Studio|Group)/i;

  for (const l of lines) {
    if (!out.title && titleKw.test(l) && l.length < 25) out.title = l;
    if (!out.company && compKw.test(l)) out.company = l;
  }

  // 地址
  const addr = lines.find(l => /(市|縣|區|路|街|樓|號|Rd\.?|St\.?|Ave\.?|Floor|No\.)/.test(l) && l.length > 6);
  if (addr) out.address = addr;

  // 姓名:取最前面、無數字/@、較短、且非公司/職稱的那行
  const nameCand = lines.find(l =>
    l.length >= 2 && l.length <= 18 &&
    !/[\d@]/.test(l) && !compKw.test(l) && !titleKw.test(l) &&
    l !== out.address);
  if (nameCand) out.name = nameCand;

  return out;
}

/* ============================================================
   OCR 流程
   ============================================================ */
async function runOCR(file) {
  const url = URL.createObjectURL(file);
  $('#preview').src = url;
  $('#preview').classList.remove('hidden');
  $('#dropzone').classList.add('hidden');
  $('#ocrStatus').classList.remove('hidden');

  try {
    if (typeof Tesseract === 'undefined') throw new Error('OCR 引擎尚未載入,請檢查網路');
    const { data } = await Tesseract.recognize(url, 'chi_tra+eng', {
      logger: m => {
        if (m.status === 'recognizing text')
          $('#ocrText').textContent = `辨識中… ${Math.round(m.progress * 100)}%`;
        else
          $('#ocrText').textContent = m.status === 'loading language traineddata'
            ? '載入語言模型…' : '處理中…';
      }
    });
    lastOcrRaw = (data.text || '').trim();
    const fields = parseCard(lastOcrRaw);
    closeModal('#captureModal');
    openEdit(null, fields, lastOcrRaw);
    if (!lastOcrRaw) toast('沒辨識到文字,請手動填寫');
  } catch (e) {
    toast('辨識失敗:' + e.message);
    resetCapture();
  } finally {
    URL.revokeObjectURL(url);
  }
}

function resetCapture() {
  $('#dropzone').classList.remove('hidden');
  $('#preview').classList.add('hidden');
  $('#ocrStatus').classList.add('hidden');
  $('#fileInput').value = '';
}

/* ============================================================
   名單渲染
   ============================================================ */
function allTags() {
  const s = new Set();
  contacts.forEach(c => (c.tags || []).forEach(t => s.add(t)));
  return [...s].sort();
}

function filtered() {
  const q = query.trim().toLowerCase();
  return contacts.filter(c => {
    if (activeTag && !(c.tags || []).includes(activeTag)) return false;
    if (!q) return true;
    return [c.name, c.company, c.title, c.phone, c.email, c.note, ...(c.tags||[])]
      .filter(Boolean).join(' ').toLowerCase().includes(q);
  }).sort((a,b) => (b.favorite?1:0)-(a.favorite?1:0) || (b.created||0)-(a.created||0));
}

function initials(name) {
  if (!name) return '？';
  return /[A-Za-z]/.test(name[0]) ? name.slice(0,2).toUpperCase() : name.slice(0,1);
}

function render() {
  const data = filtered();
  $('#countLabel').textContent = `共 ${contacts.length} 張名片` + (activeTag ? ` · #${activeTag}` : '');
  $('#empty').classList.toggle('hidden', contacts.length !== 0);

  // tag chips
  const tags = allTags();
  $('#tagChips').innerHTML = tags.map(t =>
    `<span class="chip ${t===activeTag?'active':''}" data-tag="${esc(t)}">#${esc(t)}</span>`).join('');
  $$('#tagChips .chip').forEach(ch => ch.onclick = () => {
    activeTag = ch.dataset.tag === activeTag ? null : ch.dataset.tag; render();
  });

  // list
  const list = $('#list');
  list.innerHTML = data.map(c => `
    <div class="contact" data-id="${c.id}">
      <div class="avatar">${esc(initials(c.name))}</div>
      <div class="c-main">
        <div class="c-name">${esc(c.name || '未命名')} ${c.favorite?'<span class="star">★</span>':''}</div>
        <div class="c-sub">${esc([c.title, c.company].filter(Boolean).join(' · ') || c.phone || c.email || '—')}</div>
        ${(c.tags||[]).length ? `<div class="c-tags">${c.tags.map(t=>`<span class="c-tag">${esc(t)}</span>`).join('')}</div>`:''}
      </div>
      <div class="c-quick">
        ${c.phone?`<a href="tel:${esc(c.phone)}" title="撥打" onclick="event.stopPropagation()">📞</a>`:''}
        ${c.email?`<a href="mailto:${esc(c.email)}" title="寄信" onclick="event.stopPropagation()">✉️</a>`:''}
      </div>
    </div>`).join('');
  $$('#list .contact').forEach(el => el.onclick = () => openDetail(el.dataset.id));
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
    tags: $('#f_tags').value.split(',').map(t=>t.trim()).filter(Boolean),
    note: $('#f_note').value.trim(),
  };
  if (!data.name && !data.company && !data.phone && !data.email) {
    toast('至少填入姓名、公司、電話或 email 其中之一'); return;
  }
  if (editingId) {
    const c = contacts.find(x => x.id === editingId);
    Object.assign(c, data);
  } else {
    contacts.unshift({ id: uid(), created: Date.now(), favorite:false, raw:lastOcrRaw, ...data });
  }
  save(); render(); closeModal('#editModal'); resetCapture();
  toast(editingId ? '已更新' : '已建檔 ✓');
  editingId = null; lastOcrRaw = '';
}

/* ============================================================
   詳情 / 分享
   ============================================================ */
function openDetail(id) {
  detailId = id;
  const c = contacts.find(x => x.id === id);
  if (!c) return;
  $('#d_name').textContent = c.name || '名片';
  const row = (label, val, href) => val ? `
    <div class="detail-row"><span class="dl">${label}</span>
    <span class="dv">${href?`<a href="${esc(href)}">${esc(val)}</a>`:esc(val)}</span></div>` : '';
  $('#detailBody').innerHTML =
    `<div class="detail-row"><span class="dl">標記</span><span class="dv">
       <span class="link-btn" id="favToggle" style="cursor:pointer">${c.favorite?'★ 已收藏':'☆ 收藏'}</span></span></div>` +
    row('公司', c.company) + row('職稱', c.title) +
    row('電話', c.phone, c.phone?`tel:${c.phone}`:'') +
    row('Email', c.email, c.email?`mailto:${c.email}`:'') +
    row('網站', c.website, c.website?(/^https?:/.test(c.website)?c.website:'https://'+c.website):'') +
    row('地址', c.address) +
    ((c.tags||[]).length?`<div class="detail-row"><span class="dl">標籤</span><span class="dv">${c.tags.map(t=>`<span class="c-tag">${esc(t)}</span>`).join(' ')}</span></div>`:'') +
    row('備註', c.note);
  $('#favToggle').onclick = () => { c.favorite = !c.favorite; save(); render(); openDetail(id); };

  // QR (vCard)
  try {
    if (typeof QRCode !== 'undefined') {
      QRCode.toCanvas($('#qrCanvas'), toVCard(c), { width:180, margin:1 }, ()=>{});
      $('#qrWrap').classList.remove('hidden');
    }
  } catch { $('#qrWrap').classList.add('hidden'); }
  openModal('#detailModal');
}

/* ============================================================
   匯出格式
   ============================================================ */
function toVCard(c) {
  const L = ['BEGIN:VCARD','VERSION:3.0'];
  L.push(`FN:${c.name||''}`);
  if (c.name) L.push(`N:${c.name};;;;`);
  if (c.company) L.push(`ORG:${c.company}`);
  if (c.title) L.push(`TITLE:${c.title}`);
  if (c.phone) L.push(`TEL;TYPE=CELL:${c.phone}`);
  if (c.email) L.push(`EMAIL:${c.email}`);
  if (c.website) L.push(`URL:${c.website}`);
  if (c.address) L.push(`ADR;TYPE=WORK:;;${c.address};;;;`);
  if (c.note) L.push(`NOTE:${c.note.replace(/\n/g,'\\n')}`);
  L.push('END:VCARD');
  return L.join('\n');
}

function exportData(fmt) {
  if (!contacts.length) { toast('還沒有名片可匯出'); return; }
  let blob, fn;
  if (fmt === 'vcf') {
    blob = new Blob([contacts.map(toVCard).join('\n')], {type:'text/vcard'});
    fn = 'cardsnap.vcf';
  } else if (fmt === 'json') {
    blob = new Blob([JSON.stringify(contacts, null, 2)], {type:'application/json'});
    fn = 'cardsnap-backup.json';
  } else {
    const cols = ['name','company','title','phone','email','website','address','tags','note'];
    const head = ['姓名','公司','職稱','電話','Email','網站','地址','標籤','備註'];
    const rows = contacts.map(c => cols.map(k => {
      let v = k==='tags' ? (c.tags||[]).join(';') : (c[k]||'');
      v = String(v).replace(/"/g,'""');
      return /[",\n]/.test(v) ? `"${v}"` : v;
    }).join(','));
    blob = new Blob(['﻿' + [head.join(','), ...rows].join('\n')], {type:'text/csv'});
    fn = 'cardsnap.csv';
  }
  download(blob, fn);
  closeModal('#exportModal');
  toast(`已匯出 ${contacts.length} 張 (${fmt.toUpperCase()})`);
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
   UI helpers
   ============================================================ */
function esc(s){ return String(s??'').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }
function openModal(sel){ $(sel).classList.remove('hidden'); }
function closeModal(sel){ $(sel).classList.add('hidden'); }
let toastT;
function toast(msg){ const t=$('#toast'); t.textContent=msg; t.classList.remove('hidden');
  clearTimeout(toastT); toastT=setTimeout(()=>t.classList.add('hidden'),2200); }

/* ============================================================
   事件綁定
   ============================================================ */
function bind() {
  $('#fab').onclick = () => { resetCapture(); openModal('#captureModal'); };
  $('#dropzone').onclick = () => $('#fileInput').click();
  $('#fileInput').onchange = e => { if (e.target.files[0]) runOCR(e.target.files[0]); };

  // drag & drop (桌機)
  const dz = $('#dropzone');
  ['dragover','dragenter'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add('drag'); }));
  ['dragleave','drop'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.remove('drag'); }));
  dz.addEventListener('drop', e => { const f = e.dataTransfer.files[0]; if (f) runOCR(f); });

  // 關閉鈕 / 點背景關閉
  $$('[data-close]').forEach(b => b.onclick = () => closeModal('#'+b.closest('.modal').id));
  $$('.modal').forEach(m => m.addEventListener('click', e => { if (e.target === m) closeModal('#'+m.id); }));

  // 搜尋
  $('#btnSearch').onclick = () => { $('#searchBar').classList.toggle('hidden'); if(!$('#searchBar').classList.contains('hidden')) $('#searchInput').focus(); };
  $('#searchInput').oninput = e => { query = e.target.value; render(); };
  $('#searchClear').onclick = () => { query=''; $('#searchInput').value=''; render(); };

  // 編輯
  $('#btnSave').onclick = saveEdit;
  $('#btnDelete').onclick = () => {
    if (editingId && confirm('確定刪除這張名片?')) {
      contacts = contacts.filter(c => c.id !== editingId);
      save(); render(); closeModal('#editModal'); editingId=null; toast('已刪除');
    }
  };

  // 詳情動作
  $('#btnEdit').onclick = () => { closeModal('#detailModal'); openEdit(detailId); };
  $('#btnShare').onclick = () => shareContact(contacts.find(c=>c.id===detailId));
  $('#btnVcard').onclick = () => { const c=contacts.find(x=>x.id===detailId); download(new Blob([toVCard(c)],{type:'text/vcard'}), `${c.name||'card'}.vcf`); };

  // 匯出
  $('#btnExport').onclick = () => { $('#expCount').textContent = contacts.length; openModal('#exportModal'); };
  $$('.export-opt').forEach(b => b.onclick = () => exportData(b.dataset.fmt));

  // Esc 關閉
  document.addEventListener('keydown', e => { if (e.key==='Escape') $$('.modal:not(.hidden)').forEach(m=>closeModal('#'+m.id)); });
}

/* ---------- service worker ---------- */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(()=>{}));
}

/* ---------- init ---------- */
bind();
render();
