// Aggiornamento automatico di calendario, risultati e marcatori (prende il posto di «Carica/Aggiorna da Google»).
// Fonte dati: ESPN (gratis, senza chiave): site.api.espn.com, Serie A = "ita.1".
// ESPN non dà il numero di giornata: le partite di una giornata salvata si ritrovano dalla coppia
// casa-trasferta (in un campionato ogni coppia si gioca una volta sola), e la giornata nuova è
// fatta dalle prime partite in calendario non ancora usate, una per squadra.
//
// Gira da solo con GitHub Actions (vedi .github/workflows/aggiorna-risultati.yml),
// oppure a mano:  npm run aggiorna
//
// Variabili d'ambiente:
//   FIREBASE_SERVICE_ACCOUNT   contenuto JSON della chiave dell'account di servizio
//                              (in alternativa il file service-account.json nella cartella del progetto)
//   STAGIONE                   facoltativa, es. 2026 per la stagione 2026/27 (di default si calcola da sola)
//
// Cosa fa a ogni giro:
//   0. lavora sulla copia ufficiale serieA/{gNN}, poi copia risultati e marcatori in tutte le leghe.
//   1. per ogni giornata non ancora calcolata: riempie i risultati al 90° delle partite finite
//      e aggiunge i marcatori (autogol esclusi). Non sovrascrive MAI un risultato già scritto,
//      così le correzioni manuali dell'organizzatore restano.
//   2. quando tutte le partite hanno un risultato (o sono segnate come nulle) E i marcatori delle partite
//      riempite in automatico sono arrivati (al massimo si aspettano 48 ore) conferma la giornata.
//   3. se l'ultima giornata è chiusa, crea la successiva con il calendario ufficiale e la scadenza
//      1 minuto prima del primo calcio d'inizio.
//   ESPN si interroga solo quando serve (un mese di partite per chiamata).
import { readFileSync, existsSync } from 'node:fs';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';

const saFile = new URL('../service-account.json', import.meta.url);
const sa = process.env.FIREBASE_SERVICE_ACCOUNT ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
  : existsSync(saFile) ? JSON.parse(readFileSync(saFile, 'utf8')) : null;
const EMU = !!process.env.FIRESTORE_EMULATOR_HOST; // prove in locale con gli emulatori
if (!sa && !EMU) { console.error('Manca la chiave dell\'account di servizio Firebase'); process.exit(1); }
initializeApp(EMU ? { projectId: process.env.GCLOUD_PROJECT || 'demo-fantabet' } : { credential: cert(sa) });
const fs = getFirestore();
process.on('unhandledRejection', async e => {
  console.error(e);
  try {
    const msg = { stato: 'errore', tipo: 'risultati', finito: new Date().toISOString(), messaggio: String(e?.message || e).slice(0, 300) };
    for (const l of (await fs.collection('leghe').get()).docs) await l.ref.collection('fantabet').doc('stato').set(msg, { merge: true });
  } catch {}
  process.exit(1);
});

const now = process.env.ORA ? new Date(process.env.ORA) : new Date(); // ORA solo per le prove
const SEASON = +process.env.STAGIONE || (now.getUTCMonth() >= 6 ? now.getUTCFullYear() : now.getUTCFullYear() - 1);
const ESPN = process.env.ESPN_URL || 'https://site.api.espn.com/apis/site/v2/sports/soccer/ita.1/scoreboard';
const FINISHED = ['STATUS_FULL_TIME', 'STATUS_FINAL', 'STATUS_FINAL_AET', 'STATUS_FINAL_PEN', 'STATUS_FINAL_AGT'];
const VOID = ['STATUS_POSTPONED', 'STATUS_CANCELED', 'STATUS_ABANDONED', 'STATUS_SUSPENDED', 'STATUS_FORFEIT'];
let calls = 0;

