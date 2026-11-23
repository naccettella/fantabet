import { db as fdb, configured, watchUser, login, logout, setLeague, slug, pwHash, deadlineTsOf, pushStatus, enablePush, disablePush } from './firebase.js';
(()=>{
const GEN=window.__fbGen=(window.__fbGen||0)+1;const live=()=>window.__fbGen===GEN;
const ROLE={A:{l:'Attaccante',p:4},C:{l:'Centrocampista',p:8},D:{l:'Difensore',p:18},P:{l:'Portiere',p:60}};
const X12=[-50,-20,0,6,10,15,25,60,150,350];
let PIDS=['p1','p2','p3'];
const MULT_EX=[0,1,2.5,6];
let db=null, stato=null, dbState='loading', adj=[];
/* who is viewing: owner = admin of the competition; uid links an account to a player slot via cfg.members */
/* super admin: solo l'account di Nicola (lo stesso uid è scritto nelle regole Firestore) */
const SUPER_UID='6lew6rv9qNQpIOqFKnIYNv86Itg2';
let user=null, me={id:null,owner:false}, slips={}, requests=[], profs={};const slipSubs={},slipTimers={},slipInflight={},slipChains={};
function log(){}
const saveFail={};
let cfg={players:{p1:'Giocatore 1',p2:'Giocatore 2',p3:'Giocatore 3'}};
let rounds={};
let ui={tab:'giornata',g:null,sub:'pronostici',player:'p1',editTeams:false,importing:false,confirmReopen:false};
try{const s=JSON.parse(localStorage.getItem('fb-ui2')||'{}');['tab','g','sub','player'].forEach(k=>{if(s[k]!=null)ui[k]=s[k]})}catch(e){}
function saveUi(){try{localStorage.setItem('fb-ui2',JSON.stringify({tab:ui.tab,g:ui.g,sub:ui.sub,player:ui.player}))}catch(e){}}

const $=s=>document.querySelector(s);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const gid=n=>'g'+String(n).padStart(2,'0');
const isNum=v=>v!==null&&v!==''&&v!==undefined&&!isNaN(Number(v));
const r1=x=>Math.round(x*10)/10;
const fmt=x=>(x>0?'+':'')+new Intl.NumberFormat('it-IT',{maximumFractionDigits:1}).format(x);
const fmtN=x=>new Intl.NumberFormat('it-IT',{maximumFractionDigits:1}).format(x);
const pname=pid=>cfg.players?.[pid]||pid;

function emptyRound(n){return{num:n,deadline:'',calcolata:false,matches:Array.from({length:10},()=>({home:'',away:'',when:'',hg:null,ag:null,nullo:false})),scorers:[],preds:{}}}
function normRound(r){
  r.matches=(r.matches||[]).slice(0,10);while(r.matches.length<10)r.matches.push({home:'',away:'',when:'',hg:null,ag:null,nullo:false});
  r.scorers=r.scorers||[];r.preds=r.preds||{};return r}
/* a slot linked to an account keeps its slip in that person's own subtree (schedine/<uid>/giornate/gNN);
   unlinked slots, and rounds entered before linking, keep it in the round document as before */
const memberOf=pid=>cfg.members?.[pid]||null;
const pidOf=uid=>uid?Object.keys(cfg.members||{}).find(p=>cfg.members[p]===uid)||null:null;
const myPid=()=>pidOf(me.id);
function rawPred(r,pid){const u=memberOf(pid);return(u&&slips[u]?.[r.num])||r.preds?.[pid]||{}}
function getPred(r,pid){
  const p=rawPred(r,pid);
  const x12=Array.isArray(p.x12)?p.x12.slice(0,10):[];while(x12.length<10)x12.push('');
  const exact=Array.isArray(p.exact)?p.exact.slice(0,3):[];while(exact.length<3)exact.push({m:-1,h:'',a:''});
  const scorers=Array.isArray(p.scorers)?p.scorers.slice(0,3):[];while(scorers.length<3)scorers.push({name:'',role:'A'});
  return{status:p.status||'',x12,exact,scorers,consegnata:p.consegnata||''}}
function ensurePred(r,pid){
  const u=memberOf(pid);
  if(u){const o=slips[u]=slips[u]||{};o[r.num]={num:r.num,...getPred(r,pid)};return o[r.num]}
  r.preds[pid]=getPred(r,pid);return r.preds[pid]}
/* the slip can no longer be changed by its player: delivered, past the deadline, or round confirmed. The owner can always edit. */
/* the owner sees delivered slips and confirmed rounds locked too, until they unlock that slip on this device */
const ownerUnlocked={};const ukey=(r,pid)=>r.num+'/'+pid;
const pastDl=r=>!!(r.deadline&&new Date(r.deadline)<new Date());
/* other players' slips stay hidden, from the owner too, until everyone has delivered (or the deadline passes, or the round is calculated) */
const revealed=r=>!!r.calcolata||pastDl(r)||PIDS.every(q=>getPred(r,q).status==='consegnato');
const canSee=(r,pid)=>revealed(r)||pid===myPid()||(me.owner&&!memberOf(pid));
function ownerLocked(r,pid){const p=getPred(r,pid);return(!!p.consegnata||(r.calcolata&&!!p.status)||pastDl(r))&&!ownerUnlocked[ukey(r,pid)]}
function slipLocked(r,pid){if(me.owner)return ownerLocked(r,pid);if(pid!==myPid())return true;
  return!!getPred(r,pid).consegnata||r.calcolata||pastDl(r)}

/* exact results (same match, same score) and scorers belong to whoever delivered them first */
const exKey=e=>isNum(e.h)&&isNum(e.a)&&+e.m>=0?`${+e.m}:${+e.h}-${+e.a}`:'';
const scKey=s=>tokens(s.name).join(' ');
function takenBy(r,pid,before){
  const ex={},sc={};
  for(const q of PIDS){if(q===pid)continue;const o=getPred(r,q);
    if(o.status!=='consegnato'||!o.consegnata)continue;if(before&&!(o.consegnata<before))continue;
    o.exact.forEach(e=>{const k=exKey(e);if(k&&!ex[k])ex[k]=q});
    o.scorers.forEach(x=>{const k=scKey(x);if(k&&!sc[k])sc[k]=q})}
  return{ex,sc}}
/* items of pid's slip that clash with a slip delivered earlier; with no delivery time yet, any delivered slip counts */
function clashes(r,pid){
  const p=getPred(r,pid);if(p.status==='consegnato'&&!p.consegnata)return{ex:{},sc:{}};
  const t=takenBy(r,pid,p.consegnata||null);const ex={},sc={};
  p.exact.forEach((e,k)=>{const q=t.ex[exKey(e)];if(q)ex[k]=q});
  p.scorers.forEach((x,k)=>{const q=t.sc[scKey(x)];if(q)sc[k]=q});
  return{ex,sc}}

/* ---------- scoring ---------- */
const outcome=m=>{const h=+m.hg,a=+m.ag;return h>a?'1':h<a?'2':'X'};
const validMatch=m=>!m.nullo&&isNum(m.hg)&&isNum(m.ag);
function exactBase(h,a){h=+h;a=+a;const t=h+a;if(t<=2)return{p:6,c:'Standard'};if(t>=5||Math.abs(h-a)>=4)return{p:25,c:'Folle'};return{p:12,c:'Medio'}}
const tokens=s=>(s||'').normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase().replace(/[^a-z]+/g,' ').split(' ').filter(t=>t.length>=2);
function findGoals(r,name){
  const pt=tokens(name);if(!pt.length)return{goals:0,names:[]};
  let goals=0;const names=[];
  for(const s of r.scorers){const st=tokens(s.name);if(!st.length)continue;
    const long=st.filter(t=>t.length>=3);
    if(pt.every(t=>st.includes(t))||(long.length&&long.every(t=>pt.includes(t)))){goals+=Number(s.goals)||0;names.push(s.name)}}
  return{goals,names}}
function scoreRound(r,pid){
  const p=getPred(r,pid);
  const status=p.status||(r.calcolata?'mancato':'');
  const base={state:status||'vuoto',total:0,x12:0,hits:0,valid:0,golden:false,exact:0,exactHits:0,exactRows:[],sc:0,scRows:[],combo:false,x12rows:[]};
  if(status==='mancato')return{...base,state:'mancato',total:-50,x12:-50};
  if(status!=='consegnato')return base;
  let hits=0,valid=0;
  const x12rows=r.matches.map((m,i)=>{if(!validMatch(m))return null;valid++;const ok=p.x12[i]===outcome(m);if(ok)hits++;return ok});
  const golden=valid===10&&hits===10;
  const x12=golden?0:X12[hits];
  let exSum=0,exactHits=0;
  const usedM=new Set();const cl=p.consegnata?clashes(r,pid):{ex:{},sc:{}};
  const exactRows=p.exact.map((e,k)=>{
    const m=r.matches[e.m];
    if(!m||!isNum(e.h)||!isNum(e.a))return{e,m,state:'vuoto'};
    if(cl.ex[k])return{e,m,state:'altrui',by:cl.ex[k]};
    if(usedM.has(+e.m))return{e,m,state:'doppione'};usedM.add(+e.m);
    const b=exactBase(e.h,e.a);
    if(m.nullo)return{e,m,b,state:'nullo'};
    if(!validMatch(m))return{e,m,b,state:'attesa'};
    const hit=+e.h===+m.hg&&+e.a===+m.ag;if(hit){exactHits++;exSum+=b.p}
    return{e,m,b,state:hit?'preso':'sbagliato'}});
  const exact=r1(exSum*MULT_EX[exactHits]);
  let scSum=0,scored=0,named=0;
  const usedS=new Set();
  const scRows=p.scorers.map((s,k)=>{
    if(!s.name.trim())return{s,state:'vuoto',pts:0};
    if(cl.sc[k])return{s,state:'altrui',by:cl.sc[k],goals:0,names:[],pts:0};
    const key=tokens(s.name).join(' ');if(usedS.has(key))return{s,state:'doppione',goals:0,names:[],pts:0};usedS.add(key);named++;
    const f=findGoals(r,s.name);const bp=ROLE[s.role]?.p||4;
    const pts=f.goals>0?bp*Math.min(f.goals,3):0;if(f.goals>0)scored++;scSum+=pts;
    return{s,goals:f.goals,names:f.names,pts,state:f.goals>0?'segna':'no'}});
  const combo=named===3&&scored===3;
  const sc=r1(combo?scSum*2.5:scSum);
  return{...base,state:'consegnato',total:r1(x12+exact+sc),x12,hits,valid,golden,exact,exactHits,exactRows,sc,scRows,combo,x12rows}}

function standings(){
  const nums=Object.keys(rounds).map(Number).filter(n=>rounds[n].calcolata&&PIDS.some(p=>getPred(rounds[n],p).status)).sort((a,b)=>a-b);
  const rows=PIDS.map(pid=>({pid,tot:0,rec:null,x12:0,ex:0,per:{}}));
  for(const n of nums)for(const row of rows){const s=scoreRound(rounds[n],row.pid);row.per[n]=s;row.tot=r1(row.tot+s.total);row.rec=row.rec===null?s.total:Math.max(row.rec,s.total);row.x12+=s.x12;row.ex+=s.exactHits}
  for(const row of rows){row.adj=r1(adj.filter(a=>a.pid===row.pid).reduce((t,a)=>t+(Number(a.pts)||0),0));row.tot=r1(row.tot+row.adj)}
  const cmp=(a,b)=>b.tot-a.tot||(b.rec??0)-(a.rec??0)||b.x12-a.x12||b.ex-a.ex;
  rows.sort(cmp);
  rows.forEach((r,i)=>{r.rank=i>0&&cmp(rows[i-1],r)===0?rows[i-1].rank:i+1});
  let golden=null;
  for(const n of nums){
    const w=rows.filter(r=>r.per[n]?.golden);
    if(w.length){const before=r=>nums.filter(k=>k<n).reduce((s,k)=>s+r.per[k].total,0);
      w.sort((a,b)=>b.per[n].total-a.per[n].total||before(b)-before(a));golden={n,pid:w[0].pid,tie:w.length>1};break}}
  return{rows,nums,golden}}

/* ---------- storage ---------- */
const timers={},chains={},dirtyF={},inflight={};
/* fields: which parts of the round changed ('matches','scorers','preds','calcolata'), or '*' to create the whole document */
function saveRound(n,fields,now){
  const set=dirtyF[n]=dirtyF[n]||new Set();[].concat(fields).forEach(f=>set.add(f));
  clearTimeout(timers[n]);timers[n]=setTimeout(()=>{delete timers[n];writeRound(n)},now?0:300)}
function writeRound(n){
  log('write-start',{n});
  if(!db){toast('Salvataggio non disponibile: accedi con Google.');return}
  delete dirtyF[n];
  /* always write the whole round with a plain set: on some phones reads and partial updates don't go through */
  const data=JSON.parse(JSON.stringify(rounds[n]));
  inflight[n]=(inflight[n]||0)+1;saveState(1);
  chains[n]=(chains[n]||Promise.resolve()).then(()=>withTimeout(db.doc('giornate/'+gid(n)).set(data)))
    .then(()=>{log('write-ok',{n});saveState(-1);delete saveFail[n]},e=>{log('write-fail',{n,code:e?.code,msg:String(e?.message||'')});saveState(-1,e);saveFail[n]=e?.code||'errore';toast(errMsg(e));requestRender()}).finally(()=>{inflight[n]--})}
let adjInflight=0,adjChain=Promise.resolve();
function saveAdj(){if(!db)return toast('Salvataggio non disponibile.');const data={items:JSON.parse(JSON.stringify(adj))};adjInflight++;saveState(1);adjChain=adjChain.then(()=>withTimeout(db.doc('fantabet/rettifiche').set(data))).then(()=>saveState(-1),e=>{saveState(-1,e);toast(errMsg(e))}).finally(()=>{adjInflight--})}
let cfgTimer=null,cfgInflight=0,cfgChain=Promise.resolve();
function saveCfg(){
  if(!db)return toast('Salvataggio non disponibile.');
  clearTimeout(cfgTimer);
  cfgTimer=setTimeout(()=>{cfgTimer=null;const data=JSON.parse(JSON.stringify(cfg));cfgInflight++;
    saveState(1);cfgChain=cfgChain.then(()=>withTimeout(db.doc('fantabet/config').set(data))).then(()=>saveState(-1),e=>{saveState(-1,e);toast(errMsg(e))}).finally(()=>{cfgInflight--})},400)}
function setName(pid,v){cfg={...cfg,players:{...cfg.players,[pid]:v}};saveCfg()}
function setPlayers(){const ks=Object.keys(cfg.players||{}).filter(k=>/^p\d+$/.test(k)).sort((a,b)=>a.slice(1)-b.slice(1));PIDS=ks.length?ks:['p1']}
function linkMember(pid,uid){const m={...(cfg.members||{})};Object.keys(m).forEach(k=>{if(m[k]===uid)delete m[k]});if(uid)m[pid]=uid;else delete m[pid];cfg={...cfg,members:m};saveCfg();watchSlips()}
function addPlayer(){const n=Math.max(0,...PIDS.map(p=>+p.slice(1)))+1;cfg={...cfg,players:{...cfg.players,['p'+n]:'Giocatore '+n}};setPlayers();saveCfg();return'p'+n}
/* ---------- activity log: what the owner changes on other players' slips and on points, readable by everyone ---------- */
let registro={};const logBase={},logTimers={};let logChain=Promise.resolve();
function addLog(n,e){if(!db||!me.owner)return;const id=n?gid(n):'generale';
  const items=[...(registro[id]||[]),{at:new Date().toISOString(),...e}].slice(-300);registro[id]=items;
  const data={items:JSON.parse(JSON.stringify(items))};logChain=logChain.then(()=>withTimeout(db.doc('registro/'+id).set(data))).catch(()=>toast('Registro attività non aggiornato: riprova la modifica.'));requestRender()}
/* call BEFORE changing pid's slip: remembers how it was, then logs the differences once the edits pause */
function trackEdit(r,pid){if(!me.owner||!r||pid===myPid())return;const k=ukey(r,pid);
  if(!logBase[k])logBase[k]=JSON.stringify(getPred(r,pid));clearTimeout(logTimers[k]);logTimers[k]=setTimeout(()=>flushEdit(r.num,pid),2500)}
function flushEdit(n,pid){const k=n+'/'+pid;clearTimeout(logTimers[k]);delete logTimers[k];if(!logBase[k]||!rounds[n])return;
  const a=JSON.parse(logBase[k]),b=getPred(rounds[n],pid);delete logBase[k];const ms=rounds[n].matches;const d=[];
  const mt=i=>`${i+1}. ${ms[i]?.home||''}-${ms[i]?.away||''}`;
  if(a.status!==b.status)d.push(`stato: ${a.status||'vuota'} → ${b.status||'vuota'}`);
  b.x12.forEach((v,i)=>{if(v!==a.x12[i])d.push(`1X2 ${mt(i)}: ${a.x12[i]||'–'} → ${v||'–'}`)});
  const ex=e=>+e.m>=0&&isNum(e.h)&&isNum(e.a)?`${mt(+e.m)} ${e.h}-${e.a}`:'–';
  b.exact.forEach((e,i)=>{if(ex(e)!==ex(a.exact[i]))d.push(`esatto ${i+1}: ${ex(a.exact[i])} → ${ex(e)}`)});
  const sc=x=>x.name.trim()?`${x.name} (${x.role})`:'–';
  b.scorers.forEach((x,i)=>{if(sc(x)!==sc(a.scorers[i]))d.push(`marcatore ${i+1}: ${sc(a.scorers[i])} → ${sc(x)}`)});
  if(d.length)addLog(n,{pid,t:'Schedina modificata',det:d})}
window.addEventListener('pagehide',()=>Object.keys(logTimers).forEach(k=>{const[n,p]=k.split('/');flushEdit(+n,p)}));
/* ---------- chat: each person keeps their own messages in chat/<uid>, everyone reads all of them ---------- */
let chat={};let chatChain=Promise.resolve();
const author=u=>u===me.id?'Tu':(pidOf(u)?pname(pidOf(u)):(profs[u]?.name||'Partecipante'));
function viewChat(){
  const msgs=Object.entries(chat).flatMap(([u,items])=>(items||[]).map(m=>({...m,u}))).sort((a,b)=>a.at<b.at?-1:1).slice(-150);
  let h=`<section class="sheet chat"><h2>Chat</h2><div class="msgs" id="msgs">`;
  h+=msgs.length?msgs.map(m=>`<div class="msg ${m.u===me.id?'me':''}"><div class="who">${esc(author(m.u))} · ${esc(fmtDeadline(m.at))}</div><div class="txt">${esc(m.text)}</div></div>`).join(''):'<div class="small muted">Ancora nessun messaggio. Scrivi il primo.</div>';
  h+=`</div>`;
  h+=me.id?`<div class="row"><input type="text" id="chat-in" maxlength="500" placeholder="Scrivi un messaggio…" aria-label="Messaggio" style="flex:1 1 200px"><button class="btn primary" data-act="chat-send">Invia</button></div>`:'<div class="small muted">Per scrivere accedi con Google.</div>';
  return h+`</section>`}
async function sendChat(){const el=$('#chat-in');const t=(el?.value||'').trim();if(!t||!db||!me.id)return;
  const mine=[...(chat[me.id]||[]),{at:new Date().toISOString(),text:t.slice(0,500)}].slice(-100);const prev=chat[me.id];chat[me.id]=mine;el.value='';render();
  const data={items:JSON.parse(JSON.stringify(mine))};
  chatChain=chatChain.then(()=>withTimeout(db.doc('chat/'+me.id).set(data))).catch(e=>{chat[me.id]=prev;toast(e?.code==='permission-denied'?'Non puoi scrivere in chat: chiedi all\'organizzatore di collegarti a un giocatore.':errMsg(e));render()});
  setTimeout(()=>{const b=$('#msgs');if(b)b.scrollTop=b.scrollHeight},0)}
document.addEventListener('keydown',e=>{if(e.key==='Enter'&&e.target.id==='chat-in'){e.preventDefault();sendChat()}});

function viewLog(){if(!me.owner&&!myPid())return'';
  const all=Object.entries(registro).flatMap(([id,items])=>(items||[]).map(e=>({...e,n:id==='generale'?null:+id.slice(1)}))).sort((a,b)=>a.at<b.at?1:-1).slice(0,40);
  let h=`<section class="sheet"><h3>Registro dell'organizzatore</h3><div class="small muted">Ogni modifica che l'organizzatore fa alle schedine degli altri, ai punti manuali o ai collegamenti degli account viene scritta qui in automatico, con data e dettaglio.</div>`;
  if(!all.length)return h+`<div class="small muted">Nessuna modifica finora.</div></section>`;
  h+=`<div class="scroll"><table class="rules"><tbody>${all.map(e=>`<tr><td class="l"><b>${esc(e.t)}</b>${e.pid?` · ${esc(pname(e.pid))}`:''}${e.n?` · G${e.n}`:''}${(e.det||[]).length?`<div class="small muted">${(e.det||[]).map(esc).join('<br>')}</div>`:''}</td><td class="small muted">${esc(fmtDeadline(e.at))}</td></tr>`).join('')}</tbody></table></div>`;
  return h+`</section>`}

/* save a slip where it lives: the player's own subtree when the slot is linked, the round document otherwise */
function savePred(n,pid,now){const u=memberOf(pid);if(!u)return saveRound(n,'preds',now);
  const k=u+'/'+n;clearTimeout(slipTimers[k]);slipTimers[k]=setTimeout(()=>{delete slipTimers[k];writeSlip(u,n)},now?0:300)}
function writeSlip(u,n){
  if(!db){toast('Salvataggio non disponibile: accedi con Google.');return Promise.resolve(false)}
  const k=u+'/'+n;const data=JSON.parse(JSON.stringify(slips[u][n]));
  slipInflight[k]=(slipInflight[k]||0)+1;saveState(1);
  return slipChains[k]=(slipChains[k]||Promise.resolve()).then(()=>withTimeout(db.doc('schedine/'+u+'/giornate/'+gid(n)).set(data)))
    .then(()=>{saveState(-1);return true},e=>{saveState(-1,e);toast(e?.code==='permission-denied'?'Schedina non salvata: è già consegnata, la scadenza è passata (ora del server) oppure non sei collegato a questo giocatore.':errMsg(e));return false}).finally(()=>{slipInflight[k]--})}
/* one subscription per linked account, opened when the slot list changes, never from render */
function watchSlips(){if(!db)return;
  const uids=new Set(Object.values(cfg.members||{}));if(me.id)uids.add(me.id);
  uids.forEach(u=>{if(slipSubs[u])return;
    slipSubs[u]=db.collection('schedine/'+u+'/giornate').onSnapshot(snap=>{
      const next={};snap.docs.forEach(d=>{const x=d.data();if(x&&isNum(x.num))next[+x.num]=JSON.parse(JSON.stringify(x))});
      const cur=slips[u]||{};Object.keys(cur).forEach(n=>{const k=u+'/'+n;if(slipTimers[k]||slipInflight[k])next[n]=cur[n]});
      slips[u]=next;requestRender()},()=>{delete slipSubs[u]})})}
function withTimeout(pr,ms=20000){return Promise.race([pr,new Promise((_,rej)=>setTimeout(()=>rej({code:'timeout'}),ms))])}
let pendingSaves=0,lastSaveErr=null;
function saveState(d,err){pendingSaves=Math.max(0,pendingSaves+d);if(err)lastSaveErr=err;else if(d<0&&!pendingSaves)lastSaveErr=null;
  const t=$('#tagline');if(!t)return;
  t.textContent=pendingSaves?'Salvataggio…':lastSaveErr?'⚠ Salvataggio non riuscito ('+(lastSaveErr.code||'errore')+')':'Salvato ✓';}
function errMsg(e){if(e?.code==='timeout')return'Il salvataggio non risponde: controlla la connessione e riprova.';if(e?.code==='permission-denied')return'Non hai i permessi per questa modifica.';if(e?.code==='unavailable')return'Sei offline: la modifica verrà inviata appena torna la connessione.';return'Salvataggio non riuscito ('+(e?.code||'errore')+'). Riprova tra poco.'}

/* ---------- render ---------- */
let dirty=false;
function inputFocused(){const a=document.activeElement;return a&&$('#view').contains(a)&&/^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName)}
function requestRender(){if(!live())return;setTimeout(()=>{if(inputFocused()){dirty=true;return}dirty=false;render()},0)}
document.addEventListener('focusout',()=>setTimeout(()=>{if(dirty&&!inputFocused()){dirty=false;render()}},0));

function currentG(){
  if(ui.g&&ui.g>=1&&ui.g<=38)return ui.g;
  const nums=Object.keys(rounds).map(Number).sort((a,b)=>a-b);
  const open=nums.filter(n=>!rounds[n].calcolata);
  return open[0]||nums[nums.length-1]||1}

/* close the slips on screen the moment the next deadline passes, even with a field focused */
let dlTimer=null;
function armDeadline(){clearTimeout(dlTimer);const now=Date.now();
  const next=Object.values(rounds).map(r=>r.deadline?new Date(r.deadline).getTime():NaN).filter(t=>t>now).sort((a,b)=>a-b)[0];
  if(next)dlTimer=setTimeout(()=>{document.activeElement?.blur?.();render();toast('Scadenza passata: le schedine sono chiuse.')},Math.min(next-now+500,2147483000))}
function render(){
  if(!live())return;armDeadline();
  document.querySelectorAll('.tabs button').forEach(b=>b.setAttribute('aria-selected',b.dataset.tab===ui.tab));
  const v=$('#view');
  const html=ui.account?viewAccount():ui.tab==='classifica'?viewStandings():ui.tab==='giornata'?viewRound():ui.tab==='chat'?viewChat():viewRules();
  if(html===lastHtml&&v.firstChild)return;
  lastHtml=html;v.innerHTML=html;
}
let lastHtml='';

/* ---------- statistiche personali ---------- */
const COLORS=['#34c759','#ff3b30','#007aff','#ff9500','#af52de','#30b0c7','#ff2d55','#5856d6','#a2845e','#8e8e93'];
function viewTrend(rows,nums){if(nums.length<2)return'';
  // posizione in classifica dopo ogni giornata (senza i punti manuali)
  const cum={};PIDS.forEach(p=>cum[p]=0);const pos={};PIDS.forEach(p=>pos[p]=[]);
  for(const n of nums){PIDS.forEach(p=>{cum[p]+=rows.find(r=>r.pid===p).per[n].total});
    const sorted=[...PIDS].sort((a,b)=>cum[b]-cum[a]);PIDS.forEach(p=>pos[p].push(sorted.findIndex(q=>cum[q]===cum[p])+1))}
  const W=600,H=40+PIDS.length*34,L=30,R=12,T=14,B=26,xs=i=>L+(W-L-R)*(i/(nums.length-1)),ys=k=>T+(H-T-B)*((k-1)/Math.max(1,PIDS.length-1));
  let svg=`<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Posizione in classifica giornata per giornata" style="max-width:100%;height:auto">`;
  for(let k=1;k<=PIDS.length;k++)svg+=`<text x="4" y="${ys(k)+4}" font-size="12" fill="currentColor" opacity=".6">${k}°</text><line x1="${L}" x2="${W-R}" y1="${ys(k)}" y2="${ys(k)}" stroke="currentColor" opacity=".1"/>`;
  const step=Math.ceil(nums.length/12);nums.forEach((n,i)=>{if(i%step===0||i===nums.length-1)svg+=`<text x="${xs(i)}" y="${H-6}" font-size="11" text-anchor="middle" fill="currentColor" opacity=".6">G${n}</text>`});
  PIDS.forEach((p,j)=>{const c=COLORS[j%COLORS.length];svg+=`<polyline fill="none" stroke="${c}" stroke-width="3" stroke-linejoin="round" points="${pos[p].map((k,i)=>xs(i)+','+ys(k)).join(' ')}"/>`;
    svg+=`<circle cx="${xs(nums.length-1)}" cy="${ys(pos[p][nums.length-1])}" r="4.5" fill="${c}"/>`});
  svg+='</svg>';
  return`<section class="sheet"><h3>Andamento in classifica</h3>${svg}<div class="row small">${PIDS.map((p,j)=>`<span class="row" style="gap:5px"><span style="width:14px;height:4px;border-radius:2px;background:${COLORS[j%COLORS.length]}"></span>${esc(pname(p))}</span>`).join('')}</div></section>`}
const pct=(a,b)=>b?Math.round(a/b*100)+'%':'—';
function playerStats(rows,nums){return rows.map(r=>{let h=0,v=0,eh=0,et=0,sh=0,st=0,del=0,best=null,bestN=null;
  for(const n of nums){const s=r.per[n];if(s.state==='consegnato')del++;h+=s.hits||0;v+=s.state==='consegnato'?s.valid:0;
    (s.exactRows||[]).forEach(x=>{if(x.state==='preso'||x.state==='sbagliato'){et++;if(x.state==='preso')eh++}});
    (s.scRows||[]).forEach(x=>{if(x.state==='segna'||x.state==='no'){st++;if(x.state==='segna')sh++}});
    if(best===null||s.total>best){best=s.total;bestN=n}}
  return{pid:r.pid,h,v,eh,et,sh,st,del,avg:nums.length?r1((r.tot-(r.adj||0))/nums.length):0,best,bestN}})}
function viewStats(rows,nums){const st=playerStats(rows,nums);
  return`<section class="sheet"><h3>Statistiche</h3><div class="scroll"><table><thead><tr><th class="l">Giocatore</th><th>1X2 presi</th><th>Esatti presi</th><th>Marcatori a segno</th><th>Media punti</th><th>Giornata migliore</th><th>Consegnate</th></tr></thead><tbody>${st.map(x=>`<tr><td class="l"><b>${esc(pname(x.pid))}</b></td><td>${pct(x.h,x.v)}<div class="small muted">${x.h}/${x.v}</div></td><td>${pct(x.eh,x.et)}<div class="small muted">${x.eh}/${x.et}</div></td><td>${pct(x.sh,x.st)}<div class="small muted">${x.sh}/${x.st}</div></td><td>${fmtN(x.avg)}</td><td>${x.bestN?`${fmtN(x.best)}<div class="small muted">G${x.bestN}</div>`:'—'}</td><td>${x.del}/${nums.length}</td></tr>`).join('')}</tbody></table></div></section>`}

/* ---------- premi e medaglie ---------- */
function awards(rows,nums){const out={};rows.forEach(r=>out[r.pid]={re:0,tris:0,bomber:0,golden:0,serieEx:0,seriePos:0,sempre:true,nera:0});
  for(const n of nums){const tot=rows.map(r=>r.per[n].total);const mx=Math.max(...tot),mn=Math.min(...tot);
    rows.forEach(r=>{const s=r.per[n],a=out[r.pid];if(s.total===mx)a.re++;if(rows.length>2&&s.total===mn&&mn<mx)a.nera++;if(s.exactHits===3)a.tris++;if(s.combo)a.bomber++;if(s.golden)a.golden++;if(s.state!=='consegnato')a.sempre=false})}
  rows.forEach(r=>{let ce=0,cp=0;const a=out[r.pid];for(const n of nums){const s=r.per[n];ce=s.exactHits>0?ce+1:0;cp=s.total>0?cp+1:0;a.serieEx=Math.max(a.serieEx,ce);a.seriePos=Math.max(a.seriePos,cp)}});
  return out}
const BADGES=[['re','👑','Re della giornata','giornate chiuse con più punti di tutti'],['tris','🎯','Tris di esatti','3 risultati esatti su 3 nella stessa giornata'],['bomber','⚽','Tris di marcatori','3 marcatori su 3 a segno'],['golden','🌟','10 su 10','tutti gli 1X2 della giornata'],['serieEx','🔥','Serie di esatti','giornate di fila con almeno un esatto (la più lunga)'],['seriePos','📈','Serie positiva','giornate di fila con punti sopra lo zero (la più lunga)'],['nera','🐢','Maglia nera','giornate chiuse con meno punti di tutti']];
function viewAwards(rows,nums){const a=awards(rows,nums);const last=nums[nums.length-1];
  const lastBest=rows.filter(r=>r.per[last].total===Math.max(...rows.map(x=>x.per[last].total))).map(r=>pname(r.pid));
  return`<section class="sheet"><h3>Premi e medaglie</h3><div class="small">👑 Migliore della giornata ${last}: <b>${esc(lastBest.join(', '))}</b></div>
    ${rows.map(r=>{const x=a[r.pid];const chips=BADGES.filter(([k])=>x[k]>0).map(([k,i,l])=>`<span class="chip" title="${esc(l)}">${i} ${esc(l)}${x[k]>1||k.startsWith('serie')?' ×'+x[k]:''}</span>`);if(x.sempre&&nums.length>=3)chips.push('<span class="chip ok">✅ Sempre presente</span>');
      return`<div><b>${esc(pname(r.pid))}</b><div class="row" style="margin-top:4px">${chips.join('')||'<span class="small muted">Ancora nessuna medaglia</span>'}</div></div>`}).join('')}
    <details class="small muted"><summary>Cosa vuol dire ogni medaglia</summary>${BADGES.map(([k,i,l,d])=>`<div>${i} <b>${esc(l)}</b>: ${esc(d)}</div>`).join('')}<div>✅ <b>Sempre presente</b>: nessuna schedina mancata</div></details></section>`}

/* ---------- stagioni: albo d'oro e chiusura della stagione ---------- */
let stagioni=[];
const seasonLabel=()=>{const d=new Date();const y=d.getMonth()>=6?d.getFullYear():d.getFullYear()-1;return`${y}/${String(y+1).slice(2)}`};
function viewAlbo(){
  let h=`<section class="sheet"><h3>Albo d'oro</h3>`;
  if(!stagioni.length)h+=`<div class="small muted">Qui finiscono le stagioni chiuse, con la classifica finale.</div>`;
  stagioni.forEach(st=>{const c=st.classifica||[];const open=ui.albo===st.id;
    h+=`<div><div class="row spread"><div><b>Stagione ${esc(st.label||st.id)}</b> · 🏆 ${esc(c[0]?.name||'—')} ${c[0]?fmtN(c[0].tot):''}${c[1]?` · 2° ${esc(c[1].name)}`:''}${c[2]?` · 3° ${esc(c[2].name)}`:''}</div><button class="btn small" data-act="albo" data-id="${esc(st.id)}">${open?'Chiudi':'Classifica'}</button></div>
      ${open?`<div class="scroll"><table><thead><tr><th>#</th><th class="l">Giocatore</th><th>Punti</th><th>Record</th><th>Esatti</th></tr></thead><tbody>${c.map(r=>`<tr class="${r.rank===1?'lead':''}"><td class="rank">${r.rank}</td><td class="l"><b>${esc(r.name)}</b></td><td class="pts">${fmtN(r.tot)}</td><td>${fmtN(r.rec??0)}</td><td>${r.ex??0}</td></tr>`).join('')}</tbody></table></div><div class="small muted">${st.giornate||0} giornate · chiusa il ${esc(fmtDeadline(st.chiusa))}${st.golden?` · Golden Rule di ${esc(st.golden.name)} (G${st.golden.n})`:''}</div>`:''}</div>`});
  if(me.owner){
    h+=ui.confirmSeason?`<div class="sheet" style="border-color:var(--red)"><b>Chiudere la stagione ${esc(seasonLabel())}?</b><div class="small">La classifica finale va nell'albo d'oro e la lega riparte da zero: giornate, schedine, punti manuali e registro vengono tolti (una copia resta salvata nella stagione). I giocatori restano.</div><div class="row"><button class="btn danger" data-act="season-yes">Sì, chiudi e ricomincia</button><button class="btn" data-act="season-no">Annulla</button></div></div>`
      :`<div class="row"><button class="btn" data-act="season-ask">Chiudi la stagione e ricomincia da zero</button></div><div class="small muted">Da fare a fine campionato. Solo l'organizzatore lo vede.</div>`}
  return h+`</section>`}
async function closeSeason(){
  const label=seasonLabel();let sid=slug(label)||('s'+Date.now());if(stagioni.some(s=>s.id===sid))sid+='-'+Date.now().toString(36);
  const {rows,nums,golden}=standings();
  toast('Chiudo la stagione…');
  const snap={label,chiusa:new Date().toISOString(),giornate:nums.length,golden:golden?{n:golden.n,name:pname(golden.pid)}:null,rettifiche:JSON.parse(JSON.stringify(adj)),
    classifica:rows.map(r=>({name:pname(r.pid),pid:r.pid,tot:r.tot,rank:r.rank,rec:r.rec,x12:r.x12,ex:r.ex,adj:r.adj,per:Object.fromEntries(nums.map(n=>[n,r.per[n].total]))}))};
  await db.doc(`stagioni/${sid}`).raw(snap);
  // copia dei dati grezzi, poi si svuota la lega
  for(const n of Object.keys(rounds)){const g=gid(n);await db.doc(`stagioni/${sid}/giornate/${g}`).raw(JSON.parse(JSON.stringify(rounds[n])));}
  for(const [u,byN] of Object.entries(slips))for(const n of Object.keys(byN||{})){if(!byN[n])continue;await db.doc(`stagioni/${sid}/schedine/${u}_${gid(n)}`).raw(JSON.parse(JSON.stringify(byN[n])));await db.doc(`schedine/${u}/giornate/${gid(n)}`).del().catch(()=>{})}
  for(const n of Object.keys(rounds))await db.doc('giornate/'+gid(n)).del();
  for(const id of Object.keys(registro||{}))await db.doc('registro/'+id).del().catch(()=>{});
  adj=[];await db.doc('fantabet/rettifiche').raw({items:[]});
  // riparte con le giornate di Serie A ancora da giocare (come una lega nuova)
  try{const sa=await db.collection('serieA').get();
    for(const d of sa){const r=d.data;if(r.calcolata)continue;const{deadlineTs,...rest}=r;const ts=deadlineTsOf(rest.deadline);
      await db.doc('giornate/'+d.id).raw({...rest,preds:{},calcolata:false,...(ts?{deadlineTs:ts}:{})})}}catch(e){}
  ui.confirmSeason=false;ui.g=null;toast('Stagione chiusa: la trovi nell\'albo d\'oro. Si riparte da zero!');render()}

/* ---------- condividi su WhatsApp: classifica e invito alla lega ---------- */
const APP_URL='https://fanta-bet-serie-a.web.app';
let curLeague={id:'',nome:''};
function shareCard(){if(!curLeague.id)return'';
  return`<section class="sheet"><h2>Condividi</h2><div class="small muted">Si apre WhatsApp con il messaggio già scritto: scegli tu a chi mandarlo.</div><div class="row"><button class="btn primary" data-act="share-standings">Condividi la classifica</button><button class="btn" data-act="share-invite">Invita amici nella lega</button></div></section>`}
function shareText(kind){
  if(kind==='invite')return`Ti invito nella mia lega «${curLeague.nome}» su Fanta Bet Serie A! ⚽\nApri ${APP_URL}/?lega=${encodeURIComponent(curLeague.id)} , accedi con Google e scrivi la password della lega (te la do io).`;
  const {rows,nums}=standings();
  return`🏆 Fanta Bet · ${curLeague.nome}\nClassifica dopo ${nums.length} giornat${nums.length===1?'a':'e'}:\n`+rows.map(r=>`${r.rank}. ${pname(r.pid)} ${fmtN(r.tot)}`).join('\n')+`\n\n${APP_URL}`}
function shareWA(text){window.open('https://wa.me/?text='+encodeURIComponent(text),'_blank','noopener')}
function viewStandings(){return viewStandingsMain()+(dbState==='loading'?'':viewAlbo())+shareCard()}
function viewStandingsMain(){
  if(dbState==='loading')return`<div class="sheet empty">Carico la classifica…</div>`;
  const {rows,nums,golden}=standings();
  let h='';
  if(golden)h+=`<div class="golden"><b>Golden Rule · ${esc(pname(golden.pid))} vince il torneo</b><div class="small">10 esiti su 10 nella giornata ${golden.n}. Il campionato finisce per manifesta superiorità${golden.tie?' (spareggio deciso sul punteggio di giornata).':'.'}</div></div>`;
  h+=`<section class="sheet"><div class="row spread"><h2>Classifica generale</h2><span class="chip">${nums.length} / 38 giornate</span></div>`;
  const hasAdj=adj.length>0;
  if(!nums.length&&!hasAdj){
    const g=currentG();const r=rounds[g];
    h+=`<div class="empty"><div>Nessuna giornata ancora calcolata.</div><div class="small">${r?`Inserite i pronostici della giornata ${g}${r.deadline?' entro '+esc(fmtDeadline(r.deadline)):''}, poi a fine turno aggiornate i risultati e confermate i punti.`:'Crea la prima giornata dalla scheda Giornata.'}</div><button class="btn primary" data-act="go-round">Vai alla giornata ${g}</button></div>`;
  }else{
    h+=`<div class="scroll"><table><thead><tr><th>#</th><th class="l">Giocatore</th><th>Punti</th><th>Ultima</th><th>Record</th><th>Punti 1X2</th><th>Esatti</th>${hasAdj?'<th>Manuali</th>':''}</tr></thead><tbody>`;
    const last=nums[nums.length-1];
    rows.forEach(r=>{const l=r.per[last]?.total??0;
      h+=`<tr class="${r.rank===1?'lead':''}"><td class="rank">${r.rank}</td><td class="l"><b>${esc(pname(r.pid))}</b></td><td class="pts">${fmtN(r.tot)}${r.tot<rows[0].tot?`<div class="gap">−${fmtN(r1(rows[0].tot-r.tot))}</div>`:''}</td><td class="${l<0?'neg':'pos'}">${fmt(l)}</td><td>${fmtN(r.rec??0)}</td><td>${fmtN(r.x12)}</td><td>${r.ex}</td>${hasAdj?`<td class="${r.adj<0?'neg':r.adj>0?'pos':''}">${r.adj?fmt(r.adj):'—'}</td>`:''}</tr>`});
    h+=`</tbody></table></div><div class="small muted">Parità: record di giornata, poi punti 1X2, poi risultati esatti presi, poi sorteggio o partita secca.</div>`;
  }
  h+=`</section>`;
  if(nums.length){
    h+=`<section class="sheet"><h3>Punti per giornata</h3><div class="scroll"><table><thead><tr><th class="l">Giornata</th>${PIDS.map(p=>`<th>${esc(pname(p))}</th>`).join('')}</tr></thead><tbody>`;
    [...nums].reverse().forEach(n=>{h+=`<tr><td class="l"><button class="btn small" data-act="open-round" data-n="${n}">G${n}</button></td>${PIDS.map(p=>{const s=rows.find(r=>r.pid===p).per[n];return`<td class="${s.total<0?'neg':''}">${s.state==='mancato'?'<span class="chip bad">−50</span>':fmtN(s.total)}${s.golden?' <span class="chip gold">10/10</span>':''}</td>`}).join('')}</tr>`});
    h+=`</tbody></table></div></section>`;
    h+=viewTrend(rows,nums)+viewStats(rows,nums)+viewAwards(rows,nums);
    h+=viewX12Totals(rows,nums);
    h+=viewScorerTotals(rows,nums);
    h+=viewExactTotals(rows,nums);
  }
  if(!me.owner)return h+(me.id&&!myPid()?joinCard():'')+viewLog();
  h+=`<section class="sheet"><h3>Punti manuali</h3><div class="small muted">Aggiungi o togli punti a un giocatore (bonus, penalità, correzioni). Contano nel totale ma non nel record di giornata né nei punti 1X2.</div>
    <div class="row"><select id="adj-p" aria-label="Giocatore">${PIDS.map(p=>`<option value="${p}">${esc(pname(p))}</option>`).join('')}</select><input type="number" id="adj-pts" step="0.5" placeholder="±pt" aria-label="Punti (negativi per togliere)" style="width:5.5em"><input type="text" id="adj-why" placeholder="Motivo" aria-label="Motivo" style="flex:1 1 140px"><button class="btn primary" data-act="add-adj">Aggiungi</button></div>`;
  if(adj.length){h+=`<div class="scroll"><table><tbody>${adj.map((a,i)=>`<tr><td class="l"><b>${esc(pname(a.pid))}</b><div class="small muted">${esc(a.why||'Senza motivo')} · ${esc(fmtDeadline(a.at))}</div></td><td class="pts ${a.pts<0?'neg':'pos'}">${fmt(+a.pts)}</td><td>${ui.confirmDelAdj===i?`<button class="btn danger" data-act="del-adj" data-i="${i}">Elimina</button> <button class="btn" data-act="del-adj-no">No</button>`:`<button class="btn danger" data-act="ask-del-adj" data-i="${i}" aria-label="Elimina">✕</button>`}</td></tr>`).join('')}</tbody></table></div>`}
  h+=`</section>`;
  h+=viewPlayers()+viewLog();
  return h}
/* 1X2 outcomes each player got right over the calculated rounds, with their best single round */
function viewX12Totals(rows,nums){
  const t=PIDS.map(pid=>{const row=rows.find(r=>r.pid===pid);let hits=0,pts=0,rec=null,recN=[];
    for(const n of nums){const s=row.per[n];if(!s)continue;pts+=s.x12;if(s.state!=='consegnato')continue;hits+=s.hits;
      if(rec===null||s.hits>rec){rec=s.hits;recN=[n]}else if(s.hits===rec)recN.push(n)}
    return{pid,hits,pts:r1(pts),rec,recN}}).sort((a,b)=>b.hits-a.hits||(b.rec??0)-(a.rec??0)||b.pts-a.pts);
  return`<section class="sheet"><h3>Classifica 1X2</h3><div class="scroll"><table><thead><tr><th class="l">Giocatore</th><th>Presi</th><th>Record</th><th>Punti</th></tr></thead><tbody>${t.map(x=>`<tr><td class="l"><b>${esc(pname(x.pid))}</b><div class="small muted" style="white-space:normal">${x.rec===null?'Nessuna schedina':`Record ${x.rec}/10 in ${x.recN.map(n=>'G'+n).join(', ')}`}</div></td><td class="pts">${x.hits}</td><td>${x.rec??'—'}</td><td>${fmtN(x.pts)}</td></tr>`).join('')}</tbody></table></div><div class="small muted">Presi: esiti 1X2 indovinati in tutto. Record: più esiti presi in una sola giornata. Punti: punti 1X2, compresi i −50 delle schedine non consegnate.</div></section>`}
/* exact scores each player got right over the calculated rounds, without naming the matches */
function viewExactTotals(rows,nums){
  const t=PIDS.map(pid=>{const row=rows.find(r=>r.pid===pid);let hits=0,tried=0,pts=0;const by={};
    for(const n of nums){const s=row.per[n];if(!s||s.state!=='consegnato')continue;pts+=s.exact;
      for(const x of s.exactRows){if(['preso','sbagliato'].includes(x.state))tried++;if(x.state==='preso'){hits++;const k=`${+x.e.h}-${+x.e.a}`;by[k]=(by[k]||0)+1}}}
    const list=Object.entries(by).sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]));
    return{pid,hits,tried,pts:r1(pts),list}}).sort((a,b)=>b.hits-a.hits||b.pts-a.pts);
  return`<section class="sheet"><h3>Risultati esatti totali</h3><div class="scroll"><table><thead><tr><th class="l">Giocatore</th><th>Presi</th><th>Punti</th></tr></thead><tbody>${t.map(x=>`<tr><td class="l"><b>${esc(pname(x.pid))}</b><div class="small muted" style="white-space:normal">${x.list.length?x.list.map(([k,c])=>c>1?`${k} ×${c}`:k).join(', '):'Nessun esatto'}</div></td><td class="pts">${x.hits}</td><td>${fmtN(x.pts)}</td></tr>`).join('')}</tbody></table></div><div class="small muted">Presi: risultati esatti indovinati. Punti: punti presi con gli esatti.</div></section>`}
