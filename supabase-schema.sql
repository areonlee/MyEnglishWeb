-- 英语精读：邀请积分 + VIP 兑换 + 7 天试用（在 Supabase SQL Editor 中整段执行）

-- 1) 用户档案
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text,
  invite_code text unique,
  invited_by text,
  points integer not null default 0,
  vip_expire_date timestamptz,
  plan_type text default 'trial',
  created_at timestamptz not null default now()
);

alter table public.profiles add column if not exists plan_type text default 'trial';

create index if not exists profiles_invite_code_idx on public.profiles (invite_code);
create index if not exists profiles_invited_by_idx on public.profiles (invited_by);

-- 2) 积分流水
create table if not exists public.point_logs (
  id bigserial primary key,
  user_id uuid not null references public.profiles (id) on delete cascade,
  amount integer not null,
  reason text,
  balance_after integer,
  created_at timestamptz not null default now()
);

create index if not exists point_logs_user_id_idx on public.point_logs (user_id);

-- 3) RLS
alter table public.profiles enable row level security;
alter table public.point_logs enable row level security;

drop policy if exists "profiles_select_own_or_invite" on public.profiles;
drop policy if exists "profiles_select_by_invite_code" on public.profiles;
drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own"
  on public.profiles for select
  to authenticated
  using (id = auth.uid());

drop policy if exists "profiles_insert_own" on public.profiles;
create policy "profiles_insert_own"
  on public.profiles for insert
  to authenticated
  with check (id = auth.uid());

drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own"
  on public.profiles for update
  to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

drop policy if exists "point_logs_select_own" on public.point_logs;
create policy "point_logs_select_own"
  on public.point_logs for select
  to authenticated
  using (user_id = auth.uid());

drop policy if exists "point_logs_insert_own" on public.point_logs;
create policy "point_logs_insert_own"
  on public.point_logs for insert
  to authenticated
  with check (user_id = auth.uid());

-- 4) 注册邀请奖励（推荐人 +50，新用户 +20）
create or replace function public.process_referral_bonus(p_invite_code text)
returns public.profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  me public.profiles;
  referrer public.profiles;
  code text := upper(trim(coalesce(p_invite_code, '')));
  my_code text;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  select * into me from public.profiles where id = auth.uid();
  if me.id is null then
    raise exception 'profile not found';
  end if;

  my_code := upper(coalesce(me.invite_code, ''));
  if code = '' or code = my_code then
    return me;
  end if;

  -- 已发放过则直接返回
  if exists (
    select 1 from public.point_logs
    where user_id = me.id and reason = '新用户邀请奖励'
  ) then
    return me;
  end if;

  select * into referrer
  from public.profiles
  where upper(invite_code) = code
  limit 1;

  if referrer.id is null or referrer.id = me.id then
    return me;
  end if;

  if me.invited_by is null then
    update public.profiles
      set invited_by = code
      where id = me.id
      returning * into me;
  end if;

  update public.profiles
    set points = coalesce(points, 0) + 50
    where id = referrer.id
    returning * into referrer;

  insert into public.point_logs (user_id, amount, reason, balance_after)
  values (referrer.id, 50, '邀请好友奖励', referrer.points);

  update public.profiles
    set points = coalesce(points, 0) + 20
    where id = me.id
    returning * into me;

  insert into public.point_logs (user_id, amount, reason, balance_after)
  values (me.id, 20, '新用户邀请奖励', me.points);

  return me;
end;
$$;

revoke all on function public.process_referral_bonus(text) from public;
grant execute on function public.process_referral_bonus(text) to authenticated;

-- 5) 积分兑换 VIP
create or replace function public.redeem_vip_with_points(p_cost integer, p_days integer)
returns public.profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  me public.profiles;
  base_ts timestamptz;
  next_vip timestamptz;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  if p_cost is null or p_cost <= 0 or p_days is null or p_days <= 0 then
    raise exception 'invalid redeem params';
  end if;

  select * into me from public.profiles where id = auth.uid() for update;
  if me.id is null then
    raise exception 'profile not found';
  end if;
  if coalesce(me.points, 0) < p_cost then
    raise exception '积分不足';
  end if;

  base_ts := case
    when me.vip_expire_date is not null and me.vip_expire_date > now() then me.vip_expire_date
    else now()
  end;
  next_vip := base_ts + make_interval(days => p_days);

  update public.profiles
    set points = points - p_cost,
        vip_expire_date = next_vip,
        plan_type = 'vip'
    where id = me.id
    returning * into me;

  insert into public.point_logs (user_id, amount, reason, balance_after)
  values (me.id, -p_cost, '兑换 VIP ' || p_days || ' 天', me.points);

  return me;
end;
$$;

revoke all on function public.redeem_vip_with_points(integer, integer) from public;
grant execute on function public.redeem_vip_with_points(integer, integer) to authenticated;

-- 6) 激活码表（付费后发放）
create table if not exists public.activation_codes (
  id bigserial primary key,
  code text not null unique,
  grant_days integer not null check (grant_days > 0),
  is_used boolean not null default false,
  used_by uuid references auth.users (id),
  used_at timestamptz,
  note text,
  created_at timestamptz not null default now()
);

create index if not exists activation_codes_code_idx on public.activation_codes (code);
create index if not exists activation_codes_unused_idx on public.activation_codes (is_used) where is_used = false;

