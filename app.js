"use strict";
/* ============================================================
   Porra del Mundial — multijugador online con Supabase
   ============================================================ */

const CATEGORIES = [
  {id:"resultado", label:"🥅 Resultado (1X2)", opts:["Gana local","Empate","Gana visitante"]},
  {id:"marcador",  label:"🔢 Marcador exacto", opts:["1-0","2-1","0-0"]},
  {id:"goleador",  label:"⚽ Goleador",         opts:[]},
  {id:"sino",      label:"🔀 Sí / No",          opts:["Sí","No"]},
  {id:"especial",  label:"✨ Especial",          opts:[]},
];

const LS = {
  url:  "porra.cfg.url",
  key:  "porra.cfg.key",
  pool: "porra.poolCode",
  player: code => "porra.player." + code,
};

let sb = null;                 // cliente supabase
let pool = null;               // {id, code, name, starting_balance}
let players = [], bets = [], wagers = [];
let myId = null;               // id de jugador en este dispositivo
let channel = null;
let activeTab = "bets", betFilter = "open", createCat = "resultado", createKind = "match";

/* ---------- utilidades ---------- */
const $  = id => document.getElementById(id);
const uid = () => Math.random().toString(36).slice(2,9);
const fmt = n => Math.round(Number(n)||0).toLocaleString("es-ES");
const byId = id => players.find(p=>p.id===id);
const initials = name => (name||"?").trim().slice(0,2).toUpperCase();
const me = () => byId(myId);
function escapeHtml(s){ return String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
function toast(msg, bad=false){
  const t = $("toast");
  t.textContent = msg; t.classList.toggle("bad", bad); t.classList.add("show");
  clearTimeout(t._t); t._t = setTimeout(()=>t.classList.remove("show"), 2600);
}
function show(screen){
  ["setup","lobby","pickplayer","app"].forEach(s=> $("screen-"+s).classList.toggle("hide", s!==screen));
}

/* ============================================================
   CONFIG / CLIENTE
   ============================================================ */
function getConfig(){
  const url = localStorage.getItem(LS.url) || (window.PORRA_CONFIG && window.PORRA_CONFIG.SUPABASE_URL) || "";
  const key = localStorage.getItem(LS.key) || (window.PORRA_CONFIG && window.PORRA_CONFIG.SUPABASE_ANON_KEY) || "";
  return {url:url.trim(), key:key.trim()};
}
function initClient(){
  const {url,key} = getConfig();
  if(!url || !key) return false;
  if(!window.supabase){ toast("No se pudo cargar Supabase", true); return false; }
  sb = window.supabase.createClient(url, key, { realtime:{ params:{ eventsPerSecond:5 } } });
  return true;
}

/* ============================================================
   ARRANQUE
   ============================================================ */
async function boot(){
  if(!initClient()){ show("setup"); return; }
  const code = localStorage.getItem(LS.pool);
  if(code){
    const ok = await enterPool(code, /*silent*/true);
    if(ok) return;
  }
  show("lobby");
}

/* ============================================================
   POOLS (porras)
   ============================================================ */
function randomCode(){
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let c=""; for(let i=0;i<5;i++) c+=chars[Math.floor(Math.random()*chars.length)];
  return c;
}

async function createPool(){
  const name = $("lobbyName").value.trim() || "Porra del Mundial 2026";
  const start = Math.max(1, Math.floor(Number($("lobbyStart").value)||1000));
  const myName = $("lobbyMyName").value.trim();
  if(!myName) return toast("Escribe tu nombre", true);

  let code, inserted=null;
  for(let attempt=0; attempt<5 && !inserted; attempt++){
    code = randomCode();
    const {data,error} = await sb.from("pools")
      .insert({code, name, starting_balance:start}).select().single();
    if(!error){ inserted = data; break; }
    if(error.code !== "23505") return toast("Error al crear la porra: "+error.message, true);
  }
  if(!inserted) return toast("No se pudo generar un código, reinténtalo", true);

  pool = inserted;
  const {data:player,error:e2} = await sb.from("players")
    .insert({pool_id:pool.id, name:myName, balance:start}).select().single();
  if(e2) return toast("Error al crear tu jugador: "+e2.message, true);

  myId = player.id;
  localStorage.setItem(LS.pool, pool.code);
  localStorage.setItem(LS.player(pool.code), myId);
  await afterEnter();
  toast(`Porra creada · código ${pool.code} 🎉`);
}

async function joinPoolFromInput(){
  const code = ($("joinCode").value||"").trim().toUpperCase();
  if(!code) return toast("Escribe el código de la porra", true);
  await enterPool(code);
}

async function enterPool(code, silent=false){
  code = code.trim().toUpperCase();
  const {data,error} = await sb.from("pools").select().eq("code", code).maybeSingle();
  if(error){ if(!silent) toast("Error: "+error.message, true); return false; }
  if(!data){ if(!silent) toast("No existe ninguna porra con ese código", true); return false; }
  pool = data;
  localStorage.setItem(LS.pool, pool.code);
  myId = localStorage.getItem(LS.player(pool.code)) || null;
  await afterEnter();
  return true;
}

async function afterEnter(){
  await refresh();
  // si el jugador guardado ya no existe, pedir identidad
  if(myId && !byId(myId)){ myId = null; localStorage.removeItem(LS.player(pool.code)); }
  subscribe();
  if(!myId){ renderPickPlayer(); show("pickplayer"); }
  else { renderApp(); show("app"); }
}

function leavePool(){
  if(channel){ sb.removeChannel(channel); channel=null; }
  localStorage.removeItem(LS.pool);
  pool=null; myId=null; players=[]; bets=[]; wagers=[];
  show("lobby");
  $("joinCode").value=""; $("lobbyName").value=""; $("lobbyMyName").value="";
}

/* ============================================================
   DATOS + TIEMPO REAL
   ============================================================ */
async function refresh(){
  if(!pool) return;
  const [rp, rb, rw] = await Promise.all([
    sb.from("players").select().eq("pool_id", pool.id),
    sb.from("bets").select().eq("pool_id", pool.id).order("created_at",{ascending:true}),
    sb.from("wagers").select().eq("pool_id", pool.id),
  ]);
  players = rp.data || [];
  bets    = rb.data || [];
  wagers  = rw.data || [];
  if(!$("screen-app").classList.contains("hide")) renderApp();
  if(!$("screen-pickplayer").classList.contains("hide")) renderPickPlayer();
}

function subscribe(){
  if(channel){ sb.removeChannel(channel); channel=null; }
  channel = sb.channel("pool-"+pool.id);
  ["players","bets","wagers"].forEach(table=>{
    channel.on("postgres_changes",
      {event:"*", schema:"public", table, filter:"pool_id=eq."+pool.id},
      ()=>refresh());
  });
  channel.subscribe();
}

/* ============================================================
   RENDER — pantalla de identidad
   ============================================================ */
function renderPickPlayer(){
  $("ppPoolName").textContent = pool.name;
  $("ppPoolCode").textContent = pool.code;
  const list = $("ppList");
  if(players.length===0){
    list.innerHTML = `<p class="muted small">Aún no hay nadie. Crea tu jugador abajo 👇</p>`;
  }else{
    list.innerHTML = players.map(p=>`
      <div class="ppl-item">
        <div class="avatar" style="width:34px;height:34px;font-size:.85rem">${initials(p.name)}</div>
        <div class="nm">${escapeHtml(p.name)}<small>${fmt(p.balance)} 🪙</small></div>
        <button class="btn ghost sm" onclick="claimPlayer('${p.id}')">Soy yo</button>
      </div>`).join("");
  }
}
async function claimPlayer(id){
  myId = id; localStorage.setItem(LS.player(pool.code), id);
  renderApp(); show("app"); toast("Hola de nuevo, "+byId(id).name+" 👋");
}
async function createPlayer(){
  const name = $("ppNewName").value.trim();
  if(!name) return toast("Escribe tu nombre", true);
  const {data,error} = await sb.from("players")
    .insert({pool_id:pool.id, name, balance:pool.starting_balance}).select().single();
  if(error) return toast("Error: "+error.message, true);
  myId = data.id; localStorage.setItem(LS.player(pool.code), myId);
  await refresh(); renderApp(); show("app");
  toast(`¡Bienvenido a la porra, ${name}! 🎉`);
}

/* ============================================================
   RENDER — app principal
   ============================================================ */
function renderApp(){
  $("poolTitle").textContent = pool.name;
  $("poolCodeTag").textContent = "código " + pool.code;
  renderTopbar();
  renderBets();
  renderLeaderboard();
  renderPeople();
  renderCatPills();
}

function renderTopbar(){
  const u = me();
  $("avatar").textContent = u ? initials(u.name) : "?";
  $("userName").textContent = u ? u.name : "—";
  $("userBal").textContent = u ? fmt(u.balance) : "0";
}

function renderBets(){
  const list = $("betList");
  let arr = [...bets].reverse();
  if(betFilter==="open")     arr = arr.filter(b=>b.status==="open");
  if(betFilter==="resolved") arr = arr.filter(b=>b.status==="resolved");
  if(betFilter==="mine")     arr = arr.filter(b=>b.creator_id===myId);
  if(arr.length===0){
    list.innerHTML = emptyState("🎲","No hay apuestas aquí","Crea la primera en la pestaña <b>Crear</b>.");
    return;
  }
  list.innerHTML = arr.map(renderBetCard).join("");
}

function renderBetCard(b){
  return b.kind==="match" ? renderMatchCard(b) : renderFreeCard(b);
}

function cardShell(b, inner, extraChip){
  const creator = byId(b.creator_id);
  const betWagers = wagers.filter(w=>w.bet_id===b.id);
  const totalPot = betWagers.reduce((s,w)=>s+Number(w.amount),0);
  return `<div class="bet">
    <div class="head">
      <span class="chip cat">${extraChip}</span>
      <span class="chip ${b.status}">${b.status==="open"?"Abierta":"Resuelta"}</span>
    </div>
    <h3>${escapeHtml(b.question)}</h3>
    <div class="by">Creada por <b>${escapeHtml(creator?creator.name:"?")}</b> · bote ${fmt(totalPot)} 🪙</div>
    ${inner}
  </div>`;
}

/* ---- Pronóstico de partido (marcador escalonado) ---- */
function renderMatchCard(b){
  const myW = wagers.find(w=>w.bet_id===b.id && w.player_id===myId);
  const betWagers = wagers.filter(w=>w.bet_id===b.id);
  const oe = Number(b.odds_exact), ow = Number(b.odds_winner);

  const score = b.status==="resolved"
    ? `<div style="text-align:center; font-size:1.6rem; font-weight:800; margin:6px 0">
         ${escapeHtml(b.team_a)} <span style="color:var(--gold)">${b.real_a} - ${b.real_b}</span> ${escapeHtml(b.team_b)}</div>`
    : `<div style="text-align:center; font-size:1.15rem; font-weight:700; margin:6px 0">
         ${escapeHtml(b.team_a)} <span class="muted">vs</span> ${escapeHtml(b.team_b)}</div>`;

  const tiers = `<div class="tiers">
      <span>🎯 Marcador exacto <b>×${oe.toFixed(2)}</b></span>
      <span>✅ Solo ganador <b>×${ow.toFixed(2)}</b></span>
    </div>`;

  let mine = "";
  if(myW){
    mine = `<div class="mypick">Tu pronóstico: <b>${myW.pred_a}-${myW.pred_b}</b> · ${fmt(myW.amount)} 🪙</div>`;
  }

  let action = "";
  if(b.status==="open"){
    action = `<button class="btn sm" style="width:100%; margin-top:8px" onclick="openMatchWager('${b.id}')">${myW?"✏️ Cambiar mi pronóstico":"🎯 Pronosticar marcador"}</button>`;
  }

  // listado de pronósticos
  let list = "";
  if(betWagers.length){
    list = `<div class="wager-list">${betWagers.map(w=>{
      const p = byId(w.player_id);
      let res="";
      if(b.status==="resolved"){
        if(w.pred_a===b.real_a && w.pred_b===b.real_b) res = ` <b style="color:var(--gold)">🎯 +${fmt(w.amount*oe)}</b>`;
        else if(Math.sign(w.pred_a-w.pred_b)===Math.sign(b.real_a-b.real_b)) res = ` <b style="color:var(--green)">✅ +${fmt(w.amount*ow)}</b>`;
        else res = ` <b style="color:var(--red)">-${fmt(w.amount)}</b>`;
      }
      return `<div class="w"><span><b>${escapeHtml(p?p.name:"?")}</b> → ${w.pred_a}-${w.pred_b}</span><span>${fmt(w.amount)} 🪙${res}</span></div>`;
    }).join("")}</div>`;
  }

  let resolveCtl = "";
  if(b.status==="open"){
    resolveCtl = `<div class="row" style="margin-top:12px; align-items:center">
      <input id="ra-${b.id}" type="number" min="0" placeholder="0" style="text-align:center">
      <span style="flex:none">-</span>
      <input id="rb-${b.id}" type="number" min="0" placeholder="0" style="text-align:center">
      <button class="btn gold sm" style="flex:none" onclick="resolveMatch('${b.id}')">🏁 Resultado</button>
    </div>`;
  }

  return cardShell(b, score+tiers+mine+action+list+resolveCtl, "🆚 Partido");
}

/* ---- Apuesta libre ---- */
function renderFreeCard(b){
  const cat = CATEGORIES.find(c=>c.id===b.category);
  const myW = wagers.find(w=>w.bet_id===b.id && w.player_id===myId);
  const betWagers = wagers.filter(w=>w.bet_id===b.id);

  const opts = b.options.map(o=>{
    const isWin = b.status==="resolved" && b.winning_option_id===o.id;
    const isSel = myW && myW.option_id===o.id;
    const onOpt = betWagers.filter(w=>w.option_id===o.id).reduce((s,w)=>s+Number(w.amount),0);
    const cls = ["opt", isWin?"win":"", isSel?"sel":""].join(" ").trim();
    const action = b.status==="open" ? `onclick="openWager('${b.id}','${o.id}')"` : "";
    return `<div class="${cls}" ${action}>
      <div style="flex:1">
        <div class="lab">${escapeHtml(o.label)} ${isWin?"✅":""} ${isSel?"· <span style='color:var(--green)'>tu apuesta</span>":""}</div>
        <div class="pot">${onOpt>0?fmt(onOpt)+" 🪙 apostado":"sin apuestas"}</div>
      </div>
      <div class="od">${Number(o.odds).toFixed(2)}<small>cuota</small></div>
    </div>`;
  }).join("");

  let wagersHtml = "";
  if(betWagers.length){
    wagersHtml = `<div class="wager-list">${
      betWagers.map(w=>{
        const p = byId(w.player_id); const o = b.options.find(x=>x.id===w.option_id);
        let res = "";
        if(b.status==="resolved" && o){
          const won = w.option_id===b.winning_option_id;
          res = won ? ` <b style="color:var(--green)">+${fmt(Number(w.amount)*Number(o.odds))}</b>`
                    : ` <b style="color:var(--red)">-${fmt(w.amount)}</b>`;
        }
        return `<div class="w"><span><b>${escapeHtml(p?p.name:"?")}</b> → ${escapeHtml(o?o.label:"?")}</span><span>${fmt(w.amount)} 🪙${res}</span></div>`;
      }).join("")
    }</div>`;
  }

  let resolveCtl = "";
  if(b.status==="open"){
    const optionsSel = b.options.map(o=>`<option value="${o.id}">${escapeHtml(o.label)}</option>`).join("");
    resolveCtl = `<div class="row" style="margin-top:12px">
      <select id="rsel-${b.id}">${optionsSel}</select>
      <button class="btn gold sm" style="flex:none" onclick="resolveBet('${b.id}')">🏁 Resolver</button>
    </div>`;
  }

  return cardShell(b, opts+wagersHtml+resolveCtl, cat?cat.label:b.category);
}

function renderLeaderboard(){
  const el = $("leaderboard");
  if(players.length===0){ el.innerHTML = emptyState("📊","Sin jugadores aún",""); return; }
  const sorted = [...players].sort((a,b)=>Number(b.balance)-Number(a.balance));
  el.innerHTML = sorted.map((p,i)=>{
    const open = openExposure(p.id);
    return `<div class="lb">
      <div class="pos">${i===0?"🥇":i===1?"🥈":i===2?"🥉":(i+1)}</div>
      <div class="avatar" style="width:34px;height:34px;font-size:.85rem">${initials(p.name)}</div>
      <div class="nm">${escapeHtml(p.name)}${p.id===myId?' <span class="small" style="color:var(--green)">(tú)</span>':''}<small>${open>0?fmt(open)+" 🪙 en juego":"sin apuestas abiertas"}</small></div>
      <div class="mn">${fmt(p.balance)} 🪙</div>
    </div>`;
  }).join("");
}
function openExposure(playerId){
  const openBetIds = new Set(bets.filter(b=>b.status==="open").map(b=>b.id));
  return wagers.filter(w=>w.player_id===playerId && openBetIds.has(w.bet_id))
               .reduce((s,w)=>s+Number(w.amount),0);
}

function renderPeople(){
  $("infoPoolName").textContent = pool.name;
  $("infoPoolCode").textContent = pool.code;
  const el = $("peopleList");
  el.innerHTML = players.length===0
    ? `<p class="muted small">Nadie todavía.</p>`
    : players.map(p=>`
      <div class="ppl-item">
        <div class="avatar" style="width:34px;height:34px;font-size:.85rem">${initials(p.name)}</div>
        <div class="nm">${escapeHtml(p.name)}<small>${fmt(p.balance)} 🪙${p.id===myId?" · tú":""}</small></div>
      </div>`).join("");
}

function renderCatPills(){
  $("catPills").innerHTML = CATEGORIES.map(c=>
    `<button class="${c.id===createCat?"on":""}" onclick="pickCat('${c.id}')">${c.label}</button>`).join("");
}

function emptyState(icon,title,sub){
  return `<div class="empty"><span class="big">${icon}</span><b>${title}</b><br><span class="small">${sub}</span></div>`;
}

/* ============================================================
   CREAR APUESTA
   ============================================================ */
function pickKind(kind){
  createKind = kind;
  document.querySelectorAll("#kindPills button").forEach(b=> b.classList.toggle("on", b.dataset.kind===kind));
  $("matchFields").classList.toggle("hide", kind!=="match");
  $("freeFields").classList.toggle("hide", kind!=="free");
}
function pickCat(id){
  createCat = id; renderCatPills();
  const cat = CATEGORIES.find(c=>c.id===id);
  buildOptRows(cat.opts.length ? cat.opts.map(l=>({label:l,odds:""})) : [{label:"",odds:""},{label:"",odds:""}]);
}
function buildOptRows(rows){ $("optRows").innerHTML = rows.map(r=>optRowHtml(r.label,r.odds)).join(""); }
function optRowHtml(label="",odds=""){
  return `<div class="optrow">
    <input class="olab" placeholder="Opción" value="${escapeHtml(label)}">
    <input class="ood" type="number" step="0.01" min="1.01" placeholder="cuota" value="${odds}">
    <button class="x" onclick="this.parentElement.remove()">✕</button>
  </div>`;
}
function addOptRow(){ $("optRows").insertAdjacentHTML("beforeend", optRowHtml()); }

async function createBet(){
  if(!me()) return toast("No se ha identificado tu jugador", true);
  let payload;

  if(createKind==="match"){
    const a = $("cTeamA").value.trim(), b = $("cTeamB").value.trim();
    const oe = parseFloat($("cOddsExact").value), ow = parseFloat($("cOddsWinner").value);
    if(!a || !b) return toast("Escribe los dos equipos", true);
    if(!(oe>1) || !(ow>1)) return toast("Las cuotas deben ser mayores que 1", true);
    if(oe<=ow) return toast("La cuota del marcador exacto debe ser mayor que la de solo ganador", true);
    payload = {
      pool_id:pool.id, creator_id:myId, kind:"match", category:"partido",
      question:`${a} vs ${b}`, team_a:a, team_b:b, odds_exact:oe, odds_winner:ow,
      options:[], status:"open"
    };
  } else {
    const q = $("cQuestion").value.trim();
    if(!q) return toast("Escribe la pregunta de la apuesta", true);
    const rows = [...document.querySelectorAll("#optRows .optrow")];
    const options = [];
    for(const row of rows){
      const label = row.querySelector(".olab").value.trim();
      const odds = parseFloat(row.querySelector(".ood").value);
      if(!label) continue;
      if(!(odds>1)) return toast(`Pon una cuota válida (>1) en "${label}"`, true);
      options.push({id:uid(), label, odds});
    }
    if(options.length<2) return toast("Necesitas al menos 2 opciones con cuota", true);
    payload = { pool_id:pool.id, creator_id:myId, kind:"free", category:createCat, question:q, options, status:"open" };
  }

  const {error} = await sb.from("bets").insert(payload);
  if(error) return toast("Error al publicar: "+error.message, true);

  $("cQuestion").value=""; $("cTeamA").value=""; $("cTeamB").value=""; pickCat(createCat);
  betFilter="open"; setFilterUI(); switchTab("bets");
  toast("¡Apuesta publicada! 🎲");
}

/* ============================================================
   APOSTAR / RESOLVER  (vía funciones atómicas en Supabase)
   ============================================================ */
async function openWager(betId, optId){
  const u = me(); if(!u) return toast("No identificado", true);
  const bet = bets.find(b=>b.id===betId); if(!bet || bet.status!=="open") return;
  const opt = bet.options.find(o=>o.id===optId);
  const existing = wagers.find(w=>w.bet_id===betId && w.player_id===myId);
  if(existing){
    const prev = bet.options.find(o=>o.id===existing.option_id);
    if(!confirm(`Ya apostaste ${fmt(existing.amount)} 🪙 a "${prev?prev.label:"?"}". ¿Cambiar tu apuesta? (se te devuelve y apuestas de nuevo)`)) return;
  }
  const avail = Number(u.balance) + (existing?Number(existing.amount):0);
  const raw = prompt(`Apostar a: "${opt.label}" (cuota ${Number(opt.odds).toFixed(2)})\nSi aciertas ganas lo apostado × cuota.\n\nSaldo disponible: ${fmt(avail)} 🪙\n¿Cuánto apuestas?`, "");
  if(raw===null) return;
  const amount = Math.floor(Number(raw));
  if(!(amount>0)) return toast("Cantidad no válida", true);
  if(amount>avail) return toast("No tienes saldo suficiente", true);

  const {error} = await sb.rpc("place_wager",
    {p_bet_id:betId, p_player_id:myId, p_option_id:optId, p_amount:amount});
  if(error) return toast("Error: "+error.message, true);
  await refresh();
  toast(`Apostaste ${fmt(amount)} 🪙 · posible premio ${fmt(amount*Number(opt.odds))} 🪙`);
}

async function resolveBet(betId){
  const bet = bets.find(b=>b.id===betId); if(!bet || bet.status!=="open") return;
  const winId = $("rsel-"+betId).value;
  const winOpt = bet.options.find(o=>o.id===winId);
  if(!confirm(`Resolver "${bet.question}"\nGanadora: ${winOpt.label}\n\nSe pagarán los premios. No se puede deshacer.`)) return;
  const {error} = await sb.rpc("resolve_bet", {p_bet_id:betId, p_winning_option_id:winId});
  if(error) return toast("Error: "+error.message, true);
  await refresh();
  toast("Apuesta resuelta y premios pagados 🏆");
}

/* ---- Pronóstico de partido ---- */
async function openMatchWager(betId){
  const u = me(); if(!u) return toast("No identificado", true);
  const bet = bets.find(b=>b.id===betId); if(!bet || bet.status!=="open") return;
  const existing = wagers.find(w=>w.bet_id===betId && w.player_id===myId);

  const rawScore = prompt(`Tu marcador para ${bet.team_a} vs ${bet.team_b}\n(ejemplo: 2-1)`,
    existing ? `${existing.pred_a}-${existing.pred_b}` : "");
  if(rawScore===null) return;
  const m = rawScore.trim().match(/^(\d+)\s*[-:]\s*(\d+)$/);
  if(!m) return toast("Marcador no válido. Usa el formato 2-1", true);
  const pa = parseInt(m[1],10), pb = parseInt(m[2],10);

  const avail = Number(u.balance) + (existing?Number(existing.amount):0);
  const oe = Number(bet.odds_exact), ow = Number(bet.odds_winner);
  const raw = prompt(`Marcador ${pa}-${pb} en ${bet.team_a} vs ${bet.team_b}\n\n🎯 Si aciertas el marcador exacto: ×${oe.toFixed(2)}\n✅ Si aciertas solo el ganador: ×${ow.toFixed(2)}\n\nSaldo disponible: ${fmt(avail)} 🪙\n¿Cuánto apuestas?`, "");
  if(raw===null) return;
  const amount = Math.floor(Number(raw));
  if(!(amount>0)) return toast("Cantidad no válida", true);
  if(amount>avail) return toast("No tienes saldo suficiente", true);

  const {error} = await sb.rpc("place_match_wager",
    {p_bet_id:betId, p_player_id:myId, p_pred_a:pa, p_pred_b:pb, p_amount:amount});
  if(error) return toast("Error: "+error.message, true);
  await refresh();
  toast(`Pronóstico ${pa}-${pb} · ${fmt(amount)} 🪙 · exacto paga ${fmt(amount*oe)} 🪙`);
}

async function resolveMatch(betId){
  const bet = bets.find(b=>b.id===betId); if(!bet || bet.status!=="open") return;
  const ra = parseInt($("ra-"+betId).value,10), rb = parseInt($("rb-"+betId).value,10);
  if(!(ra>=0) || !(rb>=0)) return toast("Mete el resultado real (ej. 2 y 1)", true);
  if(!confirm(`Resultado de ${bet.team_a} vs ${bet.team_b}: ${ra}-${rb}\n\nSe pagarán los premios (exacto y solo-ganador). No se puede deshacer.`)) return;
  const {error} = await sb.rpc("resolve_match", {p_bet_id:betId, p_real_a:ra, p_real_b:rb});
  if(error) return toast("Error: "+error.message, true);
  await refresh();
  toast("Partido resuelto y premios pagados 🏆");
}

/* ============================================================
   CONFIG (pantalla de ajuste de claves)
   ============================================================ */
function saveConfigFromUI(){
  const url = $("cfgUrl").value.trim();
  const key = $("cfgKey").value.trim();
  if(!url || !key) return toast("Rellena los dos campos", true);
  localStorage.setItem(LS.url, url);
  localStorage.setItem(LS.key, key);
  if(initClient()){ toast("Conectado ✔️"); boot(); }
}

/* ============================================================
   NAV
   ============================================================ */
function switchTab(tab){
  activeTab = tab;
  ["bets","create","rank","people"].forEach(t=> $("tab-"+t).classList.toggle("hide", t!==tab));
  document.querySelectorAll("#tabs button").forEach(b=> b.classList.toggle("active", b.dataset.tab===tab));
  window.scrollTo({top:0,behavior:"smooth"});
}
function setFilterUI(){
  document.querySelectorAll("#tab-bets .filterbar button").forEach(b=> b.classList.toggle("on", b.dataset.f===betFilter));
}
function copyCode(){
  navigator.clipboard?.writeText(pool.code).then(()=>toast("Código copiado: "+pool.code));
}

/* ============================================================
   EVENTOS
   ============================================================ */
function wire(){
  $("cfgSave").addEventListener("click", saveConfigFromUI);

  $("createPoolBtn").addEventListener("click", createPool);
  $("joinPoolBtn").addEventListener("click", joinPoolFromInput);

  $("ppCreateBtn").addEventListener("click", createPlayer);
  $("ppNewName").addEventListener("keydown", e=>{ if(e.key==="Enter") createPlayer(); });
  $("ppLeave").addEventListener("click", leavePool);

  document.querySelectorAll("#tabs button").forEach(b=> b.addEventListener("click", ()=>switchTab(b.dataset.tab)));
  document.querySelectorAll("#tab-bets .filterbar button").forEach(b=>
    b.addEventListener("click", ()=>{ betFilter=b.dataset.f; setFilterUI(); renderBets(); }));

  document.querySelectorAll("#kindPills button").forEach(b=> b.addEventListener("click", ()=>pickKind(b.dataset.kind)));
  $("addOpt").addEventListener("click", addOptRow);
  $("createBet").addEventListener("click", createBet);
  $("leaveBtn").addEventListener("click", leavePool);
  $("copyCodeBtn").addEventListener("click", copyCode);

  // exponer para handlers inline
  window.openWager=openWager; window.resolveBet=resolveBet;
  window.openMatchWager=openMatchWager; window.resolveMatch=resolveMatch;
  window.pickCat=pickCat; window.claimPlayer=claimPlayer;

  // prefill config si ya existe
  const {url,key} = getConfig();
  $("cfgUrl").value = url; $("cfgKey").value = key;

  pickKind(createKind);
  pickCat(createCat);
}

document.addEventListener("DOMContentLoaded", ()=>{ wire(); boot(); });