/* goals scored by each player's picked scorers over the calculated rounds */
function viewScorerTotals(rows,nums){
  const t=PIDS.map(pid=>{const row=rows.find(r=>r.pid===pid);let goals=0,hits=0,pts=0;const by={};
    for(const n of nums){const s=row.per[n];if(!s||s.state!=='consegnato')continue;pts+=s.sc;
      for(const x of s.scRows)if(x.state==='segna'){goals+=x.goals;hits++;const k=x.s.name.trim();by[k]=(by[k]||0)+x.goals}}
    const top=Object.entries(by).sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])).slice(0,3);
    return{pid,goals,hits,pts:r1(pts),top}}).sort((a,b)=>b.goals-a.goals||b.pts-a.pts);
  return`<section class="sheet"><h3>Marcatori totali</h3><div class="scroll"><table><thead><tr><th class="l">Giocatore</th><th>Gol</th><th>A segno</th><th>Punti</th></tr></thead><tbody>${t.map(x=>`<tr><td class="l"><b>${esc(pname(x.pid))}</b><div class="small muted" style="white-space:normal">${x.top.length?x.top.map(([k,g])=>`${esc(k)} ${g}`).join(', '):'Nessun gol'}</div></td><td class="pts">${x.goals}</td><td>${x.hits}</td><td>${fmtN(x.pts)}</td></tr>`).join('')}</tbody></table></div><div class="small muted">Gol segnati dai marcatori scelti nelle giornate calcolate. A segno: quanti marcatori scelti hanno segnato. Punti: punti presi con i marcatori.</div></section>`}
