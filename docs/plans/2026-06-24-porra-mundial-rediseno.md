# Porra del Mundial 2026 — Rediseño · Plan de Implementación (rev. 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Liga global donde los partidos del Mundial 2026 se cargan/actualizan solos; cada usuario pronostica marcadores (puntos con multiplicador por sorpresa) y crea retos sobre mercados de un partido que **varios rivales** pueden aceptar (cupo configurable), con **cuotas reales de casa** donde existen y modelo propio de respaldo. Una sola moneda: puntos.

**Architecture:** Lógica de juego en Postgres (RPCs atómicas `security definer`). Edge Function (Deno/TS) en cron: vuelca calendario/resultados de openfootball y liquida; un segundo cron (1-2×/día) cachea cuotas de The Odds API en `matches.odds`. Convocatorias (goleador) van como seed estático. Frontend estático lee por Realtime y escribe por RPC.

**Tech Stack:** Supabase (Postgres 15, RLS, Realtime, pg_cron, pg_net, Edge Functions Deno/TS), JS vanilla + `@supabase/supabase-js@2` (CDN), GitHub Pages. Tests: `deno test` (helpers TS puros) + script SQL de asserts (lógica de juego).

**Fuentes (verificadas 2026-06-24):**
- `https://raw.githubusercontent.com/openfootball/worldcup.json/master/2026/worldcup.json` — 104 partidos. `matches[]`: `round,date,time,team1,team2,score?{ft:[a,b]},goals1?[{name}],goals2?[{name}],group?,ground,num?`. Grupos sin `num`; eliminatorias con `num` (73-104) y placeholders (`2A`,`W74`).
- `https://raw.githubusercontent.com/openfootball/worldcup.json/master/2026/worldcup.squads.json` — 48 selecciones × 26 jugadores (`players[].name`, `pos`).
- **The Odds API** v4 (`apiKey`, plan gratis 500 créditos/mes): `GET /v4/sports/soccer_fifa_world_cup/odds?regions=eu&markets=h2h,totals&oddsFormat=decimal`. Real para 1X2 (h2h) y Más/Menos (totals). Cobertura WC2026 a verificar; fallback = modelo.

---

## Mapa de archivos

| Archivo | Responsabilidad | Acción |
|---|---|---|
| `supabase-schema.sql` | Esquema + RLS + funciones de juego + RPCs | **Reescribir** |
| `seeds/team_strength.sql` | Fuerza Elo (48) | Crear |
| `seeds/team_squads.sql` | Convocatorias (goleador) — generado de squads.json | Crear |
| `supabase/functions/sync/pure.ts` | Helpers puros parseo openfootball | Crear |
| `supabase/functions/sync/pure.test.ts` | Tests Deno | Crear |
| `supabase/functions/sync/index.ts` | Edge Function: calendario+resultados → upsert+settle | Crear |
| `supabase/functions/odds/index.ts` | Edge Function: The Odds API → cache `matches.odds` | Crear |
| `supabase/cron.sql` | pg_cron de ambas funciones | Crear |
| `tests/game-logic.test.sql` | Seed + asserts (porra + retos multi) | Crear |
| `index.html` | Pantallas | **Reescribir** |
| `app.js` | Controlador (identidad, datos, render, RPCs, realtime) | **Reescribir** |
| `config.js` | Claves Supabase | Mantener |
| `demo.html` | Port de la demo aprobada (offline) | Reescribir (fase 5) |
| `README.md` | Puesta en marcha | Actualizar (fase 5) |

---

## FASE 1 — Lógica de juego en Postgres

### Task 1: Esquema + config

**Files:** Reescribir `supabase-schema.sql`

- [ ] **Step 1: Escribir el esquema** (reemplaza todo el archivo)

```sql
-- Porra del Mundial 2026 — esquema (Supabase/Postgres). Idempotente.
create extension if not exists "pgcrypto";

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

create table if not exists team_strength ( name text primary key, rating numeric not null );
create table if not exists team_squads (
  id uuid primary key default gen_random_uuid(),
  team text not null, player text not null, pos text,
  unique (team, player)
);

create table if not exists players (
  id uuid primary key default gen_random_uuid(),
  name text not null, recovery_code text unique not null,
  points numeric not null default 1000, created_at timestamptz default now()
);

create table if not exists matches (
  id uuid primary key default gen_random_uuid(),
  ext_id text unique not null,
  stage text not null, grp text,
  team_a text not null, team_b text not null, teams_known boolean not null default false,
  kickoff timestamptz, status text not null default 'scheduled',
  score_a integer, score_b integer, scorers jsonb not null default '[]',
  p_a numeric, p_draw numeric, p_b numeric,
  odds jsonb not null default '{}',     -- cache The Odds API: {"1x2":{"1":x,"X":y,"2":z},"ou":{"2.5":{"over":..,"under":..}}}
  settled boolean not null default false,
  created_at timestamptz default now()
);

create table if not exists predictions (
  id uuid primary key default gen_random_uuid(),
  match_id uuid not null references matches(id) on delete cascade,
  player_id uuid not null references players(id) on delete cascade,
  pred_a integer not null, pred_b integer not null, points numeric,
  created_at timestamptz default now(), updated_at timestamptz default now(),
  unique (match_id, player_id)
);

create table if not exists challenges (
  id uuid primary key default gen_random_uuid(),
  match_id uuid not null references matches(id) on delete cascade,
  creator_id uuid not null references players(id) on delete cascade,
  market text not null,            -- 1x2|ou|btts|oddeven|exact|scorer
  line numeric,                    -- solo ou: 1.5|2.5|3.5
  selection text not null,         -- 1/X/2 ; over/under ; si/no ; par/impar ; "2-1" ; nombre jugador
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
```

