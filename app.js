"use strict";
/* ============================================================
   Porra del Mundial 2026 — app real (Supabase)
   ============================================================ */

const LS = { pid:"porra.playerId", rec:"porra.recovery" };

let sb=null, me=null;
let players=[], matches=[], challenges=[], takers=[], myPreds={};
let pById={}, gameConfig=null;
let tab="matches", filter="next", channel=null;
let editing=null;   // pronóstico en edición {matchId,a,b}
let creating=null;  // reto en creación
const squadCache={};

/* ---------- utilidades ---------- */
const $ = id => document.getElementById(id);
const fmt = n => Math.round(Number(n)||0).toLocaleString("es-ES");
const ini = s => (s||"?").trim().slice(0,2).toUpperCase();
function esc(s){return String(s==null?"":s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}
function toast(m,big=false){const t=$("toast");t.innerHTML=m;t.classList.toggle("big",big);t.classList.add("show");clearTimeout(t._t);t._t=setTimeout(()=>t.classList.remove("show"),big?3600:2600);}
function show(s){["login","app"].forEach(x=>$("screen-"+x).classList.toggle("hide",x!==s));}
function genCode(){const c="ABCDEFGHJKLMNPQRSTUVWXYZ23456789";let r="";for(let i=0;i<6;i++)r+=c[Math.floor(Math.random()*c.length)];return "PM-"+r;}

const FLAG = {
  "Mexico":"🇲🇽","South Africa":"🇿🇦","South Korea":"🇰🇷","Czech Republic":"🇨🇿","Canada":"🇨🇦",
  "Bosnia & Herzegovina":"🇧🇦","Qatar":"🇶🇦","Switzerland":"🇨🇭","Brazil":"🇧🇷","Haiti":"🇭🇹",
  "Morocco":"🇲🇦","Scotland":"🏴","Australia":"🇦🇺","Paraguay":"🇵🇾","Turkey":"🇹🇷","USA":"🇺🇸",
  "Curaçao":"🇨🇼","Ecuador":"🇪🇨","Germany":"🇩🇪","Ivory Coast":"🇨🇮","Japan":"🇯🇵","Netherlands":"🇳🇱",
  "Sweden":"🇸🇪","Tunisia":"🇹🇳","Belgium":"🇧🇪","Egypt":"🇪🇬","Iran":"🇮🇷","New Zealand":"🇳🇿",
  "Cape Verde":"🇨🇻","Saudi Arabia":"🇸🇦","Spain":"🇪🇸","Uruguay":"🇺🇾","France":"🇫🇷","Iraq":"🇮🇶",
  "Norway":"🇳🇴","Senegal":"🇸🇳","Algeria":"🇩🇿","Argentina":"🇦🇷","Austria":"🇦🇹","Jordan":"🇯🇴",
  "Colombia":"🇨🇴","DR Congo":"🇨🇩","Portugal":"🇵🇹","Uzbekistan":"🇺🇿","Croatia":"🇭🇷","England":"🏴",
  "Ghana":"🇬🇭","Panama":"🇵🇦"
};
const flag = t => FLAG[t] || "🏳️";
const STAGE = {grupos:"Grupos",dieciseisavos:"Dieciseisavos",octavos:"Octavos",cuartos:"Cuartos",semis:"Semis",tercer_puesto:"3er puesto",final:"Final"};
const MK_LABEL = {"1x2":"Resultado","ou":"Más/Menos","btts":"Ambos marcan","oddeven":"Par/Impar","exact":"Marcador exacto","scorer":"Goleador"};
function selName(m, mk, sel, line){
  switch(mk){
    case "1x2":  return sel==="1"?"Gana "+m.team_a : sel==="X"?"Empate" : "Gana "+m.team_b;
    case "ou":   return (sel==="over"?"Más de ":"Menos de ")+line;
    case "btts": return sel==="si"?"Ambos marcan":"No marcan los dos";
    case "oddeven": return sel==="par"?"Goles par":"Goles impar";
    case "exact": return "Será "+sel;
    case "scorer": return "Marca "+sel;
    default: return sel;
  }
}

/* ---------- dificultad ---------- */
const factor = p => p>=0.5?1 : p>=0.3?1.5 : 3;
const dclass = p => p>=0.5?"fav" : p>=0.3?"even":"surprise";
const dlabel = p => p>=0.5?"Favorito" : p>=0.3?"Igualado":"Sorpresa";

/* ============================================================
   ARRANQUE / IDENTIDAD
   ============================================================ */
function initClient(){
  const cfg = window.PORRA_CONFIG||{};
  if(!cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY || !window.supabase) return false;
  sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {realtime:{params:{eventsPerSecond:5}}});
  return true;
}
async function boot(){
  if(!initClient()){ document.body.innerHTML="<p style='padding:30px;text-align:center'>Falta configurar Supabase en config.js</p>"; return; }
  const pid = localStorage.getItem(LS.pid);
  if(pid){
    const {data} = await sb.from("players").select().eq("id",pid).maybeSingle();
    if(data){ me=data; await afterLogin(); return; }
  }
  show("login");
}
async function doLogin(){
  const name=$("loginName").value.trim(); if(!name) return toast("Escribe tu nombre",true);
  const rec=genCode();
  const {data,error}=await sb.rpc("upsert_player",{p_name:name,p_recovery:rec});
  if(error) return toast("Error: "+error.message,true);
  me=data; localStorage.setItem(LS.pid,me.id); localStorage.setItem(LS.rec,me.recovery_code);
  await afterLogin(); toast("¡Hola, "+esc(me.name)+"! Tu código: <b>"+me.recovery_code+"</b>",true);
}
async function doRecover(){
  const rec=$("recoverCode").value.trim().toUpperCase(); if(!rec) return toast("Pega tu código",true);
  const {data}=await sb.from("players").select().eq("recovery_code",rec).maybeSingle();
  if(!data) return toast("Código no válido",true);
  me=data; localStorage.setItem(LS.pid,me.id); localStorage.setItem(LS.rec,me.recovery_code);
  await afterLogin(); toast("Cuenta recuperada 👋");
}
async function afterLogin(){ await refresh(); subscribe(); route(); }
function route(){ if(!me) return; show("app"); render(); }
function renderPreBanner(){
  const pb=$("preBanner"); if(!pb) return;
  if(gameConfig && !gameConfig.started){
    const isAdmin = gameConfig.admin_id===me.id;
    const adm = pById[gameConfig.admin_id];
    pb.style.display="";
    pb.innerHTML = `🚧 <b>Porra en preparación</b> · ${players.length} dentro. Ya puedes pronosticar y retar; <b>se resuelve cuando el organizador pulse Comenzar</b>.`
      + (isAdmin
        ? `<div style="margin-top:8px"><button class="btn gold sm" style="width:auto" onclick="startGame()">🚀 Comenzar la porra</button></div>`
        : `<div class="small" style="margin-top:6px">Esperando a <b>${esc(adm?adm.name:"el organizador")}</b>…</div>`);
  } else pb.style.display="none";
}
async function startGame(){
  if(!confirm("¿Comenzar la porra? Las apuestas pasan a contar y se resolverán los partidos que vayan acabando.")) return;
  const {error}=await sb.rpc("start_game",{p_player:me.id});
  if(error) return toast("Error: "+error.message,true);
  await refresh(); toast("¡Porra en marcha! 🚀",true);
}