/* tutte le partite della stagione (da agosto al mese prossimo), lette una volta per giro */
let seasonCache = null;
async function seasonFixtures() {
  if (seasonCache) return seasonCache;
  const months = [];
  const stop = Math.min(SEASON * 12 + 17, now.getUTCFullYear() * 12 + now.getUTCMonth() + 2); // giugno dell'anno dopo
  for (let k = SEASON * 12 + 6; k <= stop; k++) months.push(`${Math.floor(k / 12)}${String(k % 12 + 1).padStart(2, '0')}`);
  const byId = new Map();
  for (const ym of months) {
    calls++;
    let res;
    for (let t = 0; t < 3; t++) { res = await fetch(`${ESPN}?dates=${ym}&limit=500`); if (res.ok) break; await new Promise(r => setTimeout(r, 2000)); }
    if (!res.ok) throw new Error(`ESPN ${res.status} (${ym})`);
    const j = await res.json();
    for (const e of j.events || []) if (!e.season || +e.season.year === SEASON) byId.set(String(e.id), toFx(e));
  }
  return (seasonCache = [...byId.values()].sort((a, b) => a.date.localeCompare(b.date)));
}
function toFx(e) {
  const c = e.competitions[0];
  const H = c.competitors.find(x => x.homeAway === 'home'), A = c.competitors.find(x => x.homeAway === 'away');
  const teamOf = { [H.team.id]: H.team.displayName, [A.team.id]: A.team.displayName };
  const plays = (c.details || []).filter(d => d.scoringPlay && !d.shootout);
  return {
    id: String(e.id), date: new Date(e.date).toISOString(), status: c.status.type.name,
    home: H.team.displayName, away: A.team.displayName, hg: H.score, ag: A.score,
    goalsCount: plays.length,
    goals: plays.filter(d => !d.ownGoal).map(d => ({ name: d.athletesInvolved?.[0]?.displayName, team: teamOf[d.team?.id] || '' })),
  };
}
const pairKey = (h, a) => norm(h) + '|' + norm(a);
/* nomi come nel resto dell'app: "AC Milan" -> "Milan", "Internazionale" -> "Inter" */
const SHOW = { internazionale: 'Inter', 'hellas verona': 'Verona' };
const showName = s => SHOW[String(s).toLowerCase()] || String(s).replace(/^(AC|AS|SS|SSC|FC|US) /, '');

/* nomi squadra: "AC Milan" = "Milan", "Hellas Verona" = "Verona", "FC Internazionale" = "Inter" */
const ALIAS = { internazionale: 'inter', 'hellas verona': 'verona' };
function norm(s) {
  let t = String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/\b(fc|ac|as|ss|us|ssc|acf|calcio|bc|1907|1913|1909)\b/g, ' ').replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
  for (const [k, v] of Object.entries(ALIAS)) if (t.includes(k)) t = v;
  return t;
}
const same = (a, b) => { a = norm(a); b = norm(b); return !!a && !!b && (a === b || a.includes(b) || b.includes(a)); };

const romeFmt = new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
function whenLabel(iso) {
  const p = Object.fromEntries(romeFmt.formatToParts(new Date(iso)).map(x => [x.type, x.value]));
  return `${p.weekday} ${p.day} ${p.month} · ${p.hour}:${p.minute}`;
}
const isNum = v => v !== null && v !== '' && v !== undefined && !isNaN(Number(v));
const tokens = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]+/g, ' ').trim();


/* ============ 1. calendario e risultati "ufficiali" in serieA/{gNN} (uguali per tutte le leghe) ============ */
const snap = await fs.collection('serieA').get();
const rounds = {};
snap.docs.forEach(d => { const x = d.data(); if (isNum(x.num)) rounds[+x.num] = { ref: d.ref, data: x }; });
const statoRef = fs.doc('sistema/aggiornamento');
const stato = (await statoRef.get()).data() || {};
const notes = {}; // numero giornata -> note
const note = (n, t) => { (notes[n] = notes[n] || []).push(t); };

