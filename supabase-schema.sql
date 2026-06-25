-- ============================================================
--  Porra del Mundial 2026 — esquema + lógica (Supabase/Postgres)
--  Pega TODO en: Supabase → SQL Editor → New query → Run.
--  Idempotente: se puede ejecutar varias veces.
-- ============================================================
create extension if not exists "pgcrypto";

-- ---------- Configuración (fila única) ----------
create table if not exists config (
  id boolean primary key default true check (id),
  start_points numeric not null default 1000,
  pts_exact    numeric not null default 50,
  pts_winner   numeric not null default 20,
  thr_fav      numeric not null default 0.50,
  thr_even     numeric not null default 0.30,
  fac_even     numeric not null default 1.5,
  fac_surprise numeric not null default 3,
  odds_margin  numeric not null default 0.94
);
insert into config (id) values (true) on conflict (id) do nothing;
alter table config add column if not exists started  boolean not null default false;
alter table config add column if not exists admin_id uuid;
alter table config add column if not exists app_version text not null default '1';   -- súbelo para forzar recarga de todos los clientes

-- ---------- Selecciones / convocatorias ----------
create table if not exists team_strength ( name text primary key, rating numeric not null );
create table if not exists team_squads (
  id uuid primary key default gen_random_uuid(),
  team text not null, player text not null, pos text,
  unique (team, player)
);

-- ---------- Jugadores (liga global) ----------
create table if not exists players (
  id uuid primary key default gen_random_uuid(),
  name text not null, recovery_code text unique not null,
  points numeric not null default 1000, created_at timestamptz default now()
);
-- nombre único (insensible a mayúsculas/espacios)
create unique index if not exists players_name_uniq on players (lower(btrim(name)));

-- ---------- Partidos (los llena el cron) ----------
create table if not exists matches (
  id uuid primary key default gen_random_uuid(),
  ext_id text unique not null,
  stage text not null, grp text,
  team_a text not null, team_b text not null, teams_known boolean not null default false,
  kickoff timestamptz, status text not null default 'scheduled',
  score_a integer, score_b integer, scorers jsonb not null default '[]',
  p_a numeric, p_draw numeric, p_b numeric,
  odds jsonb not null default '{}',
  settled boolean not null default false,
  created_at timestamptz default now()
);
alter table matches add column if not exists pens integer not null default 0;   -- goles de penalti
alter table matches add column if not exists settled_scorers boolean not null default false;  -- goleador/penalti liquidados (necesitan datos de openfootball)
alter table matches add column if not exists pen_a integer;   -- tanda de penaltis (eliminatorias)
alter table matches add column if not exists pen_b integer;

-- Ganador a efectos de apuesta: en eliminatorias incluye los penaltis (no hay empate).
-- Devuelve '1'/'X'/'2' o NULL si es eliminatoria empatada sin penaltis aún conocidos.
create or replace function match_outcome(p_match uuid) returns text
language plpgsql stable as $$
declare m matches%rowtype; begin
  select * into m from matches where id=p_match;
  if m.score_a is null or m.score_b is null then return null; end if;
  if m.stage='grupos' then return outcome_1x2(m.score_a,m.score_b); end if;
  if m.score_a>m.score_b then return '1'; elsif m.score_a<m.score_b then return '2';
  elsif m.pen_a is not null and m.pen_b is not null then return case when m.pen_a>m.pen_b then '1' else '2' end;
  else return null; end if;   -- eliminatoria empatada, penaltis aún desconocidos
end; $$;

-- ---------- Pronósticos (porra base) ----------
create table if not exists predictions (
  id uuid primary key default gen_random_uuid(),
  match_id uuid not null references matches(id) on delete cascade,
  player_id uuid not null references players(id) on delete cascade,
  pred_a integer not null, pred_b integer not null, points numeric,
  created_at timestamptz default now(), updated_at timestamptz default now(),
  unique (match_id, player_id)
);

