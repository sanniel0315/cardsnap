/* CardSnap 核心邏輯單元測試 — 用 Node 內建 test runner,零相依 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseCard, toVCard, toCSV } = require('../assets/core.js');

test('parseCard：完整中文名片可解析所有欄位', () => {
  const raw = [
    '王小明',
    '範例科技股份有限公司',
    '資深產品經理',
    'Tel: 0912-345-678',
    'Email: ming.wang@example.com',
    'www.example.com',
    '台北市信義區松高路 11 號 8 樓',
  ].join('\n');
  const r = parseCard(raw);
  assert.equal(r.name, '王小明');
  assert.equal(r.company, '範例科技股份有限公司');
  assert.equal(r.title, '資深產品經理');
  assert.equal(r.email, 'ming.wang@example.com');
  assert.equal(r.phone, '0912-345-678');
  assert.match(r.website, /example\.com/);
  assert.match(r.address, /台北市/);
});

test('parseCard：英文名片基本欄位', () => {
  const r = parseCard('John Doe\nAcme Inc.\nSales Director\njohn@acme.io\n+1 415 555 0199');
  assert.equal(r.company, 'Acme Inc.');
  assert.equal(r.title, 'Sales Director');
  assert.equal(r.email, 'john@acme.io');
  assert.ok(r.phone.replace(/\D/g, '').length >= 8);
});

test('parseCard：空字串不丟錯,回傳空欄位', () => {
  const r = parseCard('');
  assert.equal(r.name, '');
  assert.equal(r.email, '');
});

test('parseCard：website 不會誤抓 email 網域', () => {
  const r = parseCard('Jane\nfoo@bar.com');
  assert.equal(r.email, 'foo@bar.com');
  assert.notEqual(r.website, 'bar.com');
});

test('toVCard：產生合法 vCard 3.0', () => {
  const v = toVCard({ name: '王小明', company: 'ACME', phone: '0912', email: 'a@b.com' });
  assert.match(v, /^BEGIN:VCARD/);
  assert.match(v, /VERSION:3\.0/);
  assert.match(v, /FN:王小明/);
  assert.match(v, /ORG:ACME/);
  assert.match(v, /TEL;TYPE=CELL:0912/);
  assert.match(v, /EMAIL:a@b\.com/);
  assert.match(v, /END:VCARD$/);
});

test('toVCard：缺欄位時不輸出該行', () => {
  const v = toVCard({ name: 'A' });
  assert.doesNotMatch(v, /ORG:/);
  assert.doesNotMatch(v, /TEL/);
});

test('toCSV：含表頭、BOM,且正確跳脫逗號與引號', () => {
  const csv = toCSV([
    { name: '王,小明', company: 'He said "hi"', tags: ['a', 'b'] },
  ]);
  assert.ok(csv.startsWith('﻿'), '應以 BOM 開頭');
  assert.match(csv, /姓名,公司,職稱/);
  assert.match(csv, /"王,小明"/);          // 逗號要被引號包起來
  assert.match(csv, /"He said ""hi"""/);    // 引號要加倍跳脫
  assert.match(csv, /a;b/);                  // tags 用分號串接
});

test('toCSV：空陣列只回表頭', () => {
  const csv = toCSV([]);
  const lines = csv.replace(/^﻿/, '').split('\n');
  assert.equal(lines.length, 1);
});
