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
    const out = { name: '', company: '', title: '', phone: '', email: '', website: '', address: '' };

    const em = flat.match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
    if (em) out.email = em[0].replace(/[，。、]$/, '');

    const web = flat.match(/(?:https?:\/\/)?(?:www\.)[\w-]+\.[\w.\/-]+/i)
              || flat.match(/\b[\w-]+\.(?:com|net|org|io|co|tw|cn)(?:\.[a-z]{2})?\b/i);
    if (web && (!em || !em[0].includes(web[0]))) out.website = web[0];

    const phones = flat.match(/(?:\+?\d[\d\s().-]{6,}\d)/g) || [];
    const phone = phones.map(p => p.trim()).find(p => p.replace(/\D/g, '').length >= 8);
    if (phone) out.phone = phone;

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
    if (c.email) L.push(`EMAIL:${c.email}`);
    if (c.website) L.push(`URL:${c.website}`);
    if (c.address) L.push(`ADR;TYPE=WORK:;;${c.address};;;;`);
    if (c.note) L.push(`NOTE:${String(c.note).replace(/\n/g, '\\n')}`);
    L.push('END:VCARD');
    return L.join('\n');
  }

  const COLS = ['name', 'company', 'title', 'phone', 'email', 'website', 'address', 'tags', 'note'];
  const HEAD = ['姓名', '公司', '職稱', '電話', 'Email', '網站', '地址', '標籤', '備註'];

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
      '網站': 'website', '地址': 'address', '標籤': 'tags', '備註': 'note',
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

  const api = { parseCard, toVCard, toCSV, parseCSV, parseVCards, mergeContacts, contactKey };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.CardSnapCore = api;
})(typeof self !== 'undefined' ? self : this);
