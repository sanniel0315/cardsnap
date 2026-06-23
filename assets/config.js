/* CardSnap 設定 — Google OAuth Client ID(啟用雲端同步)
   專案 CardSnap · Web 用戶端;已授權來源:cardsnap-app.netlify.app、sanniel0315.github.io */
window.CARDSNAP_CONFIG = {
  googleClientId: '813762176882-1fqksh94p9560rrmimntdpb56si0vlvp.apps.googleusercontent.com',
  // Supabase 後端(階段一)。留空則「CardSnap 雲端(Supabase)」模式停用,不影響現有 Drive 同步。
  // 值取自 Supabase 專案 Settings → API(anon key 為前端公開用,真正防線是 RLS)。
  supabaseUrl: '',
  supabaseAnonKey: ''
};
