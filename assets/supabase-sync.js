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

  /* ---- 形狀轉換:用 core.rowToContact / contactToRow(Web 與 App 共用)---- */
  const toRow = (c) => contactToRow(c, sbUserId);

  /* ---- 名片影像:存 Supabase Storage(card-images),路徑 {uid}/{id}-{i}.jpg ----
     DB 只存路徑(image_paths),不存 base64;只處理「缺的」(冪等、省流量)。
     支援雙面 images[];影像 I/O 失敗一律不擋資料同步。 */
  const BUCKET = 'card-images';
  function blobToDataUrl(blob) {
    return new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => res(''); r.readAsDataURL(blob); });
  }
  function localImages(c) { return (c.images && c.images.length) ? c.images : (c.image ? [c.image] : []); }
  function remotePaths(c) { return (c.imagePaths && c.imagePaths.length) ? c.imagePaths : (c.imagePath ? [c.imagePath] : []); }
  async function syncImagesUp(list) {
    for (const c of list) {
      const imgs = localImages(c);
      if (!imgs.length || (c.imagePaths && c.imagePaths.length >= imgs.length)) continue; // 沒圖或已上傳
      const paths = [];
      for (let i = 0; i < imgs.length; i++) {
        try {
          const path = sbUserId + '/' + c.id + '-' + i + '.jpg';
          const blob = await (await fetch(imgs[i])).blob();
          const { error } = await sb.storage.from(BUCKET).upload(path, blob, { upsert: true, contentType: 'image/jpeg' });
          if (!error) paths.push(path);
        } catch (e) { /* 單張失敗略過 */ }
      }
      if (paths.length) { c.imagePaths = paths; c.imagePath = paths[0]; }
    }
  }
  async function syncImagesDown(list) {
    for (const c of list) {
      const paths = remotePaths(c);
      if (!paths.length || (c.images && c.images.length >= paths.length)) continue; // 沒路徑或本地已有
      const imgs = [];
      for (const p of paths) {
        try { const { data } = await sb.storage.from(BUCKET).download(p); if (data) { const u = await blobToDataUrl(data); if (u) imgs.push(u); } } catch (e) {}
      }
      if (imgs.length) { c.images = imgs; c.image = imgs[0]; }
    }
  }
  // 刪名片時連帶刪 Storage 影像(避免孤兒檔)
  async function deleteImages(remoteById, ids) {
    const paths = [];
    for (const id of ids) { const r = remoteById.get(id); if (r) paths.push(...remotePaths(r)); }
    if (paths.length) { try { await sb.storage.from(BUCKET).remove(paths); } catch (e) { /* 刪圖失敗不擋 */ } }
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
      const remote = (cRes.data || []).map(rowToContact);
      const remoteById = new Map(remote.map(r => [r.id, r]));
      const remoteTombs = (tRes.data || []).map(t => ({ k: t.k, ts: Number(t.ts || 0) }));

      // 純對帳(無 I/O):算出最終名單、要 upsert、要刪、合併後墓碑
      const out = reconcile(contacts, remote, tombstones, remoteTombs);

      // 影像:本地有圖但雲端還沒存 → 上傳 Storage(讓接著的 upsert 帶上 image_path)
      await syncImagesUp(out.merged);

      if (out.toUpsert.length) {
        const { error } = await sb.from('contacts').upsert(out.toUpsert.map(toRow));
        if (error) throw new Error(error.message);
      }
      if (out.toDelete.length) {
        const { error } = await sb.from('contacts').delete().in('id', out.toDelete);
        if (error) throw new Error(error.message);
        await deleteImages(remoteById, out.toDelete);   // 連帶刪 Storage 影像(免孤兒)
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
