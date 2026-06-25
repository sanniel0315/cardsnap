-- ============================================================
-- CardSnap — 墓碑表(刪除傳播):讓「跨裝置刪除」不會在另一台復活
-- 對齊前端 tombstone(k = contactKey,ts = 刪除時間 epoch ms)
-- 套用:Supabase Dashboard → SQL Editor 貼上執行
-- ============================================================
create table if not exists public.tombstones (
  owner_id uuid   not null references public.users(id) on delete cascade,
  k        text   not null,            -- contactKey:e:email / p:phone / n:name|company
  ts       bigint not null,            -- 刪除時間(epoch 毫秒)
  primary key (owner_id, k)
);

alter table public.tombstones enable row level security;

drop policy if exists tombstones_owner on public.tombstones;
create policy tombstones_owner on public.tombstones
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());
