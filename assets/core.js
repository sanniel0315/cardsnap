/* ============================================================
   CardSnap Core — 純邏輯(無 DOM、可在瀏覽器與 Node 測試)
   parseCard：OCR 文字 → 名片欄位
   toVCard ：名片 → vCard 3.0
   toCSV   ：名單 → CSV(含 BOM、跳脫)
   以 UMD 包裝:瀏覽器掛 window.CardSnapCore,Node 走 module.exports
   ============================================================ */
(function (global) {
  'use strict';

  function parseCard(raw) {
    const lines = String(raw || '').split('\n').map(l => l.trim()).filter(Boolean);
    const flat = lines.join(' ');
    const out = { name: '', company: '', title: '', phone: '', email: '', website: '', address: '' };

    // email
    const em = flat.match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
    if (em) out.email = em[0].replace(/[，。、]$/, '');

    // website(避免抓到 email 的網域)
    const web = flat.match(/(?:https?:\/\/)?(?:www\.)[\w-]+\.[\w.\/-]+/i)
              || flat.match(/\b[\w-]+\.(?:com|net|org|io|co|tw|cn)(?:\.[a-z]{2})?\b/i);
    if (web && (!em || !em[0].includes(web[0]))) out.website = web[0];

    // phone(台灣/國際常見格式)
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

  function toCSV(contacts) {
    const list = Array.isArray(contacts) ? contacts : [];
    const cols = ['name', 'company', 'title', 'phone', 'email', 'website', 'address', 'tags', 'note'];
    const head = ['姓名', '公司', '職稱', '電話', 'Email', '網站', '地址', '標籤', '備註'];
    const rows = list.map(c => cols.map(k => {
      let v = k === 'tags' ? ((c.tags || []).join(';')) : (c[k] || '');
      v = String(v).replace(/"/g, '""');
      return /[",\n]/.test(v) ? `"${v}"` : v;
    }).join(','));
    return '﻿' + [head.join(','), ...rows].join('\n');
  }

  const api = { parseCard, toVCard, toCSV };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.CardSnapCore = api;
})(typeof self !== 'undefined' ? self : this);
