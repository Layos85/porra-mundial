# Porra del Mundial 2026 — Rediseño · Plan de Implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convertir la web en una liga global única donde los partidos del Mundial 2026 se cargan y actualizan solos, cada usuario pronostica marcadores (puntos por acertar, más si hay sorpresa) y puede retar a otros 1v1 robándose puntos.

**Architecture:** Toda la lógica de juego vive en Postgres/Supabase (tablas + funciones atómicas `security definer` + cron). Una Edge Function (Deno/TS) programada cada 5 min descarga `openfootball/worldcup.json`, hace upsert de los partidos vía RPC y dispara la liquidación. El frontend (HTML/JS estático en GitHub Pages) solo lee datos por Realtime y escribe acciones vía RPC. Una sola moneda: puntos.

**Tech Stack:** Supabase (Postgres 15, RLS, Realtime, pg_cron, Edge Functions Deno/TS), JavaScript vanilla + `@supabase/supabase-js` v2 por CDN, GitHub Pages. Tests: `deno test` (helpers TS puros) y un script SQL de asserts para la lógica de juego.

**Datos reales verificados (2026-06-24):**
- Fuente: `https://raw.githubusercontent.com/openfootball/worldcup.json/master/2026/worldcup.json`
- 104 partidos. Forma: `{name, matches:[{round,date,time,team1,team2,score?:{ft:[a,b],ht:[a,b]},group?,ground,num?}]}`.
- `score` presente solo si jugado. Grupos: SIN `num`, con `group:"Group A"`, round `"Matchday N"`. Eliminatorias: CON `num` (73–104), round `"Round of 32"|"Round of 16"|"Quarter-final"|"Semi-final"|"Match for third place"|"Final"`, equipos como placeholders (`"2A"`, `"W74"`, `"3A/B/C/D/F"`) hasta resolverse.
- 48 selecciones con nombres canónicos en `worldcup.teams.json` (deben coincidir letra a letra).

---

## Mapa de archivos

| Archivo | Responsabilidad | Acción |
|---|---|---|
| `supabase-schema.sql` | Esquema + RLS + funciones de juego + RPCs | **Reescribir** |
| `seeds/team_strength.sql` | Tabla de fuerza (48 selecciones) | Crear |
| `supabase/functions/sync/pure.ts` | Helpers puros de parseo openfootball | Crear |
| `supabase/functions/sync/pure.test.ts` | Tests Deno de los helpers | Crear |
| `supabase/functions/sync/index.ts` | Edge Function: fetch + upsert + settle | Crear |
| `tests/game-logic.test.sql` | Seed + asserts de liquidación | Crear |
| `index.html` | Pantallas (quitar pools/dinero; añadir partidos/retos) | **Reescribir** |
| `app.js` | Controlador: identidad global, datos, render, RPCs, realtime | **Reescribir** |
| `config.js` | Claves Supabase | Mantener |
| `demo.html` | Demo offline del nuevo modelo | Reescribir (fase 5) |
| `README.md` | Puesta en marcha nueva | Actualizar (fase 5) |
| `supabase/cron.sql` | Programación pg_cron de la Edge Function | Crear |

**Constantes de juego** (un solo sitio): tabla `config` (fila única) en `supabase-schema.sql`.

---

## FASE 1 — Lógica de juego en Postgres

### Task 1: Esquema base + tabla de configuración

**Files:**
- Reescribir: `supabase-schema.sql`

- [ ] **Step 1: Escribir el nuevo esquema** (reemplaza TODO el contenido actual)

```sql
-- ============================================================
--  Porra del Mundial 2026 — esquema (Supabase / Postgres)
--  Pega TODO en: Supabase → SQL Editor → New query → Run
--  Idempotente: se puede ejecutar varias veces.
-- ============================================================
create extension if not exists "pgcrypto";

-- ---------- Configuración (una sola fila) ----------
create table if not exists config (
  id            boolean primary key default true check (id),   -- fuerza fila única
  start_points  numeric not null default 1000,
  pts_exact     numeric not null default 50,   -- base marcador exacto
  pts_winner    numeric not null default 20,   -- base solo ganador
  thr_fav       numeric not null default 0.50, -- p >= 0.50 -> x1
  thr_even      numeric not null default 0.30, -- 0.30..0.50 -> x1.5 ; <0.30 -> x3
  fac_even      numeric not null default 1.5,
  fac_surprise  numeric not null default 3
);
insert into config (id) values (true) on conflict (id) do nothing;

-- ---------- Selecciones (fuerza tipo Elo) ----------
create table if not exists team_strength (
  name    text primary key,
  rating  numeric not null
);

-- ---------- Jugadores (liga global) ----------
create table if not exists players (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  recovery_code text unique not null,
  points        numeric not null default 1000,
  created_at    timestamptz default now()
);

-- ---------- Partidos (los llena el cron) ----------
create table if not exists matches (
  id           uuid primary key default gen_random_uuid(),
  ext_id       text unique not null,
  stage        text not null,           -- grupos|dieciseisavos|octavos|cuartos|semis|tercer_puesto|final
  grp          text,                    -- A..L o null
  team_a       text not null,
  team_b       text not null,
  teams_known  boolean not null default false,
  kickoff      timestamptz,
  status       text not null default 'scheduled',  -- scheduled|live|finished
  score_a      integer,
  score_b      integer,
  p_a          numeric,                 -- prob. gana A
  p_draw       numeric,                 -- prob. empate
  p_b          numeric,                 -- prob. gana B
  settled      boolean not null default false,
  created_at   timestamptz default now()
);

-- ---------- Pronósticos (porra base) ----------
create table if not exists predictions (
  id         uuid primary key default gen_random_uuid(),
  match_id   uuid not null references matches(id) on delete cascade,
  player_id  uuid not null references players(id) on delete cascade,
  pred_a     integer not null,
  pred_b     integer not null,
  points     numeric,                   -- null hasta liquidar
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (match_id, player_id)
);

-- ---------- Retos 1v1 ----------
create table if not exists challenges (
  id            uuid primary key default gen_random_uuid(),
  match_id      uuid not null references matches(id) on delete cascade,
  market        text not null,          -- 1x2|ou25|btts
  selection     text not null,          -- 1|X|2 ; over|under ; si|no  (lado del CREADOR)
  odds          numeric not null check (odds > 1),
  stake         numeric not null check (stake > 0),
  creator_id    uuid not null references players(id) on delete cascade,
  taker_id      uuid references players(id) on delete set null,
  status        text not null default 'open',  -- open|accepted|resolved|void
  result_won_by uuid,                    -- player ganador tras liquidar
  created_at    timestamptz default now(),
  resolved_at   timestamptz
);

-- ---------- RLS abierta (puntos ficticios, sin datos sensibles) ----------
alter table config         enable row level security;
alter table team_strength  enable row level security;
alter table players        enable row level security;
alter table matches        enable row level security;
alter table predictions    enable row level security;
alter table challenges     enable row level security;

do $$ begin
  perform 1;
exception when others then null; end $$;

drop policy if exists "ro config"  on config;
drop policy if exists "ro teams"   on team_strength;
drop policy if exists "rw players" on players;
drop policy if exists "ro matches" on matches;
drop policy if exists "rw preds"   on predictions;
drop policy if exists "rw chals"   on challenges;

create policy "ro config"  on config        for select using (true);
create policy "ro teams"   on team_strength  for select using (true);
create policy "rw players" on players        for all using (true) with check (true);
create policy "ro matches" on matches        for select using (true);
create policy "rw preds"   on predictions    for all using (true) with check (true);
create policy "rw chals"   on challenges      for all using (true) with check (true);

-- (matches/config/teams se escriben solo vía funciones security definer y el cron)
```

