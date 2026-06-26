-- ============================================================
-- CardSnap — 名片影像跨裝置:Supabase Storage(card-images bucket)
-- 影像存 Storage(路徑 {uid}/{contactId}.jpg),DB 只存 image_path 參照
-- 套用:Supabase Dashboard → SQL Editor 貼上執行
-- ============================================================

-- contacts 加影像路徑欄位
alter table public.contacts add column if not exists image_path text;

-- 私有 bucket(不公開,靠下方 RLS + 認證存取)
insert into storage.buckets (id, name, public)
values ('card-images', 'card-images', false)
on conflict (id) do nothing;

-- Storage RLS:每位使用者只能存取自己資料夾({uid}/...)
drop policy if exists card_images_select on storage.objects;
create policy card_images_select on storage.objects for select
  using (bucket_id = 'card-images' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists card_images_insert on storage.objects;
create policy card_images_insert on storage.objects for insert
  with check (bucket_id = 'card-images' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists card_images_update on storage.objects;
create policy card_images_update on storage.objects for update
  using (bucket_id = 'card-images' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists card_images_delete on storage.objects;
create policy card_images_delete on storage.objects for delete
  using (bucket_id = 'card-images' and (storage.foldername(name))[1] = auth.uid()::text);
