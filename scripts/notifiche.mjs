// Notifiche sul telefono, mandate dallo script di aggiornamento (aggiorna-risultati.mjs).
// Chi le riceve: i giocatori collegati a un account in leghe/{lega}/fantabet/config.members.
// Dove arrivano: i dispositivi salvati in utenti/{uid}/push/*. Cosa: le preferenze in utenti/{uid}.notifiche
// (ogni tipo è attivo se non è stato spento). Gli avvisi già mandati sono in leghe/{lega}/fantabet/notifiche.
import { getMessaging } from 'firebase-admin/messaging';
import { leagueData, makeScorer, validMatch } from './punteggi.mjs';

export const TIPI = ['aperta', 'promemoria', 'vigilia', 'solotu', 'chiusa', 'sorpasso', 'recap', 'risultati', 'x12', 'esatto', 'marcatore', 'rinvio'];
// ora e data italiane: { date: 'AAAA-MM-GG', hour, minute }
const romeParts = d => { const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d).map(x => [x.type, x.value])); return { date: `${p.year}-${p.month}-${p.day}`, hour: +p.hour, minute: +p.minute }; };
const hhmm = d => { const p = romeParts(new Date(d)); return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`; };
const pts = x => (x > 0 ? '+' : x < 0 ? '−' : '') + new Intl.NumberFormat('it-IT', { maximumFractionDigits: 1 }).format(Math.abs(x));
const num = x => new Intl.NumberFormat('it-IT', { maximumFractionDigits: 1 }).format(x);
const list = a => a.length <= 1 ? (a[0] || '') : a.slice(0, -1).join(', ') + ' e ' + a[a.length - 1];
// promemoria quando manca meno di 1 ora alla scadenza (il controllo gira ogni 20 minuti, quindi arriva
// tra 60 e 40 minuti prima). Prima delle 14 il workflow fa girare solo i promemoria (vedi in fondo).
const PROMEMORIA_ORE = 1;
const romeFmt = new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const when = iso => { try { return romeFmt.format(new Date(iso)); } catch { return ''; } };
const gid = n => 'g' + String(n).padStart(2, '0');
const isNum = v => v !== null && v !== '' && v !== undefined && !isNaN(Number(v));
const outcome = m => { const h = +m.hg, a = +m.ag; return h > a ? '1' : h < a ? '2' : 'X'; };
const tok = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]+/g, ' ').split(' ').filter(t => t.length >= 2);
// stesso confronto dei nomi usato dall'app per i marcatori
function sameScorer(pred, real) {
  const pt = tok(pred), st = tok(real); if (!pt.length || !st.length) return false;
  const long = st.filter(t => t.length >= 3);
  return pt.every(t => st.includes(t)) || (long.length > 0 && long.every(t => pt.includes(t)));
}

export async function notifica(fs, leagues, events, now, messaging = null) {
  const out = {}; // uid -> [{ tipo, line, tag }]
  let curL = null; // lega e giornata di ogni voce: servono per aprire la pagina giusta toccando la notifica
  let curNome = '';
  const add = (uid, tipo, line, tag, n) => { (out[uid] = out[uid] || []).push({ tipo, line, tag, legaId: curL, lega: curNome, n: n ?? curN }); };
  let curN = null;
  const prefsCache = {};
  for (const L of leagues) {
    curL = L.id;
    const nome = L.data().nome || L.id; curNome = nome;
    const cfg = (await L.ref.collection('fantabet').doc('config').get()).data() || {};
    const uids = [...new Set(Object.values(cfg.members || {}).filter(Boolean))];
    if (!uids.length) continue;
    const stRef = L.ref.collection('fantabet').doc('notifiche');
    const sent = (await stRef.get()).data()?.sent || {};
    const newSent = {};
    const once = k => { if (sent[k] || newSent[k]) return false; newSent[k] = now.toISOString(); return true; };
    const slipCache = {};
    const slip = async (uid, n) => {
      const k = uid + '/' + n;
      if (!(k in slipCache)) slipCache[k] = (await L.ref.collection('schedine').doc(uid).collection('giornate').doc(gid(n)).get()).data() || null;
      return slipCache[k];
    };
    const ev = events.filter(e => e.L.id === L.id);

    for (const e of ev) {
      curN = e.n;
      // partita rinviata o sospesa: solo all'organizzatore, che deve decidere se segnarla nulla
      if (e.tipo === 'rinvio' && L.data().owner && once('rinvio-' + e.n + '-' + e.key))
        add(L.data().owner, 'rinvio', `Giornata ${e.n}: ${e.partita} rinviata o sospesa. Se non si recupera prima del turno dopo, segnala "Rinviata" nei Risultati.`, 'rinvio-' + e.n);
      if (e.tipo === 'aperta' && once('aperta-' + e.n))
        uids.forEach(u => add(u, 'aperta', `Giornata ${e.n} aperta${e.deadline ? ': consegna entro ' + when(e.deadline) : ''}.`, 'aperta-' + e.n));
      if (e.tipo === 'risultato') {
        const m = e.m, score = `${m.home}-${m.away} ${m.hg}-${m.ag}`;
        for (const u of uids) {
          const p = await slip(u, e.n); if (!p || p.status !== 'consegnato') continue;
          const pick = (p.x12 || [])[e.i];
          const hit = pick && pick === outcome(m);
          if (hit) add(u, 'x12', `${score}: 1X2 preso (${pick}) ✅`);
          else add(u, 'risultati', `${score}${pick ? `: il tuo ${pick} non è entrato` : ''}.`);
          for (const x of p.exact || []) if (+x.m === e.i && isNum(x.h) && isNum(x.a) && +x.h === +m.hg && +x.a === +m.ag)
            add(u, 'esatto', `${score}: risultato esatto preso! 🎯`);
        }
      }
      if (e.tipo === 'gol') {
        for (const u of uids) {
          const p = await slip(u, e.n); if (!p || p.status !== 'consegnato') continue;
          if ((p.scorers || []).some(s => s?.name && sameScorer(s.name, e.s.name)))
            add(u, 'marcatore', `Gol di ${e.s.name}${e.s.team ? ' (' + e.s.team + ')' : ''}: il tuo marcatore ha segnato! ⚽`);
        }
      }
    }

    curN = null;
    // promemoria a chi non ha ancora consegnato
    for (const d of (await L.ref.collection('giornate').get()).docs) {
      const r = d.data(); if (r.calcolata || !r.deadline || !isNum(r.num)) continue;
      const left = new Date(r.deadline).getTime() - now.getTime();
      if (left <= 0 || left > PROMEMORIA_ORE * 3600e3) continue;
      if (!once('promemoria-' + r.num)) continue;
      for (const u of uids) {
        const p = await slip(u, +r.num);
        if (p?.status !== 'consegnato') add(u, 'promemoria', `Giornata ${r.num}: non hai ancora consegnato la schedina! Scadenza ${when(r.deadline)}.`, 'promemoria-' + r.num, +r.num);
      }
    }

    // ---- notifiche calcolate dai punteggi: vigilia, "manchi solo tu", recap della sera, recap di fine giornata, sorpassi ----
    try {
      const D = await leagueData(L); const S = makeScorer(D);
      const rp = romeParts(now);
      const tomorrow = romeParts(new Date(now.getTime() + 24 * 3600e3)).date;
      const nums = Object.keys(D.rounds).map(Number).sort((a, b) => a - b);
      const delivered = (r, pid) => S.getPred(r, pid).status === 'consegnato';
      for (const n of nums) {
        const r = D.rounds[n]; if (r.calcolata || !r.deadline) continue;
        const dl = new Date(r.deadline); const left = dl.getTime() - now.getTime();
        curN = n;
        // la sera prima della scadenza, dalle 20
        if (left > 3 * 3600e3 && rp.hour >= 20 && romeParts(dl).date === tomorrow && once('vigilia-' + n))
          for (const u of uids) { const pid = S.pidOf(u); if (pid && !delivered(r, pid)) add(u, 'vigilia', `Domani alle ${hhmm(dl)} scade la giornata ${n}: non hai ancora consegnato la schedina.`, 'vigilia-' + n); }
        // tutti gli altri hanno consegnato: manchi solo tu
        if (left > 0 && D.pids.length >= 2)
          for (const u of uids) {
            const pid = S.pidOf(u); if (!pid || delivered(r, pid)) continue;
            const others = D.pids.filter(q => q !== pid);
            if (others.every(q => delivered(r, q)) && once('solotu-' + n + '-' + u))
              add(u, 'solotu', `${others.length <= 3 ? list(others.map(S.name)) + (others.length > 1 ? ' hanno' : ' ha') : 'Tutti gli altri hanno'} già consegnato la giornata ${n}: manchi solo tu! Scadenza ${when(r.deadline)}.`, 'solotu-' + n);
          }
        // recap della sera nei giorni di partita (verso le 23:30)
        if (left < 0 && rp.hour === 23 && rp.minute >= 20) {
          const today = (r.matches || []).map((m, i) => ({ m, i })).filter(x => x.m.kickoff && romeParts(new Date(x.m.kickoff)).date === rp.date && validMatch(x.m));
          if (today.length && once('sera-' + n + '-' + rp.date)) {
            const ids = new Set(today.map(x => String(x.m.apiId || '')));
            const goalsToday = (r.scorers || []).filter(s => s.apiFixture && ids.has(String(s.apiFixture)));
            const prov = D.pids.filter(q => delivered(r, q)).map(q => ({ q, t: S.scoreRound(r, q).total })).sort((a, b) => b.t - a.t);
            for (const u of uids) {
              const pid = S.pidOf(u); if (!pid || !delivered(r, pid)) continue;
              const p = S.getPred(r, pid);
              const hit = today.filter(x => p.x12[x.i] === (+x.m.hg > +x.m.ag ? '1' : +x.m.hg < +x.m.ag ? '2' : 'X')).length;
              const sc = p.scorers.filter(s => s.name.trim() && goalsToday.some(g => S.samePlayer(s.name, g.name))).map(s => s.name.trim());
              const me = prov.find(x => x.q === pid); const rank = prov.filter(x => x.t > me.t).length + 1;
              add(u, 'recap', `Oggi in G${n}: ${hit} su ${today.length} 1X2 presi${sc.length ? `, ${list(sc)} a segno ⚽` : ''}. Giornata finora: ${pts(me.t)}, sei ${rank}° di giornata.`, 'sera-' + n);
            }
          }
        }
      }
      // recap di fine giornata: l'ultima giornata confermata, una volta sola (anche se l'ha confermata l'organizzatore a mano)
      const done = nums.filter(n => D.rounds[n].calcolata && D.pids.some(q => S.getPred(D.rounds[n], q).status));
      const n = done[done.length - 1];
      const r = n && D.rounds[n];
      if (r && (!r.deadline || now.getTime() - new Date(r.deadline).getTime() < 10 * 86400e3) && once('recap-' + n)) {
        curN = n;
        const after = S.standings(), before = S.standings(n), hadBefore = done.length > 1;
        const day = D.pids.map(q => ({ q, s: S.scoreRound(r, q) })).sort((a, b) => b.s.total - a.s.total);
        const best = day[0];
        for (const u of uids) {
          const pid = S.pidOf(u); if (!pid) continue;
          const s = day.find(x => x.q === pid).s; const me = after.find(x => x.pid === pid);
          const det = s.state === 'mancato' ? 'schedina non consegnata' : [s.golden ? '10/10 1X2: Golden Rule! 🥇' : `${s.hits}/${s.valid} 1X2`, s.exactHits ? `${s.exactHits} esatt${s.exactHits > 1 ? 'i' : 'o'}` : '', s.scored ? `${s.scored} marcator${s.scored > 1 ? 'i' : 'e'} a segno` : ''].filter(Boolean).join(', ');
          const pos = me.rank === 1 ? (after[1] ? `Sei 1° con ${num(Math.round((me.tot - after[1].tot) * 10) / 10)} punti sul 2°` : 'Sei 1°') : `Sei ${me.rank}° a −${num(Math.round((after[0].tot - me.tot) * 10) / 10)} dal 1°`;
          const top = best.q === pid ? 'Sei il migliore di giornata! 🏆' : `Migliore di giornata: ${S.name(best.q)} con ${num(best.s.total)}.`;
          add(u, 'chiusa', `Giornata ${n} confermata: ${pts(s.total)} punti (${det}). ${pos}. ${top}`, 'chiusa-' + n);
          if (hadBefore) {
            const rb = Object.fromEntries(before.map(x => [x.pid, x.rank])), ra = Object.fromEntries(after.map(x => [x.pid, x.rank]));
            const passed = D.pids.filter(q => q !== pid && rb[q] < rb[pid] && ra[q] > ra[pid]).map(S.name);
            const passedBy = D.pids.filter(q => q !== pid && rb[q] > rb[pid] && ra[q] < ra[pid]).map(S.name);
            if (passed.length) add(u, 'sorpasso', `Hai superato ${list(passed)}: ora sei ${me.rank}°! 🚀`, 'chiusa-' + n);
            if (passedBy.length) add(u, 'sorpasso', `${list(passedBy)} ti ${passedBy.length > 1 ? 'hanno' : 'ha'} superato: ora sei ${me.rank}°.`, 'chiusa-' + n);
          }
        }
      }
    } catch (e) { console.log('notifiche dei punteggi non calcolate: ' + (e?.message || e)); }
    curN = null;

    if (Object.keys(newSent).length) await stRef.set({ sent: newSent }, { merge: true });
  }

  // invio: un messaggio per persona, con le sole voci che ha lasciato attive
  messaging = messaging || getMessaging();
  let n = 0, devices = 0, removed = 0;
  for (const [uid, items] of Object.entries(out)) {
    const prefs = prefsCache[uid] ?? (prefsCache[uid] = (await fs.doc('utenti/' + uid).get()).data()?.notifiche || {});
    const keep = items.filter(x => prefs[x.tipo] !== false && !(x.tipo === 'risultati' && prefs.risultati !== true)); // "tutti i risultati" parte spento
    if (!keep.length) continue;
    const toks = (await fs.collection('utenti').doc(uid).collection('push').get()).docs;
    if (!toks.length) continue;
    const title = keep.length === 1 ? `Fanta Bet · ${keep[0].lega}` : `Fanta Bet · ${keep.length} novità`;
    const body = keep.map(x => x.line).join('\n').slice(0, 900);
    const tag = keep.length === 1 && keep[0].tag ? keep[0].tag : 'fb-' + now.getTime();
    // toccando la notifica si apre la giornata giusta: la schedina per "aperta"/"promemoria", altrimenti i punteggi
    const sameRound = keep.every(x => x.legaId === keep[0].legaId && x.n === keep[0].n) && keep[0].legaId && keep[0].n;
    const view = keep.every(x => ['aperta', 'promemoria', 'vigilia', 'solotu'].includes(x.tipo)) ? 'pronostici' : keep.some(x => x.tipo === 'rinvio') ? 'partite' : 'punteggi';
    const url = sameRound ? `/?lega=${encodeURIComponent(keep[0].legaId)}&g=${keep[0].n}&v=${view}` : '/';
    const res = await messaging.sendEach(toks.map(t => ({ token: t.data().token, data: { title, body, tag, url }, webpush: { headers: { Urgency: 'high', TTL: '86400' } } })));
    n++; devices += res.successCount;
    for (let i = 0; i < res.responses.length; i++) {
      const c = res.responses[i].error?.code || '';
      if (/registration-token-not-registered|invalid-registration-token|invalid-argument/.test(c)) { await toks[i].ref.delete(); removed++; }
    }
  }
  return `Notifiche: ${n} persone, ${devices} dispositivi${removed ? `, ${removed} dispositivi non più validi tolti` : ''}.`;
}

// Solo promemoria (giri del mattino, prima delle 14):  node scripts/notifiche.mjs promemoria
if (process.argv[2] === 'promemoria') {
  const { readFileSync } = await import('node:fs');
  const { initializeApp, cert } = await import('firebase-admin/app');
  const { getFirestore } = await import('firebase-admin/firestore');
  initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || readFileSync(new URL('../service-account.json', import.meta.url), 'utf8'))) });
  const fs = getFirestore();
  console.log(await notifica(fs, (await fs.collection('leghe').get()).docs, [], new Date()));
  process.exit(0);
}

// Prova a tutti:  node scripts/notifiche.mjs prova-tutti   -> notifica di prova a ogni dispositivo con le notifiche attive
if (process.argv[2] === 'prova-tutti') {
  const { readFileSync } = await import('node:fs');
  const { initializeApp, cert } = await import('firebase-admin/app');
  const { getFirestore } = await import('firebase-admin/firestore');
  initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || readFileSync(new URL('../service-account.json', import.meta.url), 'utf8'))) });
  const fs = getFirestore();
  let users = 0, devices = 0, ok = 0, removed = 0; const errs = {};
  for (const u of (await fs.collection('utenti').get()).docs) {
    const toks = (await u.ref.collection('push').get()).docs; if (!toks.length) continue;
    users++; devices += toks.length;
    const res = await getMessaging().sendEach(toks.map(t => ({ token: t.data().token, data: { title: 'Fanta Bet', body: 'Notifica di prova: se la leggi, le notifiche funzionano! ✅', tag: 'prova', url: '/' }, webpush: { headers: { Urgency: 'high', TTL: '3600' } } })));
    ok += res.successCount;
    for (let i = 0; i < res.responses.length; i++) {
      const c = res.responses[i].error?.code; if (!c) continue; errs[c] = (errs[c] || 0) + 1;
      if (/registration-token-not-registered|invalid-registration-token/.test(c)) { await toks[i].ref.delete(); removed++; }
    }
  }
  console.log(`PROVA: ${users} persone con notifiche attive, ${devices} dispositivi, inviate ${ok}${removed ? `, ${removed} dispositivi non più validi tolti` : ''}.`, Object.keys(errs).length ? 'Errori: ' + JSON.stringify(errs) : '');
  process.exit(0);
}

// Prova a mano:  node scripts/notifiche.mjs prova <uid>   -> manda una notifica di prova a quell'account
if (process.argv[2] === 'prova') {
  const { readFileSync } = await import('node:fs');
  const { initializeApp, cert } = await import('firebase-admin/app');
  const { getFirestore } = await import('firebase-admin/firestore');
  initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || readFileSync(new URL('../service-account.json', import.meta.url), 'utf8'))) });
  const toks = (await getFirestore().collection('utenti').doc(process.argv[3]).collection('push').get()).docs;
  if (!toks.length) { console.log('Nessun dispositivo con le notifiche attive per questo account.'); process.exit(0); }
  const res = await getMessaging().sendEach(toks.map(t => ({ token: t.data().token, data: { title: 'Fanta Bet', body: 'Notifica di prova: funziona! ✅', url: '/' } })));
  console.log(`Inviata a ${res.successCount} dispositivi su ${toks.length}.`, res.responses.filter(r => r.error).map(r => r.error.code).join(' '));
  process.exit(0);
}
