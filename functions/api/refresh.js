/* Google OAuth token 刷新代理(給 App 的 Drive 模式用)
   POST /api/refresh  body: { refresh_token }
   App 端拿不到 client secret,無法自行刷新 access token;由這裡代刷。

   ⚠️ client 必須與「發出這個 refresh token 的 client」一致(Google refresh token 綁 client)。
   App 的 Drive 授權走 Supabase 的 Google provider,用的是 Supabase 後台設定的那顆 client
   (813762176882-slmtjukjbt59...),與網頁 GIS/owner-sync 的 client(...1fqksh94p...)不同。
   因此先試專屬的 APP_GOOGLE_CLIENT_ID / APP_GOOGLE_CLIENT_SECRET,失敗再試網頁那顆
   (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET,只讀取不修改,owner-sync 不受影響)。
*/
const J = (o, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST,OPTIONS' } });

export const onRequestOptions = () => J({ ok: true });

export async function onRequestPost({ request, env }) {
  try {
    // 候選 client:App 專屬那顆 + 網頁那顆(Supabase Google provider 曾被改成網頁那顆 1fqksh94p,
    // 綁錯 client 刷新會 invalid_grant → App 清 token、一直顯示 Drive 沒連線)。依序試,哪顆發的就用哪顆刷。
    const clients = [
      [env.APP_GOOGLE_CLIENT_ID || '813762176882-slmtjukjbt59n2g20jb6co9fuc2q7dne.apps.googleusercontent.com', env.APP_GOOGLE_CLIENT_SECRET],
      [env.GOOGLE_CLIENT_ID || '813762176882-1fqksh94p9560rrmimntdpb56si0vlvp.apps.googleusercontent.com', env.GOOGLE_CLIENT_SECRET],
    ].filter(([, sec]) => sec);
    if (!clients.length) return J({ error: '後端尚未設定(缺 APP_GOOGLE_CLIENT_SECRET / GOOGLE_CLIENT_SECRET)' }, 501);
    const body = await request.json().catch(() => ({}));
    if (!body.refresh_token) return J({ error: 'missing refresh_token' }, 400);
    let last = 'refresh failed';
    for (const [clientId, clientSecret] of clients) {
      const r = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: body.refresh_token, grant_type: 'refresh_token' }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.access_token) return J({ access_token: j.access_token, expires_in: j.expires_in || 3600 });
      last = j.error_description || j.error || last;
    }
    return J({ error: last }, 401);
  } catch (e) {
    return J({ error: String((e && e.message) || e) }, 500);
  }
}
