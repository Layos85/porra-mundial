-- ============================================================
--  Automatización dentro de Supabase (pg_cron + pg_net)
--  Trae calendario/resultados de openfootball, hace upsert y liquida.
--  Cada 15 min, sin servicios externos.
-- ============================================================
create extension if not exists pg_net;
create extension if not exists pg_cron;

-- Procesa el JSON de openfootball: upsert de partidos + void + liquidación.
create or replace function sync_from_json(payload jsonb)
returns integer language plpgsql security definer as $$
declare m jsonb; n int:=0; v_ext text; v_stage text; v_grp text; v_a text; v_b text;
  v_kick timestamptz; v_status text; v_sa int; v_sb int; v_scorers jsonb;
  v_tm text[]; v_off text[]; iso text; r text; mid uuid;
begin
  for m in select jsonb_array_elements(payload->'matches') loop
    v_a := m->>'team1'; v_b := m->>'team2';
    if v_a is null or v_b is null or (m->>'date') is null then continue; end if;
    if (m->>'num') is not null then v_ext := 'n'||(m->>'num'); else v_ext := (m->>'date')||'__'||(m->>'ground'); end if;
    r := lower(coalesce(m->>'round',''));
    v_stage := case when r like 'matchday%' then 'grupos'
      when r like '%round of 32%' then 'dieciseisavos' when r like '%round of 16%' then 'octavos'
      when r like '%quarter%' then 'cuartos' when r like '%semi%' then 'semis'
      when r like '%third%' then 'tercer_puesto' when r like '%final%' then 'final' else 'grupos' end;
    v_grp := (regexp_match(coalesce(m->>'group',''),'Group ([A-L])'))[1];
    v_tm := regexp_match(coalesce(m->>'time',''),'(\d{1,2}):(\d{2})');
    v_off := regexp_match(coalesce(m->>'time',''),'UTC([+-]\d{1,2})');
    if v_tm is null then iso := (m->>'date')||'T00:00:00Z';
    else iso := (m->>'date')||'T'||lpad(v_tm[1],2,'0')||':'||v_tm[2]||':00'||
      case when v_off is null then 'Z' else (case when v_off[1] like '-%' then '-' else '+' end)||lpad(ltrim(v_off[1],'+-'),2,'0')||':00' end;
    end if;
    begin v_kick := iso::timestamptz; exception when others then v_kick := null; end;
    if (m->'score'->'ft') is not null then
      v_sa := (m->'score'->'ft'->>0)::int; v_sb := (m->'score'->'ft'->>1)::int; v_status := 'finished';
    else v_sa := null; v_sb := null; v_status := case when v_kick is not null and now()>=v_kick then 'live' else 'scheduled' end; end if;
    v_scorers := coalesce((select jsonb_agg(g->>'name')
        from jsonb_array_elements(coalesce(m->'goals1','[]'::jsonb)||coalesce(m->'goals2','[]'::jsonb)) g),'[]'::jsonb);
    perform upsert_match(v_ext,v_stage,v_grp,v_a,v_b,v_kick,v_status,v_sa,v_sb,v_scorers);
    n := n+1;
  end loop;
  perform void_started_open_challenges();
  for mid in select id from matches where status='finished' and settled=false loop
    perform settle_match(mid);
  end loop;
  return n;
end; $$;

-- Tic del cron: descarga + procesa + limpia respuestas viejas.
create or replace function cron_sync()
returns void language plpgsql security definer as $$
declare rid bigint; body jsonb;
begin
  rid := net.http_get('https://raw.githubusercontent.com/openfootball/worldcup.json/master/2026/worldcup.json');
  perform pg_sleep(5);
  select content::jsonb into body from net._http_response where id=rid and status_code=200;
  if body is not null then perform sync_from_json(body); end if;
  delete from net._http_response where created < now() - interval '1 hour';
end; $$;

-- Programar cada 15 min (idempotente).
select cron.unschedule(jobid) from cron.job where jobname='porra-sync';
select cron.schedule('porra-sync','*/15 * * * *', 'select cron_sync()');
