// Importa in Firestore i dati esportati dall'artefatto (dati/fantabet-export.json).
//
// Uso:
//   npm run import -- --lega "Fanta Bet" --password "segreta" --prova   (mostra cosa farebbe, senza scrivere)
//   npm run import -- --lega "Fanta Bet" --password "segreta"           (scrive davvero)
// I dati diventano una lega: gli altri ci entrano dall'app con quel nome e quella password.
//
// Serve il file service-account.json nella cartella principale del progetto
// (console Firebase > Impostazioni progetto > Account di servizio > Genera nuova chiave privata).
//
// Cosa fa, oltre a copiare i documenti:
// - sostituisce gli ID utente di Claude (u_...) con gli UID di Firebase, cercando l'email
//   scritta in scripts/mappa-utenti.json;
// - imposta l'organizzatore (fantabet/config.owner);
// - salva scadenze e orari di consegna anche come Timestamp, usati dalle regole di sicurezza;
// - i giocatori senza email: le loro schedine finiscono nel documento della giornata
//   (come per i giocatori "manuali"), così non si perde nulla e li colleghi dopo dall'app.
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { initializeApp, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';

const DRY = process.argv.includes('--prova');
const arg = k => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const LEGA_NOME = (arg('--lega') || '').trim(), PW = arg('--password') || '';
const slug = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
const LEGA = slug(LEGA_NOME);
if (!LEGA || PW.length < 4) { console.error('Indica nome e password della lega: npm run import -- --lega "Fanta Bet" --password "almeno4caratteri"'); process.exit(1); }
const HASH = createHash('sha256').update(LEGA + ':' + PW).digest('hex');
const root = new URL('..', import.meta.url);
const read = p => JSON.parse(readFileSync(new URL(p, root), 'utf8'));

const EMU = !!process.env.FIRESTORE_EMULATOR_HOST; // prove in locale con gli emulatori
if (!EMU && !existsSync(new URL('service-account.json', root))) {
  console.error('Manca service-account.json nella cartella del progetto (vedi GUIDA).'); process.exit(1);
}
const sa = EMU ? { project_id: process.env.GCLOUD_PROJECT || 'demo-fantabet' } : read('service-account.json');
initializeApp(EMU ? { projectId: sa.project_id } : { credential: cert(sa) });
const auth = getAuth(), fs = getFirestore();

const exp = read('dati/fantabet-export.json');
const map = process.env.MAPPA ? JSON.parse(readFileSync(process.env.MAPPA, 'utf8')) : read('scripts/mappa-utenti.json');
const docs = exp.documenti;
console.log(`Progetto Firebase: ${sa.project_id} · documenti nell'export: ${Object.keys(docs).length}${DRY ? ' · MODALITÀ PROVA' : ''}`);

async function uidFor(email) {
  if (!email) return null;
  try { return (await auth.getUserByEmail(email.trim())).uid; }
  catch (e) {
    if (e.code === 'auth/user-not-found') { console.error(`✗ ${email}: non ha ancora fatto l'accesso all'app. Fallo accedere una volta e rilancia.`); process.exit(1); }
    throw e;
  }
}
const ownerUid = await uidFor(map.organizzatore);
if (!ownerUid) { console.error('✗ Scrivi la tua email in "organizzatore" dentro scripts/mappa-utenti.json.'); process.exit(1); }
const idMap = {};
for (const [old, v] of Object.entries(map.giocatori || {})) idMap[old] = await uidFor(v.email);
for (const [old, uid] of Object.entries(idMap)) console.log(`  ${map.giocatori[old].giocatore}: ${uid ? '→ ' + uid : 'nessuna email, resta "manuale" (collegalo dopo dall\'app)'}`);

const config = structuredClone(docs['fantabet/config']);
const pidOfOld = old => Object.keys(config.members || {}).find(p => config.members[p] === old);
const players = config.players || {};

const writes = new Map(); // percorso -> dati
const put = (p, d) => writes.set(p, d);
const toTs = s => { const d = s ? new Date(s) : null; return d && !isNaN(d) ? Timestamp.fromDate(d) : null; };

// configurazione: membri rimappati, organizzatore
const members = {};
for (const [pid, old] of Object.entries(config.members || {})) if (idMap[old]) members[pid] = idMap[old];
put('fantabet/config', { ...config, members, owner: ownerUid });

// giornate (+ deadlineTs)
const rounds = {};
for (const [p, d] of Object.entries(docs)) if (/^giornate\/[^/]+$/.test(p)) rounds[p] = structuredClone(d);

for (const [p, d] of Object.entries(docs)) {
  if (p === 'fantabet/config' || /^giornate\/[^/]+$/.test(p)) continue;
  let m;
  if ((m = p.match(/^schedine\/([^/]+)\/giornate\/([^/]+)$/))) {
    const [, old, g] = m; const uid = idMap[old];
    const slip = structuredClone(d);
    if (uid) {
      const ts = toTs(slip.consegnata);
      if (ts) slip.consegnataTs = ts;
      put(`schedine/${uid}/giornate/${g}`, slip);
    } else {
      // giocatore non collegato: la schedina va nel documento della giornata
      const pid = pidOfOld(old); const r = rounds['giornate/' + g];
      if (pid && r) { r.preds = r.preds || {}; const { num, ...rest } = slip; r.preds[pid] = rest; }
      else console.warn(`  ! schedina ${p} non associabile, saltata`);
    }
  } else if ((m = p.match(/^schedine\/([^/]+)$/))) {
    const uid = idMap[m[1]]; if (uid) put(`schedine/${uid}`, d);
  } else if ((m = p.match(/^chat\/([^/]+)$/))) {
    const old = m[1]; const uid = idMap[old];
    put(`chat/${uid || old}`, d);
    // se l'autore non è ancora collegato, il nome resta visibile in chat
    if (!uid) { const pid = pidOfOld(old); put(`utenti/${old}`, { name: players[pid] || 'Partecipante', at: new Date().toISOString() }); }
  } else {
    put(p, d); // fantabet/*, registro/*
  }
}
for (const [p, r] of Object.entries(rounds)) { const ts = toTs(r.deadline); put(p, ts ? { ...r, deadlineTs: ts } : r); }

console.log(`Lega: «${LEGA_NOME}» (id ${LEGA}) · documenti di gioco: ${writes.size}`);
for (const p of [...writes.keys()].sort()) console.log('  ' + p);
if (DRY) { console.log('Prova finita: nulla è stato scritto. Rilancia senza --prova per importare.'); process.exit(0); }

// lega, password (solo l'impronta), iscritti e calendario ufficiale
const at = new Date().toISOString();
const global = new Map();
global.set(`leghe/${LEGA}`, { nome: LEGA_NOME, owner: ownerUid, creata: at });
global.set(`leghe/${LEGA}/chiavi/${HASH}`, { at });
const iscr = new Set([ownerUid, ...Object.values(idMap).filter(Boolean)]);
for (const u of iscr) {
  global.set(`leghe/${LEGA}/iscritti/${u}`, { pw: HASH, name: '', at });
  global.set(`utenti/${u}`, { leghe: { [LEGA]: LEGA_NOME } });
}
for (const [p, r] of Object.entries(rounds)) {
  const sp = 'serieA/' + p.split('/')[1];
  if (!(await fs.doc(sp).get()).exists) { const { preds, ...rest } = r; const ts = toTs(r.deadline); global.set(sp, ts ? { ...rest, deadlineTs: ts } : rest); }
}
const all = [...[...writes].map(([p, d]) => [p.startsWith('utenti/') ? p : `leghe/${LEGA}/${p}`, d]), ...global];

let batch = fs.batch(), n = 0, tot = 0;
for (const [p, d] of all) {
  batch.set(fs.doc(p), d, p.startsWith('utenti/') ? { merge: true } : {}); n++; tot++;
  if (n === 400) { await batch.commit(); batch = fs.batch(); n = 0; }
}
if (n) await batch.commit();
console.log(`✓ Importati ${tot} documenti in ${sa.project_id}. Lega «${LEGA_NOME}» pronta: si entra con questo nome e la password scelta.`);
