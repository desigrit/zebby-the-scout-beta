-- Run once in the Supabase SQL editor. Browser clients have no ledger access.
create table if not exists public.zebby_wallets (
  user_id uuid primary key, balance bigint not null default 0, reserved bigint not null default 0,
  used bigint not null default 0, purchased bigint not null default 0, updated_at timestamptz not null default now(),
  check (reserved >= 0 and used >= 0 and purchased >= 0)
);
create table if not exists public.zebby_purchases (
  id uuid primary key, user_id uuid not null, pack text not null, cents integer not null check(cents > 0),
  amount bigint not null check(amount > 0), session_id text unique, payment_id text unique,
  paid boolean not null default false, reversed bigint not null default 0, disputed boolean not null default false,
  created_at timestamptz not null default now(), check(reversed >= 0 and reversed <= amount)
);
create table if not exists public.zebby_quotes (
  id uuid primary key, user_id uuid not null, model text not null, kind text not null check(kind in ('plan','match','resume','board_extract')),
  content_hash text not null, maximum bigint not null check(maximum > 0), price_version text not null,
  thinking_level text not null default 'low' check(thinking_level in ('off','low','medium','high','xhigh','max')),
  expires_at timestamptz not null, claimed_by uuid, created_at timestamptz not null default now()
);
-- Upgrade existing deployments without changing wallet balances or stored results.
alter table public.zebby_quotes drop constraint if exists zebby_quotes_kind_check;
alter table public.zebby_quotes add constraint zebby_quotes_kind_check check(kind in ('plan','match','resume','board_extract'));
alter table public.zebby_quotes add column if not exists thinking_level text not null default 'low'
  check(thinking_level in ('off','low','medium','high','xhigh','max'));
-- Luna also supports Off. Broaden the existing check without changing saved quotes.
alter table public.zebby_quotes drop constraint if exists zebby_quotes_thinking_level_check;
alter table public.zebby_quotes add constraint zebby_quotes_thinking_level_check
  check(thinking_level in ('off','low','medium','high','xhigh','max'));
alter table public.zebby_quotes add column if not exists input_tokens integer check(input_tokens > 0);
alter table public.zebby_quotes add column if not exists output_limit integer check(output_limit > 0);
create table if not exists public.zebby_runs (
  id uuid primary key, user_id uuid not null, quote_id uuid not null references public.zebby_quotes(id),
  model text not null, kind text not null, maximum bigint not null, cost bigint not null default 0,
  status text not null check(status in ('reserved','completed','failed')), result jsonb,
  expires_at timestamptz not null default now() + interval '10 minutes', created_at timestamptz not null default now()
);
create table if not exists public.zebby_ledger (
  id bigint generated always as identity primary key, user_id uuid not null, reference uuid not null,
  kind text not null, delta bigint not null, created_at timestamptz not null default now()
);
alter table public.zebby_ledger drop constraint if exists zebby_ledger_reference_kind_delta_key;
create unique index if not exists zebby_ledger_once on public.zebby_ledger(reference,kind) where kind in ('purchase','analysis');
create table if not exists public.zebby_stripe_events (id text primary key, created_at timestamptz not null default now());
create index if not exists zebby_runs_user on public.zebby_runs(user_id,created_at desc);
create index if not exists zebby_purchase_user on public.zebby_purchases(user_id);

-- Guest wallet access is independent of Supabase Auth. Only hashes reach PostgreSQL.
-- Existing wallet UUIDs and their ledger entries are retained when old sessions migrate.
create table if not exists public.zebby_devices (
  id uuid primary key, wallet_id uuid not null references public.zebby_wallets(user_id),
  token_hash text not null unique check(token_hash ~ '^[a-f0-9]{64}$'),
  connection_hash text not null, name text not null check(length(name) between 1 and 80),
  created_at timestamptz not null default now(), last_seen_at timestamptz not null default now(), revoked_at timestamptz
);
create index if not exists zebby_devices_wallet on public.zebby_devices(wallet_id);
create table if not exists public.zebby_recovery_codes (
  wallet_id uuid primary key references public.zebby_wallets(user_id),
  code_hash text not null unique check(code_hash ~ '^[a-f0-9]{64}$'), version uuid not null default gen_random_uuid(), created_at timestamptz not null default now()
);
create table if not exists public.zebby_pairing_codes (
  wallet_id uuid primary key references public.zebby_wallets(user_id),
  code_hash text not null unique check(code_hash ~ '^[a-f0-9]{64}$'), expires_at timestamptz not null
);

