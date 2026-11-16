-- Marigold — database schema
-- Run this in the Supabase SQL editor (or via the Supabase MCP). Idempotent: safe to re-run.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

-- Mirrors auth.users; auto-populated on signup by the trigger below.
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  name        text,
  email       text,
  timezone    text,
  tone        text,
  created_at  timestamptz not null default now()
);

-- Onboarding preferences, added after the initial release (safe to re-run).
alter table public.profiles add column if not exists timezone text;
alter table public.profiles add column if not exists tone text;

create table if not exists public.projects (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  name        text not null default '',
  description text not null default '',
  color       text not null default '#e8a317',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists public.chats (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  project_id  uuid references public.projects(id) on delete set null,
  title       text not null default 'New chat',
  pinned      boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists public.messages (
  id          uuid primary key default gen_random_uuid(),
  chat_id     uuid not null references public.chats(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  role        text not null check (role in ('user', 'agent', 'system')),
  content     text not null default '',
  model       text check (model in ('agent', 'llama', 'qwen')),
  created_at  timestamptz not null default now()
);

create table if not exists public.background_tasks (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  chat_id     uuid references public.chats(id) on delete cascade,
  title       text not null,
  kind        text not null,
  status      text not null,
  progress    int not null default 0,
  summary     text not null default '',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists idx_projects_user  on public.projects(user_id);
create index if not exists idx_chats_user     on public.chats(user_id);
create index if not exists idx_chats_project  on public.chats(project_id);
create index if not exists idx_messages_chat  on public.messages(chat_id);
create index if not exists idx_tasks_user     on public.background_tasks(user_id);

-- ---------------------------------------------------------------------------
-- Row-level security — every user can only touch their own rows
-- ---------------------------------------------------------------------------

alter table public.profiles         enable row level security;
alter table public.projects         enable row level security;
alter table public.chats            enable row level security;
alter table public.messages         enable row level security;
alter table public.background_tasks enable row level security;

drop policy if exists "own profile"  on public.profiles;
create policy "own profile" on public.profiles
  for all using (auth.uid() = id) with check (auth.uid() = id);

drop policy if exists "own projects" on public.projects;
create policy "own projects" on public.projects
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own chats" on public.chats;
create policy "own chats" on public.chats
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own messages" on public.messages;
create policy "own messages" on public.messages
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own tasks" on public.background_tasks;
create policy "own tasks" on public.background_tasks
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- Auto-create a profile row whenever a new auth user signs up
-- ---------------------------------------------------------------------------

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, name, email, timezone, tone)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)),
    new.email,
    new.raw_user_meta_data->>'timezone',
    new.raw_user_meta_data->>'tone'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Account deletion — a user can delete their own account + all their data.
-- Runs as the function owner (security definer) so it can touch auth.users;
-- auth.uid() guarantees it only ever deletes the caller. All public tables
-- cascade-delete via their user_id foreign keys.
-- ---------------------------------------------------------------------------

create or replace function public.delete_user()
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;
  delete from auth.users where id = auth.uid();
end;
$$;

revoke all on function public.delete_user() from public, anon;
grant execute on function public.delete_user() to authenticated;

-- Migration (2026-11-03): allow the Qwen 14B "agent" model.
-- alter table public.messages drop constraint if exists messages_model_check;
-- alter table public.messages add constraint messages_model_check check (model in ('agent', 'llama', 'qwen'));