/* ============================================================
   DATOS + REALTIME
   ============================================================ */
async function refresh(){
  const [rcfg,rp,rm,rc,rt,rpr] = await Promise.all([
    sb.from("config").select().maybeSingle(),
    sb.from("players").select(),
    sb.from("matches").select().order("kickoff",{ascending:true}),
    sb.from("challenges").select(),
    sb.from("challenge_takers").select(),
    sb.from("predictions").select().eq("player_id", me.id),
  ]);
  gameConfig=rcfg.data||gameConfig;
  players=rp.data||[]; matches=rm.data||[]; challenges=rc.data||[]; takers=rt.data||[];
  pById={}; players.forEach(p=>pById[p.id]=p);
  myPreds={}; (rpr.data||[]).forEach(p=>myPreds[p.match_id]=p);
  if(me && pById[me.id]) me=pById[me.id];
  route();
}
let refreshT=null;
function subscribe(){
  if(channel){ sb.removeChannel(channel); channel=null; }
  channel=sb.channel("porra");
  ["config","players","matches","predictions","challenges","challenge_takers"].forEach(t=>
    channel.on("postgres_changes",{event:"*",schema:"public",table:t},()=>{ clearTimeout(refreshT); refreshT=setTimeout(refresh,400); }));
  channel.subscribe();
}