for (const n of Object.keys(rounds).map(Number).sort((a, b) => a - b)) {
  const r = rounds[n].data;
  if (r.calcolata) continue;
  const ms = r.matches || [];
  if (!ms.some(m => m.home)) continue;
  const due = m => !m.nullo && (!isNum(m.hg) || !isNum(m.ag)) && (!m.kickoff || new Date(m.kickoff).getTime() + 105 * 60e3 < now.getTime());
  const needs = ms.some(m => !m.apiId || due(m) || (m.autoRes && !m.scorersDone));
  if (!needs) continue;
  const fx = await seasonFixtures();
  if (!fx.length) { note(n, `ESPN non ha ancora le partite della stagione.`); continue; }
  let filled = 0, newScorers = 0; const waiting = [];
  const scorers = [...(r.scorers || [])];
  for (const m of ms) {
    const f = (m.apiId && fx.find(f => f.id === String(m.apiId) && same(f.home, m.home))) || fx.find(f => same(f.home, m.home) && same(f.away, m.away));
    if (!f) { if (m.home) note(n, `${m.home}-${m.away} non trovata su ESPN.`); continue; }
    m.apiId = f.id; m.kickoff = f.date;
    if (FINISHED.includes(f.status)) {
      if (!isNum(m.hg) || !isNum(m.ag)) {
        if (isNum(f.hg) && isNum(f.ag)) { m.hg = +f.hg; m.ag = +f.ag; m.autoRes = true; filled++; }
      }
      // risultato già presente (importato o scritto a mano): i marcatori di quella partita li gestisce l'organizzatore
      if (!m.autoRes) m.scorersDone = true;
      if (!m.scorersDone && m.autoRes) {
        // marcatori solo quando ESPN ha tutti i gol della partita; altrimenti si riprova al giro dopo (per 2 giorni)
        const allGoals = f.goalsCount === (+f.hg || 0) + (+f.ag || 0);
        const late = new Date(f.date).getTime() + 48 * 3600e3 < now.getTime();
        if (allGoals || late) {
          for (const g of f.goals) {
            if (!g.name) continue;
            const ex = scorers.find(s => tokens(s.name) === tokens(g.name) && s.auto && s.apiFixture === f.id);
            if (ex) ex.goals = (ex.goals || 1) + 1;
            else { scorers.push({ name: g.name, team: showName(g.team), goals: 1, auto: true, apiFixture: f.id }); newScorers++; }
          }
          m.scorersDone = true;
        }
      }
    } else if (VOID.includes(f.status)) waiting.push(`${m.home}-${m.away} rinviata/sospesa (l'organizzatore decide se segnarla nulla)`);
    else if (!isNum(m.hg) && new Date(f.date).getTime() < now.getTime()) waiting.push(`${m.home}-${m.away}`);
  }
  // si chiude solo quando ci sono anche i marcatori: dopo la chiusura non si riguardano più
  const complete = ms.every(m => m.nullo || (isNum(m.hg) && isNum(m.ag) && (!m.autoRes || m.scorersDone)));
  const noScorers = ms.filter(m => !m.nullo && isNum(m.hg) && m.autoRes && !m.scorersDone).map(m => `${m.home}-${m.away}`);
  if (noScorers.length) waiting.push(`marcatori di ${noScorers.join(', ')}`);
  await rounds[n].ref.update({ matches: ms, scorers, calcolata: complete });
  r.calcolata = complete; r.matches = ms; r.scorers = scorers;
  note(n, `${filled} risultati e ${newScorers} marcatori nuovi.` + (waiting.length && !complete ? ` In attesa: ${waiting.join(', ')}.` : ''));
}

/* crea la giornata successiva quando l'ultima è chiusa */
const nums = Object.keys(rounds).map(Number).sort((a, b) => a - b);
const last = nums.length ? nums[nums.length - 1] : 0;
const lastR = last ? rounds[last].data : null;
const lastClosed = !lastR || lastR.calcolata || (lastR.deadline && new Date(lastR.deadline) < now);
const lastTry = stato.creazioneTentata ? new Date(stato.creazioneTentata).getTime() : 0;
if (last > 0 && last < 38 && lastClosed && now.getTime() - lastTry > 6 * 3600e3) {
  const n = last + 1;
  // partite non ancora in nessuna giornata salvata, in ordine di data, una per squadra, entro 5 giorni dalla prima
  const used = new Set(Object.values(rounds).flatMap(x => (x.data.matches || []).filter(m => m.home).map(m => pairKey(m.home, m.away))));
  const cands = (await seasonFixtures()).filter(f => !used.has(pairKey(f.home, f.away)) && !VOID.includes(f.status) && !FINISHED.includes(f.status));
  const fx = [], teams = new Set();
  for (const f of cands) {
    if (fx.length && new Date(f.date) - new Date(fx[0].date) > 5 * 86400e3) break;
    if (teams.has(norm(f.home)) || teams.has(norm(f.away))) continue;
    fx.push(f); teams.add(norm(f.home)); teams.add(norm(f.away));
    if (fx.length === 10) break;
  }
  await statoRef.set({ creazioneTentata: now.toISOString() }, { merge: true });
  if (fx.length === 10 || (fx.length >= 7 && new Date(fx[0].date) - now < 3 * 86400e3)) {
    const deadline = new Date(new Date(fx[0].date).getTime() - 60e3);
    const doc = {
      num: n, calcolata: false, deadline: deadline.toISOString(), deadlineTs: Timestamp.fromDate(deadline), scorers: [],
      matches: fx.map(f => ({ home: showName(f.home), away: showName(f.away),
        when: whenLabel(f.date), hg: null, ag: null, nullo: false, apiId: f.id, kickoff: f.date })),
    };
    const ref = fs.doc('serieA/g' + String(n).padStart(2, '0'));
    await ref.create(doc);
    rounds[n] = { ref, data: doc };
    note(n, `Creata la giornata ${n}: consegna entro ${whenLabel(deadline.toISOString())}.`);
  } else note(n, `Calendario della giornata ${n} non ancora disponibile.`);
}

