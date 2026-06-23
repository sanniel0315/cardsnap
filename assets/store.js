/* ============================================================
   CardSnap Store — 資料持久化抽象層(階段 1a)
   把 contacts / tombstones 的 localStorage 讀寫收斂到單一入口,
   為後續接雲端(Supabase)鋪路。本層只做 raw 存取,不含
   migrate / dropJunk / 同步邏輯(那些留在呼叫端)。
   框架無關、無 DOM,可在瀏覽器與 Node 測試共用。
   ============================================================ */
(function (global) {
  'use strict';

  const KEY = { contacts: 'cardsnap.contacts.v1', tombstones: 'cardsnap.tombstones' };
  const ls = () => (typeof localStorage !== 'undefined' ? localStorage : null);

  // 讀:解析失敗(無資料 / 壞 JSON)一律回空陣列,與原 load/loadTombstones 行為一致
  function getContacts() {
    try { return JSON.parse(ls().getItem(KEY.contacts)) || []; } catch { return []; }
  }
  function getTombstones() {
    try { return JSON.parse(ls().getItem(KEY.tombstones)) || []; } catch { return []; }
  }

  // 寫 contacts:不吞錯,讓呼叫端的 try/catch 決定如何提示(沿用原 save() 的滿載 toast)
  function setContacts(arr) {
    ls().setItem(KEY.contacts, JSON.stringify(Array.isArray(arr) ? arr : []));
  }
  // 寫 tombstones:沿用原 saveTombstones() 吞錯不提示的行為
  function setTombstones(arr) {
    try { ls().setItem(KEY.tombstones, JSON.stringify(Array.isArray(arr) ? arr : [])); } catch (e) {}
  }

  const api = { KEY, getContacts, getTombstones, setContacts, setTombstones };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.CardSnapStore = api;
})(typeof self !== 'undefined' ? self : this);