- [ ] **Step 2: Ejecutar en Supabase SQL Editor**

Pega el archivo en SQL Editor → Run. Esperado: `Success. No rows returned`.

- [ ] **Step 3: Verificar tablas**

Run en SQL Editor:
```sql
select table_name from information_schema.tables
where table_schema='public' order by table_name;
```
Esperado: incluye `challenges, config, matches, players, predictions, team_strength`.

- [ ] **Step 4: Commit**

```bash
git add supabase-schema.sql
git commit -m "feat(db): nuevo esquema porra mundial (players/matches/predictions/challenges/config)"
```

---

### Task 2: Seed de fuerza de selecciones (48)

**Files:**
- Crear: `seeds/team_strength.sql`

- [ ] **Step 1: Escribir el seed** (nombres EXACTOS de openfootball; ratings tipo Elo, ajustables)

```sql
-- Fuerza de selecciones (rating tipo Elo). Ajustable. Nombres = openfootball.
insert into team_strength (name, rating) values
  ('Argentina', 2100), ('France', 2080), ('Spain', 2070), ('England', 2040),
  ('Brazil', 2030), ('Portugal', 2010), ('Netherlands', 1990), ('Belgium', 1970),
  ('Germany', 1965), ('Croatia', 1930), ('Uruguay', 1925), ('Colombia', 1910),
  ('Morocco', 1900), ('USA', 1860), ('Switzerland', 1855), ('Japan', 1850),
  ('Senegal', 1845), ('Mexico', 1840), ('Ecuador', 1820), ('Austria', 1815),
  ('Australia', 1790), ('South Korea', 1785), ('Sweden', 1780), ('Ivory Coast', 1770),
  ('Norway', 1765), ('Egypt', 1760), ('Panama', 1700), ('Canada', 1810),
  ('Turkey', 1800), ('Paraguay', 1750), ('Scotland', 1745), ('Iran', 1755),
  ('Algeria', 1775), ('Nigeria', 1790), ('Tunisia', 1730), ('Qatar', 1700),
  ('Saudi Arabia', 1710), ('Iraq', 1690), ('Jordan', 1660), ('Uzbekistan', 1685),
  ('DR Congo', 1715), ('Cape Verde', 1670), ('Ghana', 1740), ('Haiti', 1620),
  ('Curaçao', 1630), ('New Zealand', 1650), ('Bosnia & Herzegovina', 1760),
  ('South Africa', 1700), ('Czech Republic', 1790)
on conflict (name) do update set rating = excluded.rating;
```

> Nota: la lista incluye las 48 confirmadas + alguna extra inocua (p.ej. Nigeria) por si cambia un repechaje; cualquier equipo no listado usa 1500 por defecto en el cálculo. Verifica los 48 nombres contra `worldcup.teams.json` antes de cerrar.

- [ ] **Step 2: Ejecutar y verificar**

Run el seed en SQL Editor, luego:
```sql
select count(*) as n, min(rating) lo, max(rating) hi from team_strength;
```
Esperado: `n >= 48`.

- [ ] **Step 3: Verificar que cubre los 48 de openfootball** (manual)

Descarga `worldcup.teams.json` y comprueba que cada `name` existe en `team_strength`. Cualquier ausente → añádelo.

- [ ] **Step 4: Commit**

```bash
git add seeds/team_strength.sql
git commit -m "feat(db): seed fuerza de selecciones mundial 2026"
```

---

### Task 3: Funciones de probabilidad y dificultad

**Files:**
- Modificar: `supabase-schema.sql` (añadir al final, antes de cualquier cron)

- [ ] **Step 1: Añadir funciones puras de cálculo**

```sql
-- Probabilidades 1X2 a partir de dos ratings (modelo Elo + cuota de empate).
create or replace function calc_probs(r_a numeric, r_b numeric,
  out p_a numeric, out p_draw numeric, out p_b numeric)
language plpgsql immutable as $$
declare e_a numeric;
begin
  e_a := 1.0 / (1.0 + power(10.0, (r_b - r_a) / 400.0));   -- cuota esperada de A (0..1)
  p_draw := 0.30 * (1.0 - 2.0 * abs(e_a - 0.5));           -- máx 0.30 si parejos, 0 si paliza
  if p_draw < 0 then p_draw := 0; end if;
  p_a := (1.0 - p_draw) * e_a;
  p_b := (1.0 - p_draw) * (1.0 - e_a);
end; $$;

-- Resultado 1X2 a partir de un marcador.
create or replace function outcome_1x2(a integer, b integer)
returns text language sql immutable as $$
  select case when a > b then '1' when a = b then 'X' else '2' end;
$$;

-- Factor de dificultad a partir de la probabilidad del resultado real.
create or replace function difficulty_factor(p numeric)
returns numeric language plpgsql stable as $$
declare c record;
begin
  select thr_fav, thr_even, fac_even, fac_surprise into c from config where id;
  if p >= c.thr_fav then return 1;
  elsif p >= c.thr_even then return c.fac_even;
  else return c.fac_surprise; end if;
end; $$;
```

- [ ] **Step 2: Ejecutar y probar inline**

Run:
```sql
select * from calc_probs(2070, 1700);          -- España vs débil
select difficulty_factor((calc_probs(1700,2070)).p_a);  -- débil gana al fuerte
```
Esperado: en el primero `p_a` alto (~0.8). En el segundo, factor = 3 (sorpresa).

- [ ] **Step 3: Commit**

```bash
git add supabase-schema.sql
git commit -m "feat(db): calc_probs + outcome_1x2 + difficulty_factor"
```

---

### Task 4: RPCs de jugador y pronóstico

**Files:**
- Modificar: `supabase-schema.sql`

- [ ] **Step 1: Añadir RPCs**

```sql
-- Alta/recuperación de jugador. Devuelve la fila del jugador.
create or replace function upsert_player(p_name text, p_recovery text)
returns players language plpgsql security definer as $$
declare v players%rowtype; v_start numeric;
begin
  select * into v from players where recovery_code = p_recovery;
  if found then return v; end if;
  select start_points into v_start from config where id;
  insert into players(name, recovery_code, points)
    values (trim(p_name), p_recovery, v_start) returning * into v;
  return v;
end; $$;

-- Poner/cambiar el marcador de un partido (hasta el kickoff).
create or replace function place_prediction(p_match uuid, p_player uuid, p_a integer, p_b integer)
returns void language plpgsql security definer as $$
declare v_status text; v_kick timestamptz; v_known boolean;
begin
  select status, kickoff, teams_known into v_status, v_kick, v_known
    from matches where id = p_match;
  if not found then raise exception 'Partido no encontrado'; end if;
  if not v_known then raise exception 'Aún no se conocen los equipos'; end if;
  if v_status <> 'scheduled' or (v_kick is not null and now() >= v_kick) then
    raise exception 'El partido ya ha empezado'; end if;
  if p_a < 0 or p_b < 0 then raise exception 'Marcador no válido'; end if;

  insert into predictions(match_id, player_id, pred_a, pred_b)
    values (p_match, p_player, p_a, p_b)
  on conflict (match_id, player_id) do update
    set pred_a = excluded.pred_a, pred_b = excluded.pred_b, updated_at = now();
end; $$;
```

- [ ] **Step 2: Ejecutar y smoke**

Run:
```sql
select upsert_player('Test', 'CODE-TEST-1');
```
Esperado: una fila con `points = 1000`.

- [ ] **Step 3: Commit**

```bash
git add supabase-schema.sql
git commit -m "feat(db): RPC upsert_player + place_prediction"
```

---

### Task 5: RPCs de retos 1v1 (crear / aceptar) con reserva de puntos

**Files:**
- Modificar: `supabase-schema.sql`

- [ ] **Step 1: Añadir RPCs de retos**