- [ ] **Step 2: Ejecutar en SQL Editor.** Esperado: `Success`.
- [ ] **Step 3: Verificar.** `select count(*) from information_schema.tables where table_schema='public';` → ≥ 8.
- [ ] **Step 4: Commit.** `git add supabase-schema.sql && git commit -m "feat(db): esquema rev2 (challenges multi-taker, squads, odds cache)"`

---

### Task 2: Seed de fuerza (48)

**Files:** Crear `seeds/team_strength.sql`

- [ ] **Step 1: Escribir el seed** (nombres EXACTOS de openfootball)

```sql
insert into team_strength (name, rating) values
  ('Argentina',2100),('France',2080),('Spain',2070),('England',2040),('Brazil',2030),
  ('Portugal',2010),('Netherlands',1990),('Belgium',1970),('Germany',1965),('Croatia',1930),
  ('Uruguay',1925),('Colombia',1910),('Morocco',1900),('Canada',1810),('Turkey',1800),
  ('USA',1860),('Switzerland',1855),('Japan',1850),('Senegal',1845),('Mexico',1840),
  ('Ecuador',1820),('Austria',1815),('Australia',1790),('South Korea',1785),('Sweden',1780),
  ('Ivory Coast',1770),('Norway',1765),('Egypt',1760),('Bosnia & Herzegovina',1760),
  ('Iran',1755),('Paraguay',1750),('Scotland',1745),('Ghana',1740),('Tunisia',1730),
  ('DR Congo',1715),('Saudi Arabia',1710),('Qatar',1700),('South Africa',1700),
  ('Czech Republic',1790),('Panama',1700),('Iraq',1690),('Uzbekistan',1685),
  ('Cape Verde',1670),('Jordan',1660),('New Zealand',1650),('Curaçao',1630),
  ('Haiti',1620),('Algeria',1775)
on conflict (name) do update set rating = excluded.rating;
```

- [ ] **Step 2: Ejecutar.** `select count(*) from team_strength;` → 48.
- [ ] **Step 3: Verificar cobertura** contra `worldcup.teams.json` (cada nombre presente). Añadir ausentes.
- [ ] **Step 4: Commit.** `git add seeds/team_strength.sql && git commit -m "feat(db): seed fuerza selecciones"`

---

### Task 3: Seed de convocatorias (goleador)

**Files:** Crear `seeds/team_squads.sql`

- [ ] **Step 1: Generar el seed desde squads.json** (script de generación, ejecutar una vez)

Run:
```bash
node -e '
const https=require("https");
https.get("https://raw.githubusercontent.com/openfootball/worldcup.json/master/2026/worldcup.squads.json",r=>{let d="";r.on("data",c=>d+=c);r.on("end",()=>{
  const teams=JSON.parse(d);
  const esc=s=>s.replace(/'\''/g,"'\'''\''");
  let out="-- Convocatorias Mundial 2026 (de worldcup.squads.json)\ninsert into team_squads (team, player, pos) values\n";
  const rows=[];
  for(const t of teams) for(const p of t.players) rows.push(`  ('\''${esc(t.name)}'\'','\''${esc(p.name)}'\'','\''${esc(p.pos||"")}'\'')`);
  out+=rows.join(",\n")+"\non conflict (team, player) do nothing;\n";
  require("fs").writeFileSync("seeds/team_squads.sql",out);
  console.log("seed:",rows.length,"jugadores");
});});'
```
Esperado: `seed: ~1248 jugadores` y archivo `seeds/team_squads.sql` creado.

- [ ] **Step 2: Ejecutar el seed** en SQL Editor. `select count(distinct team), count(*) from team_squads;` → 48 equipos, ~1248 filas.
- [ ] **Step 3: Commit.** `git add seeds/team_squads.sql && git commit -m "feat(db): seed convocatorias (goleador)"`

---

### Task 4: Probabilidad, dificultad y modelo de cuotas

**Files:** Modificar `supabase-schema.sql` (añadir al final)

- [ ] **Step 1: Añadir funciones**

```sql
-- Probabilidades 1X2 por Elo + cuota de empate.
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

-- Poisson PMF (goles 0..k pequeños).
create or replace function poisson_pmf(k integer, lam numeric) returns numeric
language plpgsql immutable as $$
declare p numeric; i integer; begin
  p := exp(-lam);
  for i in 1..k loop p := p*lam/i; end loop;
  return p;
end; $$;

-- λ por equipo (modelo de goles) desde la fuerza.
create or replace function team_lambdas(team_a text, team_b text, out la numeric, out lb numeric)
language plpgsql stable as $$
declare ra numeric; rb numeric; d numeric; begin
  ra := coalesce((select rating from team_strength where name=team_a),1500);
  rb := coalesce((select rating from team_strength where name=team_b),1500);
  d := (ra-rb)/100.0;
  la := least(3.4, greatest(0.3, 1.35+0.18*d));
  lb := least(3.4, greatest(0.3, 1.35-0.18*d));
end; $$;

-- Cuota sugerida: real (matches.odds) si existe, si no modelo + margen.
create or replace function suggest_odds(p_match uuid, p_market text, p_selection text, p_line numeric)
returns numeric language plpgsql stable as $$
declare m matches%rowtype; cfg config%rowtype; lam record; pp numeric; real numeric; x int; y int; k int;
begin
  select * into m from matches where id=p_match; if not found then return 2.0; end if;
  select * into cfg from config where id;

  -- 1) intentar cuota real cacheada
  if p_market='1x2' then real := (m.odds#>>'{1x2,'||p_selection||'}')::numeric;
  elsif p_market='ou' then real := (m.odds#>>('{ou,'||p_line::text||','||p_selection||'}'))::numeric;
  elsif p_market='btts' then real := (m.odds#>>'{btts,'||p_selection||'}')::numeric;
  end if;
  if real is not null and real>1 then return real; end if;

  -- 2) modelo
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
    else pp := 0.5; end if;
  end if;
  if pp is null or pp<0.004 then pp := 0.004; end if;
  return round(greatest(1.05, (1/pp)*cfg.odds_margin)::numeric, 2);
end; $$;
```

