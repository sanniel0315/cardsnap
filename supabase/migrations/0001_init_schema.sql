-- ============================================================
-- CardSnap 後端 — 階段一 schema + RLS(對齊 docs/後端與App化-技術設計.md §4/§5)
-- 套用方式:Supabase Dashboard → SQL Editor 貼上執行,或 supabase db push。
-- 僅建立階段一必要的表;訂閱/Admin/feature_flags 等後續階段再補(YAGNI)。
-- ============================================================

-- ---- users:鏡射 auth.users,存 app 層方案/狀態 ----
create table if not exists public.users (
  id            uuid primary key references auth.users(id) on delete cascade,
  email         text,
  auth_provider text,
  plan          text not null default 'free',    -- free | pro
  status        text not null default 'active',   -- active | suspended
  created_at    timestamptz not null default now()
);

-- ---- contacts:名片中繼資料(影像存使用者 Drive,此處僅存 image_drive_id 參照)----
create table if not exists public.contacts (
  id             uuid primary key default gen_random_uuid(),
  owner_id       uuid not null references public.users(id) on delete cascade,
  name           text,
  company        text,
  title          text,
  phones         jsonb not null default '[]',      -- [{label,value}],對齊前端 phones[]
  fax            text,
  tax_id         text,
  email          text,
  website        text,
  address        text,
  note           text,
  "group"        text default '',
  source         text default '',
  is_favorite    boolean not null default false,
  image_drive_id text,
  ocr_confidence real,
  created_at     timestamptz not null default now(),
  -- 注意:updated_at 由應用層(前端 syncMerge「較新者勝」)控制,不用 DB trigger 強制覆寫,
  -- 以免破壞離線/多端衝突解。insert/update 時由前端帶入。
  updated_at     timestamptz not null default now()
);
create index if not exists contacts_owner_idx on public.contacts (owner_id);
create index if not exists contacts_owner_updated_idx on public.contacts (owner_id, updated_at desc);

-- ---- tags + contact_tags:標籤正規化(供後台統計;對齊規劃文件)----
create table if not exists public.tags (
  id       uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.users(id) on delete cascade,
  name     text not null,
  color    text,
  unique (owner_id, name)
);
create table if not exists public.contact_tags (
  contact_id uuid references public.contacts(id) on delete cascade,
  tag_id     uuid references public.tags(id) on delete cascade,
  primary key (contact_id, tag_id)
);

-- ============================================================
-- Row Level Security:每位使用者只能讀寫自己的資料
-- ============================================================
alter table public.users        enable row level security;
alter table public.contacts     enable row level security;
alter table public.tags         enable row level security;
alter table public.contact_tags enable row level security;

drop policy if exists users_self on public.users;
create policy users_self on public.users
  for select using (id = auth.uid());

drop policy if exists contacts_owner on public.contacts;
create policy contacts_owner on public.contacts
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

drop policy if exists tags_owner on public.tags;
create policy tags_owner on public.tags
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

drop policy if exists contact_tags_owner on public.contact_tags;
create policy contact_tags_owner on public.contact_tags
  for all using (
    exists (select 1 from public.contacts c
            where c.id = contact_id and c.owner_id = auth.uid())
  ) with check (
    exists (select 1 from public.contacts c
            where c.id = contact_id and c.owner_id = auth.uid())
  );

-- ============================================================
-- 新使用者註冊 → 自動在 public.users 建列(security definer 繞過 RLS)
-- ============================================================
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.users (id, email, auth_provider)
  values (new.id, new.email, coalesce(new.raw_app_meta_data->>'provider', 'google'))
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
