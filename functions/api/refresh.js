/* Google OAuth token 刷新代理(給 App 的 Drive 模式用)
   POST /api/refresh  body: { refresh_token }
   App 端拿不到 client secret,無法自行刷新 access token;由這裡代刷。

   ⚠️ client 必須與「發出這個 refresh token 的 client」一致(Google refresh token 綁 client)。
   App 的 Drive 授權走 Supabase 的 Google provider,用的是 Supabase 後台設定的那顆 client
   (813762176882-slmtjukjbt59...),與網頁 GIS/owner-sync 的 client(...1fqksh94p...)不同。
   因此這裡用專屬的 APP_GOOGLE_CLIENT_ID / APP_GOOGLE_CLIENT_SECRET,
   不共用 /api/sync 的 GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET(那是 owner-sync 專用,動了會壞)。
*/
const J = (o, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST,OPTIONS' } });

export const onRequestOptions = () => J({ ok: true });

export async function onRequestPost({ request, env }) {
  try {
    // App-Drive 專屬 client:secret 必須是「Supabase Google provider 那顆 client」的 secret
    const clientId = env.APP_GOOGLE_CLIENT_ID || '813762176882-slmtjukjbt59n2g20jb6co9fuc2q7dne.apps.googleusercontent.com';
    const clientSecret = env.APP_GOOGLE_CLIENT_SECRET;
    if (!clientSecret) return J({ error: '後端尚未設定(缺 APP_GOOGLE_CLIENT_SECRET)' }, 501);
    const body = await request.json().catch(() => ({}));
    if (!body.refresh_token) return J({ error: 'missing refresh_token' }, 400);
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: body.refresh_token, grant_type: 'refresh_token' }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) return J({ error: j.error_description || j.error || 'refresh failed' }, 401);
    return J({ access_token: j.access_token, expires_in: j.expires_in || 3600 });
  } catch (e) {
    return J({ error: String((e && e.message) || e) }, 500);
  }
}