- [ ] **Step 2: Probar.** `select suggest_odds((select id from matches limit 1),'1x2','1',null);` (tras tener partidos) → numérico > 1. Antes de tener partidos, probar el modelo: `select round((1/((calc_probs(2070,1700)).p_a))*0.94,2);` → ~1.1.
- [ ] **Step 3: Commit.** `git add supabase-schema.sql && git commit -m "feat(db): probs, dificultad, modelo Poisson y suggest_odds (real+fallback)"`

---

### Task 5: RPCs de jugador y pronóstico

**Files:** Modificar `supabase-schema.sql`

- [ ] **Step 1: Añadir**

```sql
create or replace function upsert_player(p_name text, p_recovery text)
returns players language plpgsql security definer as $$
declare v players%rowtype; v_start numeric; begin
  select * into v from players where recovery_code=p_recovery; if found then return v; end if;
  select start_points into v_start from config where id;
  insert into players(name,recovery_code,points) values (trim(p_name),p_recovery,v_start) returning * into v;
  return v;
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
```

- [ ] **Step 2: Smoke.** `select upsert_player('Test','T-1');` → fila con `points=1000`.
- [ ] **Step 3: Commit.** `git commit -am "feat(db): RPC upsert_player + place_prediction"`

---

### Task 6: RPCs de retos (crear / aceptar, 1-contra-varios)

**Files:** Modificar `supabase-schema.sql`

- [ ] **Step 1: Añadir**

```sql
create or replace function create_challenge(
  p_match uuid, p_creator uuid, p_market text, p_line numeric,
  p_selection text, p_odds numeric, p_stake numeric, p_max integer)
returns challenges language plpgsql security definer as $$
declare v challenges%rowtype; s text; k timestamptz; known boolean; bal numeric; begin
  select status,kickoff,teams_known into s,k,known from matches where id=p_match;
  if not found then raise exception 'Partido no encontrado'; end if;
  if not known then raise exception 'Aún no se conocen los equipos'; end if;
  if s<>'scheduled' or (k is not null and now()>=k) then raise exception 'El partido ya ha empezado'; end if;
  if p_market not in ('1x2','ou','btts','oddeven','exact','scorer') then raise exception 'Mercado no válido'; end if;
  if p_odds<=1 then raise exception 'Cuota no válida'; end if;
  if p_stake<=0 then raise exception 'Puntos no válidos'; end if;
  select points into bal from players where id=p_creator for update;
  if bal<p_stake then raise exception 'Saldo insuficiente'; end if;
  update players set points=points-p_stake where id=p_creator;   -- reserva por el 1er rival
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
  if s<>'scheduled' or (k is not null and now()>=k) then raise exception 'El partido ya ha empezado'; end if;

  liab := round(c.stake*(c.odds-1));
  select points into bal from players where id=p_taker for update;
  if bal<liab then raise exception 'Saldo insuficiente para cubrir el reto'; end if;
  update players set points=points-liab where id=p_taker;               -- reserva del rival
  if n>=1 then                                                          -- exposición extra del creador (2º rival en adelante)
    select points into bal from players where id=c.creator_id for update;
    if bal<c.stake then raise exception 'El creador no tiene saldo para otro rival'; end if;
    update players set points=points-c.stake where id=c.creator_id;
  end if;
  insert into challenge_takers(challenge_id,player_id,liability) values (p_challenge,p_taker,liab);
end; $$;
```

- [ ] **Step 2: Ejecutar (sin error).** Esperado `Success`.
- [ ] **Step 3: Commit.** `git commit -am "feat(db): create_challenge + accept_challenge (1-contra-varios, cupo, reservas)"`

---

### Task 7: Liquidación (porra + retos multi), idempotente

**Files:** Modificar `supabase-schema.sql`

- [ ] **Step 1: Añadir**