```sql
-- Crear un reto: reserva el stake del creador.
create or replace function create_challenge(
  p_match uuid, p_creator uuid, p_market text, p_selection text,
  p_odds numeric, p_stake numeric)
returns challenges language plpgsql security definer as $$
declare v challenges%rowtype; v_status text; v_kick timestamptz; v_known boolean; v_bal numeric;
begin
  select status, kickoff, teams_known into v_status, v_kick, v_known
    from matches where id = p_match;
  if not found then raise exception 'Partido no encontrado'; end if;
  if not v_known then raise exception 'Aún no se conocen los equipos'; end if;
  if v_status <> 'scheduled' or (v_kick is not null and now() >= v_kick) then
    raise exception 'El partido ya ha empezado'; end if;
  if p_market not in ('1x2','ou25','btts') then raise exception 'Mercado no válido'; end if;
  if p_odds <= 1 then raise exception 'La cuota debe ser mayor que 1'; end if;
  if p_stake <= 0 then raise exception 'Puntos no válidos'; end if;

  select points into v_bal from players where id = p_creator for update;
  if v_bal < p_stake then raise exception 'Saldo insuficiente'; end if;

  update players set points = points - p_stake where id = p_creator;
  insert into challenges(match_id, market, selection, odds, stake, creator_id)
    values (p_match, p_market, p_selection, p_odds, p_stake, p_creator)
  returning * into v;
  return v;
end; $$;

-- Aceptar un reto: reserva la responsabilidad del taker = stake*(odds-1).
create or replace function accept_challenge(p_challenge uuid, p_taker uuid)
returns void language plpgsql security definer as $$
declare c challenges%rowtype; v_status text; v_kick timestamptz; v_liab numeric; v_bal numeric;
begin
  select * into c from challenges where id = p_challenge for update;
  if not found then raise exception 'Reto no encontrado'; end if;
  if c.status <> 'open' then raise exception 'El reto ya no está disponible'; end if;
  if c.creator_id = p_taker then raise exception 'No puedes aceptar tu propio reto'; end if;

  select status, kickoff into v_status, v_kick from matches where id = c.match_id;
  if v_status <> 'scheduled' or (v_kick is not null and now() >= v_kick) then
    raise exception 'El partido ya ha empezado'; end if;

  v_liab := c.stake * (c.odds - 1);
  select points into v_bal from players where id = p_taker for update;
  if v_bal < v_liab then raise exception 'Saldo insuficiente para cubrir el reto'; end if;

  update players set points = points - v_liab where id = p_taker;
  update challenges set taker_id = p_taker, status = 'accepted' where id = p_challenge;
end; $$;
```

- [ ] **Step 2: Ejecutar (sin error de sintaxis)**

Run el bloque. Esperado: `Success`.

- [ ] **Step 3: Commit**

```bash
git add supabase-schema.sql
git commit -m "feat(db): RPC create_challenge + accept_challenge con reserva de puntos"
```

---

### Task 6: Liquidación de partido (porra + retos), idempotente

**Files:**
- Modificar: `supabase-schema.sql`

- [ ] **Step 1: Añadir `settle_match` y `void_open_challenges`**

```sql
-- ¿La selección del creador acierta dado el marcador?
create or replace function challenge_creator_wins(p_market text, p_sel text, a integer, b integer)
returns boolean language sql immutable as $$
  select case p_market
    when '1x2'  then outcome_1x2(a,b) = p_sel
    when 'ou25' then (case when (a+b) >= 3 then 'over' else 'under' end) = p_sel
    when 'btts' then (case when a>0 and b>0 then 'si' else 'no' end) = p_sel
    else false end;
$$;

-- Liquida un partido finalizado: reparte porra y resuelve retos. Idempotente.
create or replace function settle_match(p_match uuid)
returns void language plpgsql security definer as $$
declare m matches%rowtype; cfg config%rowtype;
        pr predictions%rowtype; ch challenges%rowtype;
        v_outcome text; v_p numeric; v_factor numeric; v_pts numeric;
        v_creator_wins boolean; v_winner uuid; v_liab numeric;
begin
  select * into m from matches where id = p_match;
  if not found then raise exception 'Partido no encontrado'; end if;
  if m.status <> 'finished' or m.score_a is null or m.score_b is null then return; end if;
  if m.settled then return; end if;     -- idempotente
  select * into cfg from config where id;

  v_outcome := outcome_1x2(m.score_a, m.score_b);
  v_p := case v_outcome when '1' then m.p_a when 'X' then m.p_draw else m.p_b end;
  v_factor := difficulty_factor(coalesce(v_p, 1));

  -- Porra base
  for pr in select * from predictions where match_id = p_match loop
    if pr.pred_a = m.score_a and pr.pred_b = m.score_b then
      v_pts := cfg.pts_exact * v_factor;
    elsif outcome_1x2(pr.pred_a, pr.pred_b) = v_outcome then
      v_pts := cfg.pts_winner * v_factor;
    else
      v_pts := 0;
    end if;
    update predictions set points = v_pts where id = pr.id;
    if v_pts > 0 then
      update players set points = points + v_pts where id = pr.player_id;
    end if;
  end loop;

  -- Retos aceptados
  for ch in select * from challenges where match_id = p_match and status = 'accepted' loop
    v_liab := ch.stake * (ch.odds - 1);
    v_creator_wins := challenge_creator_wins(ch.market, ch.selection, m.score_a, m.score_b);
    if v_creator_wins then
      v_winner := ch.creator_id;
      update players set points = points + ch.stake + v_liab where id = ch.creator_id;
    else
      v_winner := ch.taker_id;
      update players set points = points + ch.stake + v_liab where id = ch.taker_id;
    end if;
    update challenges set status='resolved', result_won_by=v_winner, resolved_at=now()
      where id = ch.id;
  end loop;

  -- Retos abiertos sin aceptar -> anular y devolver stake al creador
  for ch in select * from challenges where match_id = p_match and status = 'open' loop
    update players set points = points + ch.stake where id = ch.creator_id;
    update challenges set status='void', resolved_at=now() where id = ch.id;
  end loop;

  update matches set settled = true where id = p_match;
end; $$;

-- Anular retos abiertos de partidos que ya empezaron (por si el cron tarda en finalizar).
create or replace function void_started_open_challenges()
returns void language plpgsql security definer as $$
declare ch challenges%rowtype;
begin
  for ch in
    select c.* from challenges c join matches m on m.id = c.match_id
    where c.status='open' and m.kickoff is not null and now() >= m.kickoff
  loop
    update players set points = points + ch.stake where id = ch.creator_id;
    update challenges set status='void', resolved_at=now() where id = ch.id;
  end loop;
end; $$;
```

- [ ] **Step 2: Ejecutar (sin error)**

Run el bloque. Esperado: `Success`.

- [ ] **Step 3: Commit**

```bash
git add supabase-schema.sql
git commit -m "feat(db): settle_match idempotente (porra con dificultad + retos zero-sum) + void"
```

---

### Task 7: Test de lógica de juego (seed + asserts)

**Files:**
- Crear: `tests/game-logic.test.sql`

- [ ] **Step 1: Escribir el test SQL** (crea datos falsos, liquida, comprueba)

