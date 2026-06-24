"use strict";
/* Sincroniza calendario+resultados del Mundial (openfootball) -> Supabase y liquida.
   Lo ejecuta GitHub Actions cada ~15 min. Requiere env PGPWD (secret). */
const { Client } = require('pg');
const REF = 'tcbknzpczdkddyhreqwv';
const HOST = 'aws-1-eu-central-1.pooler.supabase.com';
const SRC = 'https://raw.githubusercontent.com/openfootball/worldcup.json/master/2026/worldcup.json';

const extId = m => typeof m.num === 'number' ? `n${m.num}` : `${m.date}__${m.ground}`;
const mapStage = r => { const s=(r||'').toLowerCase();
  if(s.startsWith('matchday'))return'grupos'; if(s.includes('round of 32'))return'dieciseisavos';
  if(s.includes('round of 16'))return'octavos'; if(s.includes('quarter'))return'cuartos';
  if(s.includes('semi'))return'semis'; if(s.includes('third'))return'tercer_puesto';
  if(s.includes('final'))return'final'; return'grupos'; };
const grp = g => { const m=(g||'').match(/Group\s+([A-L])/i); return m?m[1].toUpperCase():null; };
function kick(date,time){ if(!date)return null; const t=(time||'').match(/(\d{1,2}):(\d{2})/); const off=(time||'').match(/UTC([+-]\d{1,2})/);
  if(!t)return `${date}T00:00:00Z`; const hh=t[1].padStart(2,'0'); if(!off)return `${date}T${hh}:${t[2]}:00Z`;
  const sign=off[1].startsWith('-')?'-':'+'; const oh=String(Math.abs(parseInt(off[1],10))).padStart(2,'0');
  return `${date}T${hh}:${t[2]}:00${sign}${oh}:00`; }
function status(m,k,now){ if(m.score&&m.score.ft&&m.score.ft.length===2)return'finished'; if(k&&now>=new Date(k))return'live'; return'scheduled'; }
const scorers = m => [...(m.goals1||[]),...(m.goals2||[])].map(g=>g.name);
const pens = m => [...(m.goals1||[]),...(m.goals2||[])].filter(g=>g.penalty).length;

(async()=>{
  const data = await (await fetch(SRC,{headers:{'cache-control':'no-cache'}})).json();
  const now = new Date();
  const c = new Client({host:HOST,port:5432,user:`postgres.${REF}`,password:process.env.PGPWD,database:'postgres',ssl:{rejectUnauthorized:false}});
  await c.connect();
  let n=0;
  for(const m of data.matches||[]){
    const a=m.team1||'', b=m.team2||''; if(!a||!b||!m.date) continue;
    const k=kick(m.date,m.time);
    await c.query('select upsert_match($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
      [extId(m),mapStage(m.round),grp(m.group),a,b,k,status(m,k,now),
       m.score&&m.score.ft?m.score.ft[0]:null, m.score&&m.score.ft?m.score.ft[1]:null,
       JSON.stringify(scorers(m)), pens(m)]);
    n++;
  }
  await c.query('select void_started_open_challenges()');
  const fin = await c.query("select id from matches where status='finished' and settled=false");
  for(const row of fin.rows) await c.query('select settle_match($1)',[row.id]);
  console.log(`sync OK · upserts=${n} · liquidados=${fin.rows.length}`);
  await c.end();
})().catch(e=>{ console.error('FATAL', e.message); process.exit(1); });