/* ============================================================
   RENDER
   ============================================================ */
function render(){
  if(!me) return;
  $("avatar").textContent=ini(me.name);
  $("userName").textContent=me.name;
  $("userPts").textContent=fmt(me.points)+" 🪙";
  renderPreBanner();
  if(tab==="matches") renderMatches(); else renderRank();
}
function setTab(t){ tab=t;
  $("viewMatches").style.display=t==="matches"?"":"none";
  $("viewRank").style.display=t==="rank"?"":"none";
  $("tabMatchesBtn").classList.toggle("on",t==="matches");
  $("tabRankBtn").classList.toggle("on",t==="rank");
  render();
}
function setFilter(f,btn){ filter=f; document.querySelectorAll(".filters button").forEach(b=>b.classList.toggle("on",b===btn)); renderMatches(); }

function renderMatches(){
  let arr=matches.filter(m=>m.teams_known);
  if(filter==="next") arr=arr.filter(m=>m.status==="scheduled");
  else if(filter==="live") arr=arr.filter(m=>m.status==="live");
  else arr=arr.filter(m=>m.status==="finished");
  const el=$("matchList");
  if(!arr.length){ el.innerHTML=`<div class="empty">No hay partidos aquí.</div>`; return; }
  el.innerHTML=arr.map(matchCard).join("");
}
function dchip(name,p,isDraw){ const c=dclass(p),f=factor(p);
  return `<div class="dchip ${c}"><div class="dk">${isDraw?"Empate":esc(name)}</div><div class="dv">×${f}</div><div class="dt">${dlabel(p)}</div></div>`; }

function matchCard(m){
  const pa=Number(m.p_a),pd=Number(m.p_draw),pb=Number(m.p_b);
  const diff = (m.p_a!=null) ? `<div class="diff">${dchip(m.team_a,pa)}${dchip("Empate",pd,true)}${dchip(m.team_b,pb)}</div>` : "";
  let center, body="";
  if(m.status==="finished"){
    center=`<div class="score"><span class="${m.score_a>m.score_b?'g':''}">${m.score_a}</span> - <span class="${m.score_b>m.score_a?'g':''}">${m.score_b}</span></div>`;
    const pr=myPreds[m.id];
    if(pr){
      const exact=pr.pred_a===m.score_a&&pr.pred_b===m.score_b;
      const tag=Number(pr.points)>0?`<span class="tagwin">+${fmt(pr.points)} pts ${exact?"🎯 exacto":"✅ ganador"}</span>`:`<span class="taglose">+0 · fallaste</span>`;
      body=`<div class="mypick">Tu pronóstico <b>${pr.pred_a}-${pr.pred_b}</b> · ${tag}</div>`;
    } else body=`<div class="muted small">No pronosticaste</div>`;
  } else {
    center=`<div class="vs">vs</div>`;
    body=predictionZone(m)+newChallengeSlot(m);
  }
  const ko = m.kickoff ? new Date(m.kickoff).toLocaleString("es-ES",{day:"2-digit",month:"short",hour:"2-digit",minute:"2-digit"}) : "";
  return `<div class="match">
    <div class="mhead"><span class="stage">${STAGE[m.stage]||m.stage}${m.grp?" "+m.grp:""}${ko?" · "+ko:""}</span>
      <span class="state ${m.status}">${m.status==="finished"?"Final":m.status==="live"?"En juego":"Próximo"}</span></div>
    <div class="teams">
      <div class="team"><span class="flag">${flag(m.team_a)}</span><span class="tname">${esc(m.team_a)}</span></div>
      ${center}
      <div class="team"><span class="flag">${flag(m.team_b)}</span><span class="tname">${esc(m.team_b)}</span></div>
    </div>
    ${diff}${body}${challengesFor(m)}
  </div>`;
}

