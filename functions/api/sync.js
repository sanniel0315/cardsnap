/* CardSnap 多用戶雲端同步(存「擁有者」Google Drive)
   POST /api/sync  body: { idToken, contacts, updatedAt }
   - 用使用者的 Google ID token 驗證身分 → email(使用者不需任何 Drive 授權)
   - 用擁有者 refresh token 在擁有者 Drive 的 CardSnap-Users 資料夾存每位使用者一個 JSON
   - server 端 union 合併後寫回,回傳合併結果
   需要的環境變數(Pages Secrets):
     GOOGLE_CLIENT_ID（公開值,亦可直接帶入）, GOOGLE_CLIENT_SECRET, OWNER_REFRESH_TOKEN
*/
const J = (o, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST,OPTIONS' } });

export const onRequestOptions = () => J({ ok: true });

export async function onRequestPost({ request, env }) {
  try {
    if (!env.OWNER_REFRESH_TOKEN || !env.GOOGLE_CLIENT_SECRET) return J({ error: '後端尚未設定(缺 OWNER_REFRESH_TOKEN / GOOGLE_CLIENT_SECRET)' }, 501);
    const body = await request.json().catch(() => ({}));
    if (!body.token) return J({ error: 'missing token' }, 401);

    const clientId = env.GOOGLE_CLIENT_ID || '813762176882-1fqksh94p9560rrmimntdpb56si0vlvp.apps.googleusercontent.com';
    const who = await userinfo(body.token);
    if (!who || !who.email) return J({ error: 'invalid token' }, 401);
    const email = String(who.email).toLowerCase();

    const ownerToken = await ownerAccessToken(env, clientId);
    const folderId = await ensureFolder(ownerToken, 'CardSnap-Users');
    const fileName = keyFor(email) + '.json';
    const fileId = await findFile(ownerToken, folderId, fileName);

    let remote = [];
    if (fileId) { const d = await readJson(ownerToken, fileId); remote = Array.isArray(d) ? d : (d.contacts || []); }

    const incoming = Array.isArray(body.contacts) ? body.contacts : [];
    const merged = mergeContacts(remote, incoming);
    const out = JSON.stringify({ version: 1, updatedAt: Date.now(), owner: email, contacts: merged });
    if (fileId) await updateFile(ownerToken, fileId, out);
    else await createFile(ownerToken, folderId, fileName, out);

    return J({ ok: true, count: merged.length, contacts: merged });
  } catch (e) {
    return J({ error: String(e && e.message || e) }, 500);
  }
}

/* ---- Google 身分驗證(access token → userinfo)---- */
async function userinfo(accessToken) {
  const r = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { Authorization: 'Bearer ' + accessToken } });
  if (!r.ok) return null;
  return r.json().catch(() => null);
}

/* ---- 擁有者 access token(refresh grant)---- */
async function ownerAccessToken(env, clientId) {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: env.GOOGLE_CLIENT_SECRET, refresh_token: env.OWNER_REFRESH_TOKEN, grant_type: 'refresh_token' }),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error('owner token 失敗:' + (j.error_description || j.error || 'unknown'));
  return j.access_token;
}

/* ---- Drive helpers ---- */
const DA = (t) => ({ Authorization: 'Bearer ' + t });
async function ensureFolder(t, name) {
  const q = encodeURIComponent(`mimeType='application/vnd.google-apps.folder' and name='${name}' and trashed=false`);
  const lr = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)`, { headers: DA(t) });
  const lj = await lr.json();
  if (lj.files && lj.files[0]) return lj.files[0].id;
  const cr = await fetch('https://www.googleapis.com/drive/v3/files?fields=id', { method: 'POST', headers: { ...DA(t), 'Content-Type': 'application/json' }, body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder' }) });
  return (await cr.json()).id;
}
async function findFile(t, folderId, name) {
  const q = encodeURIComponent(`name='${name}' and '${folderId}' in parents and trashed=false`);
  const r = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)`, { headers: DA(t) });
  const j = await r.json();
  return j.files && j.files[0] ? j.files[0].id : null;
}
async function readJson(t, fileId) {
  const r = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, { headers: DA(t) });
  return r.ok ? r.json().catch(() => []) : [];
}
async function createFile(t, folderId, name, content) {
  const meta = { name, parents: [folderId] };
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(meta)], { type: 'application/json' }));
  form.append('file', new Blob([content], { type: 'application/json' }));
  await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', { method: 'POST', headers: DA(t), body: form });
}
async function updateFile(t, fileId, content) {
  await fetch(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`, { method: 'PATCH', headers: { ...DA(t), 'Content-Type': 'application/json' }, body: content });
}

/* ---- 合併(union by key,丟掉亂碼)---- */
function isJunk(x) {
  if (!x) return true;
  const b = [x.name, x.company, x.title, x.address, x.note, x.website].join(' ');
  if (/�/.test(b) || /[\x00-\x08\x0E-\x1F]/.test(b)) return true;
  if (!String(x.name || '').trim() && !String(x.company || '').trim()) return true;
  return false;
}
function ckey(c) {
  const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, '');
  const phone = (c.phone || (c.phones && c.phones[0] && c.phones[0].value) || '').replace(/[^\d]/g, '');
  return norm(c.email) || phone || (norm(c.name) + '|' + norm(c.company));
}
function keyFor(email) {
  let h = 0; const s = email; for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) >>> 0; }
  return 'u' + h.toString(36);
}
function mergeContacts(a, b) {
  const map = new Map();
  for (const c of [...(a || []), ...(b || [])]) {
    if (isJunk(c)) continue;
    const k = ckey(c);
    const prev = map.get(k);
    if (!prev || (Number(c.updated || 0) >= Number(prev.updated || 0))) map.set(k, c);
  }
  return [...map.values()];
}
