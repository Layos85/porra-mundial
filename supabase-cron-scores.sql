-- ============================================================
--  Marcadores EN VIVO (The Odds API /scores) -> matches.score_*
--  Patrón de 2 tics. Solo llama a la API si hay algún partido en juego
--  (ahorra créditos). Los finales los sigue fijando openfootball.
-- ============================================================
create extension if not exists pg_net;
create extension if not exists pg_cron;

create or replace function fetch_scores()
returns void language plpgsql security definer as $$
declare key text; body jsonb; last bigint; newid bigint; ev jsonb; home text; away text;
  mt matches%rowtype; s_home text; s_away text; nlive int;
begin
  -- 1) procesar respuesta del tic anterior
  select req_id into last from cron_state where name='scores';
  if last is not null then
    select content::jsonb into body from net._http_response where id=last and status_code=200;
  end if;
  if body is not null then
    for ev in select jsonb_array_elements(body) loop
      if coalesce(ev->>'completed','false')='true' then continue; end if;          -- finales -> openfootball
      if ev->'scores' is null or jsonb_typeof(ev->'scores')<>'array' then continue; end if;
      home := odds_norm(ev->>'home_team'); away := odds_norm(ev->>'away_team');
      select * into mt from matches
        where ((team_a=home and team_b=away) or (team_a=away and team_b=home))
          and not settled and status<>'finished' limit 1;
      if not found then continue; end if;
      s_home := (select sc->>'score' from jsonb_array_elements(ev->'scores') sc where odds_norm(sc->>'name')=home limit 1);
      s_away := (select sc->>'score' from jsonb_array_elements(ev->'scores') sc where odds_norm(sc->>'name')=away limit 1);
      if s_home is null or s_away is null then continue; end if;
      update matches set status='live',
        score_a=(case when mt.team_a=home then s_home else s_away end)::int,
        score_b=(case when mt.team_b=home then s_home else s_away end)::int
      where id=mt.id;
    end loop;
  end if;

  -- 2) si hay partidos en juego, pedir marcadores (si no, no gastar créditos)
  select count(*) into nlive from matches
    where status='live' or (status='scheduled' and kickoff is not null and now() between kickoff and kickoff + interval '150 minutes');
  select value into key from app_secrets where name='odds_api_key';
  if key is not null and nlive>0 then
    newid := net.http_get('https://api.the-odds-api.com/v4/sports/soccer_fifa_world_cup/scores/?apiKey='||key);
    insert into cron_state(name,req_id) values('scores',newid) on conflict(name) do update set req_id=excluded.req_id;
  end if;
  delete from net._http_response where created < now() - interval '1 hour';
end; $$;

select cron.unschedule(jobid) from cron.job where jobname='porra-scores';
select cron.schedule('porra-scores','*/10 * * * *', 'select fetch_scores()');
