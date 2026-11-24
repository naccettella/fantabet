// Notifiche sul telefono, mandate dallo script di aggiornamento (aggiorna-risultati.mjs).
// Chi le riceve: i giocatori collegati a un account in leghe/{lega}/fantabet/config.members.
// Dove arrivano: i dispositivi salvati in utenti/{uid}/push/*. Cosa: le preferenze in utenti/{uid}.notifiche
// (ogni tipo è attivo se non è stato spento). Gli avvisi già mandati sono in leghe/{lega}/fantabet/notifiche.
import { getMessaging } from 'firebase-admin/messaging';

export const TIPI = ['aperta', 'promemoria', 'chiusa', 'risultati', 'x12', 'esatto', 'marcatore', 'rinvio'];
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
  const add = (uid, tipo, line, tag, n) => { (out[uid] = out[uid] || []).push({ tipo, line, tag, legaId: curL, n: n ?? curN }); };
  let curN = null;
  const prefsCache = {};
  for (const L of leagues) {
    curL = L.id;
    const nome = L.data().nome || L.id;
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
      if (e.tipo === 'chiusa' && once('chiusa-' + e.n))
        uids.forEach(u => add(u, 'chiusa', `Giornata ${e.n} confermata: guarda la classifica.`, 'chiusa-' + e.n));
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
    if (Object.keys(newSent).length) await stRef.set({ sent: newSent }, { merge: true });
    for (const u of Object.keys(out)) out[u].forEach(x => { x.lega = nome; });
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
    const view = keep.every(x => x.tipo === 'aperta' || x.tipo === 'promemoria') ? 'pronostici' : keep.some(x => x.tipo === 'rinvio') ? 'partite' : 'punteggi';
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