/* ---------- pronóstico ---------- */
function predictionZone(m){
  const pr=myPreds[m.id];
  if(!editing || editing.matchId!==m.id){
    if(pr) return `<div class="mypick">Tu pronóstico: <b>${pr.pred_a}-${pr.pred_b}</b> &nbsp;<button class="acc" style="background:transparent;color:var(--muted);border:1px solid var(--line)" onclick="startEdit('${m.id}')">Cambiar</button></div>`;
    return `<button class="btn gold sm" onclick="startEdit('${m.id}')">🎯 Poner mi marcador</button>`;
  }
  const ea=editing.a,eb=editing.b;
  const out=ea>eb?Number(m.p_a):ea<eb?Number(m.p_b):Number(m.p_draw);
  const f=factor(out);
  return `<div class="predbox">
    <div class="stepper">
      <div class="stcol"><span class="sn">${esc(m.team_a)}</span><div class="stctl"><button onclick="step(-1,'a')">−</button><span class="num">${ea}</span><button onclick="step(1,'a')">+</button></div></div>
      <span class="stdash">–</span>
      <div class="stcol"><span class="sn">${esc(m.team_b)}</span><div class="stctl"><button onclick="step(-1,'b')">−</button><span class="num">${eb}</span><button onclick="step(1,'b')">+</button></div></div>
    </div>
    <div class="preview">Si lo clavas: <b>+${fmt(50*f)}</b> · si solo aciertas quién gana: <b>+${fmt(20*f)}</b><br><span style="opacity:.8">(${dlabel(out)} ×${f})</span></div>
    <div class="row2"><button class="btn ghost sm" onclick="cancelEdit()">Cancelar</button><button class="btn gold sm" onclick="savePred('${m.id}')">Guardar</button></div>
  </div>`;
}
function startEdit(id){ const pr=myPreds[id]; editing={matchId:id,a:pr?pr.pred_a:1,b:pr?pr.pred_b:0}; render(); }
function cancelEdit(){ editing=null; render(); }
function step(d,side){ editing[side]=Math.max(0,editing[side]+d); render(); }
async function savePred(id){
  const {error}=await sb.rpc("place_prediction",{p_match:id,p_player:me.id,p_a:editing.a,p_b:editing.b});
  editing=null;
  if(error) return toast("Error: "+error.message,true);
  await refresh(); toast("Pronóstico guardado 🎯");
}

