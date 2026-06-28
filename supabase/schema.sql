-- NairaX Phase 1 Supabase schema
-- Run this in the Supabase SQL editor before using the app.

create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null,
  phone text not null unique,
  account_number text not null unique check (char_length(account_number) = 10),
  wallet_address text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.balances (
  id bigserial primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  asset_code text not null check (asset_code in ('NGN', 'USDCX', 'MON', 'ETHX', 'cirBTCX', 'EURCX')),
  available numeric(36, 18) not null default 0 check (available >= 0),
  locked numeric(36, 18) not null default 0 check (locked >= 0),
  ngn_value numeric(36, 2) not null default 0 check (ngn_value >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, asset_code)
);

create index if not exists balances_user_id_idx on public.balances(user_id);

create table if not exists public.custodial_wallets (
  id bigserial primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  wallet_address text not null unique,
  encrypted_private_key text not null,
  chain_type text not null default 'EVM',
  created_at timestamptz not null default now(),
  unique (user_id, chain_type)
);

create index if not exists custodial_wallets_user_id_idx on public.custodial_wallets(user_id);

create table if not exists public.ledger_accounts (
  id uuid primary key default gen_random_uuid(),
  owner_type text not null check (owner_type in ('customer', 'platform')),
  owner_id uuid references public.profiles(id) on delete cascade,
  account_type text not null check (account_type in (
    'customer_custody',
    'treasury_settlement',
    'fee_revenue',
    'reserve_shock',
    'simulated_ngn_corporate_reserve',
    'demo_ngn_mint_source',
    'demo_ngn_burn_sink',
    'simulated_external_bank_settlement_sink',
    'statutory_fee_payable',
    'gas_fee_recovery',
    'customer_funds_pool',
    'simulated_external_payout_expense',
    'demo_crypto_faucet_source'
  )),
  asset_code text not null check (asset_code in ('NGN', 'USDCX', 'MON', 'ETHX', 'cirBTCX', 'EURCX')),
  account_name text not null,
  is_system boolean not null default false,
  created_at timestamptz not null default now(),
  constraint ledger_accounts_owner_scope check (
    (owner_type = 'customer' and owner_id is not null and account_type = 'customer_custody' and is_system = false)
    or
    (owner_type = 'platform' and owner_id is null and account_type <> 'customer_custody' and is_system = true)
  )
);

create unique index if not exists ledger_accounts_customer_asset_unique
on public.ledger_accounts(owner_id, asset_code)
where owner_type = 'customer';

create unique index if not exists ledger_accounts_owner_scope_unique
on public.ledger_accounts(owner_type, owner_id, account_type, asset_code);

create unique index if not exists ledger_accounts_platform_type_asset_unique
on public.ledger_accounts(account_type, asset_code)
where owner_type = 'platform';

create table if not exists public.ledger_transactions (
  id uuid primary key default gen_random_uuid(),
  transaction_type text not null check (transaction_type in (
    'signup_account_opening',
    'external_crypto_deposit',
    'external_crypto_withdrawal',
    'internal_transfer',
    'swap',
    'fee_assessment',
    'reserve_allocation',
    'simulated_ngn_deposit',
    'simulated_external_bank_transfer',
    'manual_adjustment'
  )),
  status text not null default 'posted' check (status in ('pending', 'posted', 'reversed')),
  user_id uuid references public.profiles(id) on delete set null,
  asset_code text check (asset_code in ('NGN', 'USDCX', 'MON', 'ETHX', 'cirBTCX', 'EURCX')),
  amount numeric(36, 18) check (amount >= 0),
  tx_hash text,
  description text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists ledger_transactions_user_id_idx on public.ledger_transactions(user_id);
create index if not exists ledger_transactions_tx_hash_idx on public.ledger_transactions(tx_hash);

create table if not exists public.ledger_entries (
  id bigserial primary key,
  transaction_id uuid not null references public.ledger_transactions(id) on delete cascade,
  account_id uuid not null references public.ledger_accounts(id),
  user_id uuid references public.profiles(id) on delete set null,
  entry_role text not null check (entry_role in (
    'user_debit',
    'user_credit',
    'treasury_movement',
    'fee_movement',
    'reserve_movement',
    'corporate_reserve_movement',
    'demo_mint_movement',
    'demo_burn_movement',
    'external_bank_settlement_movement',
    'statutory_fee_movement',
    'gas_fee_movement',
    'demo_crypto_faucet_movement'
  )),
  direction text not null check (direction in ('debit', 'credit')),
  asset_code text not null check (asset_code in ('NGN', 'USDCX', 'MON', 'ETHX', 'cirBTCX', 'EURCX')),
  amount numeric(36, 18) not null check (amount > 0),
  memo text,
  created_at timestamptz not null default now()
);

create index if not exists ledger_entries_transaction_id_idx on public.ledger_entries(transaction_id);
create index if not exists ledger_entries_account_id_idx on public.ledger_entries(account_id);
create index if not exists ledger_entries_user_id_idx on public.ledger_entries(user_id);

create table if not exists public.ledger_account_balances (
  account_id uuid primary key references public.ledger_accounts(id) on delete cascade,
  asset_code text not null check (asset_code in ('NGN', 'USDCX', 'MON', 'ETHX', 'cirBTCX', 'EURCX')),
  available numeric(36, 18) not null default 0 check (available >= 0),
  updated_at timestamptz not null default now()
);

create table if not exists public.user_transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  ledger_transaction_id uuid references public.ledger_transactions(id) on delete set null,
  direction text not null check (direction in ('in', 'out')),
  title text not null,
  amount numeric(36, 2) not null check (amount >= 0),
  note text,
  counterparty_name text,
  counterparty_account text,
  created_at timestamptz not null default now()
);

create index if not exists user_transactions_user_id_created_at_idx
on public.user_transactions(user_id, created_at desc);

drop view if exists public.ledger_transaction_movements;
create view public.ledger_transaction_movements as
select
  t.id as transaction_id,
  t.transaction_type,
  t.status,
  t.user_id,
  t.asset_code as primary_asset_code,
  t.amount as primary_amount,
  t.tx_hash,
  t.description,
  coalesce(sum(e.amount) filter (where e.entry_role = 'user_debit' and e.direction = 'debit'), 0) as user_debit,
  coalesce(sum(e.amount) filter (where e.entry_role = 'user_credit' and e.direction = 'credit'), 0) as user_credit,
  coalesce(sum(e.amount) filter (where e.entry_role = 'treasury_movement' and e.direction = 'debit'), 0) as treasury_debit,
  coalesce(sum(e.amount) filter (where e.entry_role = 'treasury_movement' and e.direction = 'credit'), 0) as treasury_credit,
  coalesce(sum(e.amount) filter (where e.entry_role = 'fee_movement' and e.direction = 'debit'), 0) as fee_debit,
  coalesce(sum(e.amount) filter (where e.entry_role = 'fee_movement' and e.direction = 'credit'), 0) as fee_credit,
  coalesce(sum(e.amount) filter (where e.entry_role = 'reserve_movement' and e.direction = 'debit'), 0) as reserve_debit,
  coalesce(sum(e.amount) filter (where e.entry_role = 'reserve_movement' and e.direction = 'credit'), 0) as reserve_credit,
  coalesce(sum(e.amount) filter (where e.entry_role = 'corporate_reserve_movement' and e.direction = 'debit'), 0) as corporate_reserve_debit,
  coalesce(sum(e.amount) filter (where e.entry_role = 'corporate_reserve_movement' and e.direction = 'credit'), 0) as corporate_reserve_credit,
  coalesce(sum(e.amount) filter (where e.entry_role = 'demo_mint_movement' and e.direction = 'debit'), 0) as demo_mint_debit,
  coalesce(sum(e.amount) filter (where e.entry_role = 'demo_mint_movement' and e.direction = 'credit'), 0) as demo_mint_credit,
  coalesce(sum(e.amount) filter (where e.entry_role = 'demo_burn_movement' and e.direction = 'debit'), 0) as demo_burn_debit,
  coalesce(sum(e.amount) filter (where e.entry_role = 'demo_burn_movement' and e.direction = 'credit'), 0) as demo_burn_credit,
  coalesce(sum(e.amount) filter (where e.entry_role = 'external_bank_settlement_movement' and e.direction = 'debit'), 0) as external_bank_settlement_debit,
  coalesce(sum(e.amount) filter (where e.entry_role = 'external_bank_settlement_movement' and e.direction = 'credit'), 0) as external_bank_settlement_credit,
  t.created_at
from public.ledger_transactions t
left join public.ledger_entries e on e.transaction_id = t.id
group by t.id;

create or replace function public.seed_platform_ledger_accounts()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  asset text;
begin
  foreach asset in array array['NGN', 'USDCX', 'MON', 'ETHX', 'cirBTCX', 'EURCX']
  loop
    insert into public.ledger_accounts (owner_type, account_type, asset_code, account_name, is_system)
    values
      ('platform', 'treasury_settlement', asset, 'NairaX Treasury/Settlement - ' || asset, true),
      ('platform', 'fee_revenue', asset, 'NairaX Fee Revenue - ' || asset, true),
      ('platform', 'reserve_shock', asset, 'NairaX Reserve/Shock Fund - ' || asset, true)
    on conflict do nothing;
  end loop;

  insert into public.ledger_accounts (owner_type, account_type, asset_code, account_name, is_system)
  values
    ('platform', 'simulated_ngn_corporate_reserve', 'NGN', 'NairaX Simulated NGN Corporate Reserve', true),
    ('platform', 'demo_ngn_mint_source', 'NGN', 'Demo NGN Funding Source', true),
    ('platform', 'demo_ngn_burn_sink', 'NGN', 'Demo NGN Burn Sink', true),
    ('platform', 'simulated_external_bank_settlement_sink', 'NGN', 'Simulated External Bank Settlement Sink', true)
  on conflict do nothing;
end;
$$;

-- Final SECURITY DEFINER hardening.
-- Keep this after function definitions so browser roles cannot execute backend RPCs.
update public.ledger_accounts
set account_name = 'CBN Statutory Fee Payable - NGN'
where owner_type = 'platform'
  and account_type = 'statutory_fee_payable'
  and asset_code = 'NGN';

