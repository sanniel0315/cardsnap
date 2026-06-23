/* CardSnap Store 持久化層單元測試 — 用 Node 內建 test runner,零相依
   以最小 localStorage mock 驗證 get/set round-trip 與壞資料回退行為 */
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// 注入最小 localStorage mock(store.js 透過 typeof localStorage 取用)
const mem = new Map();
global.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => { mem.set(k, String(v)); },
  removeItem: (k) => { mem.delete(k); },
};

const Store = require('../assets/store.js');

beforeEach(() => mem.clear());

test('getContacts:無資料時回空陣列', () => {
  assert.deepEqual(Store.getContacts(), []);
});

test('setContacts → getContacts round-trip', () => {
  const data = [{ name: '王小明', company: '範例科技' }];
  Store.setContacts(data);
  assert.deepEqual(Store.getContacts(), data);
});

test('getContacts:壞 JSON 回退空陣列(不丟例外)', () => {
  mem.set(Store.KEY.contacts, '{not json');
  assert.deepEqual(Store.getContacts(), []);
});

test('setContacts:非陣列正規化為空陣列', () => {
  Store.setContacts(null);
  assert.deepEqual(Store.getContacts(), []);
});

test('tombstones round-trip 與壞資料回退', () => {
  const tombs = [{ k: 'e:a@b.com', ts: 123 }];
  Store.setTombstones(tombs);
  assert.deepEqual(Store.getTombstones(), tombs);
  mem.set(Store.KEY.tombstones, 'x');
  assert.deepEqual(Store.getTombstones(), []);
});