```sql
create or replace function challenge_creator_wins(p_market text, p_line numeric, p_sel text,
  a integer, b integer, p_scorers jsonb)
returns boolean language sql immutable as $$
  select case p_market
    when '1x2'  then outcome_1x2(a,b)=p_sel
    when 'ou'   then case when p_sel='over' then (a+b) > p_line else (a+b) < p_line end
    when 'btts' then (case when a>0 and b>0 then 'si' else 'no' end)=p_sel
    when 'oddeven' then (case when (a+b)%2=0 then 'par' else 'impar' end)=p_sel
    when 'exact' then p_sel = a::text||'-'||b::text
    when 'scorer' then p_scorers ? p_sel
    else false end;
$$;

create or replace function settle_match(p_match uuid)
returns void language plpgsql security definer as $$
declare m matches%rowtype; cfg config%rowtype; pr predictions%rowtype; ch challenges%rowtype; tk challenge_takers%rowtype;
  v_out text; v_p numeric; v_f numeric; v_pts numeric; won boolean; begin
  select * into m from matches where id=p_match;
  if not found or m.status<>'finished' or m.score_a is null or m.score_b is null or m.settled then return; end if;
  select * into cfg from config where id;
  v_out := outcome_1x2(m.score_a,m.score_b);
  v_p := case v_out when '1' then m.p_a when 'X' then m.p_draw else m.p_b end;
  v_f := difficulty_factor(coalesce(v_p,1));

  -- Porra base
  for pr in select * from predictions where match_id=p_match loop
    if pr.pred_a=m.score_a and pr.pred_b=m.score_b then v_pts := cfg.pts_exact*v_f;
    elsif outcome_1x2(pr.pred_a,pr.pred_b)=v_out then v_pts := cfg.pts_winner*v_f;
    else v_pts := 0; end if;
    update predictions set points=v_pts where id=pr.id;
    if v_pts>0 then update players set points=points+v_pts where id=pr.player_id; end if;
  end loop;

  -- Retos
  for ch in select * from challenges where match_id=p_match and status='open' loop
    if not exists (select 1 from challenge_takers where challenge_id=ch.id) then
      update players set points=points+ch.stake where id=ch.creator_id;       -- void: devolver reserva
      update challenges set status='void', resolved_at=now() where id=ch.id; continue;
    end if;
    won := challenge_creator_wins(ch.market, ch.line, ch.selection, m.score_a, m.score_b, m.scorers);
    for tk in select * from challenge_takers where challenge_id=ch.id loop
      if won then update players set points=points+ch.stake+tk.liability where id=ch.creator_id;  -- creador recupera su reserva (stake) y gana liability
      else update players set points=points+tk.liability+ch.stake where id=tk.player_id; end if;  -- rival recupera liability y gana stake
    end loop;
    update challenges set status='resolved', creator_won=won, resolved_at=now() where id=ch.id;
  end loop;

  update matches set settled=true where id=p_match;
end; $$;

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
```

> Cuadre de reservas: creador reserva `stake` al crear (1er rival) y `stake` por cada rival extra → total `stake×n`. Al ganar recupera `stake` y suma `liability` **por cada** rival; al perder, cada rival recupera su `liability` y suma `stake`. Suma cero por par.

- [ ] **Step 2: Ejecutar.** `Success`.
- [ ] **Step 3: Commit.** `git commit -am "feat(db): settle_match multi-taker idempotente + void"`

---

### Task 8: Test SQL de lógica (porra sorpresa + reto multi)

**Files:** Crear `tests/game-logic.test.sql`

- [ ] **Step 1: Escribir el test**

```sql
do $$
declare m_id uuid; pa uuid; pb uuid; pc uuid; ch uuid; bal numeric; pts numeric; begin
  pa:=(upsert_player('A','T-A')).id; pb:=(upsert_player('B','T-B')).id; pc:=(upsert_player('C','T-C')).id;

  -- Sorpresa: débil(1700) vs fuerte(2070), gana débil 2-1.
  insert into matches(ext_id,stage,team_a,team_b,teams_known,kickoff,status,score_a,score_b,p_a,p_draw,p_b)
  select 'T1','grupos','Débil','Fuerte',true,now()-interval '3h','finished',2,1,pr.p_a,pr.p_draw,pr.p_b
  from calc_probs(1700,2070) pr returning id into m_id;

  perform place_prediction(m_id,pa,2,1);  -- exacto
  perform place_prediction(m_id,pb,3,1);  -- ganador
  perform place_prediction(m_id,pc,0,2);  -- fallo

  -- Reto de A (gana local '1') odds 3.0 stake 100, max 0; aceptan B y C (liab 200 c/u)
  ch:=(create_challenge(m_id,pa,'1x2',null,'1',3.0,100,0)).id;
  perform accept_challenge(ch,pb); perform accept_challenge(ch,pc);

  -- Reservas: A 1000-100(crear)-100(2º rival)=800 ; B 1000-200=800 ; C 1000-200=800
  select points into bal from players where id=pa; assert bal=800,'reserva A='||bal;
  select points into bal from players where id=pb; assert bal=800,'reserva B='||bal;
  select points into bal from players where id=pc; assert bal=800,'reserva C='||bal;

  perform settle_match(m_id);

  -- Porra factor 3: A 50*3=150, B 20*3=60, C 0
  select points into pts from predictions where match_id=m_id and player_id=pa; assert pts=150,'porra A='||pts;
  select points into pts from predictions where match_id=m_id and player_id=pb; assert pts=60,'porra B='||pts;

  -- Reto: A acertó '1'. A recupera 2*100 (reservas) + gana 2*200 = 600 -> A=800+150+600=1550
  -- B y C pierden su liability (200) -> B=800+60(porra)=860 ; C=800+0=800
  select points into bal from players where id=pa; assert bal=1550,'A final='||bal;
  select points into bal from players where id=pb; assert bal=860,'B final='||bal;
  select points into bal from players where id=pc; assert bal=800,'C final='||bal;

  perform settle_match(m_id);  -- idempotente
  select points into bal from players where id=pa; assert bal=1550,'idempotente A';

  delete from matches where ext_id='T1';
  delete from players where recovery_code in ('T-A','T-B','T-C');
  raise notice 'OK: asserts pasaron';
end $$;
```