-- Admin crypto fee settlement batches.
-- Ledger fee revenue remains all-time accounting; this table tracks which crypto
-- fees have already been moved from Treasury Wallet to the real Fee Wallet.
create table if not exists public.crypto_fee_settlements (
  id uuid primary key default gen_random_uuid(),
  admin_user_id uuid references public.profiles(id) on delete set null,
  network text not null default 'Arc Testnet',
  asset_symbol text not null,
  token_contract text,
  amount numeric(36, 18) not null check (amount > 0),
  treasury_wallet_address text,
  fee_wallet_address text,
  tx_hash text,
  status text not null default 'pending' check (status in ('pending', 'completed', 'failed')),
  failure_reason text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists crypto_fee_settlements_asset_status_idx
on public.crypto_fee_settlements(asset_symbol, status, created_at desc);

alter table public.crypto_fee_settlements enable row level security;
revoke all on public.crypto_fee_settlements from anon, authenticated;
grant all on public.crypto_fee_settlements to service_role;

alter view if exists public.ledger_transaction_movements set (security_invoker = true);
revoke all on public.ledger_transaction_movements from anon, authenticated;
revoke execute on all functions in schema public from anon, authenticated;
grant execute on all functions in schema public to service_role;
alter default privileges in schema public revoke execute on functions from anon, authenticated;
alter default privileges in schema public grant execute on functions to service_role;

-- Security hardening and Smart Spend.
-- Views are not used by the browser; keep them invoker-scoped and revoke direct frontend access.
alter view if exists public.ledger_transaction_movements set (security_invoker = true);
revoke all on public.ledger_transaction_movements from anon, authenticated;

alter table public.ledger_transactions drop constraint if exists ledger_transactions_transaction_type_check;
alter table public.ledger_transactions add constraint ledger_transactions_transaction_type_check
check (transaction_type in (
  'signup_account_opening',
  'external_crypto_deposit',
  'external_crypto_withdrawal',
  'internal_transfer',
  'swap',
  'ngn_crypto_conversion',
  'crypto_ngn_conversion',
  'smart_spend',
  'fee_assessment',
  'reserve_allocation',
  'simulated_ngn_deposit',
  'simulated_external_bank_transfer',
  'manual_adjustment'
));

create or replace function public.smart_spend_execute(
  p_sender_user_id uuid,
  p_recipient_type text,
  p_recipient_identifier text,
  p_bank_name text,
  p_recipient_name text,
  p_receive_asset text,
  p_receive_amount numeric,
  p_source_asset text,
  p_source_amount numeric,
  p_total_deducted numeric,
  p_platform_fee_amount numeric,
  p_statutory_fee_amount numeric,
  p_statutory_fee_source_amount numeric,
  p_rate_used numeric,
  p_spread_ngn numeric,
  p_applied_ngn_usd_rate numeric,
  p_rate_source text,
  p_conversion_required boolean,
  p_narration text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  source_asset text := case when upper(p_source_asset) = 'CIRBTCX' then 'cirBTCX' else upper(p_source_asset) end;
  receive_asset text := case when upper(p_receive_asset) = 'CIRBTCX' then 'cirBTCX' else upper(p_receive_asset) end;
  clean_identifier text := regexp_replace(coalesce(p_recipient_identifier, ''), '\D', '', 'g');
  sender public.profiles%rowtype;
  receiver public.profiles%rowtype;
  sender_source_account_id uuid;
  receiver_account_id uuid;
  treasury_source_account_id uuid;
  treasury_receive_account_id uuid;
  fee_account_id uuid;
  statutory_account_id uuid;
  bank_sink_account_id uuid;
  sender_available numeric(36, 18);
  tx_id uuid;
  statutory_source numeric(36, 18) := coalesce(p_statutory_fee_source_amount, 0);
  platform_fee numeric(36, 18) := coalesce(p_platform_fee_amount, 0);
  statutory_fee numeric(36, 18) := coalesce(p_statutory_fee_amount, 0);
begin
  if p_recipient_type not in ('nairax_user', 'external_bank', 'bill_payment') then
    raise exception 'unsupported Smart Spend recipient type';
  end if;

  if source_asset not in ('NGN', 'USDCX', 'MON', 'ETHX', 'cirBTCX', 'EURCX')
     or receive_asset not in ('NGN', 'USDCX', 'MON', 'ETHX', 'cirBTCX', 'EURCX') then
    raise exception 'unsupported Smart Spend asset';
  end if;

  if p_recipient_type in ('external_bank', 'bill_payment') and receive_asset <> 'NGN' then
    raise exception 'external bank and bill payment Smart Spend must settle NGN';
  end if;

  if p_receive_amount <= 0 or p_source_amount <= 0 or p_total_deducted <= 0 then
    raise exception 'invalid Smart Spend amount';
  end if;

  select * into sender from public.profiles where id = p_sender_user_id;
  if sender.id is null then raise exception 'sender profile not found'; end if;

  if p_recipient_type = 'nairax_user' then
    select * into receiver
    from public.profiles
    where account_number = clean_identifier
       or regexp_replace(phone, '\D', '', 'g') = clean_identifier
       or (char_length(clean_identifier) = 11 and left(clean_identifier, 1) = '0' and account_number = substring(clean_identifier from 2 for 10))
    limit 1;
    if receiver.id is null then raise exception 'NairaX recipient not found'; end if;
    if receiver.id = p_sender_user_id then raise exception 'cannot send to yourself'; end if;
  elsif p_recipient_type = 'external_bank' and length(clean_identifier) <> 10 then
    raise exception 'enter a valid 10-digit destination account number';
  end if;

  perform public.seed_conversion_treasury_liquidity();
  perform public.create_default_balances(p_sender_user_id);
  perform public.create_customer_custody_ledger_accounts(p_sender_user_id);
  if receiver.id is not null then
    perform public.create_default_balances(receiver.id);
    perform public.create_customer_custody_ledger_accounts(receiver.id);
  end if;

  select id into sender_source_account_id
  from public.ledger_accounts
  where owner_type = 'customer' and owner_id = p_sender_user_id and account_type = 'customer_custody' and asset_code = source_asset
  limit 1;

  if p_recipient_type = 'nairax_user' then
    select id into receiver_account_id
    from public.ledger_accounts
    where owner_type = 'customer' and owner_id = receiver.id and account_type = 'customer_custody' and asset_code = receive_asset
    limit 1;
  elsif p_recipient_type = 'external_bank' then
    select id into bank_sink_account_id
    from public.ledger_accounts
    where owner_type = 'platform' and account_type = 'simulated_external_bank_settlement_sink' and asset_code = 'NGN'
    limit 1;
  else
    select id into bank_sink_account_id
    from public.ledger_accounts
    where owner_type = 'platform' and account_type = 'demo_ngn_burn_sink' and asset_code = 'NGN'
    limit 1;
  end if;

  select id into treasury_source_account_id
  from public.ledger_accounts
  where owner_type = 'platform' and account_type = 'treasury_settlement' and asset_code = source_asset
  limit 1;

  select id into treasury_receive_account_id
  from public.ledger_accounts
  where owner_type = 'platform' and account_type = 'treasury_settlement' and asset_code = receive_asset
  limit 1;

  select id into fee_account_id
  from public.ledger_accounts
  where owner_type = 'platform' and account_type = 'fee_revenue' and asset_code = source_asset
  limit 1;

  select id into statutory_account_id
  from public.ledger_accounts
  where owner_type = 'platform' and account_type = 'statutory_fee_payable' and asset_code = 'NGN'
  limit 1;

  if sender_source_account_id is null or fee_account_id is null or statutory_account_id is null then
    raise exception 'required Smart Spend ledger accounts are missing';
  end if;
  if p_recipient_type = 'nairax_user' and receiver_account_id is null then
    raise exception 'receiver ledger account is missing';
  end if;
  if p_recipient_type in ('external_bank', 'bill_payment') and bank_sink_account_id is null then
    raise exception 'settlement ledger account is missing';
  end if;

  select available into sender_available
  from public.balances
  where user_id = p_sender_user_id and asset_code = source_asset
  for update;

  if coalesce(sender_available, 0) < p_total_deducted then
    raise exception 'insufficient % balance. Total required is %', source_asset, p_total_deducted;
  end if;

  update public.balances
  set available = available - p_total_deducted,
      ngn_value = case when source_asset = 'NGN' then greatest(0, ngn_value - p_total_deducted) else ngn_value end,
      updated_at = now()
  where user_id = p_sender_user_id and asset_code = source_asset;

  update public.ledger_account_balances
  set available = available - p_total_deducted, updated_at = now()
  where account_id = sender_source_account_id;

  if p_recipient_type = 'nairax_user' then
    update public.balances
    set available = available + p_receive_amount,
        ngn_value = case when receive_asset = 'NGN' then ngn_value + p_receive_amount else ngn_value end,
        updated_at = now()
    where user_id = receiver.id and asset_code = receive_asset;

    update public.ledger_account_balances
    set available = available + p_receive_amount, updated_at = now()
    where account_id = receiver_account_id;
  else
    update public.ledger_account_balances
    set available = available + p_receive_amount, updated_at = now()
    where account_id = bank_sink_account_id;
  end if;

  if source_asset <> receive_asset then
    if treasury_source_account_id is null or treasury_receive_account_id is null then
      raise exception 'required treasury conversion accounts are missing';
    end if;

    update public.ledger_account_balances
    set available = available + p_source_amount + case when source_asset <> 'NGN' then statutory_source else 0 end,
        updated_at = now()
    where account_id = treasury_source_account_id;

    update public.ledger_account_balances
    set available = available - (p_receive_amount + case when receive_asset = 'NGN' then statutory_fee else 0 end),
        updated_at = now()
    where account_id = treasury_receive_account_id;
  end if;

  if platform_fee > 0 then
    update public.ledger_account_balances
    set available = available + platform_fee, updated_at = now()
    where account_id = fee_account_id;
  end if;

  if statutory_fee > 0 then
    update public.ledger_account_balances
    set available = available + statutory_fee, updated_at = now()
    where account_id = statutory_account_id;
  end if;

  insert into public.ledger_transactions (
    transaction_type, status, user_id, asset_code, amount, description, metadata
  )
  values (
    'smart_spend',
    'posted',
    p_sender_user_id,
    source_asset,
    p_receive_amount,
    'Smart Spend / Auto-Conversion',
    jsonb_build_object(
      'recipient_type', p_recipient_type,
      'recipient_identifier', clean_identifier,
      'bank_name', p_bank_name,
      'bill_provider', p_bank_name,
      'receive_asset', receive_asset,
      'receive_amount', p_receive_amount,
      'source_asset', source_asset,
      'source_amount', p_source_amount,
      'total_deducted', p_total_deducted,
      'platform_fee_amount', platform_fee,
      'statutory_fee_amount', statutory_fee,
      'statutory_fee_source_amount', statutory_source,
      'rate_used', p_rate_used,
      'spread_ngn', p_spread_ngn,
      'applied_ngn_usd_rate', p_applied_ngn_usd_rate,
      'rate_source', p_rate_source,
      'conversion_required', p_conversion_required,
      'narration', p_narration
    )
  )
  returning id into tx_id;

  insert into public.ledger_entries (transaction_id, account_id, user_id, entry_role, direction, asset_code, amount, memo)
  values (tx_id, sender_source_account_id, p_sender_user_id, 'user_debit', 'debit', source_asset, p_total_deducted, 'Smart Spend debit from selected source asset');

  if p_recipient_type = 'nairax_user' then
    insert into public.ledger_entries (transaction_id, account_id, user_id, entry_role, direction, asset_code, amount, memo)
    values (tx_id, receiver_account_id, receiver.id, 'user_credit', 'credit', receive_asset, p_receive_amount, 'Smart Spend receiver credit');
  else
    insert into public.ledger_entries (transaction_id, account_id, user_id, entry_role, direction, asset_code, amount, memo)
    values (
      tx_id,
      bank_sink_account_id,
      null,
      case when p_recipient_type = 'bill_payment' then 'demo_burn_movement' else 'external_bank_settlement_movement' end,
      'credit',
      'NGN',
      p_receive_amount,
      case when p_recipient_type = 'bill_payment' then 'Smart Spend simulated bill payment settlement' else 'Smart Spend simulated external bank settlement' end
    );
  end if;

  if source_asset <> receive_asset then
    insert into public.ledger_entries (transaction_id, account_id, user_id, entry_role, direction, asset_code, amount, memo)
    values
      (tx_id, treasury_source_account_id, null, 'treasury_movement', 'credit', source_asset, p_source_amount, 'Smart Spend source asset settlement'),
      (tx_id, treasury_receive_account_id, null, 'treasury_movement', 'debit', receive_asset, p_receive_amount, 'Smart Spend destination asset settlement');

    if source_asset <> 'NGN' and statutory_source > 0 then
      insert into public.ledger_entries (transaction_id, account_id, user_id, entry_role, direction, asset_code, amount, memo)
      values (tx_id, treasury_source_account_id, null, 'treasury_movement', 'credit', source_asset, statutory_source, 'Crypto equivalent of statutory fee');
    end if;

    if receive_asset = 'NGN' and statutory_fee > 0 then
      insert into public.ledger_entries (transaction_id, account_id, user_id, entry_role, direction, asset_code, amount, memo)
      values (tx_id, treasury_receive_account_id, null, 'treasury_movement', 'debit', 'NGN', statutory_fee, 'NGN statutory fee settlement source');
    end if;
  end if;

  if platform_fee > 0 then
    insert into public.ledger_entries (transaction_id, account_id, user_id, entry_role, direction, asset_code, amount, memo)
    values (tx_id, fee_account_id, null, 'fee_movement', 'credit', source_asset, platform_fee, 'Smart Spend platform fee');
  end if;

  if statutory_fee > 0 then
    insert into public.ledger_entries (transaction_id, account_id, user_id, entry_role, direction, asset_code, amount, memo)
    values (tx_id, statutory_account_id, null, 'statutory_fee_movement', 'credit', 'NGN', statutory_fee, 'Smart Spend statutory fee payable');
  end if;

  if platform_fee > 0 or statutory_fee > 0 then
    insert into public.fee_events (
      transaction_id, user_id, asset_symbol, fee_rate, fee_amount,
      platform_fee_amount, statutory_fee_amount, gas_fee_amount, total_fee_amount,
      fee_asset, fee_reason, fee_destination_account_id, status
    )
    values (
      tx_id, p_sender_user_id, source_asset, case when platform_fee > 0 then 0.006 else 0 end,
      platform_fee + case when source_asset = 'NGN' then statutory_fee else statutory_source end,
      platform_fee, statutory_fee, 0,
      platform_fee + case when source_asset = 'NGN' then statutory_fee else statutory_source end,
      source_asset, case when p_recipient_type = 'bill_payment' then 'bill_payment_crypto_fee' else 'smart_spend' end, fee_account_id, 'posted'
    );
  end if;

  insert into public.user_transactions (
    user_id, ledger_transaction_id, direction, title, amount, note, counterparty_name,
    counterparty_account, transaction_type, status, asset_code, fee_amount, total_deducted,
    sender_name, sender_account, receiver_name, receiver_account, bank_name, recipient_name,
    recipient_account, narration, updated_at, rate_used, from_asset, to_asset
  )
  values (
    p_sender_user_id, tx_id, 'out',
    case
      when p_recipient_type = 'bill_payment' then 'Paid bill: ' || coalesce(p_recipient_name, p_bank_name, 'Bill payment')
      else 'Smart Spend: sent ' || p_receive_amount::text || ' ' || receive_asset
    end,
    p_receive_amount,
    case when source_asset = receive_asset then 'Paid directly with ' || source_asset else 'Auto-converted from ' || source_asset || ' to ' || receive_asset end,
    case
      when p_recipient_type = 'nairax_user' then receiver.full_name
      when p_recipient_type = 'bill_payment' then coalesce(p_bank_name, 'Bill provider')
      else coalesce(p_recipient_name, 'External bank recipient')
    end,
    case when p_recipient_type = 'nairax_user' then receiver.account_number else clean_identifier end,
    'smart_spend', 'posted', source_asset,
    platform_fee + case when source_asset = 'NGN' then statutory_fee else statutory_source end,
    p_total_deducted,
    sender.full_name, sender.account_number,
    case
      when p_recipient_type = 'nairax_user' then receiver.full_name
      when p_recipient_type = 'bill_payment' then coalesce(p_bank_name, 'Bill provider')
      else coalesce(p_recipient_name, 'External bank recipient')
    end,
    case when p_recipient_type = 'nairax_user' then receiver.account_number else clean_identifier end,
    p_bank_name,
    case
      when p_recipient_type = 'nairax_user' then receiver.full_name
      when p_recipient_type = 'bill_payment' then coalesce(p_bank_name, 'Bill provider')
      else coalesce(p_recipient_name, 'External bank recipient')
    end,
    case when p_recipient_type = 'nairax_user' then receiver.account_number else clean_identifier end,
    coalesce(p_narration, 'Smart Spend'),
    now(), p_rate_used, source_asset, receive_asset
  );

  if p_recipient_type = 'nairax_user' then
    insert into public.user_transactions (
      user_id, ledger_transaction_id, direction, title, amount, note, counterparty_name,
      counterparty_account, transaction_type, status, asset_code, fee_amount, total_deducted,
      sender_name, sender_account, receiver_name, receiver_account, narration, updated_at,
      rate_used, from_asset, to_asset
    )
    values (
      receiver.id, tx_id, 'in',
      'Received ' || p_receive_amount::text || ' ' || receive_asset || ' from ' || sender.full_name,
      p_receive_amount, coalesce(p_narration, 'NairaX Smart Spend'),
      sender.full_name, sender.account_number, 'smart_spend', 'posted', receive_asset, 0, p_receive_amount,
      sender.full_name, sender.account_number, receiver.full_name, receiver.account_number,
      coalesce(p_narration, 'NairaX Smart Spend'), now(), p_rate_used, source_asset, receive_asset
    );
  end if;

  return tx_id;
end;
$$;

revoke all on function public.smart_spend_execute(uuid, text, text, text, text, text, numeric, text, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric, text, boolean, text) from anon, authenticated;
grant execute on function public.smart_spend_execute(uuid, text, text, text, text, text, numeric, text, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric, text, boolean, text) to service_role;

-- Final SECURITY DEFINER hardening.
-- Backend/service-role functions stay callable by the backend only; browser roles use tables with RLS.
alter view if exists public.ledger_transaction_movements set (security_invoker = true);
revoke all on public.ledger_transaction_movements from anon, authenticated;
revoke execute on all functions in schema public from anon, authenticated;
grant execute on all functions in schema public to service_role;
alter default privileges in schema public revoke execute on functions from anon, authenticated;
alter default privileges in schema public grant execute on functions to service_role;

-- Phase 9: Coinbase price engine and ledger-based NGN/crypto conversions.

alter table public.ledger_transactions drop constraint if exists ledger_transactions_transaction_type_check;
alter table public.ledger_transactions add constraint ledger_transactions_transaction_type_check
check (transaction_type in (
  'signup_account_opening',
  'external_crypto_deposit',
  'external_crypto_withdrawal',
  'internal_transfer',
  'swap',
  'ngn_crypto_conversion',
  'crypto_ngn_conversion',
  'smart_spend',
  'fee_assessment',
  'reserve_allocation',
  'simulated_ngn_deposit',
  'simulated_external_bank_transfer',
  'manual_adjustment'
));

alter table public.user_transactions add column if not exists rate_used numeric(36, 18);
alter table public.user_transactions add column if not exists from_asset text;
alter table public.user_transactions add column if not exists to_asset text;

create table if not exists public.exchange_rates (
  id uuid primary key default gen_random_uuid(),
  base_asset text not null,
  quote_asset text not null,
  rate numeric(36, 18) not null check (rate > 0),
  source text not null default 'manual',
  fetched_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists exchange_rates_pair_fetched_idx
on public.exchange_rates(base_asset, quote_asset, fetched_at desc);

alter table public.exchange_rates enable row level security;

drop policy if exists "authenticated users can read exchange rates" on public.exchange_rates;
create policy "authenticated users can read exchange rates"
on public.exchange_rates for select
to authenticated
using (true);

revoke insert, update, delete on public.exchange_rates from anon, authenticated;

create table if not exists public.conversion_transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  ledger_transaction_id uuid references public.ledger_transactions(id) on delete set null,
  from_asset text not null check (from_asset in ('NGN', 'USDCX', 'MON', 'ETHX', 'cirBTCX', 'EURCX')),
  to_asset text not null check (to_asset in ('NGN', 'USDCX', 'MON', 'ETHX', 'cirBTCX', 'EURCX')),
  from_amount numeric(36, 18) not null check (from_amount > 0),
  to_amount numeric(36, 18) not null check (to_amount > 0),
  amount_ngn_equivalent numeric(36, 18) not null check (amount_ngn_equivalent > 0),
  rate_used numeric(36, 18) not null check (rate_used > 0),
  rate_source text not null default 'coinbase',
  platform_fee_amount numeric(36, 18) not null default 0 check (platform_fee_amount >= 0),
  statutory_fee_amount numeric(36, 18) not null default 0 check (statutory_fee_amount >= 0),
  statutory_fee_source_amount numeric(36, 18) not null default 0 check (statutory_fee_source_amount >= 0),
  total_fee_amount numeric(36, 18) not null default 0 check (total_fee_amount >= 0),
  total_deducted numeric(36, 18) not null check (total_deducted > 0),
  status text not null default 'posted' check (status in ('pending', 'posted', 'failed', 'reversed')),
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists conversion_transactions_user_created_idx
on public.conversion_transactions(user_id, created_at desc);

alter table public.conversion_transactions add column if not exists network text;
alter table public.conversion_transactions add column if not exists token_contract text;
alter table public.conversion_transactions add column if not exists user_wallet_address text;
alter table public.conversion_transactions add column if not exists treasury_wallet_address text;
alter table public.conversion_transactions add column if not exists fee_wallet_address text;
alter table public.conversion_transactions add column if not exists treasury_tx_hash text;
alter table public.conversion_transactions add column if not exists fee_tx_hash text;
alter table public.conversion_transactions add column if not exists settlement_status text not null default 'ledger_posted';

alter table public.conversion_transactions enable row level security;

drop policy if exists "users can read own conversions" on public.conversion_transactions;
create policy "users can read own conversions"
on public.conversion_transactions for select
to authenticated
using (auth.uid() = user_id);

revoke insert, update, delete on public.conversion_transactions from anon, authenticated;

create or replace function public.seed_conversion_treasury_liquidity()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  row record;
  seed_amount numeric(36, 18);
begin
  perform public.seed_platform_ledger_accounts();
  perform public.seed_all_ledger_account_balances();

  for row in
    select a.id, a.asset_code
    from public.ledger_accounts a
    where a.owner_type = 'platform'
      and a.account_type = 'treasury_settlement'
  loop
    seed_amount := case row.asset_code
      when 'NGN' then 1000000000
      when 'USDCX' then 1000000
      when 'EURCX' then 1000000
      when 'ETHX' then 1000
      when 'cirBTCX' then 100
      when 'MON' then 1000000
      else 0
    end;

    update public.ledger_account_balances
    set available = seed_amount,
        updated_at = now()
    where account_id = row.id
      and available = 0;
  end loop;
end;
$$;

create or replace function public.execute_asset_conversion(
  p_user_id uuid,
  p_from_asset text,
  p_to_asset text,
  p_from_amount numeric,
  p_to_amount numeric,
  p_rate_used numeric,
  p_amount_ngn_equivalent numeric,
  p_platform_fee_amount numeric,
  p_statutory_fee_amount numeric,
  p_statutory_fee_source_amount numeric,
  p_total_fee_amount numeric,
  p_total_deducted numeric,
  p_rate_source text default 'coinbase'
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  normalized_from text := case when upper(p_from_asset) = 'CIRBTCX' then 'cirBTCX' else upper(p_from_asset) end;
  normalized_to text := case when upper(p_to_asset) = 'CIRBTCX' then 'cirBTCX' else upper(p_to_asset) end;
  tx_type text;
  user_from_account_id uuid;
  user_to_account_id uuid;
  treasury_from_account_id uuid;
  treasury_to_account_id uuid;
  fee_account_id uuid;
  statutory_account_id uuid;
  user_available numeric(36, 18);
  tx_id uuid;
  conversion_id uuid;
  profile public.profiles%rowtype;
  statutory_source_amount numeric(36, 18) := coalesce(p_statutory_fee_source_amount, 0);
begin
  if normalized_from = normalized_to then
    raise exception 'conversion assets must be different';
  end if;

  if normalized_from not in ('NGN', 'USDCX', 'MON', 'ETHX', 'cirBTCX', 'EURCX')
     or normalized_to not in ('NGN', 'USDCX', 'MON', 'ETHX', 'cirBTCX', 'EURCX') then
    raise exception 'unsupported conversion asset';
  end if;

  if p_from_amount <= 0 or p_to_amount <= 0 or p_rate_used <= 0 or p_total_deducted <= 0 then
    raise exception 'invalid conversion preview';
  end if;

  tx_type := case
    when normalized_from = 'NGN' then 'ngn_crypto_conversion'
    when normalized_to = 'NGN' then 'crypto_ngn_conversion'
    else 'swap'
  end;

  select * into profile from public.profiles where id = p_user_id;
  if profile.id is null then
    raise exception 'profile not found';
  end if;

  perform public.seed_conversion_treasury_liquidity();
  perform public.create_default_balances(p_user_id);
  perform public.create_customer_custody_ledger_accounts(p_user_id);

  select id into user_from_account_id
  from public.ledger_accounts
  where owner_type = 'customer' and owner_id = p_user_id and account_type = 'customer_custody' and asset_code = normalized_from
  limit 1;

  select id into user_to_account_id
  from public.ledger_accounts
  where owner_type = 'customer' and owner_id = p_user_id and account_type = 'customer_custody' and asset_code = normalized_to
  limit 1;

  select id into treasury_from_account_id
  from public.ledger_accounts
  where owner_type = 'platform' and account_type = 'treasury_settlement' and asset_code = normalized_from
  limit 1;

  select id into treasury_to_account_id
  from public.ledger_accounts
  where owner_type = 'platform' and account_type = 'treasury_settlement' and asset_code = normalized_to
  limit 1;

  select id into fee_account_id
  from public.ledger_accounts
  where owner_type = 'platform' and account_type = 'fee_revenue' and asset_code = normalized_from
  limit 1;

  select id into statutory_account_id
  from public.ledger_accounts
  where owner_type = 'platform' and account_type = 'statutory_fee_payable' and asset_code = 'NGN'
  limit 1;

  if user_from_account_id is null or user_to_account_id is null or treasury_from_account_id is null
     or treasury_to_account_id is null or fee_account_id is null or statutory_account_id is null then
    raise exception 'required conversion ledger account is missing';
  end if;

  select available into user_available
  from public.balances
  where user_id = p_user_id and asset_code = normalized_from
  for update;

  if coalesce(user_available, 0) < p_total_deducted then
    raise exception 'insufficient % balance. Total required is %', normalized_from, p_total_deducted;
  end if;

  perform 1 from public.balances where user_id = p_user_id and asset_code = normalized_to for update;
  perform 1 from public.ledger_account_balances
  where account_id in (user_from_account_id, user_to_account_id, treasury_from_account_id, treasury_to_account_id, fee_account_id, statutory_account_id)
  for update;

  if normalized_from = 'NGN' then
    update public.balances
    set available = available - p_total_deducted,
        ngn_value = greatest(0, ngn_value - p_total_deducted),
        updated_at = now()
    where user_id = p_user_id and asset_code = normalized_from;

    update public.balances
    set available = available + p_to_amount,
        ngn_value = ngn_value + p_amount_ngn_equivalent,
        updated_at = now()
    where user_id = p_user_id and asset_code = normalized_to;

    update public.ledger_account_balances set available = available - p_total_deducted, updated_at = now()
    where account_id = user_from_account_id;
    update public.ledger_account_balances set available = available + p_to_amount, updated_at = now()
    where account_id = user_to_account_id;
    update public.ledger_account_balances set available = available + p_from_amount, updated_at = now()
    where account_id = treasury_from_account_id;
    update public.ledger_account_balances set available = available - p_to_amount, updated_at = now()
    where account_id = treasury_to_account_id;
  elsif normalized_to = 'NGN' then
    update public.balances
    set available = available - p_total_deducted,
        ngn_value = greatest(0, ngn_value - p_amount_ngn_equivalent),
        updated_at = now()
    where user_id = p_user_id and asset_code = normalized_from;

    update public.balances
    set available = available + p_to_amount,
        ngn_value = ngn_value + p_to_amount,
        updated_at = now()
    where user_id = p_user_id and asset_code = normalized_to;

    update public.ledger_account_balances set available = available - p_total_deducted, updated_at = now()
    where account_id = user_from_account_id;
    update public.ledger_account_balances set available = available + p_to_amount, updated_at = now()
    where account_id = user_to_account_id;
    update public.ledger_account_balances set available = available + p_from_amount + statutory_source_amount, updated_at = now()
    where account_id = treasury_from_account_id;
    update public.ledger_account_balances set available = available - (p_to_amount + p_statutory_fee_amount), updated_at = now()
    where account_id = treasury_to_account_id;
  else
    update public.balances
    set available = available - p_total_deducted,
        ngn_value = greatest(0, ngn_value - p_amount_ngn_equivalent),
        updated_at = now()
    where user_id = p_user_id and asset_code = normalized_from;

    update public.balances
    set available = available + p_to_amount,
        ngn_value = ngn_value + p_amount_ngn_equivalent,
        updated_at = now()
    where user_id = p_user_id and asset_code = normalized_to;

    update public.ledger_account_balances set available = available - p_total_deducted, updated_at = now()
    where account_id = user_from_account_id;
    update public.ledger_account_balances set available = available + p_to_amount, updated_at = now()
    where account_id = user_to_account_id;
    update public.ledger_account_balances set available = available + p_from_amount + statutory_source_amount, updated_at = now()
    where account_id = treasury_from_account_id;
    update public.ledger_account_balances set available = available - p_to_amount, updated_at = now()
    where account_id = treasury_to_account_id;
  end if;

  update public.ledger_account_balances
  set available = available + p_platform_fee_amount, updated_at = now()
  where account_id = fee_account_id;

  if p_statutory_fee_amount > 0 then
    update public.ledger_account_balances
    set available = available + p_statutory_fee_amount, updated_at = now()
    where account_id = statutory_account_id;
  end if;

  insert into public.ledger_transactions (
    transaction_type, status, user_id, asset_code, amount, description, metadata
  )
  values (
    tx_type,
    'posted',
    p_user_id,
    normalized_from,
    p_from_amount,
    'Ledger-based NGN/crypto conversion',
    jsonb_build_object(
      'from_asset', normalized_from,
      'to_asset', normalized_to,
      'from_amount', p_from_amount,
      'to_amount', p_to_amount,
      'rate_used', p_rate_used,
      'rate_source', p_rate_source,
      'amount_ngn_equivalent', p_amount_ngn_equivalent,
      'platform_fee_amount', p_platform_fee_amount,
      'statutory_fee_amount', p_statutory_fee_amount,
      'statutory_fee_source_amount', statutory_source_amount,
      'total_fee_amount', p_total_fee_amount,
      'total_deducted', p_total_deducted,
      'ledger_only', false,
      'settlement_model', case
        when normalized_from = 'NGN' then 'treasury_sends_crypto_to_user_wallet'
        when normalized_to = 'NGN' then 'ledger_ngn_credit_pending_source_crypto_sweep'
        else 'treasury_sends_destination_crypto_pending_source_crypto_sweep'
      end
    )
  )
  returning id into tx_id;

  if normalized_from = 'NGN' then
    insert into public.ledger_entries (transaction_id, account_id, user_id, entry_role, direction, asset_code, amount, memo)
    values
      (tx_id, user_from_account_id, p_user_id, 'user_debit', 'debit', 'NGN', p_total_deducted, 'Debit user NGN for conversion amount plus fees'),
      (tx_id, treasury_from_account_id, null, 'treasury_movement', 'credit', 'NGN', p_from_amount, 'Credit NGN treasury settlement'),
      (tx_id, fee_account_id, null, 'fee_movement', 'credit', 'NGN', p_platform_fee_amount, 'Credit 0.6% platform fee'),
      (tx_id, treasury_to_account_id, null, 'treasury_movement', 'debit', normalized_to, p_to_amount, 'Debit treasury crypto inventory'),
      (tx_id, user_to_account_id, p_user_id, 'user_credit', 'credit', normalized_to, p_to_amount, 'Credit user crypto custody');

    if p_statutory_fee_amount > 0 then
      insert into public.ledger_entries (transaction_id, account_id, user_id, entry_role, direction, asset_code, amount, memo)
      values (tx_id, statutory_account_id, null, 'statutory_fee_movement', 'credit', 'NGN', p_statutory_fee_amount, 'Credit statutory fee payable');
    end if;
  elsif normalized_to = 'NGN' then
    insert into public.ledger_entries (transaction_id, account_id, user_id, entry_role, direction, asset_code, amount, memo)
    values
      (tx_id, user_from_account_id, p_user_id, 'user_debit', 'debit', normalized_from, p_total_deducted, 'Debit user crypto for conversion amount plus fees'),
      (tx_id, treasury_from_account_id, null, 'treasury_movement', 'credit', normalized_from, p_from_amount, 'Credit treasury crypto settlement'),
      (tx_id, fee_account_id, null, 'fee_movement', 'credit', normalized_from, p_platform_fee_amount, 'Credit 0.6% platform fee'),
      (tx_id, treasury_to_account_id, null, 'treasury_movement', 'debit', 'NGN', p_to_amount + p_statutory_fee_amount, 'Debit NGN treasury settlement'),
      (tx_id, user_to_account_id, p_user_id, 'user_credit', 'credit', 'NGN', p_to_amount, 'Credit user NGN custody');

    if statutory_source_amount > 0 then
      insert into public.ledger_entries (transaction_id, account_id, user_id, entry_role, direction, asset_code, amount, memo)
      values (tx_id, treasury_from_account_id, null, 'treasury_movement', 'credit', normalized_from, statutory_source_amount, 'Credit treasury crypto equivalent of statutory levy');
    end if;

    if p_statutory_fee_amount > 0 then
      insert into public.ledger_entries (transaction_id, account_id, user_id, entry_role, direction, asset_code, amount, memo)
      values (tx_id, statutory_account_id, null, 'statutory_fee_movement', 'credit', 'NGN', p_statutory_fee_amount, 'Credit statutory fee payable');
    end if;
  else
    insert into public.ledger_entries (transaction_id, account_id, user_id, entry_role, direction, asset_code, amount, memo)
    values
      (tx_id, user_from_account_id, p_user_id, 'user_debit', 'debit', normalized_from, p_total_deducted, 'Debit user source crypto for swap amount including fees'),
      (tx_id, treasury_from_account_id, null, 'treasury_movement', 'credit', normalized_from, p_from_amount + statutory_source_amount, 'Credit treasury source crypto pending sweep'),
      (tx_id, fee_account_id, null, 'fee_movement', 'credit', normalized_from, p_platform_fee_amount, 'Credit 0.6% platform fee'),
      (tx_id, treasury_to_account_id, null, 'treasury_movement', 'debit', normalized_to, p_to_amount, 'Debit treasury destination crypto inventory'),
      (tx_id, user_to_account_id, p_user_id, 'user_credit', 'credit', normalized_to, p_to_amount, 'Credit user destination crypto custody');

    if p_statutory_fee_amount > 0 then
      insert into public.ledger_entries (transaction_id, account_id, user_id, entry_role, direction, asset_code, amount, memo)
      values (tx_id, statutory_account_id, null, 'statutory_fee_movement', 'credit', 'NGN', p_statutory_fee_amount, 'Credit statutory fee payable');
    end if;
  end if;

  insert into public.conversion_transactions (
    user_id, ledger_transaction_id, from_asset, to_asset, from_amount, to_amount,
    amount_ngn_equivalent, rate_used, rate_source, platform_fee_amount,
    statutory_fee_amount, statutory_fee_source_amount, total_fee_amount,
    total_deducted, status, completed_at
  )
  values (
    p_user_id, tx_id, normalized_from, normalized_to, p_from_amount, p_to_amount,
    p_amount_ngn_equivalent, p_rate_used, coalesce(p_rate_source, 'coinbase'), p_platform_fee_amount,
    p_statutory_fee_amount, statutory_source_amount, p_total_fee_amount,
    p_total_deducted, 'posted', now()
  )
  returning id into conversion_id;

  if normalized_from = 'NGN' then
    insert into public.fee_events (
      transaction_id, user_id, asset_symbol, fee_rate, fee_amount,
      platform_fee_amount, statutory_fee_amount, gas_fee_amount, total_fee_amount,
      fee_asset, fee_reason, fee_destination_account_id, status
    )
    values (
      tx_id, p_user_id, 'NGN', 0.006, p_total_fee_amount,
      p_platform_fee_amount, p_statutory_fee_amount, 0, p_total_fee_amount,
      'NGN', tx_type, fee_account_id, 'posted'
    );
  else
    insert into public.fee_events (
      transaction_id, user_id, asset_symbol, fee_rate, fee_amount,
      platform_fee_amount, statutory_fee_amount, gas_fee_amount, total_fee_amount,
      fee_asset, fee_reason, fee_destination_account_id, status
    )
    values (
      tx_id, p_user_id, normalized_from, 0.006, p_platform_fee_amount,
      p_platform_fee_amount, 0, 0, p_platform_fee_amount,
      normalized_from, tx_type, fee_account_id, 'posted'
    );

    if p_statutory_fee_amount > 0 then
      insert into public.fee_events (
        transaction_id, user_id, asset_symbol, fee_rate, fee_amount,
        platform_fee_amount, statutory_fee_amount, gas_fee_amount, total_fee_amount,
        fee_asset, fee_reason, fee_destination_account_id, status
      )
      values (
        tx_id, p_user_id, 'NGN', 0, p_statutory_fee_amount,
        0, p_statutory_fee_amount, 0, p_statutory_fee_amount,
        'NGN', 'conversion_statutory_levy', statutory_account_id, 'posted'
      );
    end if;
  end if;

  insert into public.user_transactions (
    user_id, ledger_transaction_id, direction, title, amount, note, counterparty_name,
    counterparty_account, transaction_type, status, asset_code, fee_amount,
    total_deducted, sender_name, sender_account, receiver_name, receiver_account,
    narration, updated_at, rate_used, from_asset, to_asset
  )
  values (
    p_user_id,
    tx_id,
    'out',
    'Converted ' || normalized_from || ' to ' || normalized_to,
    p_from_amount,
    'Rate: ' || p_rate_used || ' NGN per ' || case when normalized_from = 'NGN' then normalized_to else normalized_from end,
    'NairaX Treasury',
    'Treasury Settlement',
    tx_type,
    'posted',
    normalized_from,
    p_total_fee_amount,
    p_total_deducted,
    profile.full_name,
    profile.account_number,
    profile.full_name,
    profile.account_number,
    'Converted ' || p_from_amount || ' ' || normalized_from || ' to ' || p_to_amount || ' ' || normalized_to,
    now(),
    p_rate_used,
    normalized_from,
    normalized_to
  );

  return tx_id;
end;
$$;
-- Keep Phase 9 transaction types active after all compatibility overrides above.
alter table public.ledger_transactions drop constraint if exists ledger_transactions_transaction_type_check;
alter table public.ledger_transactions add constraint ledger_transactions_transaction_type_check
check (transaction_type in (
  'signup_account_opening',
  'external_crypto_deposit',
  'external_crypto_withdrawal',
  'internal_transfer',
  'swap',
  'ngn_crypto_conversion',
  'crypto_ngn_conversion',
  'smart_spend',
  'fee_assessment',
  'reserve_allocation',
  'simulated_ngn_deposit',
  'simulated_external_bank_transfer',
  'manual_adjustment'
));

-- Keep Phase 9 transaction types active after all compatibility overrides above.
alter table public.ledger_transactions drop constraint if exists ledger_transactions_transaction_type_check;
alter table public.ledger_transactions add constraint ledger_transactions_transaction_type_check
check (transaction_type in (
  'signup_account_opening',
  'external_crypto_deposit',
  'external_crypto_withdrawal',
  'internal_transfer',
  'swap',
  'ngn_crypto_conversion',
  'crypto_ngn_conversion',
  'smart_spend',
  'fee_assessment',
  'reserve_allocation',
  'simulated_ngn_deposit',
  'simulated_external_bank_transfer',
  'manual_adjustment'
));

grant execute on function public.seed_conversion_treasury_liquidity() to service_role;
grant execute on function public.execute_asset_conversion(uuid, text, text, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric, text) to service_role;

alter table public.ledger_accounts drop constraint if exists ledger_accounts_account_type_check;
alter table public.ledger_accounts add constraint ledger_accounts_account_type_check
check (account_type in (
  'customer_custody',
  'treasury_settlement',
  'fee_revenue',
  'reserve_shock',
  'simulated_ngn_corporate_reserve',
  'demo_ngn_mint_source',
  'demo_ngn_burn_sink',
  'simulated_external_bank_settlement_sink',
  'statutory_fee_payable',
  'gas_fee_recovery',
  'customer_funds_pool',
  'simulated_external_payout_expense',
  'demo_crypto_faucet_source'
));

alter table public.ledger_transactions drop constraint if exists ledger_transactions_transaction_type_check;
alter table public.ledger_transactions add constraint ledger_transactions_transaction_type_check
check (transaction_type in (
  'signup_account_opening',
  'external_crypto_deposit',
  'external_crypto_withdrawal',
  'internal_transfer',
  'swap',
  'ngn_crypto_conversion',
  'crypto_ngn_conversion',
  'smart_spend',
  'fee_assessment',
  'reserve_allocation',
  'simulated_ngn_deposit',
  'simulated_external_bank_transfer',
  'manual_adjustment'
));

alter table public.ledger_entries drop constraint if exists ledger_entries_entry_role_check;
alter table public.ledger_entries add constraint ledger_entries_entry_role_check
check (entry_role in (
  'user_debit',
  'user_credit',
  'treasury_movement',
  'fee_movement',
  'reserve_movement',
  'corporate_reserve_movement',
  'demo_mint_movement',
  'demo_burn_movement',
  'external_bank_settlement_movement',
  'statutory_fee_movement',
  'gas_fee_movement',
  'demo_crypto_faucet_movement'
)) not valid;

select public.seed_platform_ledger_accounts();

create or replace function public.ensure_ledger_account_balance(target_account_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  target_asset text;
begin
  select asset_code into target_asset
  from public.ledger_accounts
  where id = target_account_id;

  if target_asset is null then
    raise exception 'ledger account % does not exist', target_account_id;
  end if;

  insert into public.ledger_account_balances (account_id, asset_code, available)
  values (target_account_id, target_asset, 0)
  on conflict (account_id) do nothing;
end;
$$;

create or replace function public.seed_all_ledger_account_balances()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  acct record;
begin
  for acct in select id from public.ledger_accounts
  loop
    perform public.ensure_ledger_account_balance(acct.id);
  end loop;
end;
$$;

select public.seed_all_ledger_account_balances();

create or replace function public.seed_demo_ngn_mint_source()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  mint_account_id uuid;
  treasury_account_id uuid;
  existing_balance numeric(36, 18);
  tx_id uuid;
begin
  perform public.seed_platform_ledger_accounts();

  select id into mint_account_id
  from public.ledger_accounts
  where owner_type = 'platform'
    and account_type = 'demo_ngn_mint_source'
    and asset_code = 'NGN'
  limit 1;

  select id into treasury_account_id
  from public.ledger_accounts
  where owner_type = 'platform'
    and account_type = 'treasury_settlement'
    and asset_code = 'NGN'
  limit 1;

  if mint_account_id is null or treasury_account_id is null then
    raise exception 'required platform NGN ledger accounts are missing';
  end if;

  perform public.ensure_ledger_account_balance(mint_account_id);
  perform public.ensure_ledger_account_balance(treasury_account_id);

  select available into existing_balance
  from public.ledger_account_balances
  where account_id = mint_account_id
  for update;

  if existing_balance > 0 then
    return;
  end if;

  update public.ledger_account_balances
  set available = 1000000000, updated_at = now()
  where account_id = mint_account_id;

  insert into public.ledger_transactions (
    transaction_type,
    status,
    asset_code,
    amount,
    description,
    metadata
  )
  values (
    'reserve_allocation',
    'posted',
    'NGN',
    1000000000,
    'Seed demo NGN funding source',
    '{"phase":"phase_2_seed","source":"demo_ngn_mint_source"}'::jsonb
  )
  returning id into tx_id;

  insert into public.ledger_entries (
    transaction_id,
    account_id,
    entry_role,
    direction,
    asset_code,
    amount,
    memo
  )
  values
    (tx_id, treasury_account_id, 'treasury_movement', 'debit', 'NGN', 1000000000, 'Balanced seed source for demo NGN funding'),
    (tx_id, mint_account_id, 'demo_mint_movement', 'credit', 'NGN', 1000000000, 'Seed demo NGN funding source');
end;
$$;

select public.seed_demo_ngn_mint_source();

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_profiles_updated_at on public.profiles;
create trigger set_profiles_updated_at
before update on public.profiles
for each row execute function public.set_updated_at();

drop trigger if exists set_balances_updated_at on public.balances;
create trigger set_balances_updated_at
before update on public.balances
for each row execute function public.set_updated_at();

create or replace function public.create_default_balances(target_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.balances (user_id, asset_code)
  values
    (target_user_id, 'NGN'),
    (target_user_id, 'USDCX'),
    (target_user_id, 'MON'),
    (target_user_id, 'ETHX'),
    (target_user_id, 'cirBTCX'),
    (target_user_id, 'EURCX')
  on conflict (user_id, asset_code) do nothing;
end;
$$;

create or replace function public.create_customer_custody_ledger_accounts(target_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  asset text;
begin
  foreach asset in array array['NGN', 'USDCX', 'MON', 'ETHX', 'cirBTCX', 'EURCX']
  loop
    insert into public.ledger_accounts (
      owner_type,
      owner_id,
      account_type,
      asset_code,
      account_name,
      is_system
    )
    values (
      'customer',
      target_user_id,
      'customer_custody',
      asset,
      'Customer Custody - ' || asset,
      false
    )
    on conflict do nothing;
  end loop;

  insert into public.ledger_account_balances (account_id, asset_code, available)
  select id, asset_code, 0
  from public.ledger_accounts
  where owner_type = 'customer'
    and owner_id = target_user_id
    and account_type = 'customer_custody'
  on conflict (account_id) do nothing;
end;
$$;

create or replace function public.validate_ledger_entry_account_type()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  ledger_account public.ledger_accounts%rowtype;
begin
  select * into ledger_account
  from public.ledger_accounts
  where id = new.account_id;

  if not found then
    raise exception 'ledger account % does not exist', new.account_id;
  end if;

  if ledger_account.asset_code <> new.asset_code then
    raise exception 'ledger entry asset % does not match ledger account asset %', new.asset_code, ledger_account.asset_code;
  end if;

  if new.entry_role in ('user_debit', 'user_credit') and ledger_account.account_type <> 'customer_custody' then
    raise exception 'user debit/credit entries must post only to customer custody accounts';
  end if;

  if new.entry_role = 'treasury_movement' and ledger_account.account_type <> 'treasury_settlement' then
    raise exception 'treasury movement entries must post only to treasury/settlement accounts';
  end if;

  if new.entry_role = 'fee_movement' and ledger_account.account_type <> 'fee_revenue' then
    raise exception 'fee movement entries must post only to fee revenue accounts';
  end if;

  if new.entry_role = 'reserve_movement' and ledger_account.account_type <> 'reserve_shock' then
    raise exception 'reserve movement entries must post only to reserve/shock fund accounts';
  end if;

  if new.entry_role = 'corporate_reserve_movement' and ledger_account.account_type <> 'simulated_ngn_corporate_reserve' then
    raise exception 'corporate reserve entries must post only to simulated NGN corporate reserve accounts';
  end if;

  if new.entry_role = 'demo_mint_movement' and ledger_account.account_type <> 'demo_ngn_mint_source' then
    raise exception 'demo mint entries must post only to demo NGN funding source accounts';
  end if;

  if new.entry_role = 'demo_burn_movement' and ledger_account.account_type <> 'demo_ngn_burn_sink' then
    raise exception 'demo burn entries must post only to demo NGN burn sink accounts';
  end if;

  if new.entry_role = 'external_bank_settlement_movement' and ledger_account.account_type <> 'simulated_external_bank_settlement_sink' then
    raise exception 'external bank settlement entries must post only to simulated external bank settlement sink accounts';
  end if;

  if ledger_account.account_type = 'customer_custody' and new.user_id is null then
    raise exception 'customer custody ledger entries must include user_id';
  end if;

  return new;
end;
$$;

drop trigger if exists validate_ledger_entry_account_type on public.ledger_entries;
create trigger validate_ledger_entry_account_type
before insert or update on public.ledger_entries
for each row execute function public.validate_ledger_entry_account_type();

create or replace function public.simulate_ngn_deposit(
  target_user_id uuid,
  deposit_amount numeric default 100000
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  mint_account_id uuid;
  user_account_id uuid;
  mint_available numeric(36, 18);
  tx_id uuid;
begin
  if deposit_amount <= 0 then
    raise exception 'deposit amount must be greater than zero';
  end if;

  perform public.seed_demo_ngn_mint_source();
  perform public.create_default_balances(target_user_id);
  perform public.create_customer_custody_ledger_accounts(target_user_id);

  select id into mint_account_id
  from public.ledger_accounts
  where owner_type = 'platform'
    and account_type = 'demo_ngn_mint_source'
    and asset_code = 'NGN'
  limit 1;

  select id into user_account_id
  from public.ledger_accounts
  where owner_type = 'customer'
    and owner_id = target_user_id
    and account_type = 'customer_custody'
    and asset_code = 'NGN'
  limit 1;

  if mint_account_id is null or user_account_id is null then
    raise exception 'required NGN ledger accounts are missing';
  end if;

  select available into mint_available
  from public.ledger_account_balances
  where account_id = mint_account_id
  for update;

  if mint_available < deposit_amount then
    raise exception 'demo NGN funding source is insufficient';
  end if;

  perform 1 from public.ledger_account_balances where account_id = user_account_id for update;
  perform 1 from public.balances where user_id = target_user_id and asset_code = 'NGN' for update;

  update public.ledger_account_balances
  set available = available - deposit_amount, updated_at = now()
  where account_id = mint_account_id;

  update public.ledger_account_balances
  set available = available + deposit_amount, updated_at = now()
  where account_id = user_account_id;

  update public.balances
  set available = available + deposit_amount,
      ngn_value = ngn_value + deposit_amount,
      updated_at = now()
  where user_id = target_user_id and asset_code = 'NGN';

  insert into public.ledger_transactions (
    transaction_type,
    status,
    user_id,
    asset_code,
    amount,
    description,
    metadata
  )
  values (
    'simulated_ngn_deposit',
    'posted',
    target_user_id,
    'NGN',
    deposit_amount,
    'Simulated Naira Deposit',
    jsonb_build_object('phase', 'phase_2', 'source', 'demo_ngn_mint_source')
  )
  returning id into tx_id;

  insert into public.ledger_entries (
    transaction_id,
    account_id,
    user_id,
    entry_role,
    direction,
    asset_code,
    amount,
    memo
  )
  values
    (tx_id, mint_account_id, null, 'demo_mint_movement', 'debit', 'NGN', deposit_amount, 'Debit demo NGN funding source'),
    (tx_id, user_account_id, target_user_id, 'user_credit', 'credit', 'NGN', deposit_amount, 'Credit user NGN custody');

  insert into public.user_transactions (
    user_id,
    ledger_transaction_id,
    direction,
    title,
    amount,
    note
  )
  values (
    target_user_id,
    tx_id,
    'in',
    'Simulated Naira Deposit',
    deposit_amount,
    'Naira banking is simulated. No real money moved.'
  );

  return tx_id;
end;
$$;

create or replace function public.internal_ngn_transfer(
  sender_user_id uuid,
  recipient_identifier text,
  transfer_amount numeric,
  transfer_note text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  clean_identifier text := regexp_replace(coalesce(recipient_identifier, ''), '\D', '', 'g');
  recipient public.profiles%rowtype;
  sender public.profiles%rowtype;
  sender_account_id uuid;
  receiver_account_id uuid;
  sender_available numeric(36, 18);
  tx_id uuid;
begin
  if transfer_amount <= 0 then
    raise exception 'transfer amount must be greater than zero';
  end if;

  select * into sender from public.profiles where id = sender_user_id;
  if sender.id is null then
    raise exception 'sender profile not found';
  end if;

  select * into recipient
  from public.profiles
  where account_number = clean_identifier
     or regexp_replace(phone, '\D', '', 'g') = clean_identifier
     or (char_length(clean_identifier) = 11 and left(clean_identifier, 1) = '0' and account_number = substring(clean_identifier from 2 for 10))
  limit 1;

  if recipient.id is null then
    raise exception 'NairaX recipient not found';
  end if;

  if recipient.id = sender_user_id then
    raise exception 'cannot transfer to yourself';
  end if;

  perform public.create_default_balances(sender_user_id);
  perform public.create_default_balances(recipient.id);
  perform public.create_customer_custody_ledger_accounts(sender_user_id);
  perform public.create_customer_custody_ledger_accounts(recipient.id);

  select id into sender_account_id
  from public.ledger_accounts
  where owner_type = 'customer'
    and owner_id = sender_user_id
    and account_type = 'customer_custody'
    and asset_code = 'NGN'
  limit 1;

  select id into receiver_account_id
  from public.ledger_accounts
  where owner_type = 'customer'
    and owner_id = recipient.id
    and account_type = 'customer_custody'
    and asset_code = 'NGN'
  limit 1;

  select available into sender_available
  from public.balances
  where user_id = sender_user_id and asset_code = 'NGN'
  for update;

  if sender_available < transfer_amount then
    raise exception 'insufficient NGN balance';
  end if;

  perform 1 from public.balances where user_id = recipient.id and asset_code = 'NGN' for update;
  perform 1 from public.ledger_account_balances where account_id in (sender_account_id, receiver_account_id) for update;

  update public.balances
  set available = available - transfer_amount,
      ngn_value = ngn_value - transfer_amount,
      updated_at = now()
  where user_id = sender_user_id and asset_code = 'NGN';

  update public.balances
  set available = available + transfer_amount,
      ngn_value = ngn_value + transfer_amount,
      updated_at = now()
  where user_id = recipient.id and asset_code = 'NGN';

  update public.ledger_account_balances
  set available = available - transfer_amount, updated_at = now()
  where account_id = sender_account_id;

  update public.ledger_account_balances
  set available = available + transfer_amount, updated_at = now()
  where account_id = receiver_account_id;

  insert into public.ledger_transactions (
    transaction_type,
    status,
    user_id,
    asset_code,
    amount,
    description,
    metadata
  )
  values (
    'internal_transfer',
    'posted',
    sender_user_id,
    'NGN',
    transfer_amount,
    'Internal NairaX NGN transfer',
    jsonb_build_object('recipient_user_id', recipient.id, 'note', transfer_note)
  )
  returning id into tx_id;

  insert into public.ledger_entries (
    transaction_id,
    account_id,
    user_id,
    entry_role,
    direction,
    asset_code,
    amount,
    memo
  )
  values
    (tx_id, sender_account_id, sender_user_id, 'user_debit', 'debit', 'NGN', transfer_amount, 'Debit sender NGN custody'),
    (tx_id, receiver_account_id, recipient.id, 'user_credit', 'credit', 'NGN', transfer_amount, 'Credit receiver NGN custody');

  insert into public.user_transactions (
    user_id,
    ledger_transaction_id,
    direction,
    title,
    amount,
    note,
    counterparty_name,
    counterparty_account
  )
  values
    (
      sender_user_id,
      tx_id,
      'out',
      'Sent NGN to ' || recipient.full_name,
      transfer_amount,
      coalesce(transfer_note, 'NairaX internal transfer'),
      recipient.full_name,
      recipient.account_number
    ),
    (
      recipient.id,
      tx_id,
      'in',
      'Received NGN from ' || sender.full_name,
      transfer_amount,
      coalesce(transfer_note, 'NairaX internal transfer'),
      sender.full_name,
      sender.account_number
    );

  return tx_id;
end;
$$;

create or replace function public.simulated_external_bank_transfer(
  sender_user_id uuid,
  bank_name text,
  destination_account_number text,
  transfer_amount numeric,
  transfer_note text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  settlement_sink_account_id uuid;
  sender_account_id uuid;
  sender_available numeric(36, 18);
  tx_id uuid;
begin
  if transfer_amount <= 0 then
    raise exception 'transfer amount must be greater than zero';
  end if;

  if length(regexp_replace(coalesce(destination_account_number, ''), '\D', '', 'g')) <> 10 then
    raise exception 'enter a valid 10-digit destination account number';
  end if;

  perform public.seed_platform_ledger_accounts();
  perform public.create_default_balances(sender_user_id);
  perform public.create_customer_custody_ledger_accounts(sender_user_id);

  select id into settlement_sink_account_id
  from public.ledger_accounts
  where owner_type = 'platform'
    and account_type = 'simulated_external_bank_settlement_sink'
    and asset_code = 'NGN'
  limit 1;

  select id into sender_account_id
  from public.ledger_accounts
  where owner_type = 'customer'
    and owner_id = sender_user_id
    and account_type = 'customer_custody'
    and asset_code = 'NGN'
  limit 1;

  select available into sender_available
  from public.balances
  where user_id = sender_user_id and asset_code = 'NGN'
  for update;

  if sender_available < transfer_amount then
    raise exception 'insufficient NGN balance';
  end if;

  perform public.ensure_ledger_account_balance(settlement_sink_account_id);
  perform 1 from public.ledger_account_balances where account_id in (sender_account_id, settlement_sink_account_id) for update;

  update public.balances
  set available = available - transfer_amount,
      ngn_value = ngn_value - transfer_amount,
      updated_at = now()
  where user_id = sender_user_id and asset_code = 'NGN';

  update public.ledger_account_balances
  set available = available - transfer_amount, updated_at = now()
  where account_id = sender_account_id;

  update public.ledger_account_balances
  set available = available + transfer_amount, updated_at = now()
  where account_id = settlement_sink_account_id;

  insert into public.ledger_transactions (
    transaction_type,
    status,
    user_id,
    asset_code,
    amount,
    description,
    metadata
  )
  values (
    'simulated_external_bank_transfer',
    'posted',
    sender_user_id,
    'NGN',
    transfer_amount,
    'Simulated external bank transfer',
    jsonb_build_object(
      'bank_name', bank_name,
      'destination_account_number', regexp_replace(destination_account_number, '\D', '', 'g'),
      'note', transfer_note
    )
  )
  returning id into tx_id;

  insert into public.ledger_entries (
    transaction_id,
    account_id,
    user_id,
    entry_role,
    direction,
    asset_code,
    amount,
    memo
  )
  values
    (tx_id, sender_account_id, sender_user_id, 'user_debit', 'debit', 'NGN', transfer_amount, 'Debit user NGN custody for simulated bank transfer'),
    (tx_id, settlement_sink_account_id, null, 'external_bank_settlement_movement', 'credit', 'NGN', transfer_amount, 'Credit simulated external bank settlement sink');

  insert into public.user_transactions (
    user_id,
    ledger_transaction_id,
    direction,
    title,
    amount,
    note,
    counterparty_name,
    counterparty_account
  )
  values (
    sender_user_id,
    tx_id,
    'out',
    'Simulated bank transfer to ' || coalesce(nullif(bank_name, ''), 'Bank') || ' ' || regexp_replace(destination_account_number, '\D', '', 'g'),
    transfer_amount,
    coalesce(transfer_note, 'Naira banking is simulated. No real money moved.'),
    coalesce(nullif(bank_name, ''), 'External Bank'),
    regexp_replace(destination_account_number, '\D', '', 'g')
  );

  return tx_id;
end;
$$;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  raw_phone text := coalesce(new.raw_user_meta_data->>'phone', '');
  raw_account text := coalesce(nullif(new.raw_user_meta_data->>'account_number', ''), '');
begin
  if raw_account = '' then
    raw_account := case
      when char_length(raw_phone) = 11 and left(raw_phone, 1) = '0' then substring(raw_phone from 2 for 10)
      when char_length(raw_phone) = 10 then raw_phone
      else lpad(left(regexp_replace(new.id::text, '[^0-9]', '', 'g'), 10), 10, '0')
    end;
  end if;

  insert into public.profiles (id, full_name, phone, account_number, wallet_address)
  values (
    new.id,
    coalesce(nullif(new.raw_user_meta_data->>'full_name', ''), 'NairaX User'),
    raw_phone,
    raw_account,
    coalesce(nullif(new.raw_user_meta_data->>'wallet_address', ''), '0x0000000000000000000000000000000000000000')
  )
  on conflict (id) do nothing;

  perform public.create_default_balances(new.id);
  perform public.create_customer_custody_ledger_accounts(new.id);
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

alter table public.profiles enable row level security;
alter table public.balances enable row level security;
alter table public.custodial_wallets enable row level security;
alter table public.ledger_accounts enable row level security;
alter table public.ledger_transactions enable row level security;
alter table public.ledger_entries enable row level security;
alter table public.ledger_account_balances enable row level security;
alter table public.user_transactions enable row level security;

revoke all on public.custodial_wallets from anon, authenticated;
revoke all on public.ledger_accounts from anon, authenticated;
revoke all on public.ledger_transactions from anon, authenticated;
revoke all on public.ledger_entries from anon, authenticated;
revoke all on public.ledger_account_balances from anon, authenticated;
revoke all on public.ledger_transaction_movements from anon, authenticated;
revoke all on function public.simulate_ngn_deposit(uuid, numeric) from anon, authenticated;
revoke all on function public.internal_ngn_transfer(uuid, text, numeric, text) from anon, authenticated;
revoke all on function public.simulated_external_bank_transfer(uuid, text, text, numeric, text) from anon, authenticated;
grant execute on function public.simulate_ngn_deposit(uuid, numeric) to service_role;
grant execute on function public.internal_ngn_transfer(uuid, text, numeric, text) to service_role;
grant execute on function public.simulated_external_bank_transfer(uuid, text, text, numeric, text) to service_role;
grant select on public.user_transactions to authenticated;

drop policy if exists "Users can read own profile" on public.profiles;
create policy "Users can read own profile"
on public.profiles for select
to authenticated
using (auth.uid() = id);

drop policy if exists "Users can insert own profile" on public.profiles;
drop policy if exists "Users can update own profile" on public.profiles;

drop policy if exists "Users can read own balances" on public.balances;
create policy "Users can read own balances"
on public.balances for select
to authenticated
using (auth.uid() = user_id);

drop policy if exists "Users can insert own balances" on public.balances;

drop policy if exists "Users can read own custodial wallets" on public.custodial_wallets;
drop policy if exists "Users can insert own custodial wallets" on public.custodial_wallets;
drop policy if exists "Users can update own custodial wallets" on public.custodial_wallets;
drop policy if exists "Users can delete own custodial wallets" on public.custodial_wallets;

drop policy if exists "Users can read own ledger accounts" on public.ledger_accounts;
drop policy if exists "Users can insert own ledger accounts" on public.ledger_accounts;
drop policy if exists "Users can update own ledger accounts" on public.ledger_accounts;
drop policy if exists "Users can delete own ledger accounts" on public.ledger_accounts;

drop policy if exists "Users can read own ledger transactions" on public.ledger_transactions;
drop policy if exists "Users can insert own ledger transactions" on public.ledger_transactions;
drop policy if exists "Users can update own ledger transactions" on public.ledger_transactions;
drop policy if exists "Users can delete own ledger transactions" on public.ledger_transactions;

drop policy if exists "Users can read own ledger entries" on public.ledger_entries;
drop policy if exists "Users can insert own ledger entries" on public.ledger_entries;
drop policy if exists "Users can update own ledger entries" on public.ledger_entries;
drop policy if exists "Users can delete own ledger entries" on public.ledger_entries;

drop policy if exists "Users can read own ledger account balances" on public.ledger_account_balances;
drop policy if exists "Users can insert own ledger account balances" on public.ledger_account_balances;
drop policy if exists "Users can update own ledger account balances" on public.ledger_account_balances;
drop policy if exists "Users can delete own ledger account balances" on public.ledger_account_balances;

drop policy if exists "Users can read own transaction history" on public.user_transactions;
create policy "Users can read own transaction history"
on public.user_transactions for select
to authenticated
using (auth.uid() = user_id);

drop policy if exists "Users can insert own transaction history" on public.user_transactions;
drop policy if exists "Users can update own transaction history" on public.user_transactions;
drop policy if exists "Users can delete own transaction history" on public.user_transactions;

-- Phase 2 Deluxe + Phase 3 + corrected fee engine compatibility migration.
-- This block is intentionally append-only so an existing Supabase project can rerun the schema safely.

alter table public.ledger_accounts drop constraint if exists ledger_accounts_account_type_check;
alter table public.ledger_accounts add constraint ledger_accounts_account_type_check
check (account_type in (
  'customer_custody',
  'treasury_settlement',
  'fee_revenue',
  'reserve_shock',
  'simulated_ngn_corporate_reserve',
  'demo_ngn_mint_source',
  'demo_ngn_burn_sink',
  'simulated_external_bank_settlement_sink',
  'statutory_fee_payable',
  'gas_fee_recovery',
  'customer_funds_pool',
  'simulated_external_payout_expense',
  'demo_crypto_faucet_source'
));

alter table public.ledger_entries drop constraint if exists ledger_entries_entry_role_check;
alter table public.ledger_entries add constraint ledger_entries_entry_role_check
check (entry_role in (
  'user_debit',
  'user_credit',
  'treasury_movement',
  'fee_movement',
  'reserve_movement',
  'corporate_reserve_movement',
  'demo_mint_movement',
  'demo_burn_movement',
  'external_bank_settlement_movement',
  'statutory_fee_movement',
  'gas_fee_movement',
  'demo_crypto_faucet_movement'
)) not valid;

alter table public.user_transactions add column if not exists transaction_type text;
alter table public.user_transactions add column if not exists status text not null default 'posted';
alter table public.user_transactions add column if not exists asset_code text not null default 'NGN';
alter table public.user_transactions alter column amount type numeric(36, 18);
alter table public.user_transactions add column if not exists fee_amount numeric(36, 18) not null default 0;
alter table public.user_transactions add column if not exists total_deducted numeric(36, 18) not null default 0;
alter table public.user_transactions add column if not exists sender_name text;
alter table public.user_transactions add column if not exists sender_account text;
alter table public.user_transactions add column if not exists receiver_name text;
alter table public.user_transactions add column if not exists receiver_account text;
alter table public.user_transactions add column if not exists bank_name text;
alter table public.user_transactions add column if not exists recipient_name text;
alter table public.user_transactions add column if not exists recipient_account text;
alter table public.user_transactions add column if not exists narration text;
alter table public.user_transactions add column if not exists updated_at timestamptz;

create table if not exists public.fee_events (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid references public.ledger_transactions(id) on delete set null,
  user_id uuid references public.profiles(id) on delete set null,
  asset_symbol text not null check (asset_symbol in ('NGN', 'USDCX', 'MON', 'ETHX', 'cirBTCX', 'EURCX')),
  fee_rate numeric(12, 8) not null default 0,
  platform_fee_amount numeric(36, 18) not null default 0 check (platform_fee_amount >= 0),
  statutory_fee_amount numeric(36, 18) not null default 0 check (statutory_fee_amount >= 0),
  gas_fee_amount numeric(36, 18) not null default 0 check (gas_fee_amount >= 0),
  total_fee_amount numeric(36, 18) not null default 0 check (total_fee_amount >= 0),
  fee_asset text not null check (fee_asset in ('NGN', 'USDCX', 'MON', 'ETHX', 'cirBTCX', 'EURCX')),
  fee_reason text not null,
  fee_destination_account_id uuid references public.ledger_accounts(id),
  status text not null default 'posted' check (status in ('pending', 'posted', 'waived', 'failed')),
  created_at timestamptz not null default now()
);

create index if not exists fee_events_user_id_created_at_idx
on public.fee_events(user_id, created_at desc);

alter table public.fee_events enable row level security;
revoke all on public.fee_events from anon, authenticated;

create table if not exists public.admin_users (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.admin_users enable row level security;
revoke all on public.admin_users from anon, authenticated;

create or replace function public.seed_platform_ledger_accounts()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  asset text;
begin
  foreach asset in array array['NGN', 'USDCX', 'MON', 'ETHX', 'cirBTCX', 'EURCX']
  loop
    insert into public.ledger_accounts (owner_type, account_type, asset_code, account_name, is_system)
    values
      ('platform', 'treasury_settlement', asset, 'NairaX Treasury/Settlement - ' || asset, true),
      ('platform', 'fee_revenue', asset, 'NairaX Fee Revenue - ' || asset, true),
      ('platform', 'reserve_shock', asset, 'NairaX Reserve/Shock Fund - ' || asset, true),
      ('platform', 'gas_fee_recovery', asset, 'NairaX Gas Fee Recovery - ' || asset, true)
    on conflict do nothing;
  end loop;

  insert into public.ledger_accounts (owner_type, account_type, asset_code, account_name, is_system)
  values
    ('platform', 'simulated_ngn_corporate_reserve', 'NGN', 'NairaX Simulated NGN Corporate Reserve', true),
    ('platform', 'demo_ngn_mint_source', 'NGN', 'Demo NGN Funding Source', true),
    ('platform', 'demo_ngn_burn_sink', 'NGN', 'Demo NGN Burn Sink', true),
    ('platform', 'simulated_external_bank_settlement_sink', 'NGN', 'Simulated External Bank Settlement Sink', true),
    ('platform', 'statutory_fee_payable', 'NGN', 'Statutory Fee Payable - NGN', true)
  on conflict do nothing;
end;
$$;

select public.seed_platform_ledger_accounts();
select public.seed_all_ledger_account_balances();

drop view if exists public.ledger_transaction_movements;
create view public.ledger_transaction_movements as
select
  t.id as transaction_id,
  t.transaction_type,
  t.status,
  t.user_id,
  t.asset_code as primary_asset_code,
  t.amount as primary_amount,
  t.tx_hash,
  t.description,
  coalesce(sum(e.amount) filter (where e.entry_role = 'user_debit' and e.direction = 'debit'), 0) as user_debit,
  coalesce(sum(e.amount) filter (where e.entry_role = 'user_credit' and e.direction = 'credit'), 0) as user_credit,
  coalesce(sum(e.amount) filter (where e.entry_role = 'treasury_movement' and e.direction = 'debit'), 0) as treasury_debit,
  coalesce(sum(e.amount) filter (where e.entry_role = 'treasury_movement' and e.direction = 'credit'), 0) as treasury_credit,
  coalesce(sum(e.amount) filter (where e.entry_role = 'fee_movement' and e.direction = 'debit'), 0) as fee_debit,
  coalesce(sum(e.amount) filter (where e.entry_role = 'fee_movement' and e.direction = 'credit'), 0) as fee_credit,
  coalesce(sum(e.amount) filter (where e.entry_role = 'statutory_fee_movement' and e.direction = 'debit'), 0) as statutory_fee_debit,
  coalesce(sum(e.amount) filter (where e.entry_role = 'statutory_fee_movement' and e.direction = 'credit'), 0) as statutory_fee_credit,
  coalesce(sum(e.amount) filter (where e.entry_role = 'gas_fee_movement' and e.direction = 'debit'), 0) as gas_fee_debit,
  coalesce(sum(e.amount) filter (where e.entry_role = 'gas_fee_movement' and e.direction = 'credit'), 0) as gas_fee_credit,
  coalesce(sum(e.amount) filter (where e.entry_role = 'reserve_movement' and e.direction = 'debit'), 0) as reserve_debit,
  coalesce(sum(e.amount) filter (where e.entry_role = 'reserve_movement' and e.direction = 'credit'), 0) as reserve_credit,
  coalesce(sum(e.amount) filter (where e.entry_role = 'corporate_reserve_movement' and e.direction = 'debit'), 0) as corporate_reserve_debit,
  coalesce(sum(e.amount) filter (where e.entry_role = 'corporate_reserve_movement' and e.direction = 'credit'), 0) as corporate_reserve_credit,
  coalesce(sum(e.amount) filter (where e.entry_role = 'demo_mint_movement' and e.direction = 'debit'), 0) as demo_mint_debit,
  coalesce(sum(e.amount) filter (where e.entry_role = 'demo_mint_movement' and e.direction = 'credit'), 0) as demo_mint_credit,
  coalesce(sum(e.amount) filter (where e.entry_role = 'demo_burn_movement' and e.direction = 'debit'), 0) as demo_burn_debit,
  coalesce(sum(e.amount) filter (where e.entry_role = 'demo_burn_movement' and e.direction = 'credit'), 0) as demo_burn_credit,
  coalesce(sum(e.amount) filter (where e.entry_role = 'external_bank_settlement_movement' and e.direction = 'debit'), 0) as external_bank_settlement_debit,
  coalesce(sum(e.amount) filter (where e.entry_role = 'external_bank_settlement_movement' and e.direction = 'credit'), 0) as external_bank_settlement_credit,
  t.created_at
from public.ledger_transactions t
left join public.ledger_entries e on e.transaction_id = t.id
group by t.id;

create or replace function public.validate_ledger_entry_account_type()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  ledger_account public.ledger_accounts%rowtype;
begin
  select * into ledger_account
  from public.ledger_accounts
  where id = new.account_id;

  if not found then
    raise exception 'ledger account % does not exist', new.account_id;
  end if;

  if ledger_account.asset_code <> new.asset_code then
    raise exception 'ledger entry asset % does not match ledger account asset %', new.asset_code, ledger_account.asset_code;
  end if;

  if new.entry_role in ('user_debit', 'user_credit') and ledger_account.account_type <> 'customer_custody' then
    raise exception 'user debit/credit entries must post only to customer custody accounts';
  end if;

  if new.entry_role = 'treasury_movement' and ledger_account.account_type <> 'treasury_settlement' then
    raise exception 'treasury movement entries must post only to treasury/settlement accounts';
  end if;

  if new.entry_role = 'fee_movement' and ledger_account.account_type <> 'fee_revenue' then
    raise exception 'fee movement entries must post only to fee revenue accounts';
  end if;

  if new.entry_role = 'statutory_fee_movement' and ledger_account.account_type <> 'statutory_fee_payable' then
    raise exception 'statutory fee entries must post only to statutory fee payable accounts';
  end if;

  if new.entry_role = 'gas_fee_movement' and ledger_account.account_type <> 'gas_fee_recovery' then
    raise exception 'gas fee entries must post only to gas fee recovery accounts';
  end if;

  if new.entry_role = 'reserve_movement' and ledger_account.account_type <> 'reserve_shock' then
    raise exception 'reserve movement entries must post only to reserve/shock fund accounts';
  end if;

  if new.entry_role = 'corporate_reserve_movement' and ledger_account.account_type <> 'simulated_ngn_corporate_reserve' then
    raise exception 'corporate reserve entries must post only to simulated NGN corporate reserve accounts';
  end if;

  if new.entry_role = 'demo_mint_movement' and ledger_account.account_type <> 'demo_ngn_mint_source' then
    raise exception 'demo mint entries must post only to demo NGN funding source accounts';
  end if;

  if new.entry_role = 'demo_burn_movement' and ledger_account.account_type <> 'demo_ngn_burn_sink' then
    raise exception 'demo burn entries must post only to demo NGN burn sink accounts';
  end if;

  if new.entry_role = 'external_bank_settlement_movement' and ledger_account.account_type <> 'simulated_external_bank_settlement_sink' then
    raise exception 'external bank settlement entries must post only to simulated external bank settlement sink accounts';
  end if;

  if ledger_account.account_type = 'customer_custody' and new.user_id is null then
    raise exception 'customer custody ledger entries must include user_id';
  end if;

  return new;
end;
$$;

create or replace function public.internal_asset_transfer(
  sender_user_id uuid,
  recipient_identifier text,
  transfer_asset text,
  transfer_amount numeric,
  transfer_note text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  clean_identifier text := regexp_replace(coalesce(recipient_identifier, ''), '\D', '', 'g');
  normalized_asset text := upper(coalesce(transfer_asset, 'NGN'));
  recipient public.profiles%rowtype;
  sender public.profiles%rowtype;
  sender_account_id uuid;
  receiver_account_id uuid;
  sender_available numeric(36, 18);
  tx_id uuid;
  display_asset text;
begin
  if normalized_asset = 'CIRBTCX' then
    normalized_asset := 'cirBTCX';
  end if;

  if normalized_asset not in ('NGN', 'USDCX', 'MON', 'ETHX', 'cirBTCX', 'EURCX') then
    raise exception 'unsupported transfer asset';
  end if;

  if transfer_amount <= 0 then
    raise exception 'transfer amount must be greater than zero';
  end if;

  select * into sender from public.profiles where id = sender_user_id;
  if sender.id is null then
    raise exception 'sender profile not found';
  end if;

  select * into recipient
  from public.profiles
  where account_number = clean_identifier
     or regexp_replace(phone, '\D', '', 'g') = clean_identifier
     or (char_length(clean_identifier) = 11 and left(clean_identifier, 1) = '0' and account_number = substring(clean_identifier from 2 for 10))
  limit 1;

  if recipient.id is null then
    raise exception 'NairaX recipient not found';
  end if;

  if recipient.id = sender_user_id then
    raise exception 'cannot transfer to yourself';
  end if;

  perform public.create_default_balances(sender_user_id);
  perform public.create_default_balances(recipient.id);
  perform public.create_customer_custody_ledger_accounts(sender_user_id);
  perform public.create_customer_custody_ledger_accounts(recipient.id);

  select id into sender_account_id
  from public.ledger_accounts
  where owner_type = 'customer'
    and owner_id = sender_user_id
    and account_type = 'customer_custody'
    and asset_code = normalized_asset
  limit 1;

  select id into receiver_account_id
  from public.ledger_accounts
  where owner_type = 'customer'
    and owner_id = recipient.id
    and account_type = 'customer_custody'
    and asset_code = normalized_asset
  limit 1;

  select available into sender_available
  from public.balances
  where user_id = sender_user_id and asset_code = normalized_asset
  for update;

  if sender_available < transfer_amount then
    raise exception 'insufficient % balance', normalized_asset;
  end if;

  perform 1 from public.balances where user_id = recipient.id and asset_code = normalized_asset for update;
  perform 1 from public.ledger_account_balances where account_id in (sender_account_id, receiver_account_id) for update;

  update public.balances
  set available = available - transfer_amount,
      ngn_value = case when normalized_asset = 'NGN' then ngn_value - transfer_amount else ngn_value end,
      updated_at = now()
  where user_id = sender_user_id and asset_code = normalized_asset;

  update public.balances
  set available = available + transfer_amount,
      ngn_value = case when normalized_asset = 'NGN' then ngn_value + transfer_amount else ngn_value end,
      updated_at = now()
  where user_id = recipient.id and asset_code = normalized_asset;

  update public.ledger_account_balances
  set available = available - transfer_amount, updated_at = now()
  where account_id = sender_account_id;

  update public.ledger_account_balances
  set available = available + transfer_amount, updated_at = now()
  where account_id = receiver_account_id;

  insert into public.ledger_transactions (
    transaction_type,
    status,
    user_id,
    asset_code,
    amount,
    description,
    metadata
  )
  values (
    'internal_transfer',
    'posted',
    sender_user_id,
    normalized_asset,
    transfer_amount,
    case when normalized_asset = 'NGN' then 'Internal NairaX NGN transfer' else 'Internal NairaX crypto ledger transfer' end,
    jsonb_build_object(
      'recipient_user_id', recipient.id,
      'note', transfer_note,
      'is_internal', true,
      'fee_policy', 'free_internal_transfer'
    )
  )
  returning id into tx_id;

  insert into public.ledger_entries (
    transaction_id,
    account_id,
    user_id,
    entry_role,
    direction,
    asset_code,
    amount,
    memo
  )
  values
    (tx_id, sender_account_id, sender_user_id, 'user_debit', 'debit', normalized_asset, transfer_amount, 'Debit sender customer custody'),
    (tx_id, receiver_account_id, recipient.id, 'user_credit', 'credit', normalized_asset, transfer_amount, 'Credit receiver customer custody');

  display_asset := normalized_asset;

  insert into public.user_transactions (
    user_id,
    ledger_transaction_id,
    direction,
    title,
    amount,
    note,
    counterparty_name,
    counterparty_account,
    transaction_type,
    status,
    asset_code,
    fee_amount,
    total_deducted,
    sender_name,
    sender_account,
    receiver_name,
    receiver_account,
    narration,
    updated_at
  )
  values
    (
      sender_user_id,
      tx_id,
      'out',
      'Sent ' || display_asset || ' to ' || recipient.full_name,
      transfer_amount,
      coalesce(transfer_note, 'Free internal NairaX transfer'),
      recipient.full_name,
      recipient.account_number,
      'internal_transfer',
      'posted',
      normalized_asset,
      0,
      transfer_amount,
      sender.full_name,
      sender.account_number,
      recipient.full_name,
      recipient.account_number,
      coalesce(transfer_note, 'Free internal NairaX transfer'),
      now()
    ),
    (
      recipient.id,
      tx_id,
      'in',
      'Received ' || display_asset || ' from ' || sender.full_name,
      transfer_amount,
      coalesce(transfer_note, 'Free internal NairaX transfer'),
      sender.full_name,
      sender.account_number,
      'internal_transfer',
      'posted',
      normalized_asset,
      0,
      transfer_amount,
      sender.full_name,
      sender.account_number,
      recipient.full_name,
      recipient.account_number,
      coalesce(transfer_note, 'Free internal NairaX transfer'),
      now()
    );

  return tx_id;
end;
$$;

create or replace function public.internal_ngn_transfer(
  sender_user_id uuid,
  recipient_identifier text,
  transfer_amount numeric,
  transfer_note text default null
)
returns uuid
language sql
security definer
set search_path = public
as $$
  select public.internal_asset_transfer(sender_user_id, recipient_identifier, 'NGN', transfer_amount, transfer_note);
$$;

create or replace function public.simulated_external_bank_transfer(
  sender_user_id uuid,
  bank_name text,
  destination_account_number text,
  transfer_amount numeric,
  transfer_note text default null,
  destination_account_name text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  settlement_sink_account_id uuid;
  fee_revenue_account_id uuid;
  statutory_fee_account_id uuid;
  sender_account_id uuid;
  sender_available numeric(36, 18);
  prior_external_count integer;
  platform_fee numeric(36, 18) := 0;
  statutory_fee numeric(36, 18) := 0;
  total_fee numeric(36, 18) := 0;
  total_deducted numeric(36, 18) := 0;
  tx_id uuid;
  clean_account text := regexp_replace(coalesce(destination_account_number, ''), '\D', '', 'g');
begin
  if transfer_amount <= 0 then
    raise exception 'transfer amount must be greater than zero';
  end if;

  if length(clean_account) <> 10 then
    raise exception 'enter a valid 10-digit destination account number';
  end if;

  perform public.seed_platform_ledger_accounts();
  perform public.create_default_balances(sender_user_id);
  perform public.create_customer_custody_ledger_accounts(sender_user_id);

  select count(*) into prior_external_count
  from public.ledger_transactions
  where user_id = sender_user_id
    and transaction_type = 'simulated_external_bank_transfer'
    and status = 'posted'
    and created_at >= (date_trunc('day', now() at time zone 'Africa/Lagos') at time zone 'Africa/Lagos')
    and created_at < ((date_trunc('day', now() at time zone 'Africa/Lagos') + interval '1 day') at time zone 'Africa/Lagos');

  platform_fee := case when prior_external_count >= 3 then 10 else 0 end;
  statutory_fee := case when transfer_amount >= 10000 then 50 else 0 end;
  total_fee := platform_fee + statutory_fee;
  total_deducted := transfer_amount + total_fee;

  select id into settlement_sink_account_id
  from public.ledger_accounts
  where owner_type = 'platform'
    and account_type = 'simulated_external_bank_settlement_sink'
    and asset_code = 'NGN'
  limit 1;

  select id into fee_revenue_account_id
  from public.ledger_accounts
  where owner_type = 'platform'
    and account_type = 'fee_revenue'
    and asset_code = 'NGN'
  limit 1;

  select id into statutory_fee_account_id
  from public.ledger_accounts
  where owner_type = 'platform'
    and account_type = 'statutory_fee_payable'
    and asset_code = 'NGN'
  limit 1;

  select id into sender_account_id
  from public.ledger_accounts
  where owner_type = 'customer'
    and owner_id = sender_user_id
    and account_type = 'customer_custody'
    and asset_code = 'NGN'
  limit 1;

  select available into sender_available
  from public.balances
  where user_id = sender_user_id and asset_code = 'NGN'
  for update;

  if sender_available < total_deducted then
    raise exception 'insufficient NGN balance. Total required is %', total_deducted;
  end if;

  perform public.ensure_ledger_account_balance(settlement_sink_account_id);
  perform public.ensure_ledger_account_balance(fee_revenue_account_id);
  perform public.ensure_ledger_account_balance(statutory_fee_account_id);
  perform 1 from public.ledger_account_balances
  where account_id in (sender_account_id, settlement_sink_account_id, fee_revenue_account_id, statutory_fee_account_id)
  for update;

  update public.balances
  set available = available - total_deducted,
      ngn_value = ngn_value - total_deducted,
      updated_at = now()
  where user_id = sender_user_id and asset_code = 'NGN';

  update public.ledger_account_balances
  set available = available - total_deducted, updated_at = now()
  where account_id = sender_account_id;

  update public.ledger_account_balances
  set available = available + transfer_amount, updated_at = now()
  where account_id = settlement_sink_account_id;

  if platform_fee > 0 then
    update public.ledger_account_balances
    set available = available + platform_fee, updated_at = now()
    where account_id = fee_revenue_account_id;
  end if;

  if statutory_fee > 0 then
    update public.ledger_account_balances
    set available = available + statutory_fee, updated_at = now()
    where account_id = statutory_fee_account_id;
  end if;

  insert into public.ledger_transactions (
    transaction_type,
    status,
    user_id,
    asset_code,
    amount,
    description,
    metadata
  )
  values (
    'simulated_external_bank_transfer',
    'posted',
    sender_user_id,
    'NGN',
    transfer_amount,
    'Simulated external bank transfer',
    jsonb_build_object(
      'bank_name', bank_name,
      'destination_account_number', clean_account,
      'destination_account_name', destination_account_name,
      'note', transfer_note,
      'platform_fee', platform_fee,
      'statutory_fee', statutory_fee,
      'total_fee', total_fee,
      'total_deducted', total_deducted,
      'prior_external_transfer_count', prior_external_count
    )
  )
  returning id into tx_id;

  insert into public.ledger_entries (
    transaction_id,
    account_id,
    user_id,
    entry_role,
    direction,
    asset_code,
    amount,
    memo
  )
  values
    (tx_id, sender_account_id, sender_user_id, 'user_debit', 'debit', 'NGN', total_deducted, 'Debit user NGN custody for simulated bank transfer plus fees'),
    (tx_id, settlement_sink_account_id, null, 'external_bank_settlement_movement', 'credit', 'NGN', transfer_amount, 'Credit simulated external bank settlement sink');

  if platform_fee > 0 then
    insert into public.ledger_entries (
      transaction_id, account_id, user_id, entry_role, direction, asset_code, amount, memo
    )
    values (
      tx_id, fee_revenue_account_id, null, 'fee_movement', 'credit', 'NGN', platform_fee, 'Credit NGN platform transfer fee'
    );
  end if;

  if statutory_fee > 0 then
    insert into public.ledger_entries (
      transaction_id, account_id, user_id, entry_role, direction, asset_code, amount, memo
    )
    values (
      tx_id, statutory_fee_account_id, null, 'statutory_fee_movement', 'credit', 'NGN', statutory_fee, 'Credit statutory fee payable'
    );
  end if;

  if total_fee > 0 then
    insert into public.fee_events (
      transaction_id,
      user_id,
      asset_symbol,
      fee_rate,
      platform_fee_amount,
      statutory_fee_amount,
      gas_fee_amount,
      total_fee_amount,
      fee_asset,
      fee_reason,
      fee_destination_account_id,
      status
    )
    values (
      tx_id,
      sender_user_id,
      'NGN',
      0,
      platform_fee,
      statutory_fee,
      0,
      total_fee,
      'NGN',
      'simulated_external_bank_transfer',
      case when platform_fee > 0 then fee_revenue_account_id else statutory_fee_account_id end,
      'posted'
    );
  end if;

  insert into public.user_transactions (
    user_id,
    ledger_transaction_id,
    direction,
    title,
    amount,
    note,
    counterparty_name,
    counterparty_account,
    transaction_type,
    status,
    asset_code,
    fee_amount,
    total_deducted,
    sender_name,
    sender_account,
    receiver_name,
    receiver_account,
    bank_name,
    recipient_name,
    recipient_account,
    narration,
    updated_at
  )
  select
    sender_user_id,
    tx_id,
    'out',
    'Simulated bank transfer to ' || coalesce(nullif(bank_name, ''), 'Bank') || ' ' || clean_account,
    transfer_amount,
    coalesce(transfer_note, 'Naira banking is simulated. No real money moved.'),
    coalesce(nullif(destination_account_name, ''), coalesce(nullif(bank_name, ''), 'External Bank')),
    clean_account,
    'simulated_external_bank_transfer',
    'posted',
    'NGN',
    total_fee,
    total_deducted,
    p.full_name,
    p.account_number,
    coalesce(nullif(destination_account_name, ''), 'External bank recipient'),
    clean_account,
    coalesce(nullif(bank_name, ''), 'External Bank'),
    coalesce(nullif(destination_account_name, ''), 'External bank recipient'),
    clean_account,
    coalesce(transfer_note, 'Simulated external bank transfer'),
    now()
  from public.profiles p
  where p.id = sender_user_id;

  return tx_id;
end;
$$;

-- Final SECURITY DEFINER hardening.
-- Keep this as the last executable block in the schema.
update public.ledger_accounts
set account_name = 'CBN Statutory Fee Payable - NGN'
where owner_type = 'platform'
  and account_type = 'statutory_fee_payable'
  and asset_code = 'NGN';

alter view if exists public.ledger_transaction_movements set (security_invoker = true);
revoke all on public.ledger_transaction_movements from anon, authenticated;
revoke execute on all functions in schema public from anon, authenticated;
grant execute on all functions in schema public to service_role;
alter default privileges in schema public revoke execute on functions from anon, authenticated;
alter default privileges in schema public grant execute on functions to service_role;

create or replace function public.resolve_nairax_recipient(
  requesting_user_id uuid,
  recipient_identifier text
)
returns table (
  id uuid,
  full_name text,
  account_number text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  clean_identifier text := regexp_replace(coalesce(recipient_identifier, ''), '\D', '', 'g');
begin
  return query
  select p.id, p.full_name, p.account_number
  from public.profiles p
  where p.id <> requesting_user_id
    and (
      p.account_number = clean_identifier
      or regexp_replace(p.phone, '\D', '', 'g') = clean_identifier
      or (char_length(clean_identifier) = 11 and left(clean_identifier, 1) = '0' and p.account_number = substring(clean_identifier from 2 for 10))
    )
  limit 1;
end;
$$;

revoke all on function public.internal_asset_transfer(uuid, text, text, numeric, text) from anon, authenticated;
revoke all on function public.resolve_nairax_recipient(uuid, text) from anon, authenticated;
grant execute on function public.internal_asset_transfer(uuid, text, text, numeric, text) to service_role;
grant execute on function public.resolve_nairax_recipient(uuid, text) to service_role;
grant execute on function public.internal_ngn_transfer(uuid, text, numeric, text) to service_role;
grant execute on function public.simulated_external_bank_transfer(uuid, text, text, numeric, text, text) to service_role;

-- Phase 5 Deluxe: deployed demo ERC20 registry, platform wallets, and one-time faucet.

alter table public.ledger_accounts drop constraint if exists ledger_accounts_account_type_check;
alter table public.ledger_accounts add constraint ledger_accounts_account_type_check
check (account_type in (
  'customer_custody',
  'treasury_settlement',
  'fee_revenue',
  'reserve_shock',
  'simulated_ngn_corporate_reserve',
  'demo_ngn_mint_source',
  'demo_ngn_burn_sink',
  'simulated_external_bank_settlement_sink',
  'statutory_fee_payable',
  'gas_fee_recovery',
  'customer_funds_pool',
  'simulated_external_payout_expense',
  'demo_crypto_faucet_source'
));

alter table public.ledger_entries drop constraint if exists ledger_entries_entry_role_check;
alter table public.ledger_entries add constraint ledger_entries_entry_role_check
check (entry_role in (
  'user_debit',
  'user_credit',
  'treasury_movement',
  'fee_movement',
  'reserve_movement',
  'corporate_reserve_movement',
  'demo_mint_movement',
  'demo_burn_movement',
  'external_bank_settlement_movement',
  'statutory_fee_movement',
  'gas_fee_movement',
  'demo_crypto_faucet_movement'
)) not valid;

create table if not exists public.supported_tokens (
  id uuid primary key default gen_random_uuid(),
  symbol text not null check (symbol in ('USDCX', 'EURCX', 'ETHX', 'cirBTCX')),
  name text not null,
  decimals integer not null check (decimals >= 0 and decimals <= 36),
  network text not null,
  chain_id bigint not null,
  contract_address text not null,
  is_active boolean not null default true,
  faucet_amount numeric(36, 18) not null default 0 check (faucet_amount > 0),
  explorer_base_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (symbol, network)
);

create table if not exists public.platform_wallets (
  id uuid primary key default gen_random_uuid(),
  wallet_type text not null check (wallet_type in ('demo_faucet', 'treasury', 'fee')),
  network text not null,
  wallet_address text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (wallet_type, network)
);

create table if not exists public.network_gas_settings (
  id uuid primary key default gen_random_uuid(),
  network text not null unique,
  native_symbol text not null default 'ETH',
  gas_faucet_amount numeric(36, 18) not null default 0 check (gas_faucet_amount >= 0),
  withdrawal_gas_fee_amount numeric(36, 18) not null default 0 check (withdrawal_gas_fee_amount >= 0),
  gas_faucet_enabled boolean not null default false,
  explorer_base_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.network_gas_settings add column if not exists withdrawal_gas_fee_amount numeric(36, 18) not null default 0;

create table if not exists public.faucet_claims (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  token_symbol text not null,
  network text not null,
  amount numeric(36, 18) not null check (amount > 0),
  tx_hash text,
  status text not null default 'pending' check (status in ('pending', 'submitted', 'posted', 'failed')),
  claimed_at timestamptz not null default now(),
  unique (user_id, token_symbol, network)
);

create index if not exists faucet_claims_user_id_claimed_at_idx
on public.faucet_claims(user_id, claimed_at desc);

drop trigger if exists supported_tokens_set_updated_at on public.supported_tokens;
create trigger supported_tokens_set_updated_at
before update on public.supported_tokens
for each row execute function public.set_updated_at();

drop trigger if exists platform_wallets_set_updated_at on public.platform_wallets;
create trigger platform_wallets_set_updated_at
before update on public.platform_wallets
for each row execute function public.set_updated_at();

drop trigger if exists network_gas_settings_set_updated_at on public.network_gas_settings;
create trigger network_gas_settings_set_updated_at
before update on public.network_gas_settings
for each row execute function public.set_updated_at();

insert into public.supported_tokens (symbol, name, decimals, network, chain_id, contract_address, is_active, faucet_amount)
values
  ('USDCX', 'USDCX Demo Token', 6, 'Arc Testnet', 5042002, '0xf7dD42F87F92A8B19d6a8615aceBAf3Ee4D4EB3a', true, 150),
  ('EURCX', 'EURCX Demo Token', 6, 'Arc Testnet', 5042002, '0x29d0D3a0df438878D4bf8316e9537006b2b9F401', true, 150),
  ('cirBTCX', 'cirBTCX Demo Token', 8, 'Arc Testnet', 5042002, '0x27793Ec6760760670328592ca8BAeA43bb0ad3FB', true, 1),
  ('ETHX', 'ETHX Demo Token', 18, 'Arc Testnet', 5042002, '0x2e7226d8EcB1975bB1530C4C654509D975316fa8', true, 1)
on conflict (symbol, network) do update
set name = excluded.name,
    decimals = excluded.decimals,
    chain_id = excluded.chain_id,
    contract_address = excluded.contract_address,
    is_active = excluded.is_active,
    faucet_amount = excluded.faucet_amount,
    updated_at = now();

insert into public.network_gas_settings (network, native_symbol, gas_faucet_amount, gas_faucet_enabled)
values
  ('Arc Testnet', 'USDC', 0, false),
  ('Monad Testnet', 'MON', 0, false)
on conflict (network) do nothing;

create or replace function public.seed_platform_ledger_accounts()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  asset text;
begin
  foreach asset in array array['NGN', 'USDCX', 'MON', 'ETHX', 'cirBTCX', 'EURCX']
  loop
    insert into public.ledger_accounts (owner_type, account_type, asset_code, account_name, is_system)
    values
      ('platform', 'treasury_settlement', asset, 'NairaX Treasury/Settlement - ' || asset, true),
      ('platform', 'fee_revenue', asset, 'NairaX Fee Revenue - ' || asset, true),
      ('platform', 'reserve_shock', asset, 'NairaX Reserve/Shock Fund - ' || asset, true),
      ('platform', 'gas_fee_recovery', asset, 'NairaX Gas Fee Recovery - ' || asset, true)
    on conflict do nothing;
  end loop;

  foreach asset in array array['USDCX', 'MON', 'ETHX', 'cirBTCX', 'EURCX']
  loop
    insert into public.ledger_accounts (owner_type, account_type, asset_code, account_name, is_system)
    values ('platform', 'demo_crypto_faucet_source', asset, 'Demo Crypto Faucet Source - ' || asset, true)
    on conflict do nothing;
  end loop;

  insert into public.ledger_accounts (owner_type, account_type, asset_code, account_name, is_system)
  values
    ('platform', 'simulated_ngn_corporate_reserve', 'NGN', 'NairaX Simulated NGN Corporate Reserve', true),
    ('platform', 'demo_ngn_mint_source', 'NGN', 'Demo NGN Funding Source', true),
    ('platform', 'demo_ngn_burn_sink', 'NGN', 'Demo NGN Burn Sink', true),
    ('platform', 'simulated_external_bank_settlement_sink', 'NGN', 'Simulated External Bank Settlement Sink', true),
    ('platform', 'statutory_fee_payable', 'NGN', 'Statutory Fee Payable - NGN', true)
  on conflict do nothing;
end;
$$;

select public.seed_platform_ledger_accounts();
select public.seed_all_ledger_account_balances();

create or replace function public.validate_ledger_entry_account_type()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  ledger_account public.ledger_accounts%rowtype;
begin
  select * into ledger_account
  from public.ledger_accounts
  where id = new.account_id;

  if not found then
    raise exception 'ledger account % does not exist', new.account_id;
  end if;

  if ledger_account.asset_code <> new.asset_code then
    raise exception 'ledger entry asset % does not match ledger account asset %', new.asset_code, ledger_account.asset_code;
  end if;

  if new.entry_role in ('user_debit', 'user_credit') and ledger_account.account_type <> 'customer_custody' then
    raise exception 'user debit/credit entries must post only to customer custody accounts';
  end if;

  if new.entry_role = 'treasury_movement' and ledger_account.account_type <> 'treasury_settlement' then
    raise exception 'treasury movement entries must post only to treasury/settlement accounts';
  end if;

  if new.entry_role = 'fee_movement' and ledger_account.account_type <> 'fee_revenue' then
    raise exception 'fee movement entries must post only to fee revenue accounts';
  end if;

  if new.entry_role = 'statutory_fee_movement' and ledger_account.account_type <> 'statutory_fee_payable' then
    raise exception 'statutory fee entries must post only to statutory fee payable accounts';
  end if;

  if new.entry_role = 'gas_fee_movement' and ledger_account.account_type <> 'gas_fee_recovery' then
    raise exception 'gas fee entries must post only to gas fee recovery accounts';
  end if;

  if new.entry_role = 'reserve_movement' and ledger_account.account_type <> 'reserve_shock' then
    raise exception 'reserve movement entries must post only to reserve/shock fund accounts';
  end if;

  if new.entry_role = 'corporate_reserve_movement' and ledger_account.account_type <> 'simulated_ngn_corporate_reserve' then
    raise exception 'corporate reserve entries must post only to simulated NGN corporate reserve accounts';
  end if;

  if new.entry_role = 'demo_mint_movement' and ledger_account.account_type <> 'demo_ngn_mint_source' then
    raise exception 'demo mint entries must post only to demo NGN funding source accounts';
  end if;

  if new.entry_role = 'demo_burn_movement' and ledger_account.account_type <> 'demo_ngn_burn_sink' then
    raise exception 'demo burn entries must post only to demo NGN burn sink accounts';
  end if;

  if new.entry_role = 'external_bank_settlement_movement' and ledger_account.account_type <> 'simulated_external_bank_settlement_sink' then
    raise exception 'external bank settlement entries must post only to simulated external bank settlement sink accounts';
  end if;

  if new.entry_role = 'demo_crypto_faucet_movement' and ledger_account.account_type <> 'demo_crypto_faucet_source' then
    raise exception 'demo crypto faucet entries must post only to demo crypto faucet source accounts';
  end if;

  if ledger_account.account_type = 'customer_custody' and new.user_id is null then
    raise exception 'customer custody ledger entries must include user_id';
  end if;

  return new;
end;
$$;

create or replace function public.credit_demo_faucet_claim(
  target_user_id uuid,
  token_symbol text,
  token_network text,
  claim_amount numeric,
  chain_tx_hash text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  normalized_asset text := case when upper(token_symbol) = 'CIRBTCX' then 'cirBTCX' else upper(token_symbol) end;
  faucet_source_account_id uuid;
  user_account_id uuid;
  tx_id uuid;
begin
  if normalized_asset not in ('USDCX', 'ETHX', 'cirBTCX', 'EURCX') then
    raise exception 'unsupported faucet token';
  end if;

  if claim_amount <= 0 then
    raise exception 'faucet amount must be greater than zero';
  end if;

  if chain_tx_hash is null or length(chain_tx_hash) < 10 then
    raise exception 'chain transaction hash is required before ledger credit';
  end if;

  perform public.seed_platform_ledger_accounts();
  perform public.create_default_balances(target_user_id);
  perform public.create_customer_custody_ledger_accounts(target_user_id);

  select id into faucet_source_account_id
  from public.ledger_accounts
  where owner_type = 'platform'
    and owner_id is null
    and account_type = 'demo_crypto_faucet_source'
    and asset_code = normalized_asset
  limit 1;

  select id into user_account_id
  from public.ledger_accounts
  where owner_type = 'customer'
    and owner_id = target_user_id
    and account_type = 'customer_custody'
    and asset_code = normalized_asset
  limit 1;

  if faucet_source_account_id is null or user_account_id is null then
    raise exception 'required faucet ledger accounts are missing';
  end if;

  perform public.ensure_ledger_account_balance(faucet_source_account_id);
  perform public.ensure_ledger_account_balance(user_account_id);
  perform 1 from public.ledger_account_balances where account_id in (faucet_source_account_id, user_account_id) for update;
  perform 1 from public.balances where user_id = target_user_id and asset_code = normalized_asset for update;

  update public.ledger_account_balances
  set available = available + claim_amount, updated_at = now()
  where account_id = user_account_id;

  update public.balances
  set available = available + claim_amount,
      updated_at = now()
  where user_id = target_user_id and asset_code = normalized_asset;

  insert into public.ledger_transactions (
    transaction_type,
    status,
    user_id,
    asset_code,
    amount,
    tx_hash,
    description,
    metadata
  )
  values (
    'external_crypto_deposit',
    'posted',
    target_user_id,
    normalized_asset,
    claim_amount,
    chain_tx_hash,
    'Demo Faucet Funding',
    jsonb_build_object('network', token_network, 'source', 'demo_faucet')
  )
  returning id into tx_id;

  insert into public.ledger_entries (
    transaction_id,
    account_id,
    user_id,
    entry_role,
    direction,
    asset_code,
    amount,
    memo
  )
  values
    (tx_id, faucet_source_account_id, null, 'demo_crypto_faucet_movement', 'debit', normalized_asset, claim_amount, 'Demo faucet external funding source'),
    (tx_id, user_account_id, target_user_id, 'user_credit', 'credit', normalized_asset, claim_amount, 'Credit user custody after successful on-chain faucet transfer');

  insert into public.user_transactions (
    user_id,
    ledger_transaction_id,
    direction,
    title,
    amount,
    note,
    transaction_type,
    status,
    asset_code,
    fee_amount,
    total_deducted,
    receiver_name,
    narration,
    updated_at
  )
  values (
    target_user_id,
    tx_id,
    'in',
    'Demo Faucet Funding - ' || claim_amount::text || ' ' || normalized_asset,
    claim_amount,
    'Demo tokens run on testnets and have no real value.',
    'demo_faucet_funding',
    'posted',
    normalized_asset,
    0,
    0,
    'NairaX Demo Faucet',
    'Demo Faucet Funding',
    now()
  );

  return tx_id;
end;
$$;

alter table public.supported_tokens enable row level security;
alter table public.platform_wallets enable row level security;
alter table public.network_gas_settings enable row level security;
alter table public.faucet_claims enable row level security;

revoke all on public.platform_wallets from anon, authenticated;
revoke all on public.network_gas_settings from anon, authenticated;
grant select on public.supported_tokens to authenticated;
grant select on public.faucet_claims to authenticated;

drop policy if exists "Users can read active supported tokens" on public.supported_tokens;
create policy "Users can read active supported tokens"
on public.supported_tokens for select
to authenticated
using (is_active = true);

drop policy if exists "Users can read own faucet claims" on public.faucet_claims;
create policy "Users can read own faucet claims"
on public.faucet_claims for select
to authenticated
using (auth.uid() = user_id);

revoke all on function public.credit_demo_faucet_claim(uuid, text, text, numeric, text) from anon, authenticated;
grant execute on function public.credit_demo_faucet_claim(uuid, text, text, numeric, text) to service_role;

-- Phase 6 Deluxe: external crypto deposits and treasury-settled withdrawals.

create table if not exists public.crypto_deposits (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  network text not null,
  chain_id bigint not null,
  token_symbol text not null check (token_symbol in ('USDCX', 'EURCX', 'ETHX', 'cirBTCX')),
  token_contract text not null,
  wallet_address text not null,
  amount numeric(36, 18) not null check (amount > 0),
  tx_hash text not null unique,
  status text not null default 'completed' check (status in ('pending', 'completed', 'failed')),
  verified_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.user_transactions add column if not exists tx_hash text;
alter table public.user_transactions add column if not exists gas_fee_amount numeric(36, 18) not null default 0;

create index if not exists crypto_deposits_user_id_created_at_idx
on public.crypto_deposits(user_id, created_at desc);

create table if not exists public.crypto_withdrawals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  network text not null,
  chain_id bigint not null,
  token_symbol text not null check (token_symbol in ('USDCX', 'EURCX', 'ETHX', 'cirBTCX')),
  token_contract text not null,
  recipient_address text not null,
  amount numeric(36, 18) not null check (amount > 0),
  platform_fee numeric(36, 18) not null default 0 check (platform_fee >= 0),
  gas_fee_estimate numeric(36, 18) not null default 0 check (gas_fee_estimate >= 0),
  total_deducted numeric(36, 18) not null check (total_deducted > 0),
  tx_hash text unique,
  status text not null default 'pending' check (status in ('pending', 'completed', 'failed')),
  failure_reason text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists crypto_withdrawals_user_id_created_at_idx
on public.crypto_withdrawals(user_id, created_at desc);

alter table public.crypto_withdrawals add column if not exists fee_wallet_address text;
alter table public.crypto_withdrawals add column if not exists fee_tx_hash text;
alter table public.crypto_withdrawals add column if not exists fee_settlement_status text not null default 'not_required';
alter table public.crypto_withdrawals add column if not exists fee_settlement_error text;

alter table public.crypto_deposits enable row level security;
alter table public.crypto_withdrawals enable row level security;
grant select on public.crypto_deposits to authenticated;
grant select on public.crypto_withdrawals to authenticated;

drop policy if exists "Users can read own crypto deposits" on public.crypto_deposits;
create policy "Users can read own crypto deposits"
on public.crypto_deposits for select
to authenticated
using (auth.uid() = user_id);

drop policy if exists "Users can read own crypto withdrawals" on public.crypto_withdrawals;
create policy "Users can read own crypto withdrawals"
on public.crypto_withdrawals for select
to authenticated
using (auth.uid() = user_id);

create or replace function public.credit_verified_crypto_deposit(
  target_user_id uuid,
  deposit_network text,
  deposit_chain_id bigint,
  deposit_token_symbol text,
  deposit_token_contract text,
  deposit_wallet_address text,
  deposit_amount numeric,
  deposit_tx_hash text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  normalized_asset text := case when upper(deposit_token_symbol) = 'CIRBTCX' then 'cirBTCX' else upper(deposit_token_symbol) end;
  treasury_account_id uuid;
  user_account_id uuid;
  tx_id uuid;
begin
  if normalized_asset not in ('USDCX', 'ETHX', 'cirBTCX', 'EURCX') then
    raise exception 'unsupported deposit token';
  end if;

  if deposit_amount <= 0 then
    raise exception 'deposit amount must be greater than zero';
  end if;

  if exists (select 1 from public.crypto_deposits where tx_hash = deposit_tx_hash) then
    raise exception 'this deposit transaction hash has already been used';
  end if;

  perform public.seed_platform_ledger_accounts();
  perform public.create_default_balances(target_user_id);
  perform public.create_customer_custody_ledger_accounts(target_user_id);

  select id into treasury_account_id
  from public.ledger_accounts
  where owner_type = 'platform'
    and owner_id is null
    and account_type = 'treasury_settlement'
    and asset_code = normalized_asset
  limit 1;

  select id into user_account_id
  from public.ledger_accounts
  where owner_type = 'customer'
    and owner_id = target_user_id
    and account_type = 'customer_custody'
    and asset_code = normalized_asset
  limit 1;

  if treasury_account_id is null or user_account_id is null then
    raise exception 'required crypto deposit ledger accounts are missing';
  end if;

  perform public.ensure_ledger_account_balance(user_account_id);
  perform 1 from public.ledger_account_balances where account_id = user_account_id for update;
  perform 1 from public.balances where user_id = target_user_id and asset_code = normalized_asset for update;

  update public.ledger_account_balances
  set available = available + deposit_amount, updated_at = now()
  where account_id = user_account_id;

  update public.balances
  set available = available + deposit_amount,
      updated_at = now()
  where user_id = target_user_id and asset_code = normalized_asset;

  insert into public.crypto_deposits (
    user_id, network, chain_id, token_symbol, token_contract, wallet_address,
    amount, tx_hash, status, verified_at
  )
  values (
    target_user_id, deposit_network, deposit_chain_id, normalized_asset, deposit_token_contract,
    deposit_wallet_address, deposit_amount, deposit_tx_hash, 'completed', now()
  );

  insert into public.ledger_transactions (
    transaction_type, status, user_id, asset_code, amount, tx_hash, description, metadata
  )
  values (
    'external_crypto_deposit',
    'posted',
    target_user_id,
    normalized_asset,
    deposit_amount,
    deposit_tx_hash,
    'External Crypto Deposit',
    jsonb_build_object('network', deposit_network, 'token_contract', deposit_token_contract, 'wallet_address', deposit_wallet_address)
  )
  returning id into tx_id;

  insert into public.ledger_entries (
    transaction_id, account_id, user_id, entry_role, direction, asset_code, amount, memo
  )
  values
    (tx_id, treasury_account_id, null, 'treasury_movement', 'debit', normalized_asset, deposit_amount, 'External token deposit verified on-chain'),
    (tx_id, user_account_id, target_user_id, 'user_credit', 'credit', normalized_asset, deposit_amount, 'Credit user custody for verified external deposit');

  insert into public.user_transactions (
    user_id, ledger_transaction_id, direction, title, amount, note, transaction_type,
    status, asset_code, fee_amount, total_deducted, receiver_name, receiver_account,
    narration, tx_hash, updated_at
  )
  values (
    target_user_id,
    tx_id,
    'in',
    'External Crypto Deposit - ' || deposit_amount::text || ' ' || normalized_asset,
    deposit_amount,
    'Verified on ' || deposit_network || '. Tx: ' || deposit_tx_hash,
    'external_crypto_deposit',
    'posted',
    normalized_asset,
    0,
    0,
    'NairaX Custodial Wallet',
    deposit_wallet_address,
    'External Crypto Deposit',
    deposit_tx_hash,
    now()
  );

  return tx_id;
end;
$$;

create or replace function public.create_crypto_withdrawal_pending(
  sender_user_id uuid,
  withdrawal_network text,
  withdrawal_chain_id bigint,
  withdrawal_token_symbol text,
  withdrawal_token_contract text,
  withdrawal_recipient_address text,
  withdrawal_amount numeric,
  withdrawal_platform_fee numeric,
  withdrawal_gas_fee_estimate numeric
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  normalized_asset text := case when upper(withdrawal_token_symbol) = 'CIRBTCX' then 'cirBTCX' else upper(withdrawal_token_symbol) end;
  sender_account_id uuid;
  treasury_account_id uuid;
  fee_account_id uuid;
  gas_account_id uuid;
  sender_available numeric(36, 18);
  total_amount numeric(36, 18);
  withdrawal_id uuid;
begin
  if normalized_asset not in ('USDCX', 'ETHX', 'cirBTCX', 'EURCX') then
    raise exception 'unsupported withdrawal token';
  end if;

  if withdrawal_amount <= 0 then
    raise exception 'withdrawal amount must be greater than zero';
  end if;

  total_amount := withdrawal_amount + coalesce(withdrawal_platform_fee, 0) + coalesce(withdrawal_gas_fee_estimate, 0);

  perform public.seed_platform_ledger_accounts();
  perform public.create_default_balances(sender_user_id);
  perform public.create_customer_custody_ledger_accounts(sender_user_id);

  select id into sender_account_id from public.ledger_accounts
  where owner_type = 'customer' and owner_id = sender_user_id and account_type = 'customer_custody' and asset_code = normalized_asset limit 1;
  select id into treasury_account_id from public.ledger_accounts
  where owner_type = 'platform' and owner_id is null and account_type = 'treasury_settlement' and asset_code = normalized_asset limit 1;
  select id into fee_account_id from public.ledger_accounts
  where owner_type = 'platform' and owner_id is null and account_type = 'fee_revenue' and asset_code = normalized_asset limit 1;
  select id into gas_account_id from public.ledger_accounts
  where owner_type = 'platform' and owner_id is null and account_type = 'gas_fee_recovery' and asset_code = normalized_asset limit 1;

  select available into sender_available
  from public.balances
  where user_id = sender_user_id and asset_code = normalized_asset
  for update;

  if sender_available < total_amount then
    raise exception 'insufficient % balance. Total required is %', normalized_asset, total_amount;
  end if;

  perform public.ensure_ledger_account_balance(sender_account_id);
  perform public.ensure_ledger_account_balance(treasury_account_id);
  perform public.ensure_ledger_account_balance(fee_account_id);
  perform public.ensure_ledger_account_balance(gas_account_id);
  perform 1 from public.ledger_account_balances where account_id in (sender_account_id, treasury_account_id, fee_account_id, gas_account_id) for update;

  update public.balances set available = available - total_amount, updated_at = now()
  where user_id = sender_user_id and asset_code = normalized_asset;
  update public.ledger_account_balances set available = available - total_amount, updated_at = now()
  where account_id = sender_account_id;
  update public.ledger_account_balances set available = available + withdrawal_amount, updated_at = now()
  where account_id = treasury_account_id;

  if withdrawal_platform_fee > 0 then
    update public.ledger_account_balances set available = available + withdrawal_platform_fee, updated_at = now()
    where account_id = fee_account_id;
  end if;

  if withdrawal_gas_fee_estimate > 0 then
    update public.ledger_account_balances set available = available + withdrawal_gas_fee_estimate, updated_at = now()
    where account_id = gas_account_id;
  end if;

  insert into public.crypto_withdrawals (
    user_id, network, chain_id, token_symbol, token_contract, recipient_address,
    amount, platform_fee, gas_fee_estimate, total_deducted, status
  )
  values (
    sender_user_id, withdrawal_network, withdrawal_chain_id, normalized_asset, withdrawal_token_contract,
    withdrawal_recipient_address, withdrawal_amount, coalesce(withdrawal_platform_fee, 0),
    coalesce(withdrawal_gas_fee_estimate, 0), total_amount, 'pending'
  )
  returning id into withdrawal_id;

  return withdrawal_id;
end;
$$;

create or replace function public.complete_crypto_withdrawal(
  withdrawal_id uuid,
  chain_tx_hash text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  w public.crypto_withdrawals%rowtype;
  sender public.profiles%rowtype;
  sender_account_id uuid;
  treasury_account_id uuid;
  fee_account_id uuid;
  gas_account_id uuid;
  tx_id uuid;
begin
  select * into w from public.crypto_withdrawals where id = withdrawal_id for update;
  if w.id is null then raise exception 'withdrawal not found'; end if;
  if w.status <> 'pending' then raise exception 'withdrawal is not pending'; end if;

  select * into sender from public.profiles where id = w.user_id;

  select id into sender_account_id from public.ledger_accounts
  where owner_type = 'customer' and owner_id = w.user_id and account_type = 'customer_custody' and asset_code = w.token_symbol limit 1;
  select id into treasury_account_id from public.ledger_accounts
  where owner_type = 'platform' and owner_id is null and account_type = 'treasury_settlement' and asset_code = w.token_symbol limit 1;
  select id into fee_account_id from public.ledger_accounts
  where owner_type = 'platform' and owner_id is null and account_type = 'fee_revenue' and asset_code = w.token_symbol limit 1;
  select id into gas_account_id from public.ledger_accounts
  where owner_type = 'platform' and owner_id is null and account_type = 'gas_fee_recovery' and asset_code = w.token_symbol limit 1;

  update public.crypto_withdrawals
  set tx_hash = chain_tx_hash, status = 'completed', completed_at = now()
  where id = withdrawal_id;

  insert into public.ledger_transactions (
    transaction_type, status, user_id, asset_code, amount, tx_hash, description, metadata
  )
  values (
    'external_crypto_withdrawal',
    'posted',
    w.user_id,
    w.token_symbol,
    w.amount,
    chain_tx_hash,
    'External Crypto Withdrawal',
    jsonb_build_object(
      'network', w.network,
      'recipient_address', w.recipient_address,
      'platform_fee', w.platform_fee,
      'gas_fee_estimate', w.gas_fee_estimate,
      'total_deducted', w.total_deducted,
      'settlement_wallet', 'NairaX Treasury Wallet'
    )
  )
  returning id into tx_id;

  insert into public.ledger_entries (
    transaction_id, account_id, user_id, entry_role, direction, asset_code, amount, memo
  )
  values
    (tx_id, sender_account_id, w.user_id, 'user_debit', 'debit', w.token_symbol, w.total_deducted, 'Debit user custody for external withdrawal'),
    (tx_id, treasury_account_id, null, 'treasury_movement', 'credit', w.token_symbol, w.amount, 'Settled via NairaX Treasury Wallet');

  if w.platform_fee > 0 then
    insert into public.ledger_entries (transaction_id, account_id, user_id, entry_role, direction, asset_code, amount, memo)
    values (tx_id, fee_account_id, null, 'fee_movement', 'credit', w.token_symbol, w.platform_fee, 'Credit crypto platform fee');
  end if;

  if w.gas_fee_estimate > 0 then
    insert into public.ledger_entries (transaction_id, account_id, user_id, entry_role, direction, asset_code, amount, memo)
    values (tx_id, gas_account_id, null, 'gas_fee_movement', 'credit', w.token_symbol, w.gas_fee_estimate, 'Credit gas recovery');
  end if;

  insert into public.fee_events (
    transaction_id, user_id, asset_symbol, fee_rate, fee_amount, platform_fee_amount,
    statutory_fee_amount, gas_fee_amount, total_fee_amount, fee_asset, fee_reason,
    fee_destination_account_id, status
  )
  values (
    tx_id, w.user_id, w.token_symbol, 0.003, w.platform_fee, w.platform_fee,
    0, w.gas_fee_estimate, w.platform_fee + w.gas_fee_estimate,
    w.token_symbol, 'external_crypto_withdrawal', fee_account_id, 'posted'
  );

  insert into public.user_transactions (
    user_id, ledger_transaction_id, direction, title, amount, note, counterparty_name,
    counterparty_account, transaction_type, status, asset_code, fee_amount, total_deducted,
    sender_name, receiver_name, receiver_account, narration, tx_hash, gas_fee_amount, updated_at
  )
  values (
    w.user_id,
    tx_id,
    'out',
    'External Crypto Withdrawal - ' || w.amount::text || ' ' || w.token_symbol,
    w.amount,
    'Settled via NairaX Treasury Wallet. Tx: ' || chain_tx_hash,
    'External Wallet',
    w.recipient_address,
    'external_crypto_withdrawal',
    'posted',
    w.token_symbol,
    w.platform_fee + w.gas_fee_estimate,
    w.total_deducted,
    sender.full_name,
    'External Wallet',
    w.recipient_address,
    'External Crypto Withdrawal',
    chain_tx_hash,
    w.gas_fee_estimate,
    now()
  );

  return tx_id;
end;
$$;

create or replace function public.fail_crypto_withdrawal_refund(
  withdrawal_id uuid,
  reason text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  w public.crypto_withdrawals%rowtype;
  sender_account_id uuid;
  treasury_account_id uuid;
  fee_account_id uuid;
  gas_account_id uuid;
begin
  select * into w from public.crypto_withdrawals where id = withdrawal_id for update;
  if w.id is null then raise exception 'withdrawal not found'; end if;
  if w.status <> 'pending' then return; end if;

  select id into sender_account_id from public.ledger_accounts
  where owner_type = 'customer' and owner_id = w.user_id and account_type = 'customer_custody' and asset_code = w.token_symbol limit 1;
  select id into treasury_account_id from public.ledger_accounts
  where owner_type = 'platform' and owner_id is null and account_type = 'treasury_settlement' and asset_code = w.token_symbol limit 1;
  select id into fee_account_id from public.ledger_accounts
  where owner_type = 'platform' and owner_id is null and account_type = 'fee_revenue' and asset_code = w.token_symbol limit 1;
  select id into gas_account_id from public.ledger_accounts
  where owner_type = 'platform' and owner_id is null and account_type = 'gas_fee_recovery' and asset_code = w.token_symbol limit 1;

  update public.balances set available = available + w.total_deducted, updated_at = now()
  where user_id = w.user_id and asset_code = w.token_symbol;
  update public.ledger_account_balances set available = available + w.total_deducted, updated_at = now()
  where account_id = sender_account_id;
  update public.ledger_account_balances set available = greatest(available - w.amount, 0), updated_at = now()
  where account_id = treasury_account_id;
  update public.ledger_account_balances set available = greatest(available - w.platform_fee, 0), updated_at = now()
  where account_id = fee_account_id;
  update public.ledger_account_balances set available = greatest(available - w.gas_fee_estimate, 0), updated_at = now()
  where account_id = gas_account_id;

  update public.crypto_withdrawals
  set status = 'failed', failure_reason = reason
  where id = withdrawal_id;
end;
$$;

revoke all on function public.credit_verified_crypto_deposit(uuid, text, bigint, text, text, text, numeric, text) from anon, authenticated;
revoke all on function public.create_crypto_withdrawal_pending(uuid, text, bigint, text, text, text, numeric, numeric, numeric) from anon, authenticated;
revoke all on function public.complete_crypto_withdrawal(uuid, text) from anon, authenticated;
revoke all on function public.fail_crypto_withdrawal_refund(uuid, text) from anon, authenticated;
grant execute on function public.credit_verified_crypto_deposit(uuid, text, bigint, text, text, text, numeric, text) to service_role;
grant execute on function public.create_crypto_withdrawal_pending(uuid, text, bigint, text, text, text, numeric, numeric, numeric) to service_role;
grant execute on function public.complete_crypto_withdrawal(uuid, text) to service_role;
grant execute on function public.fail_crypto_withdrawal_refund(uuid, text) to service_role;

-- Phase 4 override: 0.6% platform fee for active transfer flows.
-- This supersedes the earlier free-internal-transfer/NGN-statutory-fee experiment.

alter table public.fee_events add column if not exists fee_amount numeric(36, 18) not null default 0;

create or replace function public.internal_asset_transfer(
  sender_user_id uuid,
  recipient_identifier text,
  transfer_asset text,
  transfer_amount numeric,
  transfer_note text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  clean_identifier text := regexp_replace(coalesce(recipient_identifier, ''), '\D', '', 'g');
  normalized_asset text := upper(coalesce(transfer_asset, 'NGN'));
  recipient public.profiles%rowtype;
  sender public.profiles%rowtype;
  sender_account_id uuid;
  receiver_account_id uuid;
  fee_revenue_account_id uuid;
  sender_available numeric(36, 18);
  fee_amount numeric(36, 18);
  total_deducted numeric(36, 18);
  tx_id uuid;
  display_asset text;
begin
  if normalized_asset = 'CIRBTCX' then
    normalized_asset := 'cirBTCX';
  end if;

  if normalized_asset not in ('NGN', 'USDCX', 'MON', 'ETHX', 'cirBTCX', 'EURCX') then
    raise exception 'unsupported transfer asset';
  end if;

  if transfer_amount <= 0 then
    raise exception 'transfer amount must be greater than zero';
  end if;

  fee_amount := 0;
  total_deducted := transfer_amount + fee_amount;

  select * into sender from public.profiles where id = sender_user_id;
  if sender.id is null then
    raise exception 'sender profile not found';
  end if;

  select * into recipient
  from public.profiles
  where account_number = clean_identifier
     or regexp_replace(phone, '\D', '', 'g') = clean_identifier
     or (char_length(clean_identifier) = 11 and left(clean_identifier, 1) = '0' and account_number = substring(clean_identifier from 2 for 10))
  limit 1;

  if recipient.id is null then
    raise exception 'NairaX recipient not found';
  end if;

  if recipient.id = sender_user_id then
    raise exception 'cannot transfer to yourself';
  end if;

  perform public.seed_platform_ledger_accounts();
  perform public.create_default_balances(sender_user_id);
  perform public.create_default_balances(recipient.id);
  perform public.create_customer_custody_ledger_accounts(sender_user_id);
  perform public.create_customer_custody_ledger_accounts(recipient.id);

  select id into sender_account_id
  from public.ledger_accounts
  where owner_type = 'customer'
    and owner_id = sender_user_id
    and account_type = 'customer_custody'
    and asset_code = normalized_asset
  limit 1;

  select id into receiver_account_id
  from public.ledger_accounts
  where owner_type = 'customer'
    and owner_id = recipient.id
    and account_type = 'customer_custody'
    and asset_code = normalized_asset
  limit 1;

  select id into fee_revenue_account_id
  from public.ledger_accounts
  where owner_type = 'platform'
    and owner_id is null
    and account_type = 'fee_revenue'
    and asset_code = normalized_asset
  limit 1;

  if sender_account_id is null or receiver_account_id is null or fee_revenue_account_id is null then
    raise exception 'required ledger accounts are missing for %', normalized_asset;
  end if;

  select available into sender_available
  from public.balances
  where user_id = sender_user_id and asset_code = normalized_asset
  for update;

  if sender_available < total_deducted then
    raise exception 'insufficient % balance. Total required is %', normalized_asset, total_deducted;
  end if;

  perform public.ensure_ledger_account_balance(fee_revenue_account_id);
  perform 1 from public.balances where user_id = recipient.id and asset_code = normalized_asset for update;
  perform 1 from public.ledger_account_balances
  where account_id in (sender_account_id, receiver_account_id, fee_revenue_account_id)
  for update;

  update public.balances
  set available = available - total_deducted,
      ngn_value = case when normalized_asset = 'NGN' then ngn_value - total_deducted else ngn_value end,
      updated_at = now()
  where user_id = sender_user_id and asset_code = normalized_asset;

  update public.balances
  set available = available + transfer_amount,
      ngn_value = case when normalized_asset = 'NGN' then ngn_value + transfer_amount else ngn_value end,
      updated_at = now()
  where user_id = recipient.id and asset_code = normalized_asset;

  update public.ledger_account_balances
  set available = available - total_deducted, updated_at = now()
  where account_id = sender_account_id;

  update public.ledger_account_balances
  set available = available + transfer_amount, updated_at = now()
  where account_id = receiver_account_id;

  if fee_amount > 0 then
    update public.ledger_account_balances
    set available = available + fee_amount, updated_at = now()
    where account_id = fee_revenue_account_id;
  end if;

  insert into public.ledger_transactions (
    transaction_type,
    status,
    user_id,
    asset_code,
    amount,
    description,
    metadata
  )
  values (
    'internal_transfer',
    'posted',
    sender_user_id,
    normalized_asset,
    transfer_amount,
    case when normalized_asset = 'NGN' then 'Internal NairaX NGN transfer' else 'Internal NairaX crypto ledger transfer' end,
    jsonb_build_object(
      'recipient_user_id', recipient.id,
      'note', transfer_note,
      'is_internal', true,
      'fee_rate', case when fee_amount > 0 then 0.006 else 0 end,
      'fee_amount', fee_amount,
      'total_deducted', total_deducted
    )
  )
  returning id into tx_id;

  insert into public.ledger_entries (
    transaction_id,
    account_id,
    user_id,
    entry_role,
    direction,
    asset_code,
    amount,
    memo
  )
  values
    (tx_id, sender_account_id, sender_user_id, 'user_debit', 'debit', normalized_asset, total_deducted, 'Debit sender customer custody for amount plus 0.6% fee'),
    (tx_id, receiver_account_id, recipient.id, 'user_credit', 'credit', normalized_asset, transfer_amount, 'Credit receiver customer custody');

  if fee_amount > 0 then
    insert into public.ledger_entries (
      transaction_id, account_id, user_id, entry_role, direction, asset_code, amount, memo
    )
    values (
      tx_id, fee_revenue_account_id, null, 'fee_movement', 'credit', normalized_asset, fee_amount, 'Credit 0.6% platform fee revenue'
    );

    insert into public.fee_events (
      transaction_id,
      user_id,
      asset_symbol,
      fee_rate,
      fee_amount,
      platform_fee_amount,
      statutory_fee_amount,
      gas_fee_amount,
      total_fee_amount,
      fee_asset,
      fee_reason,
      fee_destination_account_id,
      status
    )
    values (
      tx_id,
      sender_user_id,
      normalized_asset,
      0.006,
      fee_amount,
      fee_amount,
      0,
      0,
      fee_amount,
      normalized_asset,
      'internal_transfer',
      fee_revenue_account_id,
      'posted'
    );
  end if;

  display_asset := normalized_asset;

  insert into public.user_transactions (
    user_id,
    ledger_transaction_id,
    direction,
    title,
    amount,
    note,
    counterparty_name,
    counterparty_account,
    transaction_type,
    status,
    asset_code,
    fee_amount,
    total_deducted,
    sender_name,
    sender_account,
    receiver_name,
    receiver_account,
    narration,
    updated_at
  )
  values
    (
      sender_user_id,
      tx_id,
      'out',
      'Sent ' || display_asset || ' to ' || recipient.full_name,
      transfer_amount,
      coalesce(transfer_note, 'NairaX internal transfer'),
      recipient.full_name,
      recipient.account_number,
      'internal_transfer',
      'posted',
      normalized_asset,
      fee_amount,
      total_deducted,
      sender.full_name,
      sender.account_number,
      recipient.full_name,
      recipient.account_number,
      coalesce(transfer_note, 'NairaX internal transfer'),
      now()
    ),
    (
      recipient.id,
      tx_id,
      'in',
      'Received ' || display_asset || ' from ' || sender.full_name,
      transfer_amount,
      coalesce(transfer_note, 'NairaX internal transfer'),
      sender.full_name,
      sender.account_number,
      'internal_transfer',
      'posted',
      normalized_asset,
      0,
      transfer_amount,
      sender.full_name,
      sender.account_number,
      recipient.full_name,
      recipient.account_number,
      coalesce(transfer_note, 'NairaX internal transfer'),
      now()
    );

  return tx_id;
end;
$$;

create or replace function public.simulated_external_bank_transfer(
  sender_user_id uuid,
  bank_name text,
  destination_account_number text,
  transfer_amount numeric,
  transfer_note text default null,
  destination_account_name text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  settlement_sink_account_id uuid;
  fee_revenue_account_id uuid;
  statutory_fee_account_id uuid;
  sender_account_id uuid;
  sender_available numeric(36, 18);
  fee_amount numeric(36, 18) := 0;
  statutory_fee numeric(36, 18) := 0;
  prior_external_count integer := 0;
  total_deducted numeric(36, 18) := 0;
  tx_id uuid;
  clean_account text := regexp_replace(coalesce(destination_account_number, ''), '\D', '', 'g');
begin
  if transfer_amount <= 0 then
    raise exception 'transfer amount must be greater than zero';
  end if;

  if length(clean_account) <> 10 then
    raise exception 'enter a valid 10-digit destination account number';
  end if;

  select count(*) into prior_external_count
  from public.ledger_transactions
  where user_id = sender_user_id
    and transaction_type = 'simulated_external_bank_transfer'
    and status = 'posted'
    and created_at >= (date_trunc('day', now() at time zone 'Africa/Lagos') at time zone 'Africa/Lagos')
    and created_at < ((date_trunc('day', now() at time zone 'Africa/Lagos') + interval '1 day') at time zone 'Africa/Lagos');

  fee_amount := case when prior_external_count >= 3 then 10 else 0 end;
  statutory_fee := case when transfer_amount >= 10000 then 50 else 0 end;
  total_deducted := transfer_amount + fee_amount + statutory_fee;

  perform public.seed_platform_ledger_accounts();
  perform public.create_default_balances(sender_user_id);
  perform public.create_customer_custody_ledger_accounts(sender_user_id);

  select id into settlement_sink_account_id
  from public.ledger_accounts
  where owner_type = 'platform'
    and account_type = 'simulated_external_bank_settlement_sink'
    and asset_code = 'NGN'
  limit 1;

  select id into fee_revenue_account_id
  from public.ledger_accounts
  where owner_type = 'platform'
    and account_type = 'fee_revenue'
    and asset_code = 'NGN'
  limit 1;

  select id into sender_account_id
  from public.ledger_accounts
  where owner_type = 'customer'
    and owner_id = sender_user_id
    and account_type = 'customer_custody'
    and asset_code = 'NGN'
  limit 1;

  select id into statutory_fee_account_id
  from public.ledger_accounts
  where owner_type = 'platform'
    and account_type = 'statutory_fee_payable'
    and asset_code = 'NGN'
  limit 1;

  select available into sender_available
  from public.balances
  where user_id = sender_user_id and asset_code = 'NGN'
  for update;

  if sender_available < total_deducted then
    raise exception 'insufficient NGN balance. Total required is %', total_deducted;
  end if;

  perform public.ensure_ledger_account_balance(settlement_sink_account_id);
  perform public.ensure_ledger_account_balance(fee_revenue_account_id);
  perform public.ensure_ledger_account_balance(statutory_fee_account_id);
  perform 1 from public.ledger_account_balances
  where account_id in (sender_account_id, settlement_sink_account_id, fee_revenue_account_id, statutory_fee_account_id)
  for update;

  update public.balances
  set available = available - total_deducted,
      ngn_value = ngn_value - total_deducted,
      updated_at = now()
  where user_id = sender_user_id and asset_code = 'NGN';

  update public.ledger_account_balances
  set available = available - total_deducted, updated_at = now()
  where account_id = sender_account_id;

  update public.ledger_account_balances
  set available = available + transfer_amount, updated_at = now()
  where account_id = settlement_sink_account_id;

  if fee_amount > 0 then
    update public.ledger_account_balances
    set available = available + fee_amount, updated_at = now()
    where account_id = fee_revenue_account_id;
  end if;

  if statutory_fee > 0 then
    update public.ledger_account_balances
    set available = available + statutory_fee, updated_at = now()
    where account_id = statutory_fee_account_id;
  end if;

  insert into public.ledger_transactions (
    transaction_type,
    status,
    user_id,
    asset_code,
    amount,
    description,
    metadata
  )
  values (
    'simulated_external_bank_transfer',
    'posted',
    sender_user_id,
    'NGN',
    transfer_amount,
    'Simulated external bank transfer',
    jsonb_build_object(
      'bank_name', bank_name,
      'destination_account_number', clean_account,
      'destination_account_name', destination_account_name,
      'note', transfer_note,
      'fee_policy', 'first_3_external_ngn_free_then_10_plus_50_statutory_at_10000',
      'platform_fee', fee_amount,
      'statutory_fee', statutory_fee,
      'fee_amount', fee_amount + statutory_fee,
      'total_deducted', total_deducted,
      'simulated', true
    )
  )
  returning id into tx_id;

  insert into public.ledger_entries (
    transaction_id,
    account_id,
    user_id,
    entry_role,
    direction,
    asset_code,
    amount,
    memo
  )
  values
    (tx_id, sender_account_id, sender_user_id, 'user_debit', 'debit', 'NGN', total_deducted, 'Debit user NGN custody for simulated bank transfer plus fees'),
    (tx_id, settlement_sink_account_id, null, 'external_bank_settlement_movement', 'credit', 'NGN', transfer_amount, 'Credit simulated external bank settlement sink');

  if fee_amount > 0 then
    insert into public.ledger_entries (transaction_id, account_id, user_id, entry_role, direction, asset_code, amount, memo)
    values (tx_id, fee_revenue_account_id, null, 'fee_movement', 'credit', 'NGN', fee_amount, 'Credit NGN platform transfer fee');
  end if;

  if statutory_fee > 0 then
    insert into public.ledger_entries (transaction_id, account_id, user_id, entry_role, direction, asset_code, amount, memo)
    values (tx_id, statutory_fee_account_id, null, 'statutory_fee_movement', 'credit', 'NGN', statutory_fee, 'Credit CBN statutory fee payable');
  end if;

  insert into public.fee_events (
    transaction_id,
    user_id,
    asset_symbol,
    fee_rate,
    fee_amount,
    platform_fee_amount,
    statutory_fee_amount,
    gas_fee_amount,
    total_fee_amount,
    fee_asset,
    fee_reason,
    fee_destination_account_id,
    status
  )
  values (
    tx_id,
    sender_user_id,
    'NGN',
    0,
    fee_amount + statutory_fee,
    fee_amount,
    statutory_fee,
    0,
    fee_amount + statutory_fee,
    'NGN',
    'simulated_external_bank_transfer',
    case when fee_amount > 0 then fee_revenue_account_id else statutory_fee_account_id end,
    'posted'
  );

  insert into public.user_transactions (
    user_id,
    ledger_transaction_id,
    direction,
    title,
    amount,
    note,
    counterparty_name,
    counterparty_account,
    transaction_type,
    status,
    asset_code,
    fee_amount,
    total_deducted,
    sender_name,
    sender_account,
    receiver_name,
    receiver_account,
    bank_name,
    recipient_name,
    recipient_account,
    narration,
    updated_at
  )
  select
    sender_user_id,
    tx_id,
    'out',
    'Simulated bank transfer to ' || coalesce(nullif(bank_name, ''), 'Bank') || ' ' || clean_account,
    transfer_amount,
    coalesce(transfer_note, 'Naira banking is simulated. No real money moved.'),
    coalesce(nullif(destination_account_name, ''), coalesce(nullif(bank_name, ''), 'External Bank')),
    clean_account,
    'simulated_external_bank_transfer',
    'posted',
    'NGN',
    fee_amount + statutory_fee,
    total_deducted,
    p.full_name,
    p.account_number,
    coalesce(nullif(destination_account_name, ''), 'External bank recipient'),
    clean_account,
    coalesce(nullif(bank_name, ''), 'External Bank'),
    coalesce(nullif(destination_account_name, ''), 'External bank recipient'),
    clean_account,
    coalesce(transfer_note, 'Simulated external bank transfer'),
    now()
  from public.profiles p
  where p.id = sender_user_id;

  return tx_id;
end;
$$;

-- Final SECURITY DEFINER hardening.
-- Keep this as the last executable block in the schema.
alter view if exists public.ledger_transaction_movements set (security_invoker = true);
revoke all on public.ledger_transaction_movements from anon, authenticated;
revoke execute on all functions in schema public from anon, authenticated;
grant execute on all functions in schema public to service_role;
alter default privileges in schema public revoke execute on functions from anon, authenticated;
alter default privileges in schema public grant execute on functions to service_role;

update public.ledger_accounts
set account_name = 'CBN Statutory Fee Payable - NGN'
where owner_type = 'platform'
  and account_type = 'statutory_fee_payable'
  and asset_code = 'NGN';
