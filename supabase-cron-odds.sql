-- ============================================================
--  Cuotas reales (The Odds API) -> cache en matches.odds
--  Patrón de 2 tics (igual que cron_sync). Key en app_secrets (privada).
--  La key NO va en este archivo; se inserta por separado.
-- ============================================================
create extension if not exists pg_net;
create extension if not exists pg_cron;

create table if not exists app_secrets (name text primary key, value text not null);
alter table app_secrets enable row level security;   -- sin políticas: anon NO accede
create table if not exists cron_state (name text primary key, req_id bigint);

create or replace function odds_norm(s text) returns text language sql immutable as $$
  select case s
    when 'United States' then 'USA'
    when 'Korea Republic' then 'South Korea'
    when 'Türkiye' then 'Turkey'
    when 'Czechia' then 'Czech Republic'
    when 'Côte d''Ivoire' then 'Ivory Coast'
    when 'Cabo Verde' then 'Cape Verde'
    else s end;
$$;

create or replace function fetch_odds()
returns void language plpgsql security definer as $$
declare key text; body jsonb; last bigint; newid bigint; ev jsonb; home text; away text; mt matches%rowtype;
  bk jsonb; h2h jsonb; tot jsonb; swap boolean; v_odds jsonb; hmap jsonb; pt text; over_p numeric; under_p numeric; ou jsonb;
  o1 numeric; ox numeric; o2 numeric; s numeric;
begin
  -- 1) procesar respuesta del tic anterior
  select req_id into last from cron_state where name='odds';
  if last is not null then
    select content::jsonb into body from net._http_response where id=last and status_code=200;
  end if;
  if body is not null then
    for ev in select jsonb_array_elements(body) loop
      home := odds_norm(ev->>'home_team'); away := odds_norm(ev->>'away_team');
      select * into mt from matches where status='scheduled'
        and ((team_a=home and team_b=away) or (team_a=away and team_b=home)) limit 1;
      if not found then continue; end if;
      swap := (mt.team_a <> home);
      bk := ev->'bookmakers'->0; if bk is null then continue; end if;
      v_odds := '{}'::jsonb;
      select value into h2h from jsonb_array_elements(bk->'markets') where value->>'key'='h2h' limit 1;
      if h2h is not null then
        select jsonb_object_agg(value->>'name',(value->>'price')::numeric) into hmap from jsonb_array_elements(h2h->'outcomes');
        v_odds := v_odds || jsonb_build_object('1x2', jsonb_build_object(
          '1', hmap->(case when swap then away else home end),
          'X', hmap->'Draw',
          '2', hmap->(case when swap then home else away end)));
      end if;
      select value into tot from jsonb_array_elements(bk->'markets') where value->>'key'='totals' limit 1;
      if tot is not null then
        ou := '{}'::jsonb;
        for pt in select distinct value->>'point' from jsonb_array_elements(tot->'outcomes') loop
          select (value->>'price')::numeric into over_p from jsonb_array_elements(tot->'outcomes') where value->>'name'='Over' and value->>'point'=pt limit 1;
          select (value->>'price')::numeric into under_p from jsonb_array_elements(tot->'outcomes') where value->>'name'='Under' and value->>'point'=pt limit 1;
          ou := ou || jsonb_build_object(pt, jsonb_build_object('over',over_p,'under',under_p));
        end loop;
        v_odds := v_odds || jsonb_build_object('ou', ou);
      end if;
      if v_odds <> '{}'::jsonb then
        -- coordinar la dificultad de la PORRA con las casas: probabilidades implícitas del 1X2 (quitando el margen)
        o1 := (v_odds#>>'{1x2,1}')::numeric; ox := (v_odds#>>'{1x2,X}')::numeric; o2 := (v_odds#>>'{1x2,2}')::numeric;
        if o1>0 and ox>0 and o2>0 then
          s := 1/o1 + 1/ox + 1/o2;
          update matches set odds=v_odds, p_a=(1/o1)/s, p_draw=(1/ox)/s, p_b=(1/o2)/s where id=mt.id;
        else
          update matches set odds=v_odds where id=mt.id;
        end if;
      end if;
    end loop;
  end if;
  -- 2) disparar la siguiente descarga
  select value into key from app_secrets where name='odds_api_key';
  if key is not null then
    newid := net.http_get('https://api.the-odds-api.com/v4/sports/soccer_fifa_world_cup/odds/?apiKey='||key||'&regions=eu&markets=h2h,totals&oddsFormat=decimal');
    insert into cron_state(name,req_id) values('odds',newid) on conflict(name) do update set req_id=excluded.req_id;
  end if;
  delete from net._http_response where created < now() - interval '2 hours';
end; $$;

select cron.unschedule(jobid) from cron.job where jobname='porra-odds';
select cron.schedule('porra-odds','0 */6 * * *', 'select fetch_odds()');
