/* CardSnap 設定 — Google OAuth Client ID(啟用雲端同步)
   專案 CardSnap · Web 用戶端;已授權來源:cardsnap-app.netlify.app、sanniel0315.github.io */
window.CARDSNAP_CONFIG = {
  googleClientId: '813762176882-1fqksh94p9560rrmimntdpb56si0vlvp.apps.googleusercontent.com',
  // Supabase 後端(階段一)。留空則「CardSnap 雲端(Supabase)」模式停用,不影響現有 Drive 同步。
  // 值取自 Supabase 專案 Settings → API(anon key 為前端公開用,真正防線是 RLS)。
  supabaseUrl: 'https://qgtwyuhbheqkmraetlrv.supabase.co',
  supabaseAnonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFndHd5dWhiaGVxa21yYWV0bHJ2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIyOTA1NjgsImV4cCI6MjA5Nzg2NjU2OH0.PaXpxUYE6OQCN7eP2BC-bVC7lM7aNXUJ01vASZgtzeU'
};