/* ============ 2. copia nelle leghe ============ */
// Nelle leghe si riempiono solo i campi vuoti: le correzioni a mano dell'organizzatore restano.
const leagues = (await fs.collection('leghe').get()).docs;
let touched = 0;
for (const L of leagues) {
  const lr = {};
  (await L.ref.collection('giornate').get()).docs.forEach(d => { const x = d.data(); if (isNum(x.num)) lr[+x.num] = { ref: d.ref, data: x }; });
  const msgs = [];
  let lastN = null;
  for (const n of Object.keys(rounds).map(Number).sort((a, b) => a - b)) {
    const M = rounds[n].data; const R = lr[n];
    const id = 'g' + String(n).padStart(2, '0');
    if (!R) {
      if (M.calcolata) continue; // lega nata dopo: le giornate già finite non servono
      const { deadlineTs, ...rest } = M;
      await L.ref.collection('giornate').doc(id).set({ ...rest, ...(deadlineTs ? { deadlineTs } : {}), preds: {}, calcolata: false });
      touched++; lastN = n; msgs.push(`Giornata ${n} pronta.`);
      continue;
    }
    const r = R.data; if (r.calcolata) continue;
    let changed = false, filled = 0;
    const ms = r.matches || [];
    (M.matches || []).forEach((mm, i) => {
      let m = ms.find(x => x.home && same(x.home, mm.home) && same(x.away, mm.away));
      if (!m && ms[i] && !ms[i].home) { ms[i] = { ...mm, hg: null, ag: null }; m = ms[i]; changed = true; }
      if (!m) return;
      if (!m.apiId && mm.apiId) { m.apiId = mm.apiId; m.kickoff = mm.kickoff; changed = true; }
      if (!m.nullo && (!isNum(m.hg) || !isNum(m.ag)) && isNum(mm.hg) && isNum(mm.ag)) { m.hg = mm.hg; m.ag = mm.ag; changed = true; filled++; }
    });
    const sc = [...(r.scorers || [])];
    for (const s of (M.scorers || []).filter(s => s.auto)) {
      if (!sc.some(x => x.auto && x.apiFixture === s.apiFixture && tokens(x.name) === tokens(s.name))) { sc.push(s); changed = true; }
    }
    const upd = {};
    if (!r.deadline && M.deadline) { upd.deadline = M.deadline; if (M.deadlineTs) upd.deadlineTs = M.deadlineTs; changed = true; }
    // la lega si chiude solo dopo la copia ufficiale (che aspetta anche i marcatori)
    const complete = !!M.calcolata && ms.length > 0 && ms.every(m => m.nullo || (isNum(m.hg) && isNum(m.ag)));
    if (complete) { upd.calcolata = true; changed = true; }
    if (changed) {
      await R.ref.update({ ...upd, matches: ms, scorers: sc });
      touched++; lastN = n;
      msgs.push(`G${n}: ${filled} risultati nuovi.` + (complete ? ' Giornata completa: confermata in classifica.' : ''));
    }
  }
  if (msgs.length) {
    const g = lastN ?? last;
    const extra = (notes[g] || []).filter(t => /attesa|non trovata|non ancora/.test(t));
    await L.ref.collection('fantabet').doc('stato').set({ stato: 'fatto', tipo: 'risultati', giornata: g, richiesta: now.toISOString(), finito: new Date().toISOString(), messaggio: [...msgs, ...extra].join(' ') }, { merge: true });
  }
}

console.log(Object.entries(notes).map(([n, t]) => `G${n}: ${t.join(' ')}`).join('\n') || 'Niente da aggiornare in Serie A.',
  `\nLeghe: ${leagues.length}, giornate aggiornate nelle leghe: ${touched} (chiamate API: ${calls})`);
process.exit(0);