/* owner only: names, which account plays each slot, people waiting to join */
function viewPlayers(){
  const ids=[...new Set([...Object.values(cfg.members||{}),...requests,me.id].filter(Boolean))];
  const who=u=>u===me.id?'Tu':(profs[u]?.name||'Partecipante senza nome');
  const free=ids.filter(u=>!pidOf(u));
  let h=`<section class="sheet"><div class="row spread"><h3>Giocatori</h3>${ui.confirmAdd?`<span class="row"><span class="small">Aggiungere un nuovo giocatore?</span><button class="btn primary" data-act="add-player">Aggiungi</button><button class="btn" data-act="add-player-no">Annulla</button></span>`:'<button class="btn" data-act="ask-add-player">+ Aggiungi giocatore</button>'}</div>
  <div class="small muted">Collega ogni giocatore all'account Google di chi gioca: da lì compila e consegna da solo la sua schedina. Chi entra con nome della lega e password viene aggiunto da solo; qui puoi rinominare o ricollegare gli account.</div>`;
  PIDS.forEach(p=>{const u=memberOf(p);
    h+=`<div class="plink"><input type="text" id="name-${p}" data-f="pname" data-p="${p}" value="${esc(pname(p))}" aria-label="Nome ${p}">
    <select id="link-${p}" data-f="link" data-p="${p}" aria-label="Account di ${esc(pname(p))}"><option value="">Nessun account</option>${(u?[u]:[]).concat(free).map(x=>`<option value="${esc(x)}" ${x===u?'selected':''}>${esc(who(x))}</option>`).join('')}</select>
    <span class="chip ${u?'ok':''}">${u?'collegato':'manuale'}</span></div>`});
  const waiting=requests.filter(u=>!pidOf(u));
  h+=waiting.length?`<div class="small"><b>In attesa di essere collegati:</b> ${waiting.map(u=>esc(who(u))).join(', ')}. Sceglili nel menu accanto al giocatore giusto.</div>`:'<div class="small muted">Nessuna richiesta in attesa.</div>';
  return h+`</section>`}

