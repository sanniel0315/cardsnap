/* CardSnap 核心邏輯單元測試 — 用 Node 內建 test runner,零相依 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseCard, toVCard, toCSV } = require('../packages/core'); // 經 @cardsnap/core 入口,順帶驗證共用模組契約

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

/* ---------- 匯入 / 去重(新功能)---------- */
const core = require('../packages/core');

test('parseCSV：可解析 toCSV 匯出的內容(round-trip)', () => {
  const csv = core.toCSV([
    { name: '王小明', company: 'ACME', title: 'PM', phone: '0912-345-678', email: 'a@b.com', website: 'b.com', address: '台北市', tags: ['展場', '客戶'], note: '備註,含逗號' },
  ]);
  const r = core.parseCSV(csv);
  assert.equal(r.length, 1);
  assert.equal(r[0].name, '王小明');
  assert.equal(r[0].email, 'a@b.com');
  assert.deepEqual(r[0].tags, ['展場', '客戶']);
  assert.equal(r[0].note, '備註,含逗號');
});

test('parseCSV：無表頭也能依欄位順序解析', () => {
  const r = core.parseCSV('李四,某公司,工程師,0922000111,c@d.com,,,,');
  assert.equal(r[0].name, '李四');
  assert.equal(r[0].company, '某公司');
  assert.equal(r[0].phone, '0922000111');
});

test('parseVCards：可解析 toVCard 產生的內容', () => {
  const vcf = core.toVCard({ name: '陳大', company: 'Foo', phone: '0911', email: 'x@y.com' }) +
    '\n' + core.toVCard({ name: '林二', email: 'z@y.com' });
  const r = core.parseVCards(vcf);
  assert.equal(r.length, 2);
  assert.equal(r[0].name, '陳大');
  assert.equal(r[0].company, 'Foo');
  assert.equal(r[1].email, 'z@y.com');
});

test('mergeContacts:依 email/phone 去重,回傳新增與略過數', () => {
  const existing = [{ name: '王', email: 'a@b.com' }, { name: '李', phone: '0912 345 678' }];
  const incoming = [
    { name: '王(重複)', email: 'A@b.com' },     // email 同(大小寫不敏感)→ 略過
    { name: '李(重複)', phone: '0912-345-678' }, // phone 同(去符號)→ 略過
    { name: '新朋友', email: 'new@x.com' },       // 新增
  ];
  const res = core.mergeContacts(existing, incoming);
  assert.equal(res.added, 1);
  assert.equal(res.skipped, 2);
  assert.equal(res.merged.length, 3);
});

test('mergeContacts:無 email/phone 時以 姓名+公司 為鍵', () => {
  const res = core.mergeContacts([{ name: '同名', company: 'A' }], [{ name: '同名', company: 'A' }, { name: '同名', company: 'B' }]);
  assert.equal(res.added, 1);
  assert.equal(res.skipped, 1);
});

test('syncMerge:兩端聯集,同鍵取較新(updated 大者)', () => {
  const local = [{ name: '王', email: 'a@b.com', updated: 100, created: 100 }];
  const remote = [
    { name: '王-新', email: 'a@b.com', updated: 200, created: 100 }, // 同 email,較新 → 勝
    { name: '李', email: 'c@d.com', updated: 50, created: 50 },       // 新增
  ];
  const r = core.syncMerge(local, remote);
  assert.equal(r.length, 2);
  const wang = r.find(x => x.email === 'a@b.com');
  assert.equal(wang.name, '王-新');
});

/* ---------- OCR 解析增強:統編 / 傳真 / 多電話分類 ---------- */
test('parseCard:抓出統一編號,且不把統編當電話', () => {
  const raw = [
    '陳胤儒',
    '連益系統工程有限公司',
    '0912-133-511',
    'Tel 02-22542920',
    'Fax 02-81927003',
    '統編 54985723',
  ].join('\n');
  const r = parseCard(raw);
  assert.equal(r.taxId, '54985723');
  assert.equal(r.fax.replace(/\D/g, ''), '0281927003');
  assert.ok(!r.phones.some(p => p.value.replace(/\D/g, '') === '54985723'), '統編不應出現在電話');
});

test('parseCard:多支電話自動分手機/市話,主電話取手機', () => {
  const r = parseCard('王小明\n手機 0912-345-678\n電話 02-2345-6789');
  const mobile = r.phones.find(p => p.label === '手機');
  const land = r.phones.find(p => p.label === '市話');
  assert.ok(mobile && mobile.value.replace(/\D/g, '') === '0912345678');
  assert.ok(land && land.value.replace(/\D/g, '') === '0223456789');
  assert.equal(r.phone.replace(/\D/g, ''), '0912345678'); // 主電話優先手機
});

test('parseCard:傳真行不會被當成電話', () => {
  const r = parseCard('Acme\n傳真 03-1234567\n手機 0922000111');
  assert.equal(r.fax.replace(/\D/g, ''), '031234567');
  assert.ok(!r.phones.some(p => p.value.replace(/\D/g, '') === '031234567'));
});

test('toVCard:有傳真時輸出 FAX 行', () => {
  const v = toVCard({ name: 'A', phone: '0912', fax: '02-1234567' });
  assert.match(v, /TEL;TYPE=FAX:02-1234567/);
});

/* ---------- 資料正規化(自 app.js 下沉,Web 與 App 共用)---------- */
test('migrate:image→images[]、phone→phones[]、補 group/source', () => {
  const c = core.migrate({ name: '王', image: 'd1', phone: '0912' });
  assert.deepEqual(c.images, ['d1']);
  assert.equal(c.phones[0].label, '手機');
  assert.equal(c.phones[0].value, '0912');
  assert.equal(c.group, '');
  assert.equal(c.source, '');
});