```sql
-- Test de liquidación. Ejecutar en un proyecto Supabase de PRUEBA (escribe datos).
-- Limpia al final. Si algún assert falla, lanza excepción.
do $$
declare
  m_id uuid; pa uuid; pb uuid; pc uuid; ch_id uuid;
  bal numeric; pts numeric;
begin
  -- Jugadores
  pa := (upsert_player('A','T-A')).id;
  pb := (upsert_player('B','T-B')).id;
  pc := (upsert_player('C','T-C')).id;

  -- Partido sorpresa: equipo débil (A, 1700) vs fuerte (B, 2070). Gana A 2-1 (sorpresa).
  insert into matches(ext_id, stage, team_a, team_b, teams_known, kickoff, status,
                      score_a, score_b, p_a, p_draw, p_b)
  select 'TEST-1','grupos','Débil','Fuerte', true, now() - interval '3h', 'finished',
         2, 1, pr.p_a, pr.p_draw, pr.p_b
  from calc_probs(1700, 2070) pr
  returning id into m_id;

  -- Pronósticos: A clava 2-1 (exacto), B acierta ganador (3-1), C falla (0-2)
  perform place_prediction(m_id, pa, 2, 1);
  perform place_prediction(m_id, pb, 3, 1);
  perform place_prediction(m_id, pc, 0, 2);

  -- Reto 1v1: creador A apuesta '1' (gana local) a cuota 3.0, stake 100; B acepta (liab 200)
  ch_id := (create_challenge(m_id, pa, '1x2', '1', 3.0, 100)).id;
  perform accept_challenge(ch_id, pb);

  -- Estado tras reservas: A 1000-100=900 ; B 1000-200=800
  select points into bal from players where id = pa; assert bal = 900, 'reserva A';
  select points into bal from players where id = pb; assert bal = 800, 'reserva B';

  -- Liquidar
  perform settle_match(m_id);

  -- Factor sorpresa = 3. Porra: A exacto 50*3=150 ; B ganador 20*3=60 ; C 0.
  select points into pts from predictions where match_id=m_id and player_id=pa;
  assert pts = 150, 'porra A exacta x3 = '||pts;
  select points into pts from predictions where match_id=m_id and player_id=pb;
  assert pts = 60, 'porra B ganador x3 = '||pts;
  select points into pts from predictions where match_id=m_id and player_id=pc;
  assert pts = 0, 'porra C fallo';

  -- Reto: A acertó '1' (ganó local) -> A recupera 100 + gana 200. B pierde su 200.
  -- A final = 900 + 150(porra) + 300(reto) = 1350 ; B final = 800 + 60(porra) + 0 = 860
  select points into bal from players where id = pa; assert bal = 1350, 'A final = '||bal;
  select points into bal from players where id = pb; assert bal = 860,  'B final = '||bal;

  -- Idempotencia: re-liquidar no cambia nada
  perform settle_match(m_id);
  select points into bal from players where id = pa; assert bal = 1350, 'idempotente A';

  -- Limpieza
  delete from matches where ext_id='TEST-1';
  delete from players where recovery_code in ('T-A','T-B','T-C');
  raise notice 'OK: todos los asserts pasaron';
end $$;
```

- [ ] **Step 2: Ejecutar el test**

Pega `tests/game-logic.test.sql` en SQL Editor → Run.
Esperado: `NOTICE: OK: todos los asserts pasaron` y sin excepciones.

- [ ] **Step 3: Si algún assert falla**, corrige la función implicada en `supabase-schema.sql`, re-ejecuta el esquema y vuelve a correr el test. Repite hasta verde.

- [ ] **Step 4: Commit**

```bash
git add tests/game-logic.test.sql
git commit -m "test(db): liquidación porra+retos+idempotencia (sorpresa x3, zero-sum)"
```

---

## FASE 2 — Sincronización automática (Edge Function + cron)

### Task 8: RPC `upsert_match` (calcula probabilidades al volcar)

**Files:**
- Modificar: `supabase-schema.sql`

- [ ] **Step 1: Añadir `upsert_match`**

```sql
-- Upsert de un partido desde el cron. Calcula probabilidades si se conocen ambos equipos.
create or replace function upsert_match(
  p_ext text, p_stage text, p_grp text, p_a text, p_b text,
  p_kick timestamptz, p_status text, p_sa integer, p_sb integer)
returns void language plpgsql security definer as $$
declare v_known boolean; r_a numeric; r_b numeric; pr record;
begin
  select count(*) = 2 into v_known
    from team_strength where name in (p_a, p_b);

  if v_known then
    select coalesce((select rating from team_strength where name=p_a),1500) into r_a;
    select coalesce((select rating from team_strength where name=p_b),1500) into r_b;
    select * into pr from calc_probs(r_a, r_b);
  end if;

  insert into matches(ext_id, stage, grp, team_a, team_b, teams_known, kickoff,
                      status, score_a, score_b, p_a, p_draw, p_b)
  values (p_ext, p_stage, p_grp, p_a, p_b, v_known, p_kick,
          p_status, p_sa, p_sb,
          case when v_known then pr.p_a end,
          case when v_known then pr.p_draw end,
          case when v_known then pr.p_b end)
  on conflict (ext_id) do update set
    stage = excluded.stage, grp = excluded.grp,
    team_a = excluded.team_a, team_b = excluded.team_b,
    teams_known = excluded.teams_known, kickoff = excluded.kickoff,
    status = excluded.status, score_a = excluded.score_a, score_b = excluded.score_b,
    p_a = coalesce(matches.p_a, excluded.p_a),       -- no recalcular si ya estaba fijado
    p_draw = coalesce(matches.p_draw, excluded.p_draw),
    p_b = coalesce(matches.p_b, excluded.p_b);
end; $$;
```

> Las probabilidades se congelan la primera vez que se conocen los equipos (`coalesce` conserva el valor previo), para que la dificultad no cambie a mitad.

- [ ] **Step 2: Ejecutar y smoke**

```sql
select upsert_match('SMOKE-1','grupos','A','Spain','South Africa',
  now()+interval '1d','scheduled',null,null);
select team_a, team_b, teams_known, round(p_a,2), round(p_draw,2), round(p_b,2)
  from matches where ext_id='SMOKE-1';
delete from matches where ext_id='SMOKE-1';
```
Esperado: `teams_known=true`, `p_a` alto (~0.8).

- [ ] **Step 3: Commit**

```bash
git add supabase-schema.sql
git commit -m "feat(db): RPC upsert_match con cálculo y congelado de probabilidades"
```

---

### Task 9: Helpers puros de parseo (TDD con Deno)

**Files:**
- Crear: `supabase/functions/sync/pure.ts`
- Test: `supabase/functions/sync/pure.test.ts`

- [ ] **Step 1: Escribir los tests primero**

```ts
// supabase/functions/sync/pure.test.ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { extId, teamsKnown, mapStage, groupLetter, parseKickoff, deriveStatus } from "./pure.ts";

Deno.test("extId usa num en eliminatorias", () => {
  assertEquals(extId({ num: 89, date: "2026-07-04", ground: "Philadelphia" }), "n89");
});
Deno.test("extId usa fecha__estadio en grupos", () => {
  assertEquals(extId({ date: "2026-06-11", ground: "Mexico City" }), "2026-06-11__Mexico City");
});
Deno.test("teamsKnown solo si ambos son selecciones reales", () => {
  const valid = new Set(["Spain", "Germany"]);
  assertEquals(teamsKnown("Spain", "Germany", valid), true);
  assertEquals(teamsKnown("Spain", "2A", valid), false);
  assertEquals(teamsKnown("W74", "W77", valid), false);
});
Deno.test("mapStage traduce rondas", () => {
  assertEquals(mapStage("Matchday 3"), "grupos");
  assertEquals(mapStage("Round of 32"), "dieciseisavos");
  assertEquals(mapStage("Round of 16"), "octavos");
  assertEquals(mapStage("Quarter-final"), "cuartos");
  assertEquals(mapStage("Semi-final"), "semis");
  assertEquals(mapStage("Match for third place"), "tercer_puesto");
  assertEquals(mapStage("Final"), "final");
});
Deno.test("groupLetter extrae la letra", () => {
  assertEquals(groupLetter("Group A"), "A");
  assertEquals(groupLetter(undefined), null);
});
Deno.test("parseKickoff aplica el offset UTC", () => {
  assertEquals(parseKickoff("2026-06-11", "13:00 UTC-6"), "2026-06-11T13:00:00-06:00");
  assertEquals(parseKickoff("2026-07-04", "17:00 UTC-4"), "2026-07-04T17:00:00-04:00");
});
Deno.test("deriveStatus según score y hora", () => {
  const now = new Date("2026-06-12T00:00:00Z");
  assertEquals(deriveStatus({ score: { ft: [2, 0] } }, "2026-06-11T13:00:00-06:00", now), "finished");
  assertEquals(deriveStatus({}, "2026-06-11T13:00:00-06:00", now), "live");
  assertEquals(deriveStatus({}, "2026-07-04T17:00:00-04:00", now), "scheduled");
});
```