function fmtDeadline(iso){try{return new Date(iso).toLocaleString('it-IT',{timeZone:'Europe/Rome',weekday:'short',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})}catch(e){return iso}}

function viewRound(){
  if(dbState==='loading')return`<div class="sheet empty">Carico la giornata…</div>`;
  const n=currentG();const r=rounds[n];
  let h=`<div class="rhead"><button class="arrow" data-act="prev" aria-label="Giornata precedente" ${n<=1?'disabled':''}>‹</button><div class="gnum">Giornata ${n}</div><button class="arrow" data-act="next" aria-label="Giornata successiva" ${n>=38?'disabled':''}>›</button>
    ${r?(r.calcolata?'<span class="chip ok">Calcolata</span>':(pastDl(r)?'<span class="chip">Chiusa</span>':'<span class="chip">Aperta</span>')):''}</div>`;
  if(pushSt==='off'&&!pushNo())h+=`<section class="sheet"><div class="row spread"><div><b>Vuoi le notifiche?</b><div class="small muted">Giornata aperta, promemoria prima della scadenza, 1X2, risultati esatti e marcatori presi.</div></div><div class="row"><button class="btn primary" data-act="push-on">Attiva</button><button class="btn" data-act="push-no">No grazie</button></div></div></section>`;
  if(!r){return h+`<section class="sheet empty"><div>La giornata ${n} non è ancora stata creata.</div>${me.owner?`<div class="small">L'aggiornamento automatico crea da solo la prossima giornata con il calendario ufficiale. Se vuoi, creala vuota e scrivi le partite a mano.</div><div class="row" style="justify-content:center"><button class="btn" data-act="create">Crea vuota</button></div>`:'<div class="small">La crea l\'organizzatore (o l\'aggiornamento automatico): appena è pronta compare qui.</div>'}${autoMsg(n)}</section>`}
  if(r.deadline){const past=new Date(r.deadline)<new Date();h+=`<div class="small ${past?'muted':''}">Consegna pronostici entro <b>${esc(fmtDeadline(r.deadline))}</b>${past?' · chiusa':''}</div>`}
  if(ui.sub!=='pronostici')h+=autoBar(n,r);
  h+=`<div class="seg" role="tablist">${[['pronostici','Pronostici'],['partite','Risultati'],['punteggi','Punteggi']].map(([k,l])=>`<button data-act="sub" data-k="${k}" aria-pressed="${ui.sub===k}">${l}</button>`).join('')}</div>`;
  if(ui.sub==='partite')h+=viewResults(r,n);
  else if(ui.sub==='pronostici')h+=viewPreds(r,n);
  else h+=viewScores(r,n);
  return h}

function viewResults(r,n){
  const lock=!me.owner;
  let h=`<section class="sheet"><div class="row spread"><h3>Partite e risultati al 90°</h3>${lock?'':`<button class="btn small" data-act="edit-teams">${ui.editTeams?'Fatto':'Modifica squadre'}</button>`}</div><div>`;
  r.matches.forEach((m,i)=>{
    const dis=lock?'disabled':'';
    h+=`<div class="match ${m.nullo?'void':''}"><span class="idx">${i+1}</span>`;
    if(ui.editTeams&&!lock)h+=`<input type="text" id="home-${i}" data-f="home" data-i="${i}" value="${esc(m.home)}" placeholder="Casa" aria-label="Squadra di casa ${i+1}"><span class="muted">–</span><input type="text" id="away-${i}" data-f="away" data-i="${i}" value="${esc(m.away)}" placeholder="Ospite" aria-label="Squadra ospite ${i+1}">`;
    else h+=`<span class="home">${esc(m.home)||'—'}</span><span class="score"><input type="number" inputmode="numeric" min="0" id="hg-${i}" data-f="hg" data-i="${i}" value="${isNum(m.hg)?m.hg:''}" aria-label="Gol ${esc(m.home)}" ${dis||m.nullo?'disabled':''}><span>–</span><input type="number" inputmode="numeric" min="0" id="ag-${i}" data-f="ag" data-i="${i}" value="${isNum(m.ag)?m.ag:''}" aria-label="Gol ${esc(m.away)}" ${dis||m.nullo?'disabled':''}></span><span class="away">${esc(m.away)||'—'}</span>`;
    h+=`<div class="meta"><span>${esc(m.when||'')}</span><label class="check"><input type="checkbox" id="nullo-${i}" data-f="nullo" data-i="${i}" ${m.nullo?'checked':''} ${dis}>Rinviata, pronostico nullo</label></div></div>`});
  h+=`</div>${ui.editTeams&&!lock?`<div class="row"><label class="small muted" for="dl-in">Scadenza consegna</label><input type="datetime-local" id="dl-in" data-f="deadline" value="${esc(toLocalInput(r.deadline))}"></div>`:''}</section>`;
  h+=`<section class="sheet"><div class="row spread"><h3>Marcatori</h3><span class="small muted">Autogol esclusi</span></div>`;
  if(!r.scorers.length)h+=`<div class="small muted">${lock?'Ancora nessun marcatore.':'Ancora nessun marcatore. Arrivano con l\'aggiornamento automatico, oppure aggiungili a mano.'}</div>`;
  r.scorers.forEach((s,i)=>{h+=`<div class="scorer-line"><input type="text" id="sn-${i}" data-f="sname" data-i="${i}" value="${esc(s.name)}" placeholder="Cognome" aria-label="Marcatore" ${lock?'disabled':''}><input class="team" type="text" id="st-${i}" data-f="steam" data-i="${i}" value="${esc(s.team||'')}" placeholder="Squadra" aria-label="Squadra" ${lock?'disabled':''}><input type="number" inputmode="numeric" min="1" id="sg-${i}" data-f="sgoals" data-i="${i}" value="${s.goals||1}" aria-label="Gol" ${lock?'disabled':''}><button class="btn danger" data-act="del-scorer" data-i="${i}" aria-label="Rimuovi" ${lock?'disabled':''}>✕</button></div>`});
  if(!lock)h+=`<div><button class="btn" data-act="add-scorer">+ Aggiungi marcatore</button></div>`;
  h+=`</section>`;
  return h}

function joinCard(){
  if(!me.id)return`<section class="sheet empty"><div>Per giocare accedi con Google.</div></section>`;
  const asked=requests.includes(me.id);
  return`<section class="sheet empty"><div><b>Non sei ancora in gara.</b></div><div class="small">${asked?'Richiesta inviata: l\'organizzatore deve collegare il tuo account a un giocatore. La pagina si aggiorna da sola.':'Chiedi all\'organizzatore di collegare il tuo account a un giocatore: dopo potrai compilare e consegnare la tua schedina.'}</div>${asked?'':'<button class="btn primary" data-act="join">Chiedi di partecipare</button>'}</section>`}
function viewPreds(r,n){
  const mine=myPid();
  if(!me.owner&&!mine)return joinCard();
  const hide=!revealed(r);
  if(!me.owner&&(hide||!PIDS.includes(ui.player)))ui.player=mine;
  const pid=PIDS.includes(ui.player)?ui.player:(mine||PIDS[0]);const pasteBox=()=>'';const p=getPred(r,pid);const lock=slipLocked(r,pid);const dis=lock?'disabled':'';
  const linked=!!memberOf(pid);const cl=clashes(r,pid);
  const stChip=q=>{const g=getPred(r,q);return g.status==='consegnato'?' ✓':g.status==='mancato'?' ✕':''};
  let h='';
  if(me.owner||!hide)h+=`<div class="players" role="tablist" aria-label="Partecipanti">${PIDS.map(q=>`<button data-act="player" data-p="${q}" aria-pressed="${q===pid}">${esc(pname(q))}${stChip(q)}</button>`).join('')}</div>`;
  else h+=`<div class="row small muted">${PIDS.filter(q=>q!==mine).map(q=>`<span class="chip ${getPred(r,q).status==='consegnato'?'ok':''}">${esc(pname(q))} · ${getPred(r,q).status==='consegnato'?'consegnata':'in attesa'}</span>`).join('')}<span>Le schedine degli altri si vedono quando hanno consegnato tutti.</span></div>`;
  if(!canSee(r,pid))return h+hiddenSlip(r,pid);
  h+=`<section class="sheet"><div class="row spread"><h3>Schedina di ${esc(pname(pid))}</h3></div>`;
  if(me.owner&&(p.consegnata||(r.calcolata&&p.status)||pastDl(r))){const ul=!!ownerUnlocked[ukey(r,pid)];
    h+=`<div class="row">${p.consegnata&&p.status==='consegnato'?`<span class="chip ok">Consegnata ${esc(fmtDeadline(p.consegnata))}</span>`:r.calcolata?'<span class="chip">Giornata calcolata</span>':'<span class="chip">Scadenza passata</span>'}${ul?`<span class="chip gold">Sbloccata: le modifiche valgono subito</span><button class="btn" data-act="relock">Blocca di nuovo</button>`:`<button class="btn" data-act="owner-unlock">Sblocca per modificare</button>`}${p.consegnata&&!r.calcolata?(ui.confirmUnlock?`<span class="small">Ridare la schedina a ${esc(pname(pid))}? Dovrà consegnarla di nuovo.</span><button class="btn danger" data-act="unlock-yes">Riapri al giocatore</button><button class="btn" data-act="unlock-no">Annulla</button>`:`<button class="btn" data-act="unlock">Riapri al giocatore</button>`):''}</div>${ul&&r.calcolata?'<div class="small muted">Giornata già calcolata: punti e classifica si ricalcolano appena modifichi.</div>':''}`}
  else if(p.consegnata&&p.status==='consegnato')h+=`<div class="row"><span class="chip ok">Consegnata ${esc(fmtDeadline(p.consegnata))}</span><span class="small muted">Non è più modificabile.</span></div>`;
  else if(pastDl(r)&&!r.calcolata&&pid===mine)h+=`<div class="row"><span class="chip bad">Scadenza passata</span><span class="small muted">La schedina non può più essere inserita né modificata.</span></div>`;
  else if(!lock&&linked&&p.status!=='mancato')h+=`<div class="small muted">Bozza: ogni tocco si salva da solo. Quando hai finito premi «Consegna schedina»: dopo non potrai più modificarla.</div>`;
  else if(lock&&!p.status)h+=`<div class="small neg">${r.calcolata||!open?'Schedina non consegnata in tempo.':'Schedina non modificabile.'}</div>`;
  if(me.owner&&!linked)h+=`<div class="small muted">Giocatore senza account: la schedina la compili tu. Ogni tocco si salva da solo.</div>`;
  if(me.owner)h+=`<div class="seg">${[['consegnato','Consegnata'],['mancato','Non consegnata (−50)']].map(([k,l])=>`<button data-act="status" data-k="${k}" aria-pressed="${p.status===k}" ${dis}>${l}</button>`).join('')}</div>`;
  if(p.status==='mancato'){h+=`<div class="small muted">Mancata consegna: −50 punti, come fare 0 su 10.</div></section>`;return h+pasteBox()}
  h+=`<div class="slip"><span></span><span class="hdr" style="text-align:left">Partita</span><span class="hdr">1</span><span class="hdr">X</span><span class="hdr">2</span><span class="hdr">Esito</span>`;
  r.matches.forEach((m,i)=>{const v=validMatch(m);const out=v?outcome(m):null;
    h+=`<span class="idx">${i+1}</span><span class="teams">${esc(m.home)}<br>${esc(m.away)}</span>`;
    ['1','X','2'].forEach(o=>{h+=`<button class="cell ${v&&o===out?(p.x12[i]===o?'right':'actual'):''}" data-act="x12" data-i="${i}" data-o="${o}" aria-pressed="${p.x12[i]===o}" aria-label="Partita ${i+1}: ${o}" ${dis||m.nullo?'disabled':''}>${o}</button>`});
    h+=`<span class="res num">${m.nullo?'<span class="chip">null</span>':v?`${m.hg}-${m.ag}`:'·'}</span>`});
  h+=`</div></section>`;
  h+=`<section class="sheet"><h3>Risultati esatti · 3 a scelta</h3>`;
  p.exact.forEach((e,k)=>{const b=isNum(e.h)&&isNum(e.a)?exactBase(e.h,e.a):null;
    h+=`<div class="pick"><select id="exm-${k}" data-f="exm" data-k="${k}" aria-label="Partita risultato esatto ${k+1}" ${dis}><option value="-1">Scegli partita…</option>${r.matches.map((m,i)=>`<option value="${i}" ${+e.m===i?'selected':''}>${i+1}. ${esc(m.home)} – ${esc(m.away)}</option>`).join('')}</select>
    <span class="score row" style="flex-wrap:nowrap;gap:4px"><input type="number" inputmode="numeric" min="0" id="exh-${k}" data-f="exh" data-k="${k}" value="${isNum(e.h)?e.h:''}" aria-label="Gol casa" ${dis}><span>–</span><input type="number" inputmode="numeric" min="0" id="exa-${k}" data-f="exa" data-k="${k}" value="${isNum(e.a)?e.a:''}" aria-label="Gol ospite" ${dis}></span>
    <span class="chip">${b?`${b.c} ${b.p}`:'—'}</span></div>${cl.ex[k]?`<div class="small neg">Risultato già preso da ${esc(pname(cl.ex[k]))}: scegline un altro.</div>`:''}`});
  h+=`<div class="small muted">Standard 6 · Medio 12 · Folle 25. Due presi: somma ×2,5. Tre presi: somma ×6. Ogni risultato esatto può averlo un solo giocatore: vale chi lo consegna per primo.</div></section>`;
  h+=`<section class="sheet"><h3>Marcatori · 3 giocatori</h3>`;
  p.scorers.forEach((s,k)=>{h+=`<div class="scorer"><input type="text" id="scn-${k}" data-f="scn" data-k="${k}" value="${esc(s.name)}" placeholder="Cognome giocatore" aria-label="Marcatore ${k+1}" ${dis}><select id="scr-${k}" data-f="scr" data-k="${k}" aria-label="Ruolo" ${dis}>${Object.entries(ROLE).map(([c,o])=>`<option value="${c}" ${s.role===c?'selected':''}>${o.l} · ${o.p}</option>`).join('')}</select><span class="chip">${ROLE[s.role]?.p||4} pt</span></div>${cl.sc[k]?`<div class="small neg">${esc(s.name)} è già stato scelto da ${esc(pname(cl.sc[k]))}: scegline un altro.</div>`:''}`});
  h+=`<div class="small muted">Doppietta ×2, tripletta o più ×3. Se segnano tutti e tre: totale ×2,5. Chi non gioca prende 0. Ogni marcatore può averlo un solo giocatore: vale chi lo consegna per primo.</div></section>`;
  if(linked&&!lock&&p.status!=='consegnato'){
    const missing=r.matches.filter((m,i)=>!m.nullo&&!p.x12[i]).length;
    h+=`<section class="sheet"><div class="row">${ui.confirmDeliver?`<span>${missing?`Mancano ${missing} esiti 1X2. `:''}Dopo la consegna la schedina non sarà più modificabile. Confermi?</span><button class="btn primary" data-act="deliver-yes">Consegna</button><button class="btn" data-act="deliver-no">Annulla</button>`:`<button class="btn primary" data-act="deliver">Consegna schedina</button>${r.deadline?`<span class="small muted">entro ${esc(fmtDeadline(r.deadline))}</span>`:''}`}</div></section>`}
  return h+pasteBox()}
/* what everyone sees of a slip that is still hidden: only whether it was delivered; the owner can hand it back */
function hiddenSlip(r,pid){const p=getPred(r,pid);const done=p.status==='consegnato';
  let h=`<section class="sheet"><h3>Schedina di ${esc(pname(pid))}</h3><div class="row"><span class="chip ${done?'ok':''}">${done?'Consegnata'+(p.consegnata?' '+esc(fmtDeadline(p.consegnata)):''):'In attesa'}</span><span class="small muted">I pronostici si vedono quando hanno consegnato tutti.</span></div>`;
  if(me.owner&&done)h+=`<div class="row">${ui.confirmUnlock?`<span class="small">Ridare la schedina a ${esc(pname(pid))}? Dovrà consegnarla di nuovo.</span><button class="btn danger" data-act="unlock-yes">Riapri al giocatore</button><button class="btn" data-act="unlock-no">Annulla</button>`:`<button class="btn" data-act="unlock">Riapri al giocatore</button>`}</div>`;
  return h+`</section>`}


function viewScores(r,n){
  const pending=r.matches.filter(m=>!m.nullo&&!validMatch(m)).length;
  const missing=PIDS.filter(p=>!getPred(r,p).status);
  let h='';
  if(pending&&!r.calcolata)h+=`<div class="small muted">Punteggi provvisori: mancano ${pending} risultati.</div>`;
  h+=`<div class="cards">`;
  PIDS.filter(q=>canSee(r,q)).forEach(pid=>{const s=scoreRound(r,pid);
    h+=`<div class="card"><div class="row spread"><b>${esc(pname(pid))}</b>${s.golden?'<span class="chip gold">Golden Rule</span>':s.state==='mancato'?'<span class="chip bad">Non consegnata</span>':s.state==='vuoto'?'<span class="chip">Da inserire</span>':''}</div><div class="big num ${s.total<0?'neg':''}">${fmtN(s.total)}</div>`;
    if(s.state==='consegnato'){
      h+=`<div class="line"><span>1X2 · ${s.hits}/${s.valid} presi</span><span class="${s.x12<0?'neg':''}">${s.golden?'10/10':fmt(s.x12)}</span></div>`;
      h+=`<div class="line"><span>Esatti · ${s.exactHits}/3${s.exactHits>1?` ×${fmtN(MULT_EX[s.exactHits])}`:''}</span><span>${fmt(s.exact)}</span></div>`;
      h+=`<div class="detail">${s.exactRows.map(x=>x.state==='vuoto'?'':`<span>${esc(x.m?.home)}–${esc(x.m?.away)} ${x.e.h}-${x.e.a}: ${x.state==='preso'?`<b class="pos">preso ${x.b.p}</b>`:x.state==='nullo'?'nullo':x.state==='attesa'?'in attesa':x.state==='doppione'?'<span class="neg">partita già scelta, non conta</span>':x.state==='altrui'?`<span class="neg">già preso da ${esc(pname(x.by))}, non conta</span>`:'no'}</span>`).join('')}</div>`;
      h+=`<div class="line"><span>Marcatori${s.combo?' · combo ×2,5':''}</span><span>${fmt(s.sc)}</span></div>`;
      h+=`<div class="detail">${s.scRows.map(x=>x.state==='vuoto'?'':`<span>${esc(x.s.name)} (${ROLE[x.s.role]?.l[0]||'A'}): ${x.state==='doppione'?'<span class="neg">già scelto, non conta</span>':x.state==='altrui'?`<span class="neg">già preso da ${esc(pname(x.by))}, non conta</span>`:x.goals>0?`<b class="pos">${x.goals} gol, ${x.pts}</b>`:'0 gol'}${x.names.length>1?` <span class="small neg">attenzione, trovati più giocatori: ${esc(x.names.join(', '))}. Scrivi anche l'iniziale del nome</span>`:x.names.length&&x.names.join()!==x.s.name?` <span class="small">= ${esc(x.names.join(', '))}</span>`:''}</span>`).join('')}</div>`}
    h+=`</div>`});
  h+=`</div>`;
  if(!me.owner)return h+`<section class="sheet small muted">${r.calcolata?'Giornata confermata: i punti sono nella classifica generale.':'Punti provvisori: la giornata entra in classifica quando l\'organizzatore la conferma.'}</section>`;
  h+=`<section class="sheet">`;
  if(r.calcolata){
    h+=`<div>${PIDS.some(p=>getPred(r,p).status)?'Giornata confermata: i punti sono nella classifica generale. Se modifichi schedine o risultati, punti e classifica si ricalcolano subito.':'Giornata confermata ma senza schedine: entrerà in classifica appena inserisci i pronostici.'}</div><div class="row">${ui.confirmReopen?`<span class="small">Riaprire la giornata ${n}? I punti escono dalla classifica finché non la confermi di nuovo.</span><button class="btn danger" data-act="reopen-yes">Riapri</button><button class="btn" data-act="reopen-no">Annulla</button>`:`<button class="btn" data-act="reopen">Riapri per correggere</button>`}</div>`;
  }else{
    h+=`<div class="small muted">${missing.length?`Senza schedina: ${missing.map(p=>esc(pname(p))).join(', ')}. Alla conferma prenderanno −50.`:'Tutte le schedine sono inserite.'}${pending?` Mancano ${pending} risultati: se una partita è rinviata oltre il turno successivo segnala come nulla.`:''}</div><div><button class="btn primary" data-act="confirm">Conferma giornata e aggiorna classifica</button></div>`}
  h+=`</section>`;
  return h}

