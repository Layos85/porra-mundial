-- Test de lógica (porra sorpresa + reto multi-taker + idempotencia).
-- Flujo real: partido PROGRAMADO -> pronosticar/retar -> finalizar -> liquidar.
-- Ejecutar en un proyecto de PRUEBA. Limpia al final.
do $$
declare m_id uuid; pa uuid; pb uuid; pc uuid; ch uuid; bal numeric; pts numeric; begin
  pa:=(upsert_player('A','T-A')).id; pb:=(upsert_player('B','T-B')).id; pc:=(upsert_player('C','T-C')).id;
  insert into matches(ext_id,stage,team_a,team_b,teams_known,kickoff,status,p_a,p_draw,p_b)
  select 'T1','grupos','Debil','Fuerte',true,now()+interval '2h','scheduled',pr.p_a,pr.p_draw,pr.p_b
  from calc_probs(1700,2070) pr returning id into m_id;
  perform place_prediction(m_id,pa,2,1); perform place_prediction(m_id,pb,3,1); perform place_prediction(m_id,pc,0,2);
  ch:=(create_challenge(m_id,pa,'1x2',null,'1',3.0,100,0)).id;
  perform accept_challenge(ch,pb); perform accept_challenge(ch,pc);
  select points into bal from players where id=pa; assert bal=800,'reserva A='||bal;
  update matches set status='finished', score_a=2, score_b=1, kickoff=now()-interval '1h' where id=m_id;
  perform settle_match(m_id);
  select points into pts from predictions where match_id=m_id and player_id=pa; assert pts=150,'porra A='||pts;
  select points into pts from predictions where match_id=m_id and player_id=pb; assert pts=60,'porra B='||pts;
  select points into bal from players where id=pa; assert bal=1550,'A final='||bal;
  select points into bal from players where id=pb; assert bal=860,'B final='||bal;
  select points into bal from players where id=pc; assert bal=800,'C final='||bal;
  perform settle_match(m_id);
  select points into bal from players where id=pa; assert bal=1550,'idempotente A';
  delete from matches where ext_id='T1'; delete from players where recovery_code in ('T-A','T-B','T-C');
  raise notice 'OK: todos los asserts pasaron';
end $$;
