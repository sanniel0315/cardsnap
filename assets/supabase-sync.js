/* ============================================================
   CardSnap Supabase 同步(階段 1b/1c)— 作為第三種 storageMode
   - 與既有 Drive/owner-cloud 同步「並存」,完全不改動 Drive 設計
   - 未設定金鑰(config.supabaseUrl/anonKey 空)時整個模組 no-op
   - 對帳沿用 core.syncMerge(較新者勝)+ 本地 tombstone 刪除傳播
   - 影像不入 DB(續存使用者裝置/Drive);tags 以 jsonb 同步
   依賴:全域 supabase(SDK)、CardSnapStore、以及 app.js 暴露的
        contacts / tombstones / dropJunk / contactKey / render /
        setSyncState / markSynced / toast / migrate
   ============================================================ */
(function () {
  'use strict';

  let sb = null;            // Supabase client(未設定金鑰則保持 null)
  let sbUserId = null;      // 登入後的 auth uid
  let sbSyncing = false;
  let sbPushT = null;

  function cfg() { return (typeof window !== 'undefined' && window.CARDSNAP_CONFIG) || {}; }
  function enabled() { return !!(cfg().supabaseUrl && cfg().supabaseAnonKey); }

  /* ---- 形狀轉換:DB(snake_case)↔ 前端 contact ---- */
  function fromDb(r) {
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
      image: '', images: [],
      created: r.created_at ? new Date(r.created_at).getTime() : Date.now(),
      updated: r.updated_at ? new Date(r.updated_at).getTime() : 0,
    };
  }
  function toDb(c) {
    return {
      id: c.id, owner_id: sbUserId,
      name: c.name || null, company: c.company || null, title: c.title || null,
      phones: Array.isArray(c.phones) ? c.phones : [],
      tags: Array.isArray(c.tags) ? c.tags : [],
      fax: c.fax || null, tax_id: c.taxId || null,
      email: c.email || null, website: c.website || null, address: c.address || null,
      note: c.note || null, group: c.group || '', source: c.source || '',
      is_favorite: !!c.favorite, image_drive_id: c.imageDriveId || null,
      image_path: c.imagePath || null,
      created_at: new Date(c.created || Date.now()).toISOString(),
      updated_at: new Date(c.updated || c.created || Date.now()).toISOString(),
    };
  }

  /* ---- 名片影像:存 Supabase Storage(card-images),路徑 {uid}/{id}.jpg ----
     DB 只存路徑(image_path),不存 base64;只處理「缺的」(冪等、省流量)。
     影像 I/O 失敗一律不擋資料同步。目前同步主圖(image),雙面 images[] 後續再補。 */
  const BUCKET = 'card-images';
  function blobToDataUrl(blob) {
    return new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => res(''); r.readAsDataURL(blob); });
  }
  async function syncImagesUp(list) {
    for (const c of list) {
      if (!c.image || c.imagePath) continue;                 // 沒圖、或已上傳過 → 跳過
      try {
        const path = sbUserId + '/' + c.id + '.jpg';
        const blob = await (await fetch(c.image)).blob();
        const { error } = await sb.storage.from(BUCKET).upload(path, blob, { upsert: true, contentType: 'image/jpeg' });
        if (!error) c.imagePath = path;
      } catch (e) { /* 影像上傳失敗不擋資料同步 */ }
    }
  }
  async function syncImagesDown(list) {
    for (const c of list) {
      if (!c.imagePath || c.image) continue;                 // 沒路徑、或本地已有圖 → 跳過
      try {
        const { data } = await sb.storage.from(BUCKET).download(c.imagePath);
        if (!data) continue;
        const url = await blobToDataUrl(data);
        if (url) { c.image = url; if (!c.images || !c.images.length) c.images = [url]; }
      } catch (e) { /* 抓圖失敗不擋 */ }
    }
  }

  /* ---- 初始化:建 client、還原 session、處理 OAuth 回跳 ---- */
  function initSupabase() {
    if (!enabled()) return;
    if (typeof supabase === 'undefined' || !supabase.createClient) { setTimeout(initSupabase, 600); return; }
    sb = supabase.createClient(cfg().supabaseUrl, cfg().supabaseAnonKey, {
      auth: { detectSessionInUrl: true, persistSession: true, autoRefreshToken: true },
    });
    sb.auth.onAuthStateChange((_event, session) => {
      sbUserId = session && session.user ? session.user.id : null;
      if (sbUserId && typeof storageMode === 'function' && storageMode() === 'supabase') supabaseSync();
    });
  }

  /* ---- 登入:Google OAuth(回跳回本頁,由 detectSessionInUrl 接手)---- */
  async function supabaseSignIn() {
    if (!enabled()) { toast('Supabase 尚未設定(需填入 supabaseUrl / anonKey)'); return; }
    if (!sb) { initSupabase(); toast('初始化中,請再按一次'); return; }
    const { data } = await sb.auth.getSession();
    if (data && data.session) { sbUserId = data.session.user.id; supabaseSync(); return; }
    const { error } = await sb.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: location.href.split('#')[0] },
    });
    if (error) toast('登入失敗:' + error.message);
  }

  /* ---- 雙向對帳:此處只做 I/O,對帳決策交給 core.reconcile(Web/App 共用)----
     拉 contacts + tombstones → core.reconcile → upsert/delete/回寫;
     墓碑同步到 Supabase,讓「跨裝置刪除」不會復活。 */
  async function supabaseSync() {
    if (!sb || !sbUserId || sbSyncing) return;
    sbSyncing = true; setSyncState('syncing');
    const killer = setTimeout(() => { sbSyncing = false; setSyncState('idle'); }, 25000);
    try {
      const [cRes, tRes] = await Promise.all([
        sb.from('contacts').select('*'),
        sb.from('tombstones').select('*'),
      ]);
      if (cRes.error) throw new Error(cRes.error.message);
      if (tRes.error) throw new Error(tRes.error.message);
      const remote = (cRes.data || []).map(fromDb);
      const remoteTombs = (tRes.data || []).map(t => ({ k: t.k, ts: Number(t.ts || 0) }));

      // 純對帳(無 I/O):算出最終名單、要 upsert、要刪、合併後墓碑
      const out = reconcile(contacts, remote, tombstones, remoteTombs);

      // 影像:本地有圖但雲端還沒存 → 上傳 Storage(讓接著的 upsert 帶上 image_path)
      await syncImagesUp(out.merged);

      if (out.toUpsert.length) {
        const { error } = await sb.from('contacts').upsert(out.toUpsert.map(toDb));
        if (error) throw new Error(error.message);
      }
      if (out.toDelete.length) {
        const { error } = await sb.from('contacts').delete().in('id', out.toDelete);
        if (error) throw new Error(error.message);
      }
      if (out.tombstones.length) {
        const { error } = await sb.from('tombstones').upsert(out.tombstones.map(t => ({ owner_id: sbUserId, k: t.k, ts: t.ts })));
        if (error) throw new Error(error.message);
      }

      // 影像:雲端有路徑但本地沒圖(換裝置/另一台)→ 從 Storage 抓回
      await syncImagesDown(out.merged);

      contacts = out.merged;
      window.CardSnapStore.setContacts(contacts);
      tombstones = out.tombstones;
      if (typeof saveTombstones === 'function') saveTombstones();
      render();
      setSyncState('synced'); if (typeof markSynced === 'function') markSynced();
    } catch (e) {
      setSyncState('idle'); toast('Supabase 同步失敗:' + (e && e.message ? e.message : e));
    } finally { clearTimeout(killer); sbSyncing = false; }
  }

  /* ---- 本地變更後的 debounce 推送(由 app.js schedulePush 呼叫)---- */
  function supabaseSchedulePush() {
    if (!sb || !sbUserId) return;
    clearTimeout(sbPushT); sbPushT = setTimeout(supabaseSync, 2500);
  }

  // 暴露給 app.js(掛在 window,沿用本專案全域風格)
  window.initSupabase = initSupabase;
  window.supabaseSignIn = supabaseSignIn;
  window.supabaseSync = supabaseSync;
  window.supabaseSchedulePush = supabaseSchedulePush;
})();