function viewRules(){
  const t=(rows,head)=>`<div class="scroll"><table class="rules"><thead><tr><th class="l">${head[0]}</th><th>${head[1]}</th></tr></thead><tbody>${rows.map(([a,b])=>`<tr><td class="l">${a}</td><td>${b}</td></tr>`).join('')}</tbody></table></div>`;
  return`<section class="sheet"><h2>Consegna</h2><div>Pronostici entro 1 minuto prima del fischio d'inizio del primo anticipo. Chi non consegna prende −50. Partite rinviate: se il recupero è prima del turno successivo si aspetta, altrimenti 1X2, risultato e marcatori su quella partita sono nulli. Chi non gioca (0 minuti) prende 0.</div></section>
  <section class="sheet"><h2>1X2 · 10 partite</h2>${t(X12.map((p,i)=>[`${i} presi`,fmt(p)]).concat([['10 presi','Golden Rule: vince il torneo']]),['Esiti','Punti'])}<div class="small muted">Doppio 10/10 nello stesso turno: vince chi ha più punti in quella giornata, poi chi era più in alto in classifica.</div></section>
  <section class="sheet"><h2>Risultati esatti · 3 a scelta</h2>${t([['Standard (0-2 gol)','6'],['Medio (3-4 gol)','12'],['Folle (5+ gol, o scarto di 4+)','25'],['2 su 3 presi','somma ×2,5'],['3 su 3 presi','somma ×6']],['Tipo','Punti'])}<div class="small muted">Valido al 90°, recupero incluso. Nessun malus.</div></section>
  <section class="sheet"><h2>Marcatori · 3 giocatori</h2>${t(Object.values(ROLE).map(o=>[o.l,o.p+' a gol']).concat([['Doppietta','base ×2'],['Tripletta o più','base ×3'],['Segnano tutti e 3','totale ×2,5']]),['Ruolo','Punti'])}<div class="small muted">Gli autogol non valgono.</div></section>
  <section class="sheet"><h2>Spareggi a fine anno</h2><div>Record di giornata, poi punti della sola colonna 1X2, poi risultati esatti presi, poi sorteggio o partita secca.</div></section>`}