- [ ] **Step 2: Ejecutar.** Esperado `NOTICE: OK: asserts pasaron`, sin excepción.
- [ ] **Step 3: Si falla**, corregir la función implicada, re-ejecutar esquema y test hasta verde.
- [ ] **Step 4: Commit.** `git add tests/game-logic.test.sql && git commit -m "test(db): porra sorpresa + reto multi-taker + idempotencia"`

---

## FASE 2 — Sincronización (Edge Functions + cron)

### Task 9: RPC `upsert_match`

**Files:** Modificar `supabase-schema.sql`

- [ ] **Step 1: Añadir**

```sql
create or replace function upsert_match(
  p_ext text, p_stage text, p_grp text, p_a text, p_b text,
  p_kick timestamptz, p_status text, p_sa integer, p_sb integer, p_scorers jsonb)
returns void language plpgsql security definer as $$
declare known boolean; ra numeric; rb numeric; pr record; begin
  select count(*)=2 into known from team_strength where name in (p_a,p_b);
  if known then
    select coalesce((select rating from team_strength where name=p_a),1500) into ra;
    select coalesce((select rating from team_strength where name=p_b),1500) into rb;
    select * into pr from calc_probs(ra,rb);
  end if;
  insert into matches(ext_id,stage,grp,team_a,team_b,teams_known,kickoff,status,score_a,score_b,scorers,p_a,p_draw,p_b)
  values (p_ext,p_stage,p_grp,p_a,p_b,known,p_kick,p_status,p_sa,p_sb,coalesce(p_scorers,'[]'),
          case when known then pr.p_a end, case when known then pr.p_draw end, case when known then pr.p_b end)
  on conflict (ext_id) do update set
    stage=excluded.stage, grp=excluded.grp, team_a=excluded.team_a, team_b=excluded.team_b,
    teams_known=excluded.teams_known, kickoff=excluded.kickoff, status=excluded.status,
    score_a=excluded.score_a, score_b=excluded.score_b, scorers=excluded.scorers,
    p_a=coalesce(matches.p_a,excluded.p_a), p_draw=coalesce(matches.p_draw,excluded.p_draw),
    p_b=coalesce(matches.p_b,excluded.p_b);
end; $$;
```

- [ ] **Step 2: Smoke.** `select upsert_match('SMK','grupos','A','Spain','South Africa',now()+interval '1d','scheduled',null,null,'[]');` luego `select teams_known,round(p_a,2) from matches where ext_id='SMK';` → true, ~0.8. Borrar: `delete from matches where ext_id='SMK';`
- [ ] **Step 3: Commit.** `git commit -am "feat(db): RPC upsert_match (+scorers, congela probs)"`

---

### Task 10: Helpers puros de parseo (TDD Deno)

**Files:** Crear `supabase/functions/sync/pure.ts` + `pure.test.ts`

- [ ] **Step 1: Tests primero** (`pure.test.ts`)

```ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { extId, teamsKnown, mapStage, groupLetter, parseKickoff, deriveStatus, scorers } from "./pure.ts";

Deno.test("extId", () => {
  assertEquals(extId({num:89,date:"2026-07-04",ground:"Philadelphia"}),"n89");
  assertEquals(extId({date:"2026-06-11",ground:"Mexico City"}),"2026-06-11__Mexico City");
});
Deno.test("teamsKnown", () => {
  const v=new Set(["Spain","Germany"]);
  assertEquals(teamsKnown("Spain","Germany",v),true);
  assertEquals(teamsKnown("Spain","2A",v),false);
});
Deno.test("mapStage", () => {
  assertEquals(mapStage("Matchday 3"),"grupos");
  assertEquals(mapStage("Round of 32"),"dieciseisavos");
  assertEquals(mapStage("Round of 16"),"octavos");
  assertEquals(mapStage("Quarter-final"),"cuartos");
  assertEquals(mapStage("Semi-final"),"semis");
  assertEquals(mapStage("Match for third place"),"tercer_puesto");
  assertEquals(mapStage("Final"),"final");
});
Deno.test("groupLetter", () => { assertEquals(groupLetter("Group A"),"A"); assertEquals(groupLetter(undefined),null); });
Deno.test("parseKickoff", () => {
  assertEquals(parseKickoff("2026-06-11","13:00 UTC-6"),"2026-06-11T13:00:00-06:00");
});
Deno.test("deriveStatus", () => {
  const now=new Date("2026-06-12T00:00:00Z");
  assertEquals(deriveStatus({score:{ft:[2,0]}},"2026-06-11T13:00:00-06:00",now),"finished");
  assertEquals(deriveStatus({},"2026-06-11T13:00:00-06:00",now),"live");
  assertEquals(deriveStatus({},"2026-07-04T17:00:00-04:00",now),"scheduled");
});
Deno.test("scorers", () => {
  assertEquals(scorers({goals1:[{name:"A"},{name:"B"}],goals2:[{name:"C"}]}),["A","B","C"]);
  assertEquals(scorers({}),[]);
});
```

- [ ] **Step 2: Ejecutar (fallan).** `cd supabase/functions/sync && deno test pure.test.ts` → FAIL (no module).

- [ ] **Step 3: Implementar `pure.ts`**