- [ ] **Step 2: Ejecutar los tests (deben fallar)**

Run: `cd supabase/functions/sync && deno test pure.test.ts`
Esperado: FAIL (módulo `pure.ts` no existe).

- [ ] **Step 3: Implementar `pure.ts`**

```ts
// supabase/functions/sync/pure.ts
export interface OFMatch {
  num?: number; round?: string; date?: string; time?: string;
  team1?: string; team2?: string; group?: string; ground?: string;
  score?: { ft?: [number, number]; ht?: [number, number] };
}

export function extId(m: OFMatch): string {
  if (typeof m.num === "number") return `n${m.num}`;
  return `${m.date}__${m.ground}`;
}

export function teamsKnown(a: string, b: string, valid: Set<string>): boolean {
  return valid.has(a) && valid.has(b);
}

export function mapStage(round: string | undefined): string {
  const r = (round ?? "").toLowerCase();
  if (r.startsWith("matchday")) return "grupos";
  if (r.includes("round of 32")) return "dieciseisavos";
  if (r.includes("round of 16")) return "octavos";
  if (r.includes("quarter")) return "cuartos";
  if (r.includes("semi")) return "semis";
  if (r.includes("third")) return "tercer_puesto";
  if (r.includes("final")) return "final";
  return "grupos";
}

export function groupLetter(group: string | undefined): string | null {
  if (!group) return null;
  const m = group.match(/Group\s+([A-L])/i);
  return m ? m[1].toUpperCase() : null;
}

export function parseKickoff(date: string, time: string | undefined): string | null {
  if (!date) return null;
  if (!time) return `${date}T00:00:00Z`;
  const t = time.match(/(\d{1,2}):(\d{2})/);
  const off = time.match(/UTC([+-]\d{1,2})/);
  if (!t) return `${date}T00:00:00Z`;
  const hh = t[1].padStart(2, "0");
  const mm = t[2];
  if (!off) return `${date}T${hh}:${mm}:00Z`;
  const sign = off[1].startsWith("-") ? "-" : "+";
  const oh = String(Math.abs(parseInt(off[1], 10))).padStart(2, "0");
  return `${date}T${hh}:${mm}:00${sign}${oh}:00`;
}

export function deriveStatus(m: OFMatch, kickoffIso: string | null, now: Date): string {
  if (m.score?.ft && m.score.ft.length === 2) return "finished";
  if (kickoffIso && now >= new Date(kickoffIso)) return "live";
  return "scheduled";
}
```

- [ ] **Step 4: Ejecutar los tests (deben pasar)**

Run: `cd supabase/functions/sync && deno test pure.test.ts`
Esperado: `ok | 7 passed`.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/sync/pure.ts supabase/functions/sync/pure.test.ts
git commit -m "feat(sync): helpers puros de parseo openfootball + tests deno"
```

---

### Task 10: Edge Function `sync` (fetch + upsert + settle)

**Files:**
- Crear: `supabase/functions/sync/index.ts`

- [ ] **Step 1: Implementar la función**

```ts
// supabase/functions/sync/index.ts
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { extId, teamsKnown, mapStage, groupLetter, parseKickoff, deriveStatus, OFMatch } from "./pure.ts";

const SRC = "https://raw.githubusercontent.com/openfootball/worldcup.json/master/2026/worldcup.json";

Deno.serve(async () => {
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // 1) Selecciones válidas (para teams_known)
  const { data: teams, error: te } = await supabase.from("team_strength").select("name");
  if (te) return json({ error: te.message }, 500);
  const valid = new Set((teams ?? []).map((t) => t.name));

  // 2) Descargar fixture
  const res = await fetch(SRC, { headers: { "cache-control": "no-cache" } });
  if (!res.ok) return json({ error: `fetch ${res.status}` }, 502);
  const data = await res.json() as { matches: OFMatch[] };
  const now = new Date();

  // 3) Upsert de cada partido
  let upserts = 0;
  for (const m of data.matches ?? []) {
    const a = m.team1 ?? "", b = m.team2 ?? "";
    if (!a || !b || !m.date) continue;
    const kickoff = parseKickoff(m.date, m.time);
    const status = deriveStatus(m, kickoff, now);
    const { error } = await supabase.rpc("upsert_match", {
      p_ext: extId(m),
      p_stage: mapStage(m.round),
      p_grp: groupLetter(m.group),
      p_a: a, p_b: b,
      p_kick: kickoff,
      p_status: status,
      p_sa: m.score?.ft?.[0] ?? null,
      p_sb: m.score?.ft?.[1] ?? null,
    });
    if (!error) upserts++;
  }

  // 4) Anular retos abiertos de partidos ya empezados
  await supabase.rpc("void_started_open_challenges");

  // 5) Liquidar partidos finalizados sin liquidar
  const { data: pend } = await supabase.from("matches")
    .select("id").eq("status", "finished").eq("settled", false);
  let settled = 0;
  for (const row of pend ?? []) {
    const { error } = await supabase.rpc("settle_match", { p_match: row.id });
    if (!error) settled++;
  }

  return json({ ok: true, upserts, settled });
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { "content-type": "application/json" },
  });
}
```

- [ ] **Step 2: Verificar que compila (type-check)**

Run: `cd supabase/functions/sync && deno check index.ts`
Esperado: sin errores.

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/sync/index.ts
git commit -m "feat(sync): edge function fetch openfootball -> upsert_match -> settle"
```

---

### Task 11: Desplegar y programar el cron (setup manual guiado)

**Files:**
- Crear: `supabase/cron.sql`

- [ ] **Step 1: Desplegar la Edge Function**

Requisitos: Supabase CLI instalado y logueado (`supabase login`).
```bash
cd "$HOME/seguimiento-habitos"
supabase link --project-ref <TU_PROJECT_REF>
supabase functions deploy sync --no-verify-jwt
```
Esperado: `Deployed Function sync`.

- [ ] **Step 2: Probar la función manualmente**

```bash
curl -s -X POST "https://<TU_PROJECT_REF>.functions.supabase.co/sync" | python -m json.tool
```
Esperado: `{"ok": true, "upserts": 104, "settled": <n>}`.

- [ ] **Step 3: Verificar que se llenaron los partidos**

SQL Editor:
```sql
select stage, count(*) from matches group by stage order by 1;
select count(*) filter (where teams_known) as conocidos,
       count(*) filter (where status='finished') as jugados from matches;
```
Esperado: ~104 partidos; los de grupo `teams_known=true`.

- [ ] **Step 4: Programar el cron** (pg_cron + pg_net). Crear `supabase/cron.sql`:

```sql
-- Programa la Edge Function cada 5 minutos.
-- Sustituye <REF> y <SERVICE_ROLE_KEY> por los de tu proyecto.
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule('porra-sync', '*/5 * * * *', $$
  select net.http_post(
    url := 'https://<REF>.functions.supabase.co/sync',
    headers := jsonb_build_object(
      'Content-Type','application/json',
      'Authorization','Bearer <SERVICE_ROLE_KEY>')
  );
$$);
```
Pega en SQL Editor (con tus valores) → Run.

