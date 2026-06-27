/* ============================================================
   CardSnap Core — 純邏輯(無 DOM,可在瀏覽器與 Node 測試)
   parseCard  : OCR 文字 → 名片欄位
   toVCard    : 名片 → vCard 3.0
   toCSV      : 名單 → CSV(含 BOM、跳脫)
   parseCSV   : CSV → 名片陣列(匯入)
   parseVCards: vCard 文字 → 名片陣列(匯入)
   mergeContacts: 既有 + 匯入 → 去重合併
   ============================================================ */
(function (global) {
  'use strict';

  function parseCard(raw) {
    const lines = String(raw || '').split('\n').map(l => l.trim()).filter(Boolean);
    const flat = lines.join(' ');
    const out = { name: '', company: '', title: '', phone: '', phones: [], fax: '', taxId: '', email: '', website: '', address: '' };

    const em = flat.match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
    if (em) out.email = em[0].replace(/[，。、]$/, '');

    const web = flat.match(/(?:https?:\/\/)?(?:www\.)[\w-]+\.[\w.\/-]+/i)
              || flat.match(/\b[\w-]+\.(?:com|net|org|io|co|tw|cn)(?:\.[a-z]{2})?\b/i);
    if (web && (!em || !em[0].includes(web[0]))) out.website = web[0];

    // 統一編號(台灣 8 碼)— 先抓出來,避免被當成電話
    const taxM = flat.match(/(?:統一編號|統一編|統編|GUI|VAT)\D{0,5}(\d{8})/i);
    out.taxId = taxM ? taxM[1] : '';

    // 電話 / 傳真:逐行判斷標籤,自動分類手機 / 市話 / 傳真
    const classify = (num) => {
      const d = num.replace(/\D/g, '');
      if (/^09\d{8}$/.test(d) || /^8869\d{8}$/.test(d) || /^09/.test(d)) return '手機';
      return '市話';
    };
    const phoneList = [];
    let fax = '';
    const seen = new Set();
    for (const l of lines) {
      const nums = l.match(/\+?\d[\d\s().\-]{5,}\d/g) || [];
      for (const raw of nums) {
        const num = raw.trim();
        const d = num.replace(/\D/g, '');
        if (d.length < 8 || d.length > 15) continue;
        if (out.taxId && d === out.taxId) continue;     // 統編不是電話
        if (seen.has(d)) continue; seen.add(d);
        if (/(fax|傳真|傳\s*真)/i.test(l)) { if (!fax) fax = num; continue; }
        phoneList.push({ label: classify(num), value: num });
      }
    }
    out.fax = fax;
    out.phones = phoneList;
    const primary = (phoneList.find(p => p.label === '手機') || phoneList[0] || {}).value || '';
    if (primary) out.phone = primary;

    const titleKw = /(經理|總監|協理|執行長|董事|總經理|主任|工程師|設計師|顧問|專員|業務|處長|課長|副理|襄理|創辦|負責人|CEO|CTO|CFO|COO|Manager|Director|Engineer|Designer|Founder|President|Sales|Consultant|Lead|Head)/i;
    const compKw = /(股份有限公司|有限公司|企業|科技|工作室|事務所|集團|實業|國際|Inc\.?|Ltd\.?|LLC|Corp\.?|Company|Co\.,?|Technolog|Studio|Group)/i;

    for (const l of lines) {
      if (!out.title && titleKw.test(l) && l.length < 25) out.title = l;
      if (!out.company && compKw.test(l)) out.company = l;
    }

    const addr = lines.find(l => /(市|縣|區|路|街|樓|號|Rd\.?|St\.?|Ave\.?|Floor|No\.)/.test(l) && l.length > 6);
    if (addr) out.address = addr;

    const nameCand = lines.find(l =>
      l.length >= 2 && l.length <= 18 &&
      !/[\d@]/.test(l) && !compKw.test(l) && !titleKw.test(l) &&
      l !== out.address);
    if (nameCand) out.name = nameCand;

    return out;
  }

  function toVCard(c) {
    c = c || {};
    const L = ['BEGIN:VCARD', 'VERSION:3.0'];
    L.push(`FN:${c.name || ''}`);
    if (c.name) L.push(`N:${c.name};;;;`);
    if (c.company) L.push(`ORG:${c.company}`);
    if (c.title) L.push(`TITLE:${c.title}`);
    if (c.phone) L.push(`TEL;TYPE=CELL:${c.phone}`);
    if (Array.isArray(c.phones)) c.phones.slice(1).forEach(p => { if (p && p.value) L.push(`TEL;TYPE=${p.label === '市話' ? 'WORK' : 'VOICE'}:${p.value}`); });
    if (c.fax) L.push(`TEL;TYPE=FAX:${c.fax}`);
    if (c.email) L.push(`EMAIL:${c.email}`);
    if (c.website) L.push(`URL:${c.website}`);
    if (c.address) L.push(`ADR;TYPE=WORK:;;${c.address};;;;`);
    if (c.note) L.push(`NOTE:${String(c.note).replace(/\n/g, '\\n')}`);
    L.push('END:VCARD');
    return L.join('\n');
  }

  const COLS = ['name', 'company', 'title', 'phone', 'email', 'website', 'address', 'tags', 'note', 'taxId', 'fax'];
  const HEAD = ['姓名', '公司', '職稱', '電話', 'Email', '網站', '地址', '標籤', '備註', '統一編號', '傳真'];

  function toCSV(contacts) {
    const list = Array.isArray(contacts) ? contacts : [];
    const rows = list.map(c => COLS.map(k => {
      let v = k === 'tags' ? ((c.tags || []).join(';')) : (c[k] || '');
      v = String(v).replace(/"/g, '""');
      return /[",\n]/.test(v) ? `"${v}"` : v;
    }).join(','));
    return '﻿' + [HEAD.join(','), ...rows].join('\n');
  }

  /* ---------- 匯入:CSV ---------- */
  function parseCSVRows(text) {
    const rows = []; let row = [], field = '', i = 0, inQ = false;
    text = String(text || '').replace(/^﻿/, '');
    while (i < text.length) {
      const ch = text[i];
      if (inQ) {
        if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i += 2; continue; } inQ = false; i++; continue; }
        field += ch; i++; continue;
      }
      if (ch === '"') { inQ = true; i++; continue; }
      if (ch === ',') { row.push(field); field = ''; i++; continue; }
      if (ch === '\r') { i++; continue; }
      if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
      field += ch; i++;
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    return rows.filter(r => r.some(c => c !== ''));
  }

  function parseCSV(text) {
    const rows = parseCSVRows(text);
    if (!rows.length) return [];
    const HMAP = {
      '姓名': 'name', '公司': 'company', '職稱': 'title', '電話': 'phone', 'Email': 'email', 'email': 'email',
      '網站': 'website', '地址': 'address', '標籤': 'tags', '備註': 'note', '統一編號': 'taxId', '傳真': 'fax', 'taxId': 'taxId', 'fax': 'fax',
      'name': 'name', 'company': 'company', 'title': 'title', 'phone': 'phone', 'website': 'website',
      'address': 'address', 'tags': 'tags', 'note': 'note'
    };
    const header = rows[0].map(h => h.trim());
    const hasHeader = header.filter(h => HMAP[h]).length >= 2;
    const cols = hasHeader ? header.map(h => HMAP[h] || null) : COLS.slice();
    const dataRows = hasHeader ? rows.slice(1) : rows;
    return dataRows.map(r => {
      const o = { name: '', company: '', title: '', phone: '', email: '', website: '', address: '', note: '', tags: [] };
      cols.forEach((k, idx) => {
        if (!k) return;
        const v = (r[idx] || '').trim();
        if (k === 'tags') o.tags = v ? v.split(/[;,，、]/).map(t => t.trim()).filter(Boolean) : [];
        else o[k] = v;
      });
      return o;
    }).filter(o => o.name || o.company || o.phone || o.email);
  }

  /* ---------- 匯入:vCard ---------- */
  function parseVCards(text) {
    const out = [];
    String(text || '').split(/END:VCARD/i).forEach(block => {
      if (!/BEGIN:VCARD/i.test(block)) return;
      const c = { name: '', company: '', title: '', phone: '', email: '', website: '', address: '', note: '', tags: [] };
      block.split(/\r?\n/).forEach(line => {
        const m = line.match(/^([A-Za-z]+)(;[^:]*)?:(.*)$/);
        if (!m) return;
        const key = m[1].toUpperCase();
        const val = m[3].trim();
        if (key === 'FN') c.name = c.name || val;
        else if (key === 'N' && !c.name) c.name = val.split(';').filter(Boolean).join(' ').trim();
        else if (key === 'ORG') c.company = val.replace(/;+$/, '').trim();
        else if (key === 'TITLE') c.title = val;
        else if (key === 'TEL' && !c.phone) c.phone = val;
        else if (key === 'EMAIL' && !c.email) c.email = val;
        else if (key === 'URL') c.website = val;
        else if (key === 'ADR') c.address = val.split(';').filter(Boolean).join(' ').trim();
        else if (key === 'NOTE') c.note = val.replace(/\\n/g, '\n');
      });
      if (c.name || c.company || c.phone || c.email) out.push(c);
    });
    return out;
  }

  /* ---------- 去重合併 ---------- */
  function contactKey(c) {
    const em = (c.email || '').trim().toLowerCase();
    if (em) return 'e:' + em;
    const ph = (c.phone || '').replace(/\D/g, '');
    if (ph) return 'p:' + ph;
    return 'n:' + ((c.name || '') + '|' + (c.company || '')).toLowerCase();
  }

  function mergeContacts(existing, incoming) {
    const base = Array.isArray(existing) ? existing.slice() : [];
    const seen = new Map();
    base.forEach(c => seen.set(contactKey(c), c));
    let added = 0, skipped = 0;
    (Array.isArray(incoming) ? incoming : []).forEach(c => {
      const k = contactKey(c);
      if (seen.has(k)) { skipped++; return; }
      seen.set(k, c); base.push(c); added++;
    });
    return { merged: base, added, skipped };
  }

  /* ---------- 雙向同步合併:聯集去重,較新者勝 ---------- */
  function syncMerge(local, remote) {
    const map = new Map();
    const put = c => {
      const k = contactKey(c);
      const ex = map.get(k);
      const t = (c.updated || c.created || 0);
      const te = ex ? (ex.updated || ex.created || 0) : -1;
      if (!ex || t >= te) map.set(k, c);
    };
    (Array.isArray(local) ? local : []).forEach(put);
    (Array.isArray(remote) ? remote : []).forEach(put);
    return [...map.values()].sort((a, b) => (b.created || 0) - (a.created || 0));
  }

  /* ---------- 名片資料正規化 / 清洗(Web 與 App 共用)---------- */
  // 判斷亂碼 / 空白名片(解碼失敗、控制字元、Excel/zip 殘骸、無姓名也無公司)
  function isJunkContact(x) {
    if (!x) return true;
    const blob = [x.name, x.company, x.title, x.address, x.note, x.website].join(' ');
    if (/�/.test(blob)) return true;                  // 解碼失敗(替代字元 U+FFFD)
    if (/[\x00-\x08\x0E-\x1F]/.test(blob)) return true;        // 控制字元
    if (/PK\x03\x04|sharedStrings|xl\/worksheets|Content_Types|<\?xml/i.test(blob)) return true; // Excel/zip 殘骸
    const name = String(x.name || '').trim();
    const company = String(x.company || '').trim();
    if (!name && !company) return true;                         // 空白名片
    return false;
  }
  function dropJunk(arr) { return (Array.isArray(arr) ? arr : []).filter(c => !isJunkContact(c)); }

  // 舊資料 → 新欄位(多電話 phones[]、雙面 images[]、分組 group)
  function migrate(c) {
    if (!Array.isArray(c.images)) c.images = c.image ? [c.image] : [];
    if (c.images.length && !c.image) c.image = c.images[0];
    if (!Array.isArray(c.phones)) c.phones = c.phone ? [{ label: '手機', value: c.phone }] : [];
    if (c.phones.length && !c.phone) c.phone = c.phones[0].value;
    if (typeof c.group !== 'string') c.group = '';
    if (typeof c.source !== 'string') c.source = '';
    return c;
  }

  // 把 extra 的欄位「補進」base 目前空缺的欄位(不覆蓋已有值)。
  // 用於名片正反面互補:掃背面/重拍時,只填 base 缺的欄位、電話則去重合併。
  function fillMissing(base, extra) {
    base = base || {}; extra = extra || {};
    const TEXT = ['name', 'company', 'title', 'email', 'website', 'address', 'fax', 'taxId', 'note'];
    for (const k of TEXT) {
      if (!String(base[k] || '').trim() && String(extra[k] || '').trim()) base[k] = extra[k];
    }
    const exPhones = Array.isArray(extra.phones) && extra.phones.length
      ? extra.phones
      : (extra.phone ? [{ label: '手機', value: extra.phone }] : []);
    if (exPhones.length) {
      base.phones = Array.isArray(base.phones) ? base.phones.slice()
        : (base.phone ? [{ label: '手機', value: base.phone }] : []);
      const seen = new Set(base.phones.map(p => String(p.value || '').replace(/\D/g, '')).filter(Boolean));
      for (const p of exPhones) {
        const d = String(p.value || '').replace(/\D/g, '');
        if (d && !seen.has(d)) { base.phones.push(p); seen.add(d); }
      }
      if (!String(base.phone || '').trim() && base.phones[0]) base.phone = base.phones[0].value;
    }
    return base;
  }

  /* ---------- 墓碑(刪除傳播)+ 同步對帳(Web 與 App 共用)---------- */
  // 合併兩端墓碑:同鍵取較新 ts,清掉超過 180 天的舊墓碑
  function mergeTombstones(a, b) {
    const map = new Map();
    for (const t of [...(a || []), ...(b || [])]) {
      if (!t || !t.k) continue;
      const ts = Number(t.ts || 0);
      const prev = map.get(t.k);
      if (!prev || ts >= prev.ts) map.set(t.k, { k: t.k, ts });
    }
    const cutoff = Date.now() - 180 * 86400000;
    return [...map.values()].filter(t => t.ts >= cutoff);
  }
  // 套用墓碑:墓碑 ts >= 該聯絡人 updated 視為已刪,過濾掉
  function applyTombstones(contacts, tombs) {
    const tm = new Map((tombs || []).map(t => [t.k, Number(t.ts || 0)]));
    return (Array.isArray(contacts) ? contacts : []).filter(c => {
      const ts = tm.get(contactKey(c));
      return !(ts && ts >= Number(c.updated || c.created || 0));
    });
  }
  // 同步對帳(純決策,不碰 I/O):給定本地/遠端名片與兩端墓碑,
  // 算出最終名單 merged、要 upsert 的、要從遠端刪除的 id、合併後的墓碑。
  // Web(supabase-sync)與未來 RN App 共用同一套,各自只負責讀寫。
  function reconcile(local, remote, localTombs, remoteTombs) {
    remote = Array.isArray(remote) ? remote : [];
    const tombstones = mergeTombstones(localTombs, remoteTombs);
    const merged = dropJunk(applyTombstones(syncMerge(local, remote), tombstones));
    const mergedKeys = new Set(merged.map(contactKey));
    const toDelete = [];           // 遠端有、但對帳後不該存在(被墓碑刪或被判為髒)→ 刪遠端
    for (const r of remote) {
      if (!mergedKeys.has(contactKey(r)) && r.id) toDelete.push(r.id);
    }
    return { merged, toUpsert: merged, toDelete, tombstones };
  }

  /* ---------- Supabase DB row ↔ 前端 contact 轉換(Web 與 App 共用)----------
     影像不入 DB(走 Storage),此處只對應中繼資料 + image_path(主圖)/image_paths(多面)。 */
  function rowToContact(r) {
    r = r || {};
    const phones = Array.isArray(r.phones) ? r.phones : [];
    return {
      id: r.id,
      name: r.name || '', company: r.company || '', title: r.title || '',
      phones, phone: (phones[0] && phones[0].value) || '',
      tags: Array.isArray(r.tags) ? r.tags : [],
      fax: r.fax || '', taxId: r.tax_id || '',
      email: r.email || '', website: r.website || '', address: r.address || '',
      note: r.note || '', group: r.group || '', source: r.source || '',
      favorite: !!r.is_favorite, imageDriveId: r.image_drive_id || '',
      imagePath: r.image_path || '',
      imagePaths: Array.isArray(r.image_paths) ? r.image_paths : (r.image_path ? [r.image_path] : []),
      image: '', images: [],
      created: r.created_at ? new Date(r.created_at).getTime() : Date.now(),
      updated: r.updated_at ? new Date(r.updated_at).getTime() : 0,
    };
  }
  function contactToRow(c, ownerId) {
    c = c || {};
    const paths = Array.isArray(c.imagePaths) ? c.imagePaths : (c.imagePath ? [c.imagePath] : []);
    return {
      id: c.id, owner_id: ownerId,
      name: c.name || null, company: c.company || null, title: c.title || null,
      phones: Array.isArray(c.phones) ? c.phones : [],
      tags: Array.isArray(c.tags) ? c.tags : [],
      fax: c.fax || null, tax_id: c.taxId || null,
      email: c.email || null, website: c.website || null, address: c.address || null,
      note: c.note || null, group: c.group || '', source: c.source || '',
      is_favorite: !!c.favorite, image_drive_id: c.imageDriveId || null,
      image_path: paths[0] || null,
      image_paths: paths,
      created_at: new Date(c.created || Date.now()).toISOString(),
      updated_at: new Date(c.updated || c.created || Date.now()).toISOString(),
    };
  }

  const api = { parseCard, toVCard, toCSV, parseCSV, parseVCards, mergeContacts, contactKey, syncMerge, isJunkContact, dropJunk, migrate, fillMissing, mergeTombstones, applyTombstones, reconcile, rowToContact, contactToRow };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.CardSnapCore = api;
})(typeof self !== 'undefined' ? self : this);
