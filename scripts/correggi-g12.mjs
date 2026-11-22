// Correzione una tantum: Juventus-Venezia (giornata 12) si gioca lunedì 23 novembre 2026,
// ma nei dati importati c'era già un 4-0 con 4 marcatori della Juventus.
// Toglie risultato e marcatori Juventus (solo quelli scritti a mano/importati) dalla copia
// ufficiale serieA/g12 e dalla giornata 12 di ogni lega, così li riempie l'aggiornamento automatico.
//   prova a secco:  node scripts/correggi-g12.mjs
//   per davvero:    node scripts/correggi-g12.mjs --applica
import { readFileSync } from 'node:fs';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const APPLY = process.argv.includes('--applica');
initializeApp({ credential: cert(JSON.parse(readFileSync(new URL('../service-account.json', import.meta.url), 'utf8'))) });
const fs = getFirestore();
const isJ = s => /juventus/i.test(String(s || '')), isV = s => /venezia/i.test(String(s || ''));

const refs = [fs.doc('serieA/g12')];
for (const L of (await fs.collection('leghe').get()).docs) refs.push(L.ref.collection('giornate').doc('g12'));
for (const ref of refs) {
  const s = await ref.get();
  if (!s.exists) { console.log(ref.path, ': non esiste'); continue; }
  const r = s.data();
  if (r.calcolata) { console.log(ref.path, ': giornata già confermata, non tocco nulla'); continue; }
  const ms = r.matches || [];
  const m = ms.find(x => isJ(x.home) && isV(x.away));
  if (!m) { console.log(ref.path, ': Juventus-Venezia non trovata'); continue; }
  if (m.autoRes) { console.log(ref.path, ': risultato già arrivato in automatico, non tocco nulla'); continue; }
  const sc = r.scorers || [];
  const drop = sc.filter(x => !x.auto && isJ(x.team));
  console.log(ref.path, `: risultato ${m.hg}-${m.ag} -> vuoto; tolgo marcatori:`, drop.map(x => `${x.name} (${x.goals})`).join(', ') || 'nessuno');
  if (!APPLY) continue;
  m.hg = null; m.ag = null; delete m.scorersDone; delete m.autoRes;
  await ref.update({ matches: ms, scorers: sc.filter(x => !drop.includes(x)) });
  console.log('  fatto');
}
if (!APPLY) console.log('\nProva a secco: niente è stato scritto. Aggiungi --applica per correggere davvero.');
process.exit(0);