/* ---------- retos ---------- */
const MARKETS={
  "1x2":{sides:["1","X","2"]}, "ou":{sides:["over","under"],lines:[1.5,2.5,3.5]},
  "btts":{sides:["si","no"]}, "oddeven":{sides:["par","impar"]},
  "exact":{sides:["score"]}, "scorer":{sides:["player"]}
};
function challengesFor(m){
  const list=challenges.filter(c=>c.match_id===m.id && c.status!=="void");
  if(!list.length) return "";
  const started=m.status!=="scheduled";
  return `<div class="duel-h">Retos</div>`+list.map(c=>{
    const L=Math.round(c.stake*(c.odds-1));
    const myT=takers.filter(t=>t.challenge_id===c.id);
    const iAccepted=myT.some(t=>t.player_id===me.id);
    const mine=c.creator_id===me.id;
    const full=c.max_takers>0 && myT.length>=c.max_takers;
    const cupo=`${myT.length}${c.max_takers>0?`/${c.max_takers}`:""}`;
    const names=myT.length?` (${myT.map(t=>t.player_id===me.id?"Tú":(pById[t.player_id]?pById[t.player_id].name:"?")).join(", ")})`:"";
    const cr=pById[c.creator_id];
    let action;
    if(c.status==="resolved"){
      if(mine) action=c.creator_won?`<span class="tagwin">ganaste ×${myT.length}</span>`:`<span class="taglose">perdiste</span>`;
      else if(iAccepted) action=(!c.creator_won)?`<span class="tagwin">ganaste</span>`:`<span class="taglose">perdiste</span>`;
      else action=`<small>resuelto</small>`;
    } else if(mine){ action=`<span class="who2" style="font-size:.72rem;color:var(--muted)">tu reto · ${cupo} rivales</span>`; }
    else if(iAccepted){ action=`<span class="who2" style="font-size:.72rem;color:var(--good)">aceptado ✓</span>`; }
    else if(started){ action=`<small>cerrado</small>`; }
    else if(full){ action=`<small style="color:var(--surprise)">completo</small>`; }
    else { action=`<button class="acc" onclick="accept('${c.id}')">Aceptar · arriesgas ${fmt(L)}</button>`; }
    return `<div class="duel">
      <span class="dinfo"><b>${esc(cr?cr.name:"?")}${mine?" (tú)":""}</b>: ${MK_LABEL[c.market]} · <b>${esc(selName(m,c.market,c.selection,c.line))}</b><br>
        <small>cuota ×${Number(c.odds).toFixed(2)} · rivales ${cupo}${esc(names)}</small></span>
      <span class="pill">${fmt(c.stake)} pts</span>${action}
    </div>`;
  }).join("");
}
function newChallengeSlot(m){
  if(!creating || creating.matchId!==m.id) return `<button class="btn ghost sm" style="margin-top:8px" onclick="startChallenge('${m.id}')">⚔️ Retar a otros (1 vs varios)</button>`;
  const mk=creating.market, conf=MARKETS[mk];
  const marketBtns=Object.keys(MARKETS).map(k=>`<button class="${k===mk?'on':''}" onclick="setMarket('${m.id}','${k}')">${MK_LABEL[k]}</button>`).join("");
  let lineUI=""; if(mk==="ou") lineUI=`<label>Línea de goles</label><div class="seg">${conf.lines.map(L=>`<button class="${L===creating.line?'on':''}" onclick="setLine(${L})">${L}</button>`).join("")}</div>`;
  let selUI;
  if(mk==="exact"){
    selUI=`<label>Tu marcador</label><div class="stepper" style="margin-bottom:0">
      <div class="stcol"><span class="sn">${esc(m.team_a)}</span><div class="stctl"><button onclick="exStep(-1,'a')">−</button><span class="num">${creating.exa}</span><button onclick="exStep(1,'a')">+</button></div></div>
      <span class="stdash">–</span>
      <div class="stcol"><span class="sn">${esc(m.team_b)}</span><div class="stctl"><button onclick="exStep(-1,'b')">−</button><span class="num">${creating.exb}</span><button onclick="exStep(1,'b')">+</button></div></div></div>`;
  } else if(mk==="scorer"){
    const sq=squadCache[m.id]||{a:[],b:[]};
    const opt=l=>l.map(p=>`<option ${p===creating.sel?"selected":""}>${esc(p)}</option>`).join("");
    selUI=`<label>¿Quién marca? (convocatoria)</label><select class="stake scorer-sel" onchange="setScorer(this.value)">
      <optgroup label="${esc(m.team_a)}">${opt(sq.a)}</optgroup><optgroup label="${esc(m.team_b)}">${opt(sq.b)}</optgroup></select>`;
  } else {
    selUI=`<label>Tu apuesta</label><div class="seg">${conf.sides.map(s=>`<button class="${s===creating.sel?'on':''}" onclick="setSel('${s}')">${esc(selName(m,mk,s,creating.line))}</button>`).join("")}</div>`;
  }
  const odds=creating.odds||"…";
  const liab=creating.odds?Math.round(creating.stake*(creating.odds-1)):0;
  return `<div class="cform">
    <label>Tipo de reto</label><div class="seg">${marketBtns}</div>
    ${lineUI}${selUI}
    <label>Cuota (sugerida; editable)</label><input class="stake" type="number" step="0.01" min="1.01" value="${creating.odds||""}" oninput="setOdds(this.value)">
    <label>Puntos que te juegas</label><input class="stake" type="number" min="1" value="${creating.stake}" oninput="setStake(this.value)">
    <label>¿Cuántos pueden aceptar?</label><div class="seg">${[1,2,3,5,0].map(n=>`<button class="${n===creating.max?'on':''}" onclick="setMax(${n})">${n===0?"∞":n}</button>`).join("")}</div>
    <div class="cmeta">Cuota <b>×${typeof odds==="number"?odds.toFixed(2):odds}</b> · ganas <b>+${fmt(liab)}</b> por cada rival que pierda contra ti · arriesgas <b>${fmt(creating.stake)}</b> por cada uno${creating.max?` · máx ${creating.max}`:" · sin límite"}</div>
    <div class="row2"><button class="btn ghost sm" onclick="cancelChallenge()">Cancelar</button><button class="btn gold sm" onclick="postChallenge('${m.id}')">Publicar reto</button></div>
  </div>`;
}
async function startChallenge(id){
  creating={matchId:id,market:"1x2",sel:"1",line:2.5,exa:1,exb:0,stake:50,max:3,odds:null};
  await loadSquads(id); await refreshOdds(); render();
}
function cancelChallenge(){ creating=null; render(); }
async function loadSquads(matchId){
  if(squadCache[matchId]) return;
  const m=matches.find(x=>x.id===matchId); if(!m) return;
  const {data}=await sb.from("team_squads").select("team,player").in("team",[m.team_a,m.team_b]);
  const a=(data||[]).filter(r=>r.team===m.team_a).map(r=>r.player);
  const b=(data||[]).filter(r=>r.team===m.team_b).map(r=>r.player);
  squadCache[matchId]={a,b};
}
function curSel(){ return creating.market==="exact"?`${creating.exa}-${creating.exb}`:creating.sel; }
async function refreshOdds(){
  const c=creating; if(!c) return;
  const {data,error}=await sb.rpc("suggest_odds",{p_match:c.matchId,p_market:c.market,p_selection:curSel(),p_line:c.market==="ou"?c.line:null});
  if(!error && data) c.odds=Number(data);
  render();
}
async function setMarket(id,mk){ creating.market=mk;
  if(mk==="scorer"){ await loadSquads(id); creating.sel=(squadCache[id].a[0]||squadCache[id].b[0]||""); }
  else if(mk!=="exact") creating.sel=MARKETS[mk].sides[0];
  await refreshOdds();
}
async function setSel(s){ creating.sel=s; await refreshOdds(); }
async function setLine(L){ creating.line=L; await refreshOdds(); }
async function setScorer(n){ creating.sel=n; await refreshOdds(); }
async function exStep(d,side){ const k=side==="a"?"exa":"exb"; creating[k]=Math.max(0,creating[k]+d); await refreshOdds(); }
function setStake(v){ creating.stake=Math.max(1,Math.floor(+v||1)); }
function setOdds(v){ creating.odds=Math.max(1.01,Number(v)||1.01); }
function setMax(n){ creating.max=n; render(); }
async function postChallenge(id){
  const c=creating;
  if(!(c.odds>1)) return toast("Cuota no válida",true);
  if(c.stake>me.points) return toast("No tienes tantos puntos",true);
  const {error}=await sb.rpc("create_challenge",{p_match:id,p_creator:me.id,p_market:c.market,p_line:c.market==="ou"?c.line:null,p_selection:curSel(),p_odds:c.odds,p_stake:c.stake,p_max:c.max});
  creating=null;
  if(error) return toast("Error: "+error.message,true);
  await refresh(); toast("Reto publicado ⚔️ — ya pueden aceptarlo");
}
async function accept(id){
  const {error}=await sb.rpc("accept_challenge",{p_challenge:id,p_taker:me.id});
  if(error) return toast("Error: "+error.message,true);
  await refresh(); toast("Reto aceptado ⚔️");
}