create or replace function public.zebby_device_session(p_hash text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare d zebby_devices;
begin
  select * into d from zebby_devices where token_hash=p_hash and revoked_at is null;
  if not found then return null; end if;
  update zebby_devices set last_seen_at=now() where id=d.id and last_seen_at<now()-interval '15 minutes' and revoked_at is null;
  return jsonb_build_object('walletId',d.wallet_id,'deviceId',d.id);
end $$;

create or replace function public.zebby_attach_device(p_user uuid,p_device uuid,p_hash text,p_name text,p_connection text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare d zebby_devices;
begin
  insert into zebby_wallets(user_id) values(p_user) on conflict do nothing;
  perform 1 from zebby_wallets where user_id=p_user for update;
  select * into d from zebby_devices where token_hash=p_hash;
  if found then
    if d.wallet_id<>p_user or d.revoked_at is not null or d.connection_hash<>p_connection then raise exception 'Device connection cannot be reused'; end if;
  else
    if (select count(*) from zebby_devices where wallet_id=p_user and revoked_at is null)>=20 then raise exception 'Disconnect an unused computer before adding another'; end if;
    insert into zebby_devices(id,wallet_id,token_hash,name,connection_hash) values(p_device,p_user,p_hash,p_name,p_connection) returning * into d;
  end if;
  return jsonb_build_object('walletId',d.wallet_id,'deviceId',d.id);
end $$;

create or replace function public.zebby_guest(p_device uuid,p_hash text,p_name text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare d zebby_devices;
begin
  -- Serialize retries by token, including two processes completing a lost response.
  perform pg_advisory_xact_lock(hashtextextended(p_hash,0));
  select * into d from zebby_devices where token_hash=p_hash;
  if found then
    if d.revoked_at is not null or d.connection_hash<>'guest' then raise exception 'Device connection cannot be reused'; end if;
    return jsonb_build_object('walletId',d.wallet_id,'deviceId',d.id);
  end if;
  return zebby_attach_device(gen_random_uuid(),p_device,p_hash,p_name,'guest');
end $$;

create or replace function public.zebby_recover_device(p_device uuid,p_hash text,p_name text,p_code text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare target uuid; d zebby_devices;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_hash,0));
  select * into d from zebby_devices where token_hash=p_hash;
  if found then
    if d.revoked_at is null and d.connection_hash='recovery:'||p_code then return jsonb_build_object('walletId',d.wallet_id,'deviceId',d.id); end if;
    return null;
  end if;
  select wallet_id into target from zebby_recovery_codes where code_hash=p_code;
  if not found then return null; end if;
  perform 1 from zebby_wallets where user_id=target for update;
  -- Regeneration and recovery lock the same wallet before checking the current code.
  if not exists(select 1 from zebby_recovery_codes where wallet_id=target and code_hash=p_code) then return null; end if;
  return zebby_attach_device(target,p_device,p_hash,p_name,'recovery:'||p_code);
end $$;

create or replace function public.zebby_connect_device(p_device uuid,p_hash text,p_name text,p_code text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare target uuid; d zebby_devices;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_hash,0));
  select * into d from zebby_devices where token_hash=p_hash;
  if found then
    if d.revoked_at is null and d.connection_hash='pairing:'||p_code then return jsonb_build_object('walletId',d.wallet_id,'deviceId',d.id); end if;
    return null;
  end if;
  select wallet_id into target from zebby_pairing_codes where code_hash=p_code and expires_at>now();
  if not found then return null; end if;
  perform 1 from zebby_wallets where user_id=target for update;
  delete from zebby_pairing_codes where wallet_id=target and code_hash=p_code and expires_at>now();
  if not found then return null; end if;
  -- Consumption and device creation commit together. A retry with the same device is safe.
  return zebby_attach_device(target,p_device,p_hash,p_name,'pairing:'||p_code);
end $$;

create or replace function public.zebby_wallet_access(p_user uuid,p_current uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare devices jsonb;
begin
  select coalesce(jsonb_agg(item),'[]') into devices from (select jsonb_build_object(
    'id',id,'name',name,'createdAt',created_at,'lastSeenAt',last_seen_at,'current',coalesce(id=p_current,false)) item
    from zebby_devices where wallet_id=p_user and revoked_at is null order by created_at) records;
  return jsonb_build_object('hasRecoveryCode',exists(select 1 from zebby_recovery_codes where wallet_id=p_user),
    'recoveryVersion',(select version from zebby_recovery_codes where wallet_id=p_user),'devices',devices);
end $$;

create or replace function public.zebby_set_recovery(p_user uuid,p_code text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform 1 from zebby_wallets where user_id=p_user for update;
  if not found then raise exception 'Wallet not found'; end if;
  insert into zebby_recovery_codes(wallet_id,code_hash) values(p_user,p_code)
    on conflict(wallet_id) do update set version=case when zebby_recovery_codes.code_hash=excluded.code_hash then zebby_recovery_codes.version else gen_random_uuid() end,
      code_hash=excluded.code_hash,created_at=now();
  return jsonb_build_object('version',(select version from zebby_recovery_codes where wallet_id=p_user));
end $$;

create or replace function public.zebby_start_pairing(p_user uuid,p_code text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare expiry timestamptz:=now()+interval '10 minutes';
begin
  perform 1 from zebby_wallets where user_id=p_user for update;
  if not found then raise exception 'Wallet not found'; end if;
  insert into zebby_pairing_codes(wallet_id,code_hash,expires_at) values(p_user,p_code,expiry)
    on conflict(wallet_id) do update set code_hash=excluded.code_hash,expires_at=excluded.expires_at;
  return jsonb_build_object('expiresAt',expiry);
end $$;

create or replace function public.zebby_cancel_pairing(p_user uuid,p_code text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform 1 from zebby_wallets where user_id=p_user for update;
  delete from zebby_pairing_codes where wallet_id=p_user and code_hash=p_code;
end $$;

create or replace function public.zebby_remove_device(p_user uuid,p_device uuid) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform 1 from zebby_wallets where user_id=p_user for update;
  update zebby_devices set revoked_at=now() where wallet_id=p_user and id=p_device and revoked_at is null;
  return found;
end $$;

create or replace function public.zebby_wallet(p_user uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare w zebby_wallets; recent jsonb; daily jsonb; today date := (now() at time zone 'UTC')::date;
begin
  insert into zebby_wallets(user_id) values(p_user) on conflict do nothing;
  select * into w from zebby_wallets where user_id = p_user;
  select coalesce(jsonb_agg(item),'[]') into recent from (select jsonb_build_object(
    'id',id,'model',model,'kind',kind,'cost',cost,'createdAt',created_at) item
    from zebby_runs where user_id=p_user and status='completed' order by created_at desc,id desc limit 10) r;
  with usage as (
    select (created_at at time zone 'UTC')::date as usage_day, count(*) as analyses, sum(cost) as cost
    from zebby_runs where user_id=p_user and status='completed'
      and created_at >= ((today-83)::timestamp at time zone 'UTC')
      and created_at < ((today+1)::timestamp at time zone 'UTC')
    group by 1
  ), days as (select today-83+offset_day as usage_day from generate_series(0,83) offset_day)
  select jsonb_agg(jsonb_build_object('date',to_char(days.usage_day,'YYYY-MM-DD'),
    'count',coalesce(usage.analyses,0),'cost',coalesce(usage.cost,0)) order by days.usage_day)
    into daily from days left join usage using(usage_day);
  return jsonb_build_object('balance',w.balance,'reserved',w.reserved,'used',w.used,'purchased',w.purchased,
    'updatedAt',w.updated_at,'recent',recent,'dailyUsage',daily,
    'completedAnalyses',(select count(*) from zebby_runs where user_id=p_user and status='completed'),
    'astraUnlocked',exists(select 1 from zebby_purchases where user_id=p_user and paid
      and cents>=2000 and reversed<amount and not disputed));
end $$;

create or replace function public.zebby_reserve(p_user uuid,p_id uuid,p_quote uuid,p_hash text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare w zebby_wallets; q zebby_quotes; r zebby_runs;
begin
  insert into zebby_wallets(user_id) values(p_user) on conflict do nothing;
  select * into w from zebby_wallets where user_id=p_user for update;
  select * into r from zebby_runs where id=p_id;
  if found then
    if r.user_id <> p_user or r.quote_id <> p_quote then raise exception 'Request already belongs to another analysis'; end if;
    return to_jsonb(r) || jsonb_build_object('fresh',false);
  end if;
  select * into q from zebby_quotes where id=p_quote for update;
  if not found or q.user_id<>p_user or q.content_hash<>p_hash then raise exception 'Invalid analysis quote'; end if;
  if q.expires_at<=now() or q.claimed_by is not null then raise exception 'Analysis quote expired or already used'; end if;
  if exists(select 1 from zebby_purchases where user_id=p_user and disputed) then raise exception 'Contact support about a disputed payment'; end if;
  if q.model in ('gpt-6-astra','claude-opus-5-5') and not exists(select 1 from zebby_purchases where user_id=p_user
    and paid and cents>=2000 and reversed<amount and not disputed) then
    raise exception 'GPT-6 Astra and Claude Opus are included with a $20, $50 or $100 pack';
  end if;
  if w.balance-w.reserved<q.maximum then raise exception 'Not enough credits for this analysis'; end if;
  update zebby_quotes set claimed_by=p_id where id=p_quote;
  update zebby_wallets set reserved=reserved+q.maximum,updated_at=now() where user_id=p_user;
  insert into zebby_runs(id,user_id,quote_id,model,kind,maximum,status)
    values(p_id,p_user,p_quote,q.model,q.kind,q.maximum,'reserved') returning * into r;
  return to_jsonb(r) || jsonb_build_object('fresh',true);
end $$;

create or replace function public.zebby_finish(p_user uuid,p_id uuid,p_cost bigint,p_result jsonb,p_success boolean)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare r zebby_runs;
begin
  perform 1 from zebby_wallets where user_id=p_user for update;
  select * into r from zebby_runs where id=p_id and user_id=p_user for update;
  if not found then raise exception 'Analysis not found'; end if;
  if r.status <> 'reserved' then return to_jsonb(r); end if;
  if p_cost<0 or p_cost>r.maximum or (p_success and p_result is null) then raise exception 'Invalid analysis settlement'; end if;
  if not p_success then p_cost:=0; p_result:=null; end if;
  update zebby_wallets set reserved=reserved-r.maximum,balance=balance-p_cost,used=used+p_cost,updated_at=now() where user_id=p_user;
  update zebby_runs set cost=p_cost,result=p_result,status=case when p_success then 'completed' else 'failed' end
    where id=p_id returning * into r;
  if p_success then insert into zebby_ledger(user_id,reference,kind,delta) values(p_user,p_id,'analysis',-p_cost); end if;
  return to_jsonb(r);
end $$;

create or replace function public.zebby_payment(p_event text,p_purchase uuid,p_session text,p_payment text,p_cents integer)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare p zebby_purchases;
begin
  select * into p from zebby_purchases where id=p_purchase;
  if not found then raise exception 'Purchase not found'; end if;
  insert into zebby_wallets(user_id) values(p.user_id) on conflict do nothing;
  perform 1 from zebby_wallets where user_id=p.user_id for update;
  select * into p from zebby_purchases where id=p_purchase for update;
  if p.session_id is distinct from p_session or p.cents<>p_cents or p_payment is null then raise exception 'Payment does not match purchase'; end if;
  insert into zebby_stripe_events(id) values(p_event) on conflict do nothing;
  if not found or p.paid then return false; end if;
  update zebby_purchases set paid=true,payment_id=p_payment where id=p_purchase;
  update zebby_wallets set balance=balance+p.amount,purchased=purchased+p.amount,updated_at=now() where user_id=p.user_id;
  insert into zebby_ledger(user_id,reference,kind,delta) values(p.user_id,p.id,'purchase',p.amount);
  return true;
end $$;

create or replace function public.zebby_reverse(p_event text,p_payment text,p_refunded integer,p_disputed boolean)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare p zebby_purchases; target bigint; change bigint;
begin
  select * into p from zebby_purchases where payment_id=p_payment and paid;
  if not found then raise exception 'Paid purchase not found'; end if;
  perform 1 from zebby_wallets where user_id=p.user_id for update;
  select * into p from zebby_purchases where id=p.id for update;
  insert into zebby_stripe_events(id) values(p_event) on conflict do nothing;
  if not found then return false; end if;
  if p_refunded<0 or p_refunded>p.cents then raise exception 'Invalid refund amount'; end if;
  target:=floor(p.amount::numeric*p_refunded/p.cents);
  change:=greatest(0,target-p.reversed);
  update zebby_purchases set reversed=reversed+change,disputed=p_disputed where id=p.id;
  update zebby_wallets set balance=balance-change,updated_at=now() where user_id=p.user_id;
  if change>0 then insert into zebby_ledger(user_id,reference,kind,delta) values(p.user_id,p.id,'refund',-change); end if;
  return true;
end $$;

create or replace function public.zebby_cleanup() returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare r record;
begin
  for r in select id,user_id from zebby_runs where status='reserved' and expires_at<now() loop
    perform zebby_finish(r.user_id,r.id,0,null,false);
  end loop;
  update zebby_runs set result=null where created_at<now()-interval '24 hours' and result is not null;
  delete from zebby_quotes where expires_at<now()-interval '1 day' and claimed_by is null;
  delete from zebby_pairing_codes where expires_at<now();
end $$;

alter table public.zebby_wallets enable row level security;
alter table public.zebby_purchases enable row level security;
alter table public.zebby_quotes enable row level security;
alter table public.zebby_runs enable row level security;
alter table public.zebby_ledger enable row level security;
alter table public.zebby_stripe_events enable row level security;
revoke all on public.zebby_wallets,public.zebby_purchases,public.zebby_quotes,public.zebby_runs,public.zebby_ledger,public.zebby_stripe_events from anon,authenticated;
revoke all on function public.zebby_wallet(uuid),public.zebby_reserve(uuid,uuid,uuid,text),
  public.zebby_finish(uuid,uuid,bigint,jsonb,boolean),public.zebby_payment(text,uuid,text,text,integer),
  public.zebby_reverse(text,text,integer,boolean),public.zebby_cleanup() from public,anon,authenticated;
grant execute on function public.zebby_wallet(uuid),public.zebby_reserve(uuid,uuid,uuid,text),
  public.zebby_finish(uuid,uuid,bigint,jsonb,boolean),public.zebby_payment(text,uuid,text,text,integer),
  public.zebby_reverse(text,text,integer,boolean),public.zebby_cleanup() to service_role;
grant all on public.zebby_wallets,public.zebby_purchases,public.zebby_quotes,public.zebby_runs,public.zebby_ledger,public.zebby_stripe_events to service_role;
grant usage,select on sequence public.zebby_ledger_id_seq to service_role;

alter table public.zebby_devices enable row level security;
alter table public.zebby_recovery_codes enable row level security;
alter table public.zebby_pairing_codes enable row level security;
revoke all on public.zebby_devices,public.zebby_recovery_codes,public.zebby_pairing_codes from public,anon,authenticated;
revoke all on function public.zebby_device_session(text),public.zebby_attach_device(uuid,uuid,text,text,text),
  public.zebby_guest(uuid,text,text),public.zebby_recover_device(uuid,text,text,text),public.zebby_connect_device(uuid,text,text,text),
  public.zebby_wallet_access(uuid,uuid),public.zebby_set_recovery(uuid,text),public.zebby_start_pairing(uuid,text),
  public.zebby_cancel_pairing(uuid,text),public.zebby_remove_device(uuid,uuid) from public,anon,authenticated;
grant all on public.zebby_devices,public.zebby_recovery_codes,public.zebby_pairing_codes to service_role;
grant execute on function public.zebby_device_session(text),public.zebby_attach_device(uuid,uuid,text,text,text),
  public.zebby_guest(uuid,text,text),public.zebby_recover_device(uuid,text,text,text),public.zebby_connect_device(uuid,text,text,text),
  public.zebby_wallet_access(uuid,uuid),public.zebby_set_recovery(uuid,text),public.zebby_start_pairing(uuid,text),
  public.zebby_cancel_pairing(uuid,text),public.zebby_remove_device(uuid,uuid) to service_role;
