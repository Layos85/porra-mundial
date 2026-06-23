-- ============================================================
--  Porra del Mundial — esquema de base de datos (Supabase)
--  Pega TODO este script en: Supabase → SQL Editor → New query → Run
--  (Se puede ejecutar varias veces sin problema.)
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
  kind              text not null default 'free',   -- 'match' (pronostico) | 'free' (libre)
  category          text not null,
  question          text not null,
  options           jsonb not null default '[]',    -- apuestas libres: [{id,label,odds}]
  -- pronostico de partido:
  team_a            text,
  team_b            text,
  odds_exact        numeric,                         -- cuota si aciertas el MARCADOR EXACTO (mayor)
  odds_winner       numeric,                         -- cuota si aciertas solo el GANADOR (menor)
  real_a            integer,                         -- resultado real al resolver
  real_b            integer,
  status            text not null default 'open',
  winning_option_id text,                            -- apuestas libres
  created_at        timestamptz default now(),
  resolved_at       timestamptz
);

create table if not exists wagers (
  id         uuid primary key default gen_random_uuid(),
  bet_id     uuid references bets(id) on delete cascade,
  pool_id    uuid references pools(id) on delete cascade,
  player_id  uuid references players(id) on delete cascade,
  option_id  text,                                   -- apuestas libres
  pred_a     integer,                                -- pronostico de partido: marcador previsto
  pred_b     integer,
  amount     numeric not null,
  created_at timestamptz default now()
);

-- Columnas nuevas para bases de datos creadas con una version anterior:
alter table bets   add column if not exists kind        text not null default 'free';
alter table bets   add column if not exists team_a      text;
alter table bets   add column if not exists team_b      text;
alter table bets   add column if not exists odds_exact  numeric;
alter table bets   add column if not exists odds_winner numeric;
alter table bets   add column if not exists real_a      integer;
alter table bets   add column if not exists real_b      integer;
alter table bets   alter column options set default '[]';
alter table wagers add column if not exists pred_a      integer;
alter table wagers add column if not exists pred_b      integer;
alter table wagers alter column option_id drop not null;

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

-- ============================================================
--  APUESTAS LIBRES ("por fuera")
-- ============================================================

-- Apostar de forma atomica (cambia tu apuesta si ya tenias una)
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

-- Resolver apuesta libre y pagar premios (apostado x cuota)
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

-- ============================================================
--  PRONOSTICO DE PARTIDO (porra con marcador escalonado)
--  Marcador exacto paga MAS que acertar solo el ganador.
-- ============================================================

-- Apostar un marcador a un partido (cambia tu pronostico si ya tenias uno)
create or replace function place_match_wager(p_bet_id uuid, p_player_id uuid, p_pred_a integer, p_pred_b integer, p_amount numeric)
returns void language plpgsql security definer as $$
declare
  v_status text; v_kind text; v_pool uuid; v_balance numeric; v_prev numeric := 0;
begin
  select status, kind, pool_id into v_status, v_kind, v_pool from bets where id = p_bet_id;
  if v_status is null then raise exception 'Apuesta no encontrada'; end if;
  if v_kind <> 'match' then raise exception 'Esta apuesta no es un pronostico de partido'; end if;
  if v_status <> 'open' then raise exception 'El partido ya esta cerrado'; end if;
  if p_amount <= 0 then raise exception 'Cantidad no valida'; end if;
  if p_pred_a < 0 or p_pred_b < 0 then raise exception 'Marcador no valido'; end if;

  select coalesce(sum(amount),0) into v_prev from wagers where bet_id = p_bet_id and player_id = p_player_id;
  select balance into v_balance from players where id = p_player_id;
  if v_balance + v_prev < p_amount then raise exception 'Saldo insuficiente'; end if;

  delete from wagers where bet_id = p_bet_id and player_id = p_player_id;
  update players set balance = balance + v_prev - p_amount where id = p_player_id;

  insert into wagers(bet_id, pool_id, player_id, pred_a, pred_b, amount)
  values (p_bet_id, v_pool, p_player_id, p_pred_a, p_pred_b, p_amount);
end; $$;

-- Resolver un partido con el resultado real y pagar por niveles
create or replace function resolve_match(p_bet_id uuid, p_real_a integer, p_real_b integer)
returns void language plpgsql security definer as $$
declare
  v_status text; v_kind text; v_oe numeric; v_ow numeric;
  v_real_sign int; w record; w_sign int;
begin
  select status, kind, odds_exact, odds_winner into v_status, v_kind, v_oe, v_ow
  from bets where id = p_bet_id;
  if v_status is null then raise exception 'Apuesta no encontrada'; end if;
  if v_kind <> 'match' then raise exception 'No es un pronostico de partido'; end if;
  if v_status <> 'open' then raise exception 'El partido ya esta resuelto'; end if;

  v_real_sign := sign(p_real_a - p_real_b);

  for w in select * from wagers where bet_id = p_bet_id loop
    if w.pred_a = p_real_a and w.pred_b = p_real_b then
      -- marcador EXACTO -> premio mayor
      update players set balance = balance + w.amount * v_oe where id = w.player_id;
    else
      w_sign := sign(w.pred_a - w.pred_b);
      if w_sign = v_real_sign then
        -- solo el GANADOR (o empate) -> premio menor
        update players set balance = balance + w.amount * v_ow where id = w.player_id;
      end if;
    end if;
  end loop;

  update bets set status='resolved', real_a=p_real_a, real_b=p_real_b, resolved_at=now()
  where id = p_bet_id;
end; $$;

-- ---------- Activar sincronizacion en tiempo real ----------
alter publication supabase_realtime add table pools, players, bets, wagers;