alter table public.activation_codes enable row level security;

-- 登录用户可查询未使用激活码（用于兑换前校验）；已使用码仅本人可见
drop policy if exists "activation_codes_select_redeemable" on public.activation_codes;
create policy "activation_codes_select_redeemable"
  on public.activation_codes for select
  to authenticated
  using (is_used = false or used_by = auth.uid());

drop policy if exists "activation_codes_update_claim" on public.activation_codes;
create policy "activation_codes_update_claim"
  on public.activation_codes for update
  to authenticated
  using (is_used = false)
  with check (is_used = true and used_by = auth.uid());

-- 示例激活码（可按需删除/替换）
insert into public.activation_codes (code, grant_days, note)
values
  ('DEMO-MONTH-30', 30, '测试月卡'),
  ('DEMO-YEAR-365', 365, '测试年卡')
on conflict (code) do nothing;

-- 7) 激活码兑换 RPC（推荐：原子领取 + 延长 VIP）
create or replace function public.redeem_activation_code(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  raw_code text := upper(trim(coalesce(p_code, '')));
  code_row public.activation_codes;
  me public.profiles;
  base_ts timestamptz;
  next_vip timestamptz;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  if raw_code = '' then
    raise exception '激活码无效或已被使用';
  end if;

  select * into code_row
  from public.activation_codes
  where upper(code) = raw_code
  for update;

  if code_row.id is null or code_row.is_used then
    raise exception '激活码无效或已被使用';
  end if;

  update public.activation_codes
    set is_used = true,
        used_by = auth.uid(),
        used_at = now()
    where id = code_row.id
      and is_used = false
    returning * into code_row;

  if code_row.id is null or not code_row.is_used then
    raise exception '激活码无效或已被使用';
  end if;

  select * into me from public.profiles where id = auth.uid() for update;
  if me.id is null then
    raise exception 'profile not found';
  end if;

  base_ts := case
    when me.vip_expire_date is not null and me.vip_expire_date > now() then me.vip_expire_date
    else now()
  end;
  next_vip := base_ts + make_interval(days => code_row.grant_days);

  update public.profiles
    set vip_expire_date = next_vip,
        plan_type = 'vip'
    where id = me.id
    returning * into me;

  return jsonb_build_object(
    'grant_days', code_row.grant_days,
    'profile', to_jsonb(me)
  );
end;
$$;

revoke all on function public.redeem_activation_code(text) from public;
grant execute on function public.redeem_activation_code(text) to authenticated;

-- 9) 用户课程库（字幕 JSON + 元数据；本地大体积音频存浏览器 IndexedDB）
create table if not exists public.courses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  title text not null default '未命名课程',
  audio_source_type text not null check (audio_source_type in ('local', 'url')),
  audio_url text,
  subtitle_data jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists courses_user_id_idx on public.courses (user_id);
create index if not exists courses_created_at_idx on public.courses (created_at desc);

alter table public.courses enable row level security;

drop policy if exists "courses_select_own" on public.courses;
create policy "courses_select_own"
  on public.courses for select
  to authenticated
  using (user_id = auth.uid());

drop policy if exists "courses_insert_own" on public.courses;
create policy "courses_insert_own"
  on public.courses for insert
  to authenticated
  with check (user_id = auth.uid());

drop policy if exists "courses_update_own" on public.courses;
create policy "courses_update_own"
  on public.courses for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists "courses_delete_own" on public.courses;
create policy "courses_delete_own"
  on public.courses for delete
  to authenticated
  using (user_id = auth.uid());

-- 10) AI 字幕（Edge Function transcribe-audio）积分原子扣减 / 失败退还
create or replace function public.deduct_points_for_asr(p_cost integer default 10)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  me public.profiles;
  cost integer := greatest(coalesce(p_cost, 10), 1);
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  select * into me from public.profiles where id = auth.uid() for update;
  if not found then
    raise exception 'profile not found';
  end if;

  if coalesce(me.points, 0) < cost then
    raise exception 'insufficient_points';
  end if;

  update public.profiles
    set points = coalesce(points, 0) - cost
    where id = me.id
    returning * into me;

  insert into public.point_logs (user_id, amount, reason, balance_after)
  values (me.id, -cost, 'AI 自动生成字幕', me.points);

  return jsonb_build_object(
    'points', me.points,
    'deducted', cost
  );
end;
$$;

create or replace function public.refund_points_for_asr(p_amount integer default 10, p_reason text default 'AI 字幕转写失败退还')
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  me public.profiles;
  amt integer := greatest(coalesce(p_amount, 10), 1);
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  update public.profiles
    set points = coalesce(points, 0) + amt
    where id = auth.uid()
    returning * into me;

  if not found then
    raise exception 'profile not found';
  end if;

  insert into public.point_logs (user_id, amount, reason, balance_after)
  values (me.id, amt, coalesce(nullif(trim(p_reason), ''), 'AI 字幕转写失败退还'), me.points);

  return jsonb_build_object(
    'points', me.points,
    'refunded', amt
  );
end;
$$;

revoke all on function public.deduct_points_for_asr(integer) from public;
grant execute on function public.deduct_points_for_asr(integer) to authenticated;

revoke all on function public.refund_points_for_asr(integer, text) from public;
grant execute on function public.refund_points_for_asr(integer, text) to authenticated;