```ts
export interface OFMatch {
  num?: number; round?: string; date?: string; time?: string;
  team1?: string; team2?: string; group?: string; ground?: string;
  score?: { ft?: [number, number] };
  goals1?: { name: string }[]; goals2?: { name: string }[];
}
export const extId = (m: OFMatch) => typeof m.num==="number" ? `n${m.num}` : `${m.date}__${m.ground}`;
export const teamsKnown = (a: string, b: string, valid: Set<string>) => valid.has(a) && valid.has(b);
export function mapStage(r: string|undefined){
  const s=(r??"").toLowerCase();
  if(s.startsWith("matchday")) return "grupos";
  if(s.includes("round of 32")) return "dieciseisavos";
  if(s.includes("round of 16")) return "octavos";
  if(s.includes("quarter")) return "cuartos";
  if(s.includes("semi")) return "semis";
  if(s.includes("third")) return "tercer_puesto";
  if(s.includes("final")) return "final";
  return "grupos";
}
export function groupLetter(g: string|undefined){ const m=(g??"").match(/Group\s+([A-L])/i); return m?m[1].toUpperCase():null; }
export function parseKickoff(date: string, time: string|undefined){
  if(!date) return null;
  const t=(time??"").match(/(\d{1,2}):(\d{2})/); const off=(time??"").match(/UTC([+-]\d{1,2})/);
  if(!t) return `${date}T00:00:00Z`;
  const hh=t[1].padStart(2,"0");
  if(!off) return `${date}T${hh}:${t[2]}:00Z`;
  const sign=off[1].startsWith("-")?"-":"+"; const oh=String(Math.abs(parseInt(off[1],10))).padStart(2,"0");
  return `${date}T${hh}:${t[2]}:00${sign}${oh}:00`;
}
export function deriveStatus(m: OFMatch, kickoffIso: string|null, now: Date){
  if(m.score?.ft && m.score.ft.length===2) return "finished";
  if(kickoffIso && now>=new Date(kickoffIso)) return "live";
  return "scheduled";
}
export const scorers = (m: OFMatch) => [...(m.goals1??[]),...(m.goals2??[])].map(g=>g.name);
```

- [ ] **Step 4: Ejecutar (pasan).** `deno test pure.test.ts` → `ok | 7 passed`.
- [ ] **Step 5: Commit.** `git add supabase/functions/sync/pure.ts supabase/functions/sync/pure.test.ts && git commit -m "feat(sync): helpers parseo openfootball (+scorers) con tests"`

---

### Task 11: Edge Function `sync` (calendario + resultados + settle)

**Files:** Crear `supabase/functions/sync/index.ts`

- [ ] **Step 1: Implementar**

```ts
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { extId, teamsKnown, mapStage, groupLetter, parseKickoff, deriveStatus, scorers, OFMatch } from "./pure.ts";
const SRC = "https://raw.githubusercontent.com/openfootball/worldcup.json/master/2026/worldcup.json";

Deno.serve(async () => {
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: teams } = await sb.from("team_strength").select("name");
  const valid = new Set((teams ?? []).map(t => t.name));
  const res = await fetch(SRC, { headers: { "cache-control": "no-cache" } });
  if (!res.ok) return json({ error: `fetch ${res.status}` }, 502);
  const data = await res.json() as { matches: OFMatch[] };
  const now = new Date();
  let upserts = 0;
  for (const m of data.matches ?? []) {
    const a=m.team1??"", b=m.team2??""; if(!a||!b||!m.date) continue;
    const kickoff = parseKickoff(m.date, m.time);
    const { error } = await sb.rpc("upsert_match", {
      p_ext: extId(m), p_stage: mapStage(m.round), p_grp: groupLetter(m.group),
      p_a: a, p_b: b, p_kick: kickoff, p_status: deriveStatus(m, kickoff, now),
      p_sa: m.score?.ft?.[0] ?? null, p_sb: m.score?.ft?.[1] ?? null,
      p_scorers: scorers(m),
    });
    if(!error) upserts++;
  }
  await sb.rpc("void_started_open_challenges");
  const { data: pend } = await sb.from("matches").select("id").eq("status","finished").eq("settled",false);
  let settled = 0;
  for (const row of pend ?? []) { const { error } = await sb.rpc("settle_match",{p_match:row.id}); if(!error) settled++; }
  return json({ ok: true, upserts, settled });
});
function json(b: unknown, s=200){ return new Response(JSON.stringify(b),{status:s,headers:{"content-type":"application/json"}}); }
```

- [ ] **Step 2: Type-check.** `cd supabase/functions/sync && deno check index.ts` → sin errores.
- [ ] **Step 3: Commit.** `git add supabase/functions/sync/index.ts && git commit -m "feat(sync): edge function calendario+resultados+settle"`

---

### Task 12: Edge Function `odds` (The Odds API → cache)

**Files:** Crear `supabase/functions/odds/index.ts`

- [ ] **Step 1: Implementar** (matching por nombre normalizado + commence_time; guarda en `matches.odds`)