/* ---------- events ---------- */
document.querySelector('.tabs').addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;ui.account=false;ui.tab=b.dataset.tab;saveUi();render();const v=$('#view');v.classList.remove('enter');void v.offsetWidth;v.classList.add('enter')});
$('#view').addEventListener('click',async e=>{
  const b=e.target.closest('[data-act]');if(!b)return;if(b.disabled){log('disabled-click',{act:b.dataset.act});return}const a=b.dataset.act;const n=currentG();const r=rounds[n];
  if(a==='go-round'){ui.tab='giornata';saveUi();render();return}
  if(a==='albo'){ui.albo=ui.albo===b.dataset.id?null:b.dataset.id;render();return}
  if(a==='season-ask'||a==='season-no'){if(!me.owner)return;ui.confirmSeason=a==='season-ask';render();return}
  if(a==='season-yes'){if(!me.owner)return;b.disabled=true;try{await closeSeason()}catch(err){toast(errMsg(err));ui.confirmSeason=false;render()}return}
  if(a==='share-standings'||a==='share-invite')return shareWA(shareText(a==='share-invite'?'invite':'standings'));
  if(a==='push-on'||a==='push-off'||a==='push-no'||a==='pref'||a==='acct-back'||a==='acct-logout')return accountAct(a,b);
  if(a==='chat-send')return sendChat();
  if(a==='join'){if(!db||!me.id)return;try{await db.doc('schedine/'+me.id).set({at:new Date().toISOString()});requests=[...new Set([...requests,me.id])];toast('Richiesta inviata all\'organizzatore.')}catch(err){toast(err?.code==='invalid_argument'?'Non hai il permesso di partecipare: chiedi all\'organizzatore di invitarti come Editor.':errMsg(err))}render();return}
  const ADMIN=['create','add-adj','ask-del-adj','del-adj','edit-teams','add-scorer','del-scorer','status','confirm','reopen','reopen-yes','add-player','ask-add-player','unlock','unlock-yes','owner-unlock','relock'];
  if(ADMIN.includes(a)&&!me.owner)return toast('Solo l\'organizzatore può farlo.');
  if(a==='ask-add-player'){ui.confirmAdd=true;render();return}
  if(a==='add-player-no'){ui.confirmAdd=false;render();return}
  if(a==='add-player'){ui.confirmAdd=false;const p=addPlayer();addLog(null,{pid:p,t:'Giocatore aggiunto',det:[]});render();const el=$('#name-'+p);el&&(el.focus(),el.select());return}
  if(a==='open-round'){ui.tab='giornata';ui.g=+b.dataset.n;ui.sub='punteggi';saveUi();render();return}
  if(a==='prev'||a==='next'){ui.g=Math.min(38,Math.max(1,n+(a==='next'?1:-1)));ui.editTeams=false;ui.confirmReopen=false;saveUi();render();return}
  if(a==='create'){rounds[n]=emptyRound(n);ui.editTeams=true;ui.sub='partite';saveRound(n,'*',true);render();return}
  if(a==='sub'){ui.sub=b.dataset.k;ui.confirmReopen=false;saveUi();render();return}
  if(a==='player'){ui.player=b.dataset.p;ui.confirmDeliver=ui.confirmUnlock=false;saveUi();render();return}
  if(a==='add-adj'){const pts=parseFloat(String($('#adj-pts').value).replace(',','.'));if(!isFinite(pts)||pts===0)return toast('Scrivi quanti punti aggiungere (negativi per toglierli).');
    adj=[...adj,{pid:$('#adj-p').value,pts:r1(pts),why:$('#adj-why').value.trim(),at:new Date().toISOString()}];saveAdj();addLog(null,{pid:$('#adj-p').value,t:`Punti manuali ${fmt(r1(pts))}`,det:[$('#adj-why').value.trim()||'senza motivo']});toast(`${fmt(r1(pts))} punti a ${pname($('#adj-p').value)}.`);render();return}
  if(a==='ask-del-adj'){ui.confirmDelAdj=+b.dataset.i;render();return}
  if(a==='del-adj-no'){ui.confirmDelAdj=null;render();return}
  if(a==='del-adj'){const x=adj[+b.dataset.i];if(x)addLog(null,{pid:x.pid,t:`Punti manuali eliminati (${fmt(+x.pts)})`,det:[x.why||'senza motivo']});adj=adj.filter((_,i)=>i!==+b.dataset.i);ui.confirmDelAdj=null;saveAdj();render();return}
  if(!r)return;
  if(a==='edit-teams'){ui.editTeams=!ui.editTeams;render();return}
  if(a==='add-scorer'){r.scorers.push({name:'',team:'',goals:1});saveRound(n,'scorers');render();const el=$('#sn-'+(r.scorers.length-1));el&&el.focus();return}
  if(a==='del-scorer'){r.scorers.splice(+b.dataset.i,1);saveRound(n,'scorers');render();return}
  if(a==='status'){if(slipLocked(r,ui.player))return toast('Schedina bloccata: premi «Sblocca per modificare».');trackEdit(r,ui.player);const p=ensurePred(r,ui.player);p.status=b.dataset.k;markDelivered(r,p);savePred(n,ui.player);render();return}
  if(a==='x12'){log('x12-handler',{n,has:!!r,player:ui.player});if(slipLocked(r,ui.player))return toast('Schedina non più modificabile.');trackEdit(r,ui.player);const p=ensurePred(r,ui.player);const i=+b.dataset.i;p.x12[i]=p.x12[i]===b.dataset.o?'':b.dataset.o;if(!p.status&&me.owner&&!memberOf(ui.player))p.status='consegnato';markDelivered(r,p);savePred(n,ui.player);render();document.querySelector(`.cell[data-i="${i}"][data-o="${b.dataset.o}"]`)?.classList.add('pop');return}
  if(a==='deliver'){ui.confirmDeliver=true;render();return}
  if(a==='deliver-no'){ui.confirmDeliver=false;render();return}
  if(a==='deliver-yes'){ui.confirmDeliver=false;return deliver(n,ui.player)}
  if(a==='owner-unlock'){ownerUnlocked[ukey(r,ui.player)]=true;render();return}
  if(a==='relock'){delete ownerUnlocked[ukey(r,ui.player)];render();return}
  if(a==='unlock'){ui.confirmUnlock=true;render();return}
  if(a==='unlock-no'){ui.confirmUnlock=false;render();return}
  if(a==='unlock-yes'){ui.confirmUnlock=false;addLog(n,{pid:ui.player,t:'Schedina riaperta al giocatore',det:[]});const p=ensurePred(r,ui.player);p.consegnata='';p.status='';savePred(n,ui.player,true);toast(`Schedina di ${pname(ui.player)} riaperta.`);render();return}
  if(a==='confirm'){r.calcolata=true;saveRound(n,'calcolata',true);toast(`Giornata ${n} confermata: classifica aggiornata.`);render();return}
  if(a==='reopen'){ui.confirmReopen=true;render();return}
  if(a==='reopen-no'){ui.confirmReopen=false;render();return}
  if(a==='reopen-yes'){ui.confirmReopen=false;r.calcolata=false;saveRound(n,'calcolata',true);render();return}
});