-- ---------- Retos (1-contra-varios) ----------
create table if not exists challenges (
  id uuid primary key default gen_random_uuid(),
  match_id uuid not null references matches(id) on delete cascade,
  creator_id uuid not null references players(id) on delete cascade,
  market text not null,            -- 1x2|ou|btts|oddeven|exact|scorer
  line numeric,
  selection text not null,
  odds numeric not null check (odds > 1),
  stake numeric not null check (stake > 0),
  max_takers integer not null default 0,   -- 0 = sin límite
  status text not null default 'open',      -- open|resolved|void
  creator_won boolean,
  created_at timestamptz default now(), resolved_at timestamptz
);
create table if not exists challenge_takers (
  id uuid primary key default gen_random_uuid(),
  challenge_id uuid not null references challenges(id) on delete cascade,
  player_id uuid not null references players(id) on delete cascade,
  liability numeric not null,
  created_at timestamptz default now(),
  unique (challenge_id, player_id)
);

-- ---------- RLS abierta (puntos ficticios, sin datos sensibles) ----------
alter table config enable row level security;
alter table team_strength enable row level security;
alter table team_squads enable row level security;
alter table players enable row level security;
alter table matches enable row level security;
alter table predictions enable row level security;
alter table challenges enable row level security;
alter table challenge_takers enable row level security;

drop policy if exists ro_config on config;
drop policy if exists ro_strength on team_strength;
drop policy if exists ro_squads on team_squads;
drop policy if exists rw_players on players;
drop policy if exists ro_matches on matches;
drop policy if exists rw_preds on predictions;
drop policy if exists rw_chals on challenges;
drop policy if exists rw_takers on challenge_takers;

create policy ro_config   on config        for select using (true);
create policy ro_strength on team_strength for select using (true);
create policy ro_squads   on team_squads   for select using (true);
create policy rw_players  on players       for all using (true) with check (true);
create policy ro_matches  on matches       for select using (true);
create policy rw_preds    on predictions   for all using (true) with check (true);
create policy rw_chals    on challenges     for all using (true) with check (true);
create policy rw_takers   on challenge_takers for all using (true) with check (true);

-- ============================================================
--  Probabilidad, dificultad y modelo de cuotas
-- ============================================================
create or replace function calc_probs(r_a numeric, r_b numeric,
  out p_a numeric, out p_draw numeric, out p_b numeric)
language plpgsql immutable as $$
declare e_a numeric;
begin
  e_a := 1.0/(1.0+power(10.0,(r_b-r_a)/400.0));
  p_draw := 0.30*(1.0-2.0*abs(e_a-0.5)); if p_draw<0 then p_draw:=0; end if;
  p_a := (1.0-p_draw)*e_a; p_b := (1.0-p_draw)*(1.0-e_a);
end; $$;

create or replace function outcome_1x2(a integer, b integer) returns text
language sql immutable as $$ select case when a>b then '1' when a=b then 'X' else '2' end; $$;

create or replace function difficulty_factor(p numeric) returns numeric
language plpgsql stable as $$
declare c record; begin
  select thr_fav,thr_even,fac_even,fac_surprise into c from config where id;
  if p>=c.thr_fav then return 1; elsif p>=c.thr_even then return c.fac_even; else return c.fac_surprise; end if;
end; $$;

create or replace function poisson_pmf(k integer, lam numeric) returns numeric
language plpgsql immutable as $$
declare p numeric; i integer; begin
  p := exp(-lam); for i in 1..k loop p := p*lam/i; end loop; return p;
end; $$;

create or replace function team_lambdas(team_a text, team_b text, out la numeric, out lb numeric)
language plpgsql stable as $$
declare ra numeric; rb numeric; d numeric; begin
  ra := coalesce((select rating from team_strength where name=team_a),1500);
  rb := coalesce((select rating from team_strength where name=team_b),1500);
  d := (ra-rb)/100.0;
  la := least(3.4, greatest(0.3, 1.35+0.18*d));
  lb := least(3.4, greatest(0.3, 1.35-0.18*d));
