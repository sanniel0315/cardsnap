/* Google OAuth token 刷新代理(給 App 的 Drive 模式用)
   POST /api/refresh  body: { refresh_token }
   App 端拿不到 client secret,無法自行刷新 access token;由這裡代刷。
   重用 /api/sync 既有的環境變數 GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET。
*/
const J = (o, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST,OPTIONS' } });

export const onRequestOptions = () => J({ ok: true });

export async function onRequestPost({ request, env }) {
  try {
    if (!env.GOOGLE_CLIENT_SECRET) return J({ error: '後端尚未設定(缺 GOOGLE_CLIENT_SECRET)' }, 501);
    const body = await request.json().catch(() => ({}));
    if (!body.refresh_token) return J({ error: 'missing refresh_token' }, 400);
    const clientId = env.GOOGLE_CLIENT_ID || '813762176882-1fqksh94p9560rrmimntdpb56si0vlvp.apps.googleusercontent.com';
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, client_secret: env.GOOGLE_CLIENT_SECRET, refresh_token: body.refresh_token, grant_type: 'refresh_token' }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) return J({ error: j.error_description || j.error || 'refresh failed' }, 401);
    return J({ access_token: j.access_token, expires_in: j.expires_in || 3600 });
  } catch (e) {
    return J({ error: String((e && e.message) || e) }, 500);
  }
}