- [ ] **Step 5: Verificar el cron**

```sql
select jobname, schedule, active from cron.job;
```
Esperado: fila `porra-sync`, `*/5 * * * *`, `active=t`.

- [ ] **Step 6: Commit**

```bash
git add supabase/cron.sql
git commit -m "chore(sync): programación pg_cron de la edge function (cada 5 min)"
```

---

## FASE 3 — Frontend (liga global, partidos, porra, retos)

> El frontend se reescribe sobre el `index.html`/`app.js` actuales: se mantienen estilos, `toast`, `store` resistente y patrón Realtime; se elimina todo lo de pools/dinero/crear-apuestas-a-mano.

### Task 12: Pantallas nuevas en `index.html`

**Files:**
- Reescribir: `index.html` (cuerpo `<body>`; conserva `<head>`/estilos y añade lo que falte)

- [ ] **Step 1: Estructurar las pantallas**

Sustituye el `<body>` por estas pantallas (IDs que usa `app.js`):
```html
<body>
  <div id="toast" class="toast"></div>

  <!-- Config claves Supabase (igual que hoy) -->
  <section id="screen-setup" class="screen hide">
    <div class="wrap"><div class="card">
      <h2>Conectar</h2>
      <input id="cfgUrl" placeholder="Supabase URL">
      <input id="cfgKey" placeholder="anon public key">
      <button id="cfgSave" class="btn">Guardar</button>
    </div></div>
  </section>

  <!-- Identidad global -->
  <section id="screen-login" class="screen hide">
    <div class="wrap"><div class="card">
      <h1>⚽🏆 Porra del Mundial</h1>
      <p class="muted small">Entra con tu nombre. Te daremos un código para recuperar tu cuenta en otro móvil.</p>
      <input id="loginName" placeholder="Tu nombre">
      <button id="loginBtn" class="btn">Entrar</button>
      <hr>
      <p class="muted small">¿Ya jugabas? Pega tu código de recuperación:</p>
      <input id="recoverCode" placeholder="Código de recuperación">
      <button id="recoverBtn" class="btn ghost">Recuperar cuenta</button>
    </div></div>
  </section>

  <!-- App -->
  <section id="screen-app" class="screen hide">
    <header class="topbar">
      <div class="avatar" id="avatar">?</div>
      <div><div id="userName">—</div><small id="userPts">0 🪙</small></div>
      <button id="myCodeBtn" class="btn ghost sm">Mi código</button>
    </header>

    <nav id="tabs">
      <button data-tab="matches" class="active">Partidos</button>
      <button data-tab="rank">Clasificación</button>
    </nav>

    <div id="tab-matches">
      <div class="filterbar">
        <button data-f="next" class="on">Próximos</button>
        <button data-f="live">En juego</button>
        <button data-f="done">Finalizados</button>
      </div>
      <div id="matchList"></div>
    </div>

    <div id="tab-rank" class="hide"><div id="leaderboard"></div></div>
  </section>

  <script src="config.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
  <script src="app.js"></script>
</body>
```

- [ ] **Step 2: Verificar que carga sin errores de consola**

Run: `python -m http.server 8000` y abre `http://localhost:8000/index.html`. Con `config.js` vacío debe mostrar la pantalla de conectar. Consola sin errores rojos.

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "feat(web): pantallas login global + partidos + clasificación"
```

---

### Task 13: `app.js` — arranque, identidad global y capa de datos

**Files:**
- Reescribir: `app.js`

- [ ] **Step 1: Escribir base (config, store, identidad, datos, realtime)**

```js
"use strict";
/* Porra del Mundial 2026 — liga global con Supabase */

const LS = { url:"porra.url", key:"porra.key", pid:"porra.playerId", rec:"porra.recovery" };

let sb=null, me=null, matches=[], myPreds={}, challenges=[], players=[];
let activeTab="matches", matchFilter="next", channel=null;

/* store resistente (igual patrón que la versión anterior) */
const mem=(window.__pm=window.__pm||{}); let LS_OK=true;
try{ localStorage.setItem("__t","1"); localStorage.removeItem("__t"); }catch(e){ LS_OK=false; }
const store={ get:k=>LS_OK?localStorage.getItem(k):(k in mem?mem[k]:null),
  set:(k,v)=>{LS_OK?localStorage.setItem(k,v):mem[k]=String(v);}, del:k=>{LS_OK?localStorage.removeItem(k):delete mem[k];} };

const $=id=>document.getElementById(id);
const fmt=n=>Math.round(Number(n)||0).toLocaleString("es-ES");
const initials=s=>(s||"?").trim().slice(0,2).toUpperCase();
function esc(s){return String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}
function toast(m,bad=false){const t=$("toast");t.textContent=m;t.classList.toggle("bad",bad);t.classList.add("show");clearTimeout(t._t);t._t=setTimeout(()=>t.classList.remove("show"),2600);}
function show(s){["setup","login","app"].forEach(x=>$("screen-"+x).classList.toggle("hide",x!==s));}
function genCode(){const c="ABCDEFGHJKLMNPQRSTUVWXYZ23456789";let r="";for(let i=0;i<6;i++)r+=c[Math.floor(Math.random()*c.length)];return "PM-"+r;}

function getCfg(){return{url:(store.get(LS.url)||(window.PORRA_CONFIG&&window.PORRA_CONFIG.SUPABASE_URL)||"").trim(),
  key:(store.get(LS.key)||(window.PORRA_CONFIG&&window.PORRA_CONFIG.SUPABASE_ANON_KEY)||"").trim()};}
function initClient(){const{url,key}=getCfg();if(!url||!key)return false;if(!window.supabase)return false;
  sb=window.supabase.createClient(url,key,{realtime:{params:{eventsPerSecond:5}}});return true;}

async function boot(){
  if(!initClient()){show("setup");return;}
  const pid=store.get(LS.pid);
  if(pid){const ok=await loadMe(pid);if(ok){await afterLogin();return;}}
  show("login");
}
async function loadMe(pid){
  const{data}=await sb.from("players").select().eq("id",pid).maybeSingle();
  if(!data)return false; me=data; return true;
}
async function doLogin(){
  const name=$("loginName").value.trim(); if(!name)return toast("Escribe tu nombre",true);
  const rec=genCode();
  const{data,error}=await sb.rpc("upsert_player",{p_name:name,p_recovery:rec});
  if(error)return toast("Error: "+error.message,true);
  me=data; store.set(LS.pid,me.id); store.set(LS.rec,me.recovery_code);
  await afterLogin(); toast("¡Hola, "+me.name+"! Tu código: "+me.recovery_code);
}
async function doRecover(){
  const rec=$("recoverCode").value.trim().toUpperCase(); if(!rec)return toast("Pega tu código",true);
  const{data,error}=await sb.rpc("upsert_player",{p_name:"",p_recovery:rec});
  if(error||!data)return toast("Código no válido",true);
  me=data; store.set(LS.pid,me.id); store.set(LS.rec,me.recovery_code);
  await afterLogin(); toast("Cuenta recuperada 👋");
}
async function afterLogin(){ await refresh(); subscribe(); renderApp(); show("app"); }