end; $$;

create or replace function suggest_odds(p_match uuid, p_market text, p_selection text, p_line numeric)
returns numeric language plpgsql stable as $$
declare m matches%rowtype; cfg config%rowtype; lam record; pp numeric; real numeric; x int; y int; k int;
begin
  select * into m from matches where id=p_match; if not found then return 2.0; end if;
  select * into cfg from config where id;
  if p_market='1x2' then real := (m.odds #>> ('{1x2,'||p_selection||'}')::text[])::numeric;
  elsif p_market='ou' then real := (m.odds #>> ('{ou,'||p_line::text||','||p_selection||'}')::text[])::numeric;
  elsif p_market='btts' then real := (m.odds #>> ('{btts,'||p_selection||'}')::text[])::numeric;
  end if;
  if real is not null and real>1 then return real; end if;

  if p_market='1x2' then
    pp := case p_selection when '1' then m.p_a when 'X' then m.p_draw else m.p_b end;
  else
    select * into lam from team_lambdas(m.team_a,m.team_b);
    if p_market='ou' then
      pp := 0; for k in 0..floor(coalesce(p_line,2.5))::int loop pp := pp+poisson_pmf(k,lam.la+lam.lb); end loop;
      if p_selection='over' then pp := 1-pp; end if;
    elsif p_market='btts' then
      pp := (1-exp(-lam.la))*(1-exp(-lam.lb)); if p_selection='no' then pp := 1-pp; end if;
    elsif p_market='oddeven' then pp := 0.5;
    elsif p_market='exact' then
      x := split_part(p_selection,'-',1)::int; y := split_part(p_selection,'-',2)::int;
      pp := poisson_pmf(x,lam.la)*poisson_pmf(y,lam.lb);
    elsif p_market='scorer' then
      if exists (select 1 from team_squads where team=m.team_a and player=p_selection)
        then pp := 1-exp(-lam.la/6); else pp := 1-exp(-lam.lb/6); end if;
    elsif p_market='pens' then pp := 0.28; if p_selection='no' then pp := 1-pp; end if;
    else pp := 0.5; end if;
  end if;
  if pp is null or pp<0.004 then pp := 0.004; end if;
  return round(greatest(1.05, (1/pp)*cfg.odds_margin)::numeric, 2);
end; $$;

-- ============================================================
--  RPCs: jugador y pronóstico
-- ============================================================
-- Login SOLO por nombre: si el nombre existe, entra a esa cuenta; si no, la crea.
drop function if exists upsert_player(text, text);
create or replace function upsert_player(p_name text)
returns players language plpgsql security definer as $$
declare v players%rowtype; v_start numeric; begin
  select * into v from players where lower(btrim(name))=lower(btrim(p_name)); if found then return v; end if;
  select start_points into v_start from config where id;
  begin
    insert into players(name,recovery_code,points) values (btrim(p_name), gen_random_uuid()::text, v_start) returning * into v;
  exception when unique_violation then
    select * into v from players where lower(btrim(name))=lower(btrim(p_name)); return v;  -- carrera: devuelve el existente
  end;
  update config set admin_id = v.id where admin_id is null;   -- el primero en entrar es el organizador
  return v;
end; $$;

-- Comenzar la porra (solo el organizador)
create or replace function start_game(p_player uuid)
returns void language plpgsql security definer as $$
declare adm uuid; mid uuid; begin
  select admin_id into adm from config where id;
  if adm is null or adm<>p_player then raise exception 'Solo el organizador puede empezar la porra'; end if;
  update config set started=true where id;
  for mid in select id from matches where status='finished' and settled=false loop perform settle_match(mid); end loop;
end; $$;

create or replace function place_prediction(p_match uuid, p_player uuid, p_a integer, p_b integer)
returns void language plpgsql security definer as $$
declare s text; k timestamptz; known boolean; begin
  select status,kickoff,teams_known into s,k,known from matches where id=p_match;
  if not found then raise exception 'Partido no encontrado'; end if;
  if not known then raise exception 'Aún no se conocen los equipos'; end if;
  if s<>'scheduled' or (k is not null and now()>=k) then raise exception 'El partido ya ha empezado'; end if;
  if p_a<0 or p_b<0 then raise exception 'Marcador no válido'; end if;
  insert into predictions(match_id,player_id,pred_a,pred_b) values (p_match,p_player,p_a,p_b)
  on conflict (match_id,player_id) do update set pred_a=excluded.pred_a,pred_b=excluded.pred_b,updated_at=now();
end; $$;

-- ============================================================
--  RPCs: retos (1-contra-varios)
-- ============================================================
create or replace function create_challenge(
  p_match uuid, p_creator uuid, p_market text, p_line numeric,
  p_selection text, p_odds numeric, p_stake numeric, p_max integer)
returns challenges language plpgsql security definer as $$
declare v challenges%rowtype; s text; k timestamptz; known boolean; bal numeric; begin
  select status,kickoff,teams_known into s,k,known from matches where id=p_match;
  if not found then raise exception 'Partido no encontrado'; end if;
  if not known then raise exception 'Aún no se conocen los equipos'; end if;
  if s<>'scheduled' or (k is not null and now()>=k - interval '1 minute') then raise exception 'Cerrado: falta menos de 1 minuto para el partido'; end if;
  if p_market not in ('1x2','ou','btts','oddeven','exact','scorer','pens') then raise exception 'Mercado no válido'; end if;
  if p_odds<=1 then raise exception 'Cuota no válida'; end if;
  if p_stake<=0 then raise exception 'Puntos no válidos'; end if;
  select points into bal from players where id=p_creator for update;
  if bal<p_stake then raise exception 'Saldo insuficiente'; end if;
  update players set points=points-p_stake where id=p_creator;
  insert into challenges(match_id,creator_id,market,line,selection,odds,stake,max_takers)
    values (p_match,p_creator,p_market,p_line,p_selection,p_odds,p_stake,coalesce(p_max,0))
  returning * into v; return v;
end; $$;

create or replace function accept_challenge(p_challenge uuid, p_taker uuid)
returns void language plpgsql security definer as $$
declare c challenges%rowtype; s text; k timestamptz; n integer; liab numeric; bal numeric; begin
  select * into c from challenges where id=p_challenge for update;
  if not found then raise exception 'Reto no encontrado'; end if;
  if c.status<>'open' then raise exception 'El reto ya no está disponible'; end if;
  if c.creator_id=p_taker then raise exception 'No puedes aceptar tu propio reto'; end if;
  if exists (select 1 from challenge_takers where challenge_id=p_challenge and player_id=p_taker)
    then raise exception 'Ya lo aceptaste'; end if;
  select count(*) into n from challenge_takers where challenge_id=p_challenge;
  if c.max_takers>0 and n>=c.max_takers then raise exception 'Reto completo'; end if;
  select status,kickoff into s,k from matches where id=c.match_id;
  if s<>'scheduled' or (k is not null and now()>=k - interval '1 minute') then raise exception 'Cerrado: falta menos de 1 minuto para el partido'; end if;
  liab := round(c.stake*(c.odds-1));
  select points into bal from players where id=p_taker for update;
  if bal<liab then raise exception 'Saldo insuficiente para cubrir el reto'; end if;
  update players set points=points-liab where id=p_taker;
  if n>=1 then
    select points into bal from players where id=c.creator_id for update;
    if bal<c.stake then raise exception 'El creador no tiene saldo para otro rival'; end if;
    update players set points=points-c.stake where id=c.creator_id;
  end if;
  insert into challenge_takers(challenge_id,player_id,liability) values (p_challenge,p_taker,liab);
end; $$;

-- Cancelar un reto (solo el creador, solo si NADIE lo ha aceptado, hasta 1 min antes).
create or replace function cancel_challenge(p_challenge uuid, p_player uuid)
returns void language plpgsql security definer as $$
declare c challenges%rowtype; k timestamptz; n int; begin
  select * into c from challenges where id=p_challenge for update;
  if not found then raise exception 'Reto no encontrado'; end if;
  if c.creator_id<>p_player then raise exception 'Solo el creador puede cancelar el reto'; end if;
  if c.status<>'open' then raise exception 'El reto ya no se puede cancelar'; end if;
  select count(*) into n from challenge_takers where challenge_id=c.id;
  if n>0 then raise exception 'No puedes cancelar: alguien ya ha aceptado el reto'; end if;
  select kickoff into k from matches where id=c.match_id;
  if k is not null and now()>=k - interval '1 minute' then raise exception 'Demasiado tarde: falta menos de 1 minuto para el partido'; end if;
  update players set points=points + c.stake where id=c.creator_id;   -- devolver reserva (n=0 => 1 stake)
  update challenges set status='void', resolved_at=now() where id=c.id;
end; $$;

-- Modificar un reto (solo el creador, solo si NADIE lo ha aceptado, hasta 1 min antes).
create or replace function update_challenge(p_challenge uuid, p_player uuid, p_market text, p_line numeric,
  p_selection text, p_odds numeric, p_stake numeric, p_max integer)
returns void language plpgsql security definer as $$
declare c challenges%rowtype; k timestamptz; n int; delta numeric; bal numeric; begin
  select * into c from challenges where id=p_challenge for update;
  if not found then raise exception 'Reto no encontrado'; end if;
  if c.creator_id<>p_player then raise exception 'Solo el creador puede modificar el reto'; end if;
  if c.status<>'open' then raise exception 'El reto ya no se puede modificar'; end if;
  select count(*) into n from challenge_takers where challenge_id=c.id;
  if n>0 then raise exception 'No puedes modificar: alguien ya ha aceptado el reto'; end if;
  select kickoff into k from matches where id=c.match_id;
  if k is not null and now()>=k - interval '1 minute' then raise exception 'Demasiado tarde: falta menos de 1 minuto para el partido'; end if;
  if p_market not in ('1x2','ou','btts','oddeven','exact','scorer','pens') then raise exception 'Mercado no válido'; end if;
  if p_odds<=1 then raise exception 'Cuota no válida'; end if;
  if p_stake<=0 then raise exception 'Puntos no válidos'; end if;
  delta := p_stake - c.stake;   -- ajustar reserva del creador (n=0 => reserva actual = c.stake)
  if delta>0 then
    select points into bal from players where id=p_player for update;
    if bal<delta then raise exception 'Saldo insuficiente'; end if;
  end if;
  update players set points=points-delta where id=p_player;
  update challenges set market=p_market, line=p_line, selection=p_selection, odds=p_odds, stake=p_stake, max_takers=coalesce(p_max,0)
    where id=c.id;
end; $$;

-- ============================================================
--  Liquidación (porra + retos), idempotente
-- ============================================================
drop function if exists challenge_creator_wins(text,numeric,text,integer,integer,jsonb);
drop function if exists challenge_creator_wins(text,numeric,text,integer,integer,jsonb,integer);
create or replace function challenge_creator_wins(p_market text, p_line numeric, p_sel text,
  a integer, b integer, p_scorers jsonb, p_pens integer default 0, p_outcome text default null)
returns boolean language sql immutable as $$
  select case p_market
    when '1x2'  then coalesce(p_outcome, outcome_1x2(a,b))=p_sel
    when 'ou'   then case when p_sel='over' then (a+b) > p_line else (a+b) < p_line end
    when 'btts' then (case when a>0 and b>0 then 'si' else 'no' end)=p_sel
    when 'oddeven' then (case when (a+b)%2=0 then 'par' else 'impar' end)=p_sel
    when 'exact' then p_sel = a::text||'-'||b::text
    when 'scorer' then p_scorers ? p_sel
    when 'pens' then (case when p_pens>=1 then 'si' else 'no' end)=p_sel
    else false end;
$$;

-- Liquida UN reto (paga a creador o rivales). Helper común.
create or replace function settle_one_challenge(p_ch uuid, sa integer, sb integer, p_scorers jsonb, p_pens integer, p_outcome text default null)
returns void language plpgsql security definer as $$
declare ch challenges%rowtype; tk challenge_takers%rowtype; won boolean; begin
  select * into ch from challenges where id=p_ch for update;
  if ch.status<>'open' then return; end if;
  if not exists (select 1 from challenge_takers where challenge_id=ch.id) then
    update players set points=points+ch.stake where id=ch.creator_id;
    update challenges set status='void', resolved_at=now() where id=ch.id; return;
  end if;
  won := challenge_creator_wins(ch.market, ch.line, ch.selection, sa, sb, p_scorers, p_pens, p_outcome);
  for tk in select * from challenge_takers where challenge_id=ch.id loop
    if won then update players set points=points+ch.stake+tk.liability where id=ch.creator_id;
    else update players set points=points+tk.liability+ch.stake where id=tk.player_id; end if;
  end loop;
  update challenges set status='resolved', creator_won=won, resolved_at=now() where id=ch.id;
end; $$;

-- FASE 1: porra + retos que NO necesitan goleadores (resultado, marcador, +/-, ambos marcan, par/impar).
create or replace function settle_match_main(p_match uuid)
returns void language plpgsql security definer as $$
declare m matches%rowtype; cfg config%rowtype; pr predictions%rowtype; ch challenges%rowtype;
  v_out text; v_cw numeric; v_ce numeric; v_pts numeric; begin
  select * into m from matches where id=p_match;
  if not found or m.status<>'finished' or m.score_a is null or m.score_b is null or m.settled then return; end if;
  select * into cfg from config where id;
  if not coalesce(cfg.started,false) then return; end if;
  v_out := match_outcome(p_match);   -- ganador con penaltis en eliminatorias
  if v_out is null then return; end if;   -- eliminatoria empatada sin penaltis aún: esperar a openfootball
  -- cuotas de casa: ganador 1X2 (real de The Odds API si existe, si no modelo) y marcador exacto (modelo)
  v_cw := suggest_odds(p_match, '1x2', v_out, null);
  v_ce := suggest_odds(p_match, 'exact', m.score_a::text||'-'||m.score_b::text, null);
  for pr in select * from predictions where match_id=p_match loop
    if pr.pred_a=m.score_a and pr.pred_b=m.score_b then v_pts := round(cfg.pts_exact*v_ce);
    elsif outcome_1x2(pr.pred_a,pr.pred_b)=v_out then v_pts := round(cfg.pts_winner*v_cw);
    else v_pts := 0; end if;
    update predictions set points=v_pts where id=pr.id;
    if v_pts>0 then update players set points=points+v_pts where id=pr.player_id; end if;
  end loop;
  for ch in select * from challenges where match_id=p_match and status='open' and market in ('1x2','ou','btts','oddeven','exact') loop
    perform settle_one_challenge(ch.id, m.score_a, m.score_b, m.scorers, m.pens, v_out);
  end loop;
  update matches set settled=true where id=p_match;
end; $$;

-- FASE 2: retos de goleador y penalti (necesitan datos de openfootball).
create or replace function settle_match_scorers(p_match uuid)
returns void language plpgsql security definer as $$
declare m matches%rowtype; cfg config%rowtype; ch challenges%rowtype; begin
  select * into m from matches where id=p_match;
  if not found or m.status<>'finished' or m.score_a is null or m.settled_scorers then return; end if;
  select * into cfg from config where id;
  if not coalesce(cfg.started,false) then return; end if;
  for ch in select * from challenges where match_id=p_match and status='open' and market in ('scorer','pens') loop
    perform settle_one_challenge(ch.id, m.score_a, m.score_b, m.scorers, m.pens);
  end loop;
  update matches set settled_scorers=true where id=p_match;
end; $$;

-- Conveniencia: ambas fases (desde la sync de openfootball, que sí tiene goleadores).
create or replace function settle_match(p_match uuid)
returns void language plpgsql security definer as $$
begin perform settle_match_main(p_match); perform settle_match_scorers(p_match); end; $$;

create or replace function void_started_open_challenges()
returns void language plpgsql security definer as $$
declare ch challenges%rowtype; begin
  for ch in select c.* from challenges c join matches m on m.id=c.match_id
    where c.status='open' and m.kickoff is not null and now()>=m.kickoff
      and not exists (select 1 from challenge_takers t where t.challenge_id=c.id) loop
    update players set points=points+ch.stake where id=ch.creator_id;
    update challenges set status='void', resolved_at=now() where id=ch.id;
  end loop;
end; $$;

-- ============================================================
--  Upsert de partido (lo llama el cron)
-- ============================================================
drop function if exists upsert_match(text,text,text,text,text,timestamptz,text,integer,integer,jsonb);
drop function if exists upsert_match(text,text,text,text,text,timestamptz,text,integer,integer,jsonb,integer);
create or replace function upsert_match(
  p_ext text, p_stage text, p_grp text, p_a text, p_b text,
  p_kick timestamptz, p_status text, p_sa integer, p_sb integer, p_scorers jsonb,
  p_pens integer default 0, p_pen_a integer default null, p_pen_b integer default null)
returns void language plpgsql security definer as $$
declare known boolean; ra numeric; rb numeric; va numeric; vd numeric; vb numeric; begin
  select count(*)=2 into known from team_strength where name in (p_a,p_b);
  if known then
    select rating into ra from team_strength where name=p_a;
    select rating into rb from team_strength where name=p_b;
    select cp.p_a, cp.p_draw, cp.p_b into va, vd, vb from calc_probs(ra,rb) cp;
  end if;
  insert into matches(ext_id,stage,grp,team_a,team_b,teams_known,kickoff,status,score_a,score_b,scorers,pens,pen_a,pen_b,p_a,p_draw,p_b)
  values (p_ext,p_stage,p_grp,p_a,p_b,known,p_kick,p_status,p_sa,p_sb,coalesce(p_scorers,'[]'),coalesce(p_pens,0),p_pen_a,p_pen_b,
          va, vd, vb)
  on conflict (ext_id) do update set
    stage=excluded.stage, grp=excluded.grp, team_a=excluded.team_a, team_b=excluded.team_b,
    teams_known=excluded.teams_known, kickoff=excluded.kickoff,
    status=case when excluded.status='finished' or matches.status='finished' then 'finished' else excluded.status end,
    score_a=coalesce(excluded.score_a, matches.score_a), score_b=coalesce(excluded.score_b, matches.score_b),
    scorers=excluded.scorers, pens=excluded.pens,
    pen_a=coalesce(excluded.pen_a, matches.pen_a), pen_b=coalesce(excluded.pen_b, matches.pen_b),
    p_a=coalesce(matches.p_a,excluded.p_a), p_draw=coalesce(matches.p_draw,excluded.p_draw),
    p_b=coalesce(matches.p_b,excluded.p_b);
end; $$;

-- ---------- Realtime (idempotente) ----------
do $$
declare t text;
begin
  foreach t in array array['config','players','matches','predictions','challenges','challenge_takers'] loop
    if not exists (select 1 from pg_publication_tables
                   where pubname='supabase_realtime' and schemaname='public' and tablename=t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