/* ---------- clasificación ---------- */
function renderRank(){
  const sorted=[...players].sort((a,b)=>Number(b.points)-Number(a.points));
  $("viewRank").innerHTML=sorted.map((p,i)=>`<div class="lb ${p.id===me.id?'me':''}">
    <span class="pos">${i===0?"🥇":i===1?"🥈":i===2?"🥉":i+1}</span>
    <span class="av">${ini(p.name)}</span>
    <span class="nm">${esc(p.name)}${p.id===me.id?' <small>tú</small>':''}</span>
    <span class="pts">${fmt(p.points)} pts</span></div>`).join("")
    || `<div class="empty">Aún no hay jugadores.</div>`;
}

/* ---------- código de recuperación ---------- */
function showMyCode(){ const c=localStorage.getItem(LS.rec); if(c){ navigator.clipboard?.writeText(c); toast("Tu código: <b>"+c+"</b> (copiado). Guárdalo para entrar desde otro móvil.",true); } }

/* ---------- wiring ---------- */
function wire(){
  $("loginBtn").addEventListener("click",doLogin);
  $("loginName").addEventListener("keydown",e=>{if(e.key==="Enter")doLogin();});
  $("recoverBtn").addEventListener("click",doRecover);
  $("myCodeBtn").addEventListener("click",showMyCode);
  $("tabMatchesBtn").addEventListener("click",()=>setTab("matches"));
  $("tabRankBtn").addEventListener("click",()=>setTab("rank"));
  document.querySelectorAll(".filters button").forEach(b=>b.addEventListener("click",()=>setFilter(b.dataset.f,b)));
  Object.assign(window,{startEdit,cancelEdit,step,savePred,startChallenge,cancelChallenge,setMarket,setSel,setLine,setScorer,exStep,setStake,setOdds,setMax,postChallenge,accept,startGame});
}
document.addEventListener("DOMContentLoaded",()=>{ wire(); boot(); });