$('#view').addEventListener('input',e=>{const el=e.target;if(el.dataset.f==='pname'&&el.value.trim())setName(el.dataset.p,el.value.trim())});
$('#view').addEventListener('change',e=>{
  const el=e.target;const f=el.dataset.f;if(!f)return;
  if((f==='pname'||f==='link')&&!me.owner)return;
  if(f==='pname'){setName(el.dataset.p,el.value.trim()||('Giocatore '+el.dataset.p.slice(1)));requestRender();return}
  if(f==='link'){addLog(null,{pid:el.dataset.p,t:el.value?'Account collegato':'Account scollegato',det:el.value?[]:['ora la schedina la compila l\'organizzatore']});linkMember(el.dataset.p,el.value||null);toast(el.value?`Account collegato a ${pname(el.dataset.p)}.`:`${pname(el.dataset.p)} ora la compili tu.`);requestRender();return}
  const n=currentG();const r=rounds[n];if(!r)return;
  if(f==='deadline'){if(!me.owner)return;r.deadline=el.value?new Date(el.value).toISOString():'';saveRound(n,'deadline');requestRender();return}
  const i=+el.dataset.i,k=+el.dataset.k;const val=el.value;
  const field=['home','away','hg','ag','nullo'].includes(f)?'matches':['sname','steam','sgoals'].includes(f)?'scorers':'preds';
  if(field!=='preds'&&!me.owner)return;if(field==='preds'&&slipLocked(r,ui.player)){toast('Schedina non più modificabile.');return requestRender()}
  const num=val===''?null:Math.max(0,parseInt(val,10)||0);
  if(f==='home'||f==='away')r.matches[i][f]=val.trim();
  else if(f==='hg'||f==='ag')r.matches[i][f]=num;
  else if(f==='nullo')r.matches[i].nullo=el.checked;
  else if(f==='sname')r.scorers[i].name=val.trim();
  else if(f==='steam')r.scorers[i].team=val.trim();
  else if(f==='sgoals')r.scorers[i].goals=Math.max(1,num||1);
  else{trackEdit(r,ui.player);const p=ensurePred(r,ui.player);if(!p.status&&me.owner&&!memberOf(ui.player))p.status='consegnato';markDelivered(r,p);
    if(f==='exm')p.exact[k].m=+val;else if(f==='exh')p.exact[k].h=num??'';else if(f==='exa')p.exact[k].a=num??'';
    else if(f==='scn')p.scorers[k].name=val.trim();else if(f==='scr')p.scorers[k].role=val}
  if(field==='preds')savePred(n,ui.player);else saveRound(n,field);requestRender()});
function markDelivered(r,p){if(p.status==='consegnato'&&!p.consegnata&&!r.calcolata)p.consegnata=new Date().toISOString()}
async function deliver(n,pid){
  const r=rounds[n];if(!r||slipLocked(r,pid))return toast('Schedina non più modificabile.');
  const cl=clashes(r,pid);const p0=getPred(r,pid);
  const bad=[...Object.entries(cl.ex).map(([k,q])=>{const e=p0.exact[k],m=r.matches[e.m];return`il risultato ${m?.home||''}–${m?.away||''} ${e.h}-${e.a} è già di ${pname(q)}`}),...Object.entries(cl.sc).map(([k,q])=>`${p0.scorers[k].name} è già di ${pname(q)}`)];
  if(bad.length){render();return toast('Non puoi consegnare: '+bad.join('; ')+'. Cambia le scelte segnate in rosso.')}
  const p=ensurePred(r,pid);p.status='consegnato';p.consegnata=new Date().toISOString();
  const u=memberOf(pid);render();
  const ok=u?await writeSlip(u,n):(saveRound(n,'preds',true),true);
  if(ok)toast(`Schedina di ${pname(pid)} consegnata.`);else{p.status='';p.consegnata='';render()}}


let toastT;function toast(m){const t=$('#toast');t.textContent=m;t.hidden=false;clearTimeout(toastT);toastT=setTimeout(()=>t.hidden=true,Math.max(3800,m.length*70))}

/* ---------- aggiornamento automatico (script esterno che scrive fantabet/stato) ---------- */
function autoMsg(n){const st=stato&&+stato.giornata===n?stato:null;if(!st)return'';
  return`<div class="small ${st.stato==='errore'?'neg':'muted'}">${st.stato==='errore'?'Ultimo aggiornamento automatico non riuscito: ':'Aggiornamento automatico · '+esc(fmtDeadline(st.finito||st.richiesta))+': '}${esc(st.messaggio||'')}</div>`}
function autoBar(n,r){
  return`<section class="sheet"><h3>Risultati automatici</h3><div class="small muted">Risultati e marcatori arrivano da soli (controllo ogni 20 minuti nei giorni di partita). ${r.calcolata?'Giornata confermata in classifica.':'Quando tutte le partite sono finite la giornata entra in classifica da sola.'}${me.owner?' Puoi sempre correggere a mano qui sotto: le correzioni manuali non vengono sovrascritte.':''}</div>${autoMsg(n)}</section>`}
function toLocalInput(iso){if(!iso)return'';const d=new Date(iso);if(isNaN(d))return'';return new Date(d.getTime()-d.getTimezoneOffset()*6e4).toISOString().slice(0,16)}

/* ---------- boot: login Google, poi ascolto dei dati su Firestore ---------- */
function refreshChatProfiles(){}function refreshProfiles(){}
function loginView(msg){
  $('#view').innerHTML=`<section class="sheet empty"><div><b>Benvenuto in Fanta Bet Serie A</b></div><div class="small">Accedi con il tuo account Google per vedere la classifica e giocare.</div><button class="btn primary" id="login-btn">Accedi con Google</button>${msg?`<div class="small neg">${esc(msg)}</div>`:''}</section>`;
  $('#login-btn').onclick=()=>login().catch(e=>loginView('Accesso non riuscito ('+(e?.code||'errore')+'). Riprova.'))}
