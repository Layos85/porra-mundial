-- ============================================================
--  Porra del Mundial — esquema de base de datos (Supabase)
--  Pega TODO este script en: Supabase → SQL Editor → New query → Run
-- ============================================================

create extension if not exists "pgcrypto";

-- ---------- Tablas ----------
create table if not exists pools (
  id               uuid primary key default gen_random_uuid(),
  code             text unique not null,
  name             text not null,
  starting_balance numeric not null default 1000,
  created_at       timestamptz default now()
);

create table if not exists players (
  id         uuid primary key default gen_random_uuid(),
  pool_id    uuid references pools(id) on delete cascade,
  name       text not null,
  balance    numeric not null default 0,
  created_at timestamptz default now()
);

create table if not exists bets (
  id                uuid primary key default gen_random_uuid(),
  pool_id           uuid references pools(id) on delete cascade,
  creator_id        uuid references players(id) on delete set null,
  category          text not null,
  question          text not null,
  options           jsonb not null,            -- [{id,label,odds}]
  status            text not null default 'open',
  winning_option_id text,
  created_at        timestamptz default now(),
  resolved_at       timestamptz
);

create table if not exists wagers (
  id         uuid primary key default gen_random_uuid(),
  bet_id     uuid references bets(id) on delete cascade,
  pool_id    uuid references pools(id) on delete cascade,
  player_id  uuid references players(id) on delete cascade,
  option_id  text not null,
  amount     numeric not null,
  created_at timestamptz default now()
);

-- ---------- Seguridad (juego casual con dinero ficticio) ----------
alter table pools   enable row level security;
alter table players enable row level security;
alter table bets    enable row level security;
alter table wagers  enable row level security;

drop policy if exists "open pools"   on pools;
drop policy if exists "open players" on players;
drop policy if exists "open bets"    on bets;
drop policy if exists "open wagers"  on wagers;

create policy "open pools"   on pools   for all using (true) with check (true);
create policy "open players" on players for all using (true) with check (true);
create policy "open bets"    on bets    for all using (true) with check (true);
create policy "open wagers"  on wagers  for all using (true) with check (true);

-- ---------- Apostar de forma atómica (cambia tu apuesta si ya tenías una) ----------
create or replace function place_wager(p_bet_id uuid, p_player_id uuid, p_option_id text, p_amount numeric)
returns void language plpgsql security definer as $$
declare
  v_status text; v_pool uuid; v_balance numeric; v_prev numeric := 0;
begin
  select status, pool_id into v_status, v_pool from bets where id = p_bet_id;
  if v_status is null then raise exception 'Apuesta no encontrada'; end if;
  if v_status <> 'open' then raise exception 'La apuesta ya esta cerrada'; end if;
  if p_amount <= 0 then raise exception 'Cantidad no valida'; end if;

  select coalesce(sum(amount),0) into v_prev from wagers where bet_id = p_bet_id and player_id = p_player_id;
  select balance into v_balance from players where id = p_player_id;
  if v_balance + v_prev < p_amount then raise exception 'Saldo insuficiente'; end if;

  delete from wagers where bet_id = p_bet_id and player_id = p_player_id;
  update players set balance = balance + v_prev - p_amount where id = p_player_id;

  insert into wagers(bet_id, pool_id, player_id, option_id, amount)
  values (p_bet_id, v_pool, p_player_id, p_option_id, p_amount);
end; $$;

-- ---------- Resolver y pagar premios (apostado x cuota) ----------
create or replace function resolve_bet(p_bet_id uuid, p_winning_option_id text)
returns void language plpgsql security definer as $$
declare
  v_status text; v_odds numeric; w record;
begin
  select status into v_status from bets where id = p_bet_id;
  if v_status is null then raise exception 'Apuesta no encontrada'; end if;
  if v_status <> 'open' then raise exception 'La apuesta ya esta resuelta'; end if;

  select (opt->>'odds')::numeric into v_odds
  from bets, jsonb_array_elements(options) opt
  where id = p_bet_id and opt->>'id' = p_winning_option_id;

  for w in select * from wagers where bet_id = p_bet_id and option_id = p_winning_option_id loop
    update players set balance = balance + w.amount * v_odds where id = w.player_id;
  end loop;

  update bets set status='resolved', winning_option_id=p_winning_option_id, resolved_at=now()
  where id = p_bet_id;
end; $$;

-- ---------- Activar sincronizacion en tiempo real ----------
alter publication supabase_realtime add table pools, players, bets, wagers;