test('migrate:已是新格式時不破壞既有 phones/images', () => {
  const c = core.migrate({ name: '李', images: ['a', 'b'], phones: [{ label: '市話', value: '02-1' }] });
  assert.deepEqual(c.images, ['a', 'b']);
  assert.equal(c.image, 'a');           // 由 images[0] 補上
  assert.equal(c.phone, '02-1');        // 由 phones[0] 補上
});

test('isJunkContact:亂碼(U+FFFD)、控制字元、空白名片 → true;正常 → false', () => {
  assert.equal(core.isJunkContact({ name: '正�碼' }), true);   // 替代字元
  assert.equal(core.isJunkContact({ name: '\x01\x02' }), true);     // 控制字元
  assert.equal(core.isJunkContact({ name: '', company: '' }), true); // 空白
  assert.equal(core.isJunkContact({ name: '王小明' }), false);
});

test('dropJunk:過濾亂碼/空白,保留正常名片', () => {
  const out = core.dropJunk([{ name: '王' }, { name: '', company: '' }, { name: 'a�' }]);
  assert.equal(out.length, 1);
  assert.equal(out[0].name, '王');
});

/* ---------- 正反面欄位互補(fillMissing)---------- */
test('fillMissing:正面人名 + 背面資料 → 只補空欄位,不覆蓋人名', () => {
  const front = { name: '王小明', phones: [{ label: '手機', value: '0912-345-678' }], phone: '0912-345-678' };
  const back = { name: 'WONG', company: '宏碁', email: 'a@b.com', phones: [{ label: '市話', value: '02-1234567' }] };
  const r = core.fillMissing(front, back);
  assert.equal(r.name, '王小明');          // 已有人名 → 不被背面覆蓋
  assert.equal(r.company, '宏碁');          // 缺 → 補上
  assert.equal(r.email, 'a@b.com');
  assert.equal(r.phones.length, 2);         // 兩面電話合併
  assert.equal(r.phone, '0912-345-678');    // 主電話不變
});

test('fillMissing:重複電話(去符號相同)不重複加入', () => {
  const r = core.fillMissing(
    { phones: [{ label: '手機', value: '0912-345-678' }], phone: '0912-345-678' },
    { phone: '0912 345 678' });
  assert.equal(r.phones.length, 1);
});

test('fillMissing:正面只有人名、背面才有全部資料的典型情境', () => {
  const r = core.fillMissing({ name: '陳大文' }, { company: 'ACME', title: 'PM', email: 'x@acme.com', phone: '0922000111' });
  assert.equal(r.name, '陳大文');
  assert.equal(r.company, 'ACME');
  assert.equal(r.title, 'PM');
  assert.equal(r.phone, '0922000111');
});

/* ---------- 墓碑 + 同步對帳(reconcile,跨端共用)---------- */
test('mergeTombstones:同鍵取較新 ts、清掉超過 180 天的舊墓碑', () => {
  const now = Date.now();
  const r = core.mergeTombstones([{ k: 'e:a', ts: now - 1000 }], [{ k: 'e:a', ts: now }, { k: 'p:123', ts: now }]);
  assert.equal(r.find(t => t.k === 'e:a').ts, now);
  assert.equal(r.length, 2);
  assert.equal(core.mergeTombstones([{ k: 'e:old', ts: now - 200 * 86400000 }], []).length, 0);
});

test('applyTombstones:墓碑 ts >= updated 的聯絡人會被刪掉', () => {
  const now = Date.now();
  const r = core.applyTombstones(
    [{ email: 'a@b.com', updated: now - 1000 }, { email: 'c@d.com', updated: now }],
    [{ k: 'e:a@b.com', ts: now }]);
  assert.equal(r.length, 1);
  assert.equal(r[0].email, 'c@d.com');
});

test('reconcile:遠端墓碑刪掉本地殘留(跨裝置刪除「不復活」)', () => {
  const now = Date.now();
  const local = [{ id: 'x1', name: '王小明', email: 'a@b.com', updated: now - 5000 }]; // 本地還殘留 X
  const remoteTombs = [{ k: 'e:a@b.com', ts: now }];                                   // 別台刪了 X(較新)
  // 對照:沒有遠端墓碑時 X 會保留;有墓碑才刪 → 真正驗證墓碑而非 dropJunk
  assert.equal(core.reconcile(local, [], [], []).merged.length, 1);
  const r = core.reconcile(local, [], [], remoteTombs);
  assert.equal(r.merged.length, 0, 'X 不應復活');
  assert.equal(r.tombstones.length, 1);
});

test('reconcile:本地刪除傳播到遠端(toDelete 含遠端 id)', () => {
  const now = Date.now();
  const r = core.reconcile([], [{ id: 'x1', name: '王小明', email: 'a@b.com', updated: now - 5000 }], [{ k: 'e:a@b.com', ts: now }], []);
  assert.equal(r.merged.length, 0);
  assert.deepEqual(r.toDelete, ['x1']);
});

test('reconcile:雙方各有不同名片 → 聯集、皆 upsert、無刪除', () => {
  const now = Date.now();
  const r = core.reconcile(
    [{ id: 'a', name: '甲', email: 'a@x.com', updated: now }],
    [{ id: 'b', name: '乙', email: 'b@x.com', updated: now }], [], []);
  assert.equal(r.merged.length, 2);
  assert.equal(r.toUpsert.length, 2);
  assert.equal(r.toDelete.length, 0);
});
