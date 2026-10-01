-- dwater schema.
--
-- Every table has RLS on and no policies at all: nothing reaches these rows
-- through the public API. The edge function talks to them with the service
-- key, which bypasses RLS, and that function is the only way in.

create table if not exists public.water_settings (
  id             smallint primary key default 1 check (id = 1),
  timezone       text     not null default 'Europe/Chisinau',
  -- Reminder times, as minutes since local midnight.
  -- 07:00, 09:30, 12:00, 14:30, 17:00, 19:30, 22:00
  slots          smallint[] not null default '{420,570,720,870,1020,1170,1320}',
  repeat_minutes smallint not null default 5,
  max_repeats    smallint not null default 8,
  quiet_start    smallint not null default 1380,  -- 23:00
  quiet_end      smallint not null default 420,   -- 07:00
  -- A glass drunk this many minutes before a slot opens already satisfies it.
  grace_minutes  smallint not null default 20,
  daily_goal     smallint not null default 7
);

-- Which slot is currently being nagged about, and how far along it is.
create table if not exists public.water_state (
  id             smallint primary key default 1 check (id = 1),
  slot_date      date,
  slot_minute    smallint,
  reminders_sent smallint not null default 0,
  last_sent_at   timestamptz,
  confirmed      boolean not null default true,
  updated_at     timestamptz not null default now()
);

create table if not exists public.water_subscriptions (
  id         uuid primary key default gen_random_uuid(),
  endpoint   text not null unique,
  p256dh     text not null,
  auth       text not null,
  label      text,
  created_at timestamptz not null default now(),
  last_ok_at timestamptz,
  fail_count smallint not null default 0
);

create table if not exists public.water_log (
  id          bigint generated always as identity primary key,
  drank_at    timestamptz not null default now(),
  -- The local calendar day the glass belongs to, so counting a day never
  -- depends on the server's timezone.
  local_date  date not null,
  slot_minute smallint
);

create index if not exists water_log_local_date_idx on public.water_log (local_date);
create index if not exists water_log_drank_at_idx on public.water_log (drank_at desc);

insert into public.water_settings (id) values (1) on conflict (id) do nothing;
insert into public.water_state (id) values (1) on conflict (id) do nothing;

alter table public.water_settings      enable row level security;
alter table public.water_state         enable row level security;
alter table public.water_subscriptions enable row level security;
alter table public.water_log           enable row level security;

revoke all on public.water_settings      from anon, authenticated;
revoke all on public.water_state         from anon, authenticated;
revoke all on public.water_subscriptions from anon, authenticated;
revoke all on public.water_log           from anon, authenticated;