async function refresh(){
  const[rm,rc,rp]=await Promise.all([
    sb.from("matches").select().order("kickoff",{ascending:true}),
    sb.from("challenges").select(),
    sb.from("players").select(),
  ]);
  matches=rm.data||[]; challenges=rc.data||[]; players=rp.data||[];
  if(me){const mine=players.find(p=>p.id===me.id); if(mine)me=mine;}
  const rpr=await sb.from("predictions").select().eq("player_id",me.id);
  myPreds={}; (rpr.data||[]).forEach(p=>myPreds[p.match_id]=p);
  if(!$("screen-app").classList.contains("hide"))renderApp();
}
function subscribe(){
  if(channel){sb.removeChannel(channel);channel=null;}
  channel=sb.channel("porra");
  ["matches","challenges","players","predictions"].forEach(t=>
    channel.on("postgres_changes",{event:"*",schema:"public",table:t},()=>refresh()));
  channel.subscribe();
}
```

- [ ] **Step 2: Verificar carga (smoke, sin render aún)**

Temporalmente añade al final `document.addEventListener("DOMContentLoaded",boot);` y carga la web con `config.js` relleno de un proyecto de prueba. Debe mostrar la pantalla de login sin errores de consola. (El render completo llega en Task 14.)

- [ ] **Step 3: Commit**

```bash
git add app.js
git commit -m "feat(web): arranque, identidad global por código y capa de datos+realtime"
```

---

### Task 14: `app.js` — render de partidos y pronóstico

**Files:**
- Modificar: `app.js` (añadir funciones de render/acciones)

- [ ] **Step 1: Render de la lista de partidos + preview de dificultad**

```js
function factorLabel(p){ if(p==null)return{f:"?",t:""}; if(p>=0.5)return{f:"×1",t:"Favorito"};
  if(p>=0.3)return{f:"×1.5",t:"Igualado"}; return{f:"×3",t:"Sorpresa"}; }

function renderApp(){
  $("avatar").textContent=initials(me.name);
  $("userName").textContent=me.name; $("userPts").textContent=fmt(me.points)+" 🪙";
  renderMatches(); renderLeaderboard();
}
function renderMatches(){
  const now=Date.now();
  let arr=matches.filter(m=>m.teams_known);
  if(matchFilter==="next") arr=arr.filter(m=>m.status==="scheduled");
  if(matchFilter==="live") arr=arr.filter(m=>m.status==="live");
  if(matchFilter==="done") arr=arr.filter(m=>m.status==="finished");
  const el=$("matchList");
  if(!arr.length){el.innerHTML=`<div class="empty"><b>No hay partidos aquí</b></div>`;return;}
  el.innerHTML=arr.map(m=>matchCard(m,now)).join("");
}
function matchCard(m,now){
  const pred=myPreds[m.id];
  const started=m.status!=="scheduled"||(m.kickoff&&now>=new Date(m.kickoff).getTime());
  const score=m.status==="finished"
    ? `<span class="sc">${m.score_a} - ${m.score_b}</span>`
    : `<span class="muted">vs</span>`;
  const fa=factorLabel(m.p_a),fx=factorLabel(m.p_draw),fb=factorLabel(m.p_b);
  const chips=`<div class="tiers small">
     <span>${esc(m.team_a)} ${fa.f}</span><span>X ${fx.f}</span><span>${esc(m.team_b)} ${fb.f}</span></div>`;

  let pred_html;
  if(m.status==="finished"){
    pred_html=pred?`<div class="mypick">Tu ${pred.pred_a}-${pred.pred_b} · ${pred.points>0?"+"+fmt(pred.points):"0"} 🪙</div>`
      :`<div class="muted small">No pronosticaste</div>`;
  }else if(started){
    pred_html=pred?`<div class="mypick">Tu pronóstico: ${pred.pred_a}-${pred.pred_b} (cerrado)</div>`
      :`<div class="muted small">Cerrado sin pronóstico</div>`;
  }else{
    pred_html=`<button class="btn sm" onclick="predict('${m.id}')">${pred?`✏️ ${pred.pred_a}-${pred.pred_b}`:"🎯 Pronosticar"}</button>`;
  }

  const chal=!started?`<button class="btn ghost sm" onclick="newChallenge('${m.id}')">⚔️ Reto 1v1</button>`:"";
  return `<div class="bet">
    <div class="head"><span class="chip cat">${esc(m.stage)}${m.grp?" "+m.grp:""}</span>
      <span class="chip ${m.status}">${m.status==="finished"?"Final":m.status==="live"?"En juego":"Próximo"}</span></div>
    <h3 style="text-align:center">${esc(m.team_a)} ${score} ${esc(m.team_b)}</h3>
    ${chips}${pred_html}${chal}
    ${renderMatchChallenges(m.id)}
  </div>`;
}
async function predict(matchId){
  const m=matches.find(x=>x.id===matchId); const pred=myPreds[matchId];
  const raw=prompt(`Tu marcador para ${m.team_a} vs ${m.team_b} (ej. 2-1)`,pred?`${pred.pred_a}-${pred.pred_b}`:"");
  if(raw===null)return; const mt=raw.trim().match(/^(\d+)\s*[-:]\s*(\d+)$/);
  if(!mt)return toast("Formato 2-1",true);
  const{error}=await sb.rpc("place_prediction",{p_match:matchId,p_player:me.id,p_a:+mt[1],p_b:+mt[2]});
  if(error)return toast("Error: "+error.message,true);
  await refresh(); toast("Pronóstico guardado 🎯");
}
```

- [ ] **Step 2: Verificar en local**

Con datos reales sincronizados (Fase 2 hecha), carga la web: deben verse partidos con chips de dificultad, y poder pronosticar un partido futuro (aparece tu marcador). Un partido finalizado muestra tus puntos.

- [ ] **Step 3: Commit**

```bash
git add app.js
git commit -m "feat(web): render de partidos con dificultad y pronóstico de marcador"
```

---

### Task 15: `app.js` — retos 1v1 (crear / aceptar / listar)

**Files:**
- Modificar: `app.js`

- [ ] **Step 1: Render y acciones de retos**

```js
const MARKETS={ "1x2":["1","X","2"], "ou25":["over","under"], "btts":["si","no"] };
const MK_LABEL={ "1x2":"1X2", "ou25":"Más/Menos 2.5", "btts":"Ambos marcan" };
const SEL_LABEL={ "1":"Gana local","X":"Empate","2":"Gana visitante",
  "over":"Más de 2.5","under":"Menos de 2.5","si":"Sí","no":"No" };

