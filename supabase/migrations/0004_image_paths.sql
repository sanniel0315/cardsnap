-- ============================================================
-- CardSnap — 雙面影像:contacts 加 image_paths(多張影像路徑陣列)
-- 路徑 {uid}/{contactId}-{i}.jpg;image_path(單欄)保留為主圖,向後相容
-- 套用:Supabase Dashboard → SQL Editor 貼上執行
-- ============================================================
alter table public.contacts add column if not exists image_paths jsonb not null default '[]';