```ts
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
const SPORT = "soccer_fifa_world_cup";

// openfootball usa nombres EN; The Odds API puede diferir. Normalización mínima.
const NORM: Record<string,string> = {
  "Korea Republic":"South Korea", "USA":"United States", "Türkiye":"Turkey", "Czechia":"Czech Republic",
  "Côte d'Ivoire":"Ivory Coast", "Cabo Verde":"Cape Verde", "Curacao":"Curaçao",
};
const norm = (s: string) => NORM[s] ?? s;

Deno.serve(async () => {
  const KEY = Deno.env.get("ODDS_API_KEY");
  if (!KEY) return json({ error: "no ODDS_API_KEY" }, 500);
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const url = `https://api.the-odds-api.com/v4/sports/${SPORT}/odds?regions=eu&markets=h2h,totals&oddsFormat=decimal&apiKey=${KEY}`;
  const res = await fetch(url);
  if (!res.ok) return json({ error: `odds ${res.status}` }, 502);
  const events = await res.json() as any[];

  const { data: matches } = await sb.from("matches").select("id,team_a,team_b,status").eq("status","scheduled");
  let updated = 0;
  for (const ev of events) {
    const home = norm(ev.home_team), away = norm(ev.away_team);
    const mt = (matches ?? []).find(m =>
      (m.team_a===home && m.team_b===away) || (m.team_a===away && m.team_b===home));
    if (!mt) continue;
    const swap = mt.team_a !== home;                 // alinear 1/2 con team_a/team_b
    const bk = ev.bookmakers?.[0]; if (!bk) continue;
    const odds: any = {};
    const h2h = bk.markets?.find((x:any)=>x.key==="h2h");
    if (h2h) {
      const o = (name:string)=>h2h.outcomes.find((y:any)=>norm(y.name)===name)?.price;
      const draw = h2h.outcomes.find((y:any)=>y.name==="Draw")?.price;
      odds["1x2"] = swap ? {"1":o(away),"X":draw,"2":o(home)} : {"1":o(home),"X":draw,"2":o(away)};
    }
    const tot = bk.markets?.find((x:any)=>x.key==="totals");
    if (tot) {
      odds["ou"] = {};
      for (const pt of [...new Set(tot.outcomes.map((y:any)=>y.point))]) {
        const over = tot.outcomes.find((y:any)=>y.name==="Over"&&y.point===pt)?.price;
        const under = tot.outcomes.find((y:any)=>y.name==="Under"&&y.point===pt)?.price;
        odds["ou"][String(pt)] = { over, under };
      }
    }
    if (Object.keys(odds).length) {
      await sb.from("matches").update({ odds }).eq("id", mt.id); updated++;
    }
  }
  return json({ ok: true, events: events.length, updated });
});
function json(b: unknown, s=200){ return new Response(JSON.stringify(b),{status:s,headers:{"content-type":"application/json"}}); }
```

> Mercados sin odds reales (btts, oddeven, exact, scorer) → `suggest_odds` los resuelve con el modelo. Si el matching de nombres falla para un partido, ese partido usa modelo en todos los mercados (degradación elegante).

- [ ] **Step 2: Type-check.** `cd supabase/functions/odds && deno check index.ts` → sin errores.
- [ ] **Step 3: Commit.** `git add supabase/functions/odds/index.ts && git commit -m "feat(odds): edge function The Odds API -> cache matches.odds"`

---

### Task 13: Desplegar funciones y programar crons

**Files:** Crear `supabase/cron.sql`

- [ ] **Step 1: Desplegar** (requiere Supabase CLI logueado).
```bash
cd "$HOME/seguimiento-habitos"
supabase link --project-ref <REF>
supabase secrets set ODDS_API_KEY=<TU_KEY>
supabase functions deploy sync --no-verify-jwt
supabase functions deploy odds --no-verify-jwt
```
- [ ] **Step 2: Probar a mano.**
```bash
curl -s -X POST "https://<REF>.functions.supabase.co/sync" | python -m json.tool   # {"ok":true,"upserts":104,...}
curl -s -X POST "https://<REF>.functions.supabase.co/odds" | python -m json.tool   # {"ok":true,"events":N,"updated":M}
```
- [ ] **Step 3: Verificar datos.** SQL: `select count(*) filter(where teams_known) conocidos, count(*) filter(where odds<>'{}') con_odds from matches;`
- [ ] **Step 4: Programar crons** (`supabase/cron.sql`, sustituye `<REF>`/`<SRK>`):
```sql
create extension if not exists pg_cron;
create extension if not exists pg_net;
select cron.schedule('porra-sync','*/5 * * * *', $$
  select net.http_post(url:='https://<REF>.functions.supabase.co/sync',
    headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer <SRK>')); $$);
select cron.schedule('porra-odds','0 9,18 * * *', $$
  select net.http_post(url:='https://<REF>.functions.supabase.co/odds',
    headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer <SRK>')); $$);
```
Esperado en `select jobname,schedule from cron.job;`: `porra-sync` (*/5) y `porra-odds` (2×/día).
- [ ] **Step 5: Commit.** `git add supabase/cron.sql && git commit -m "chore: crons sync (5min) + odds (2x/dia)"`

---

## FASE 3 — Frontend

### Task 14: Pantallas `index.html`

**Files:** Reescribir `index.html`

- [ ] **Step 1: Cuerpo** (IDs que usa `app.js`): pantallas `setup` (claves), `login` (nombre + código recuperación) y `app` (topbar con hucha + tabs Partidos/Clasificación + filtros próximos/en-juego/finalizados + `#matchList` + `#leaderboard`). Cargar `config.js`, `@supabase/supabase-js@2` (CDN) y `app.js`. (Reutilizar estilos; portar el look de la demo aprobada.)
- [ ] **Step 2: Verificar** que con `config.js` vacío muestra `setup` sin errores de consola (`python -m http.server 8000`).
- [ ] **Step 3: Commit.** `git add index.html && git commit -m "feat(web): pantallas login global + partidos + clasificación"`

### Task 15: `app.js` — arranque, identidad, datos, realtime
**Files:** Reescribir `app.js`
- [ ] **Step 1:** store resistente + `initClient` + `boot` + `upsert_player`/recuperación + `refresh` (lee matches, challenges, challenge_takers, players, mis predictions) + `subscribe` (realtime en las 5 tablas). (Mismo patrón que el plan rev1 Task 13, añadiendo `challenge_takers`.)
- [ ] **Step 2:** smoke login en proyecto de prueba.
- [ ] **Step 3: Commit.** `git commit -am "feat(web): arranque, identidad global, datos+realtime"`

### Task 16: `app.js` — partidos + pronóstico
**Files:** Modificar `app.js`
- [ ] **Step 1:** `renderMatches`/`matchCard` con chips de dificultad por resultado (×1/×1.5/×3 desde `p_a/p_draw/p_b`), preview de premio al pronosticar, `predict()` → `place_prediction`. Partido finalizado muestra tus puntos.
- [ ] **Step 2:** verificar con datos reales sincronizados.
- [ ] **Step 3: Commit.** `git commit -am "feat(web): partidos con dificultad + pronóstico"`

### Task 17: `app.js` — retos (6 mercados, cupo, 1-contra-varios)
**Files:** Modificar `app.js`
- [ ] **Step 1:** formulario de creación con selector de **6 mercados** (1x2/ou con línea/btts/oddeven/exact/scorer con `<select>` de convocatoria desde `team_squads`), **cupo** (1/2/3/5/∞), cuota pre-rellenada vía RPC `suggest_odds`, `stake`. `createChallenge`→`create_challenge`. Render de cada reto con lista de rivales y cupo `X/máx`/`completo`. `accept()`→`accept_challenge`. (Portar la lógica ya validada en `demo.html`.)
- [ ] **Step 2:** verificar con 2 navegadores: crear con cupo 2, que 2 rivales acepten y el 3º vea "completo".
- [ ] **Step 3: Commit.** `git commit -am "feat(web): retos 6 mercados, cupo, 1-contra-varios"`

### Task 18: `app.js` — clasificación + nav + eventos
**Files:** Modificar `app.js`
- [ ] **Step 1:** `renderLeaderboard` (global por puntos), tabs, filtros, wiring, exponer handlers, `boot()` en DOMContentLoaded.
- [ ] **Step 2:** verificar que tras `settle` la clasificación se mueve por Realtime.
- [ ] **Step 3: Commit.** `git commit -am "feat(web): clasificación global + navegación"`

---

## FASE 4 — Verificación y deploy

### Task 19: Smoke integral + GitHub Pages
- [ ] **Step 1:** SQL `select count(*) total, count(*) filter(where settled) liq, count(*) filter(where odds<>'{}') odds from matches;`
- [ ] **Step 2:** 2 cuentas: pronosticar, crear reto cupo 2, aceptar con 2, forzar `settle_match` sobre un finished de prueba, verificar puntos y clasificación.
- [ ] **Step 3:** GitHub Pages: Settings → Pages → `main` `/root`. (La rama de trabajo es `claude/mundial-betting-pool-5a0v1d`; publicar = merge a `main`.)
- [ ] **Step 4:** rellenar `config.js` (URL + anon key) y commitear.
- [ ] **Step 5:** abrir la URL pública, login, ver partidos reales + cuotas.

### Task 20: README + demo
- [ ] **Step 1:** Reescribir `README.md` (modelo nuevo + puesta en marcha: schema, seeds, deploy funciones, secrets ODDS_API_KEY, crons, Pages).
- [ ] **Step 2:** Portar la demo aprobada a `demo.html` (offline, 6 mercados, cupo, multi-taker) — ya existe como artifact de referencia.
- [ ] **Step 3: Commit.** `git add README.md demo.html && git commit -m "docs: README + demo offline del modelo final"`

---

## Notas de verificación (self-review)

- **Cobertura spec rev2:** §3 fuentes/odds→Tasks 11,12,13; §4 modelo datos→Task 1; §5 porra+dificultad→Tasks 4,7,16; §6 retos multi+cupo+6 mercados→Tasks 6,7,17; cuotas reales+fallback→Tasks 4(suggest_odds),12; goleador/squads→Tasks 3,17; §7 clasificación→Task 18; §9 integridad→Tasks 5,6,7.
- **Suma cero y reservas** verificadas numéricamente en Task 8 (reto con 2 rivales).
- **Idempotencia** de `settle_match` verificada en Task 8.
- **Degradación elegante de cuotas:** real si hay cache y matchea por nombre; si no, modelo (Task 4 `suggest_odds`). btts/oddeven/exact/scorer siempre modelo.
- **Riesgos:** (a) cobertura WC2026 en The Odds API por confirmar → fallback modelo cubre; (b) matching de nombres EN entre fuentes → `NORM` + degradación; (c) frescura openfootball (commits) → cron 5 min, plan B football-data.org.
- **Dependencias:** Fase 3 necesita Fase 1+2 desplegadas en un Supabase real; para desarrollar el front antes, usar `demo.html`.
- **Prerrequisitos de entorno (no instalados):** proyecto Supabase, Deno, Supabase CLI, API key The Odds API.