document.getElementById('logout')?.addEventListener('click',()=>logout());
if(!configured){$('#view').innerHTML='<section class="sheet empty"><div>Configurazione Firebase mancante.</div><div class="small">Apri l\'app dal link <b>.web.app</b> dopo aver fatto <b>npm run deploy</b>.</div></section>';return}
let started=false;
watchUser(async u=>{
  const lo=document.getElementById('logout');if(lo)lo.hidden=!u;
  if(!u){if(started){location.reload();return}loginView();return}
  if(started)return;started=true;
  user=u;me={id:u.uid,owner:false,super:u.uid===SUPER_UID};db=fdb;
  const ab=document.getElementById('account-btn');if(ab){ab.hidden=false;ab.onclick=()=>openAccount()}
  pushStatus().then(st=>{pushSt=st;requestRender()}).catch(()=>{});
  db.doc('utenti/'+u.uid).onSnapshot(s=>{acct=s.data()||{};if(ui.account)refreshAccount()},()=>{});myName=u.displayName||'Partecipante';
  await db.doc('utenti/'+u.uid).set({name:myName,at:new Date().toISOString()}).catch(()=>{});
  let lid=null;try{lid=localStorage.getItem('fb-lega')}catch(e){}
  const inv=slug(new URLSearchParams(location.search).get('lega')||'');if(inv){lid=inv;invited=inv;try{history.replaceState(null,'',location.pathname)}catch(e){}}
  if(lid){try{setLeague(lid);const L=await db.doc('leghe/'+lid).get();const ok=L&&(me.super||L.owner===me.id||await db.doc('iscritti/'+me.id).get().then(x=>!!x).catch(()=>false));if(ok){openLeague(lid,L);return}}catch(e){}}
  setLeague(null);try{localStorage.removeItem('fb-lega')}catch(e){}
  leagueView();
});
/* ---------- scelta della lega ---------- */
let myName='',invited='';
async function leagueView(msg){
  const v=$('#view');document.querySelector('.tabs').hidden=true;
  let mine={};try{mine=(await db.doc('utenti/'+me.id).get())?.leghe||{}}catch(e){}
  const list=Object.entries(mine);
  v.innerHTML=`${me.super?`<section class="sheet"><div class="row spread"><h2>Super admin</h2><button class="btn primary" id="sa-go">Apri pannello</button></div><div class="small muted">Vedi tutte le leghe, gli utenti e l'aggiornamento automatico, ed entri in ogni lega come organizzatore.</div></section>`:''}${list.length?`<section class="sheet"><h2>Le tue leghe</h2><div class="players">${list.map(([id,n])=>`<button data-lega="${esc(id)}">${esc(n)}</button>`).join('')}</div></section>`:''}
  <section class="sheet"><h2>Entra in una lega</h2><div class="small muted">Scrivi il nome della lega e la password che ti ha dato l'organizzatore.</div>
    <div class="row"><input type="text" id="j-nome" placeholder="Nome della lega" style="flex:1 1 160px"><input type="password" id="j-pw" placeholder="Password" style="flex:1 1 140px"><button class="btn primary" id="j-go">Entra</button></div><div id="j-extra"></div></section>
  <section class="sheet"><h2>Crea una lega</h2><div class="small muted">Diventi l'organizzatore. Poi manda agli amici il link dell'app, il nome della lega e la password.</div>
    <div class="row"><input type="text" id="c-nome" placeholder="Nome della lega" style="flex:1 1 160px"><input type="password" id="c-pw" placeholder="Password (almeno 4 caratteri)" style="flex:1 1 140px"><button class="btn" id="c-go">Crea</button></div></section>
  ${msg?`<div class="small neg">${esc(msg)}</div>`:''}`;
  v.querySelectorAll('[data-lega]').forEach(b=>b.onclick=async()=>{setLeague(b.dataset.lega);const L=await db.doc('leghe/'+b.dataset.lega).get().catch(()=>null);if(!L)return leagueView('Questa lega non esiste più.');openLeague(b.dataset.lega,L)});
  if(me.super)$('#sa-go').onclick=()=>superView();
  if(invited){const id=invited;invited='';db.doc('leghe/'+id).get().then(L=>{if(!L)return;const n=$('#j-nome');if(n&&!n.value){n.value=L.nome||id;$('#j-pw')?.focus();$('#j-extra').innerHTML=`<div class="small" style="margin-top:6px">Sei stato invitato nella lega <b>${esc(L.nome||id)}</b>: scrivi la password che ti hanno dato.</div>`}}).catch(()=>{})}
  $('#j-go').onclick=()=>joinLeague($('#j-nome').value,$('#j-pw').value).catch(e=>leagueView(e.msg||('Errore: '+(e?.code||e?.message||e))));
  $('#c-go').onclick=()=>createLeague($('#c-nome').value,$('#c-pw').value).catch(e=>leagueView(e.msg||('Errore: '+(e?.code||e?.message||e))));
}
const fail=m=>{throw{msg:m}};
async function remember(id,nome){await db.doc('utenti/'+me.id).raw({leghe:{[id]:nome}},{merge:true}).catch(()=>{})}
async function joinLeague(nome,pw,claim){
  const id=slug(nome);if(!id||!pw)fail('Scrivi nome della lega e password.');
  const L=await db.doc('leghe/'+id).get().catch(()=>null);if(!L)fail(`La lega «${nome}» non esiste. Controlla il nome.`);
  setLeague(id);const h=await pwHash(id,pw);
  try{await db.doc('iscritti/'+me.id).raw({pw:h,name:myName,at:new Date().toISOString()})}catch(e){setLeague(null);fail('Password sbagliata.')}
  const c=await db.doc('fantabet/config').get()||{players:{},members:{}};
  const members=c.members||{},players=c.players||{};
  if(L.owner!==me.id&&!Object.values(members).includes(me.id)){
    const free=Object.keys(players).filter(p=>!members[p]);
    if(free.length&&claim===undefined){
      $('#j-extra').innerHTML=`<div class="small" style="margin-top:8px">Eri già in questa lega? Scegli il tuo nome, altrimenti entra come nuovo giocatore.</div><div class="players" style="margin-top:6px">${free.map(p=>`<button data-claim="${p}">${esc(players[p])}</button>`).join('')}<button data-claim="">Sono nuovo</button></div>`;
      $('#j-extra').querySelectorAll('[data-claim]').forEach(b=>b.onclick=()=>joinLeague(nome,pw,b.dataset.claim).catch(e=>leagueView(e.msg||('Errore: '+(e?.code||e)))));
      return}
    let pid=claim;const upd={};
    if(!pid){pid='p'+(Math.max(0,...Object.keys(players).map(k=>+k.slice(1)||0))+1);upd['players.'+pid]=myName}
    upd['members.'+pid]=me.id;
    await db.doc('fantabet/config').update(upd);
  }
  await remember(id,L.nome);openLeague(id,L);
}
async function createLeague(nome,pw){
  nome=String(nome||'').trim();const id=slug(nome);if(!id)fail('Scrivi il nome della lega.');if(String(pw||'').length<4)fail('La password deve avere almeno 4 caratteri.');
  if(await db.doc('leghe/'+id).get().catch(()=>null))fail(`Esiste già una lega «${nome}»: scegli un altro nome.`);
  const h=await pwHash(id,pw);const at=new Date().toISOString();
  await db.doc('leghe/'+id).raw({nome,owner:me.id,creata:at});
  setLeague(id);
  await db.doc('chiavi/'+h).raw({at});
  await db.doc('iscritti/'+me.id).raw({pw:h,name:myName,at});
  await db.doc('fantabet/config').raw({owner:me.id,players:{p1:myName},members:{p1:me.id}});
  // copia le giornate di Serie A ancora in corso, così la lega parte subito
  try{const sa=await db.collection('serieA').get();
    for(const d of sa){const r=d.data;if(r.calcolata)continue;const{deadlineTs,...rest}=r;const ts=deadlineTsOf(rest.deadline);
      await db.doc('giornate/'+d.id).raw({...rest,preds:{},calcolata:false,...(ts?{deadlineTs:ts}:{})})}}catch(e){}
  await remember(id,nome);openLeague(id,{nome,owner:me.id});
}
/* ---------- account: dati e preferenze (notifiche) ---------- */
let pushSt='no',acct={},inLeague=false,pushBusy=false;
const pushNo=()=>{try{return localStorage.getItem('fb-push-no')==='1'}catch(e){return false}};
const NOTIF=[['aperta','Giornata aperta (con la scadenza)',true],['promemoria','Promemoria 3 ore prima della scadenza, se non hai consegnato',true],['x12','1X2 preso',true],['esatto','Risultato esatto preso',true],['marcatore','Il tuo marcatore ha segnato',true],['risultati','Tutti i risultati, anche quando il tuo 1X2 è sbagliato',false],['chiusa','Giornata confermata in classifica',true]];
const prefOn=(k,def)=>acct.notifiche?.[k]===undefined?def:!!acct.notifiche[k];
function viewAccount(){
  const leghe=Object.entries(acct.leghe||{});const pid=inLeague?myPid():null;
  const role=!inLeague?'':me.super&&!cfg.members?.[pid]&&cfg.owner!==me.id?'super admin':me.owner?'organizzatore':pid?'giocatore':'iscritto';
  const pst={on:'<span class="chip ok">Attive su questo dispositivo</span>',off:'<span class="chip">Spente su questo dispositivo</span>',blocked:'<span class="chip">Bloccate</span>','ios-home':'<span class="chip">Serve la schermata Home</span>',no:'<span class="chip">Non disponibili</span>'}[pushSt]||'';
  const help={blocked:'Le hai bloccate per questo sito: riattivale dalle impostazioni del browser o del telefono (Notifiche), poi torna qui.','ios-home':'Su iPhone le notifiche funzionano solo con l\'app aggiunta alla schermata Home: tocca Condividi e poi «Aggiungi alla schermata Home», poi apri l\'app da lì.',no:'Questo browser non supporta le notifiche. Prova con Chrome o con l\'app installata.'}[pushSt]||'';
  return`<section class="sheet"><div class="row spread"><h2>Account</h2><button class="btn" data-act="acct-back">Indietro</button></div>
    <div class="row">${user?.photoURL?`<img src="${esc(user.photoURL)}" alt="" width="48" height="48" style="border-radius:50%" referrerpolicy="no-referrer">`:''}<div><div><b>${esc(user?.displayName||myName||'')}</b>${me.super?' <span class="chip gold">Super admin</span>':''}</div><div class="small muted">${esc(user?.email||'')}</div></div></div>
    <div class="small">Leghe: ${leghe.length?leghe.map(([id,n])=>esc(n)).join(', '):'nessuna'}${inLeague?` · in questa lega sei <b>${esc(role)}</b>${pid?` (${esc(pname(pid))})`:''}`:''}</div>
    <div class="small muted">Ultimo accesso ${esc(acct.at?new Date(acct.at).toLocaleString('it-IT',{timeZone:'Europe/Rome'}):'—')}</div></section>
  <section class="sheet"><div class="row spread"><h2>Notifiche</h2>${pst}</div>
    ${pushSt==='off'?'<div class="row"><button class="btn primary" data-act="push-on">Attiva su questo dispositivo</button></div>':pushSt==='on'?'<div class="row"><button class="btn" data-act="push-off">Spegni su questo dispositivo</button></div>':`<div class="small">${help}</div>`}
    <div class="small muted">Scegli cosa ricevere (vale per tutti i tuoi dispositivi). Gli avvisi arrivano entro 20 minuti, dalle 11 a mezzanotte circa.</div>
    ${NOTIF.map(([k,l,d])=>`<label class="row" style="gap:10px;cursor:pointer"><input type="checkbox" data-act="pref" data-k="${k}" ${prefOn(k,d)?'checked':''}><span>${esc(l)}</span></label>`).join('')}</section>
  <section class="sheet"><div class="row"><button class="btn danger" data-act="acct-logout">Esci dall'account</button></div></section>`}
function refreshAccount(){if(inLeague)return requestRender();$('#view').innerHTML=viewAccount()}
function openAccount(){ui.account=true;if(inLeague){lastHtml='';render()}else{document.querySelector('.tabs').hidden=true;refreshAccount()}}
async function accountAct(a,b){
  if(a==='acct-logout')return logout();
  if(a==='acct-back'){ui.account=false;if(inLeague)render();else leagueView();return}
  if(a==='push-no'){try{localStorage.setItem('fb-push-no','1')}catch(e){}lastHtml='';render();return}
  if(a==='pref'){const k=b.dataset.k;const def=NOTIF.find(x=>x[0]===k)?.[2];const val=!prefOn(k,def);acct={...acct,notifiche:{...(acct.notifiche||{}),[k]:val}};
    db.doc('utenti/'+me.id).set({notifiche:{[k]:val}}).catch(e=>toast(errMsg(e)));return}
  if(pushBusy)return;pushBusy=true;
  try{pushSt=a==='push-on'?await enablePush(me.id):await disablePush(me.id);
    toast(pushSt==='on'?'Notifiche attivate su questo dispositivo.':pushSt==='blocked'?'Notifiche bloccate: riattivale dalle impostazioni del telefono.':'Notifiche spente su questo dispositivo.')}
  catch(e){toast('Non sono riuscito ad attivare le notifiche ('+(e?.code||e?.message||'errore')+').')}
  finally{pushBusy=false;lastHtml='';if(ui.account&&!inLeague)refreshAccount();else render()}}

/* ---------- pannello super admin (solo SUPER_UID; le regole bloccano comunque gli altri) ---------- */
const fmtDt=iso=>{try{return iso?new Date(iso).toLocaleString('it-IT',{timeZone:'Europe/Rome',day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'}):'—'}catch(e){return'—'}};
async function superView(){
  if(!me.super)return leagueView();
  const v=$('#view');document.querySelector('.tabs').hidden=true;setLeague(null);
  v.innerHTML='<section class="sheet empty"><div>Carico tutte le leghe…</div></section>';
  const safe=p=>p.catch(()=>null);
  const [leghe,utenti,sys]=await Promise.all([safe(db.collection('leghe').get()),safe(db.collection('utenti').get()),safe(db.doc('sistema/aggiornamento').get())]);
  const users={};(utenti||[]).forEach(u=>{users[u.id]=u.data||{}});
  const uname=id=>users[id]?.name||('account '+String(id||'').slice(0,6));
  const info=await Promise.all((leghe||[]).map(async l=>{const b='leghe/'+l.id+'/';
    const [c,isc,gio,st]=await Promise.all([safe(db.doc(b+'fantabet/config').get()),safe(db.collection(b+'iscritti').get()),safe(db.collection(b+'giornate').get()),safe(db.doc(b+'fantabet/stato').get())]);
    return{id:l.id,L:l.data||{},c:c||{},isc:isc||[],gio:gio||[],st}}));
  info.sort((a,b)=>String(a.L.nome||a.id).localeCompare(String(b.L.nome||b.id)));
  const card=x=>{const pl=x.c.players||{},mem=x.c.members||{};const keys=Object.keys(pl).sort((a,b)=>a.slice(1)-b.slice(1));
    const calc=x.gio.filter(g=>g.data?.calcolata).length;
    return`<section class="sheet"><div class="row spread"><h2>${esc(x.L.nome||x.id)}</h2><button class="btn primary" data-sa-open="${esc(x.id)}">Entra come admin</button></div>
      <div class="small">Organizzatore: <b>${esc(uname(x.L.owner))}</b> · creata ${esc(fmtDt(x.L.creata))}</div>
      <div class="small">Giornate: <b>${x.gio.length}</b> (confermate ${calc}) · Iscritti: <b>${x.isc.length}</b></div>
      <div class="small">Giocatori: ${keys.map(k=>`${esc(pl[k])}${mem[k]?` <span class="muted">(${esc(uname(mem[k]))})</span>`:' <span class="muted">(senza account)</span>'}`).join(' · ')||'—'}</div>
      ${x.st?`<div class="small muted">Ultimo aggiornamento automatico: ${esc(x.st.stato||'')} ${esc(fmtDt(x.st.finito))}${x.st.messaggio?' · '+esc(String(x.st.messaggio).slice(0,160)):''}</div>`:''}</section>`};
  const ul=Object.entries(users).sort((a,b)=>String(a[1].name||'').localeCompare(String(b[1].name||'')));
  v.innerHTML=`<section class="sheet"><div class="row spread"><h2>Super admin</h2><button class="btn" id="sa-back">Indietro</button></div>
      <div class="small muted">${info.length} leghe · ${ul.length} utenti registrati</div></section>
    ${info.map(card).join('')||'<section class="sheet small muted">Nessuna lega.</section>'}
    <section class="sheet"><h2>Utenti</h2>${ul.map(([id,u])=>`<div class="small"><b>${esc(u.name||'—')}</b> · leghe: ${esc(Object.values(u.leghe||{}).join(', ')||'nessuna')} · ultimo accesso ${esc(fmtDt(u.at))}</div>`).join('')||'<div class="small muted">Nessuno.</div>'}</section>
    <section class="sheet"><h2>Sistema</h2><div class="small">${sys?Object.entries(sys).map(([k,val])=>`${esc(k)}: <b>${esc(typeof val==='object'?JSON.stringify(val):val)}</b>`).join('<br>'):'<span class="muted">Nessun dato.</span>'}</div></section>`;
  $('#sa-back').onclick=()=>leagueView();
  v.querySelectorAll('[data-sa-open]').forEach(b=>b.onclick=()=>{const x=info.find(i=>i.id===b.dataset.saOpen);if(x)openLeague(x.id,x.L)});
}
function openLeague(id,L){
  curLeague={id,nome:L.nome||id};inLeague=true;ui.account=false;setLeague(id);try{localStorage.setItem('fb-lega',id)}catch(e){}
  document.querySelector('.tabs').hidden=false;
  const ln=document.getElementById('lega-nome');if(ln){ln.textContent=(L.nome||id)+(me.super&&L.owner!==me.id?' (super admin)':'');ln.parentElement.hidden=false}
  render();
  db.collection('utenti').onSnapshot(s=>{const n={};s.docs.forEach(d=>{n[d.id]={name:d.data()?.name||''}});profs=n;requestRender()},()=>{});
  db.doc('fantabet/stato').onSnapshot(s=>{stato=s.data()?JSON.parse(JSON.stringify(s.data())):null;requestRender()},()=>{});
  db.doc('fantabet/rettifiche').onSnapshot(s=>{if(adjInflight)return;adj=Array.isArray(s.data()?.items)?JSON.parse(JSON.stringify(s.data().items)):[];requestRender()},()=>{});
  db.doc('fantabet/config').onSnapshot(s=>{if(cfgTimer||cfgInflight)return;const d=s.data()?JSON.parse(JSON.stringify(s.data())):null;
    me.owner=me.super||(!!d&&d.owner===me.id);if(d?.players){cfg=d;setPlayers()}watchSlips();requestRender()},()=>{});
  db.collection('stagioni').onSnapshot(s=>{stagioni=s.docs.map(d=>({id:d.id,...d.data()})).sort((a,b)=>String(b.chiusa||'').localeCompare(String(a.chiusa||'')));requestRender()},()=>{});
  db.collection('iscritti').onSnapshot(s=>{requests=s.docs.map(d=>d.id);requestRender()},()=>{});
  watchSlips();
  db.collection('registro').onSnapshot(s=>{const n={};s.docs.forEach(d=>{const x=d.data();n[d.id]=Array.isArray(x?.items)?JSON.parse(JSON.stringify(x.items)):[]});registro=n;requestRender()},()=>{});
  db.collection('chat').onSnapshot(s=>{const n={};s.docs.forEach(d=>{const x=d.data();n[d.id]=Array.isArray(x?.items)?JSON.parse(JSON.stringify(x.items)):[]});
    const grew=JSON.stringify(n)!==JSON.stringify(chat);chat=n;requestRender();if(grew&&ui.tab==='chat')setTimeout(()=>{const b=$('#msgs');if(b)b.scrollTop=b.scrollHeight},50)},()=>{});
  db.collection('giornate').onSnapshot(snap=>{
    const next={};snap.docs.forEach(d=>{const x=d.data()?JSON.parse(JSON.stringify(d.data())):null;if(x&&isNum(x.num)){const n=+x.num;next[n]=(timers[n]||inflight[n])&&rounds[n]?rounds[n]:normRound(x)}});
    Object.keys(rounds).forEach(n=>{if((timers[n]||inflight[n])&&!next[n])next[n]=rounds[n]});
    rounds=next;dbState='ready';requestRender()},err=>{dbState='off';toast(errMsg(err));render()});
}
document.getElementById('cambia-lega')?.addEventListener('click',()=>{try{localStorage.removeItem('fb-lega')}catch(e){}location.reload()});
})();
