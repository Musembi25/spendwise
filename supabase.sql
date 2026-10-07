create table if not exists public.spendwise_data (
  user_id uuid primary key references auth.users (id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.spendwise_data enable row level security;

drop policy if exists "Users can read their own SpendWise data" on public.spendwise_data;
create policy "Users can read their own SpendWise data"
  on public.spendwise_data
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Users can create their own SpendWise data" on public.spendwise_data;
create policy "Users can create their own SpendWise data"
  on public.spendwise_data
  for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users can update their own SpendWise data" on public.spendwise_data;
create policy "Users can update their own SpendWise data"
  on public.spendwise_data
  for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

grant select, insert, update on public.spendwise_data to authenticated;