function renderMatchChallenges(matchId){
  const list=challenges.filter(c=>c.match_id===matchId&&c.status!=="void");
  if(!list.length)return "";
  return `<div class="wager-list">${list.map(c=>{
    const cr=players.find(p=>p.id===c.creator_id), tk=players.find(p=>p.id===c.taker_id);
    const liab=Math.round(c.stake*(c.odds-1));
    let right;
    if(c.status==="open"){
      right=c.creator_id===me.id?`<span class="muted">esperando rival</span>`
        :`<button class="btn gold sm" onclick="accept('${c.id}')">Aceptar (arriesgas ${fmt(liab)})</button>`;
    }else if(c.status==="accepted"){ right=`<span class="muted">vs ${esc(tk?tk.name:"?")}</span>`; }
    else { const w=players.find(p=>p.id===c.result_won_by); right=`<b>🏆 ${esc(w?w.name:"?")}</b>`; }
    return `<div class="w"><span><b>${esc(cr?cr.name:"?")}</b> · ${MK_LABEL[c.market]}: <b>${SEL_LABEL[c.selection]}</b> @${c.odds} · ${fmt(c.stake)}🪙</span>${right}</div>`;
  }).join("")}</div>`;
}
async function newChallenge(matchId){
  const m=matches.find(x=>x.id===matchId);
  const mk=prompt("Mercado: 1x2 / ou25 / btts","1x2"); if(mk===null)return;
  if(!MARKETS[mk])return toast("Mercado no válido",true);
  const sel=prompt(`Tu lado (${MARKETS[mk].join(" / ")})`,MARKETS[mk][0]); if(sel===null)return;
  if(!MARKETS[mk].includes(sel))return toast("Lado no válido",true);
  const sug=mk==="1x2"?suggestOdds(m,sel):1.90;
  const oraw=prompt(`Cuota (sugerida ${sug})`,String(sug)); if(oraw===null)return;
  const odds=parseFloat(oraw); if(!(odds>1))return toast("Cuota > 1",true);
  const sraw=prompt(`¿Cuántos puntos te juegas? (tienes ${fmt(me.points)})`,""); if(sraw===null)return;
  const stake=Math.floor(+sraw); if(!(stake>0))return toast("Puntos no válidos",true);
  const{error}=await sb.rpc("create_challenge",{p_match:matchId,p_creator:me.id,p_market:mk,p_selection:sel,p_odds:odds,p_stake:stake});
  if(error)return toast("Error: "+error.message,true);
  await refresh(); toast("Reto publicado ⚔️");
}
function suggestOdds(m,sel){
  const p=sel==="1"?m.p_a:sel==="X"?m.p_draw:m.p_b;
  if(!p||p<=0)return 2.0; return Math.max(1.05,Math.round((1/p)*100)/100);
}
async function accept(id){
  const c=challenges.find(x=>x.id===id); const liab=Math.round(c.stake*(c.odds-1));
  if(!confirm(`Aceptar este reto: arriesgas ${fmt(liab)} para ganar ${fmt(c.stake)}. ¿Seguro?`))return;
  const{error}=await sb.rpc("accept_challenge",{p_challenge:id,p_taker:me.id});
  if(error)return toast("Error: "+error.message,true);
  await refresh(); toast("Reto aceptado ⚔️");
}
```

- [ ] **Step 2: Verificar flujo con dos navegadores**

Abre la web en dos navegadores (dos jugadores). Uno crea un reto 1v1 en un partido futuro; el otro lo ve y lo acepta. Comprueba que a ambos se les reservan puntos (baja su saldo).

- [ ] **Step 3: Commit**

```bash
git add app.js
git commit -m "feat(web): retos 1v1 — crear, sugerir cuota, aceptar, listar por partido"
```

---

### Task 16: `app.js` — clasificación, navegación y eventos

**Files:**
- Modificar: `app.js`

- [ ] **Step 1: Clasificación + wiring de eventos**

```js
function renderLeaderboard(){
  const el=$("leaderboard");
  const sorted=[...players].sort((a,b)=>Number(b.points)-Number(a.points));
  el.innerHTML=sorted.map((p,i)=>`<div class="lb">
    <div class="pos">${i===0?"🥇":i===1?"🥈":i===2?"🥉":(i+1)}</div>
    <div class="avatar sm">${initials(p.name)}</div>
    <div class="nm">${esc(p.name)}${p.id===me.id?' <span class="small">(tú)</span>':''}</div>
    <div class="mn">${fmt(p.points)} 🪙</div></div>`).join("");
}
function switchTab(t){ activeTab=t;
  ["matches","rank"].forEach(x=>$("tab-"+x).classList.toggle("hide",x!==t));
  document.querySelectorAll("#tabs button").forEach(b=>b.classList.toggle("active",b.dataset.tab===t));
}
function wire(){
  $("cfgSave").addEventListener("click",()=>{store.set(LS.url,$("cfgUrl").value.trim());store.set(LS.key,$("cfgKey").value.trim());if(initClient())boot();});
  $("loginBtn").addEventListener("click",doLogin);
  $("recoverBtn").addEventListener("click",doRecover);
  $("myCodeBtn").addEventListener("click",()=>{const c=store.get(LS.rec);if(c){navigator.clipboard?.writeText(c);toast("Tu código: "+c+" (copiado)");}});
  document.querySelectorAll("#tabs button").forEach(b=>b.addEventListener("click",()=>switchTab(b.dataset.tab)));
  document.querySelectorAll(".filterbar button").forEach(b=>b.addEventListener("click",()=>{matchFilter=b.dataset.f;document.querySelectorAll(".filterbar button").forEach(x=>x.classList.toggle("on",x===b));renderMatches();}));
  const{url,key}=getCfg(); $("cfgUrl").value=url; $("cfgKey").value=key;
  window.predict=predict; window.newChallenge=newChallenge; window.accept=accept;
}
document.addEventListener("DOMContentLoaded",()=>{wire();boot();});
```

- [ ] **Step 2: Verificar end-to-end**

Recarga: pestaña Clasificación ordena por puntos; tras liquidar un partido (Fase 2), los saldos y la clasificación se actualizan solos por Realtime.

- [ ] **Step 3: Commit**

```bash
git add app.js
git commit -m "feat(web): clasificación global, navegación y wiring de eventos"
```

---

## FASE 4 — Verificación integral y deploy

### Task 17: Smoke test integral en Supabase real + GitHub Pages

- [ ] **Step 1: Smoke de datos** — en SQL Editor:
```sql
select count(*) total,
  count(*) filter (where teams_known) conocidos,
  count(*) filter (where status='finished') jugados,
  count(*) filter (where settled) liquidados from matches;
```
Esperado: total ~104; jugados=liquidados.

- [ ] **Step 2: Smoke de juego** (manual, 2 cuentas): pronosticar, crear y aceptar un reto, esperar/forzar liquidación (`select settle_match(id)` sobre un partido finalizado de prueba), verificar puntos.

- [ ] **Step 3: Activar GitHub Pages** — Settings → Pages → Deploy from branch → `main` → `/root`. (Recuerda: la rama de trabajo es `claude/mundial-betting-pool-5a0v1d`; para publicar hay que mergearla a `main`.)

- [ ] **Step 4: Rellenar `config.js`** con URL + anon key del proyecto y commitear.

- [ ] **Step 5: Verificar la URL pública** — abrir la web publicada, login, ver partidos reales.

- [ ] **Step 6: Commit**
```bash
git add config.js
git commit -m "chore: claves supabase de producción + verificación integral"
```

---

### Task 18: Actualizar `README.md` y `demo.html`

- [ ] **Step 1: Reescribir `README.md`** — nuevo modelo (liga global, porra con dificultad, retos 1v1, cron). Secciones: qué es, puesta en marcha (schema + seed + edge function + cron), cómo se juega, demo.

- [ ] **Step 2: Actualizar `demo.html`** — demo offline autocontenida del nuevo flujo (partidos de ejemplo, pronóstico con dificultad, reto 1v1 simulado). Reusa la lógica de `factorLabel`/markets con una "BD" en memoria. (Opcional pero recomendado como demo sin Supabase.)

- [ ] **Step 3: Commit**
```bash
git add README.md demo.html
git commit -m "docs: README y demo offline del nuevo modelo"
```

---

## Notas de verificación (self-review)

- **Cobertura del spec:** §3 sync→Tasks 9–11; §4 modelo de datos→Task 1; §5 porra+dificultad→Tasks 3,6,7,14; §5.1 factor→Tasks 3,6; §6 retos 1v1→Tasks 5,6,15; §7 clasificación→Task 16; §8 identidad→Task 13; §9 integridad (funciones atómicas)→Tasks 4–6; §11 config→Task 1.
- **Zero-sum de retos** verificado numéricamente en Task 7.
- **Idempotencia** de `settle_match` verificada en Task 7.
- **Riesgo conocido:** frescura de openfootball (resultados por commits). Mitigación: cron cada 5 min; plan B football-data.org si se necesita inmediatez (cambia solo la URL/parse en Task 10).
- **Dependencia de fases:** Fase 3 (frontend) necesita Fase 1+2 desplegadas en un proyecto Supabase real para verse con datos. Para desarrollar el frontend antes, usar la `demo.html` (Task 18) o un proyecto Supabase de prueba.
