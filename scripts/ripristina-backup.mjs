// Ripristina un backup creato da backup.mjs. Riscrive i documenti presenti nel backup (gli altri restano).
//   prova a secco:  node scripts/ripristina-backup.mjs backup-AAAA-MM-GG.json
//   per davvero:    node scripts/ripristina-backup.mjs backup-AAAA-MM-GG.json --applica
//   solo una parte: aggiungi  --solo leghe/lanciano777   (ripristina solo i percorsi che iniziano così)
import { readFileSync, existsSync } from 'node:fs';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, Timestamp, GeoPoint } from 'firebase-admin/firestore';

const file = process.argv[2];
if (!file || !existsSync(file)) { console.error('Indica il file di backup, es: node scripts/ripristina-backup.mjs backup-2026-11-29.json'); process.exit(1); }
const APPLY = process.argv.includes('--applica');
const si = process.argv.indexOf('--solo'); const only = si > 0 ? process.argv[si + 1] : '';
const saFile = new URL('../service-account.json', import.meta.url);
const sa = process.env.FIREBASE_SERVICE_ACCOUNT ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT) : existsSync(saFile) ? JSON.parse(readFileSync(saFile, 'utf8')) : null;
initializeApp(sa ? { credential: cert(sa) } : { projectId: process.env.GCLOUD_PROJECT || 'demo-fantabet' });
const fs = getFirestore();
function dec(v) {
  if (Array.isArray(v)) return v.map(dec);
  if (v && typeof v === 'object') {
    if ('__ts' in v) return Timestamp.fromDate(new Date(v.__ts));
    if ('__geo' in v) return new GeoPoint(v.__geo[0], v.__geo[1]);
    if ('__ref' in v) return fs.doc(v.__ref);
    const o = {}; for (const k in v) o[k] = dec(v[k]); return o;
  }
  return v;
}
const b = JSON.parse(readFileSync(file, 'utf8'));
const paths = Object.keys(b.documenti).filter(p => !only || p === only || p.startsWith(only + '/'));
console.log(`Backup del ${b.creato}: ${paths.length} documenti da ripristinare${only ? ' (solo ' + only + ')' : ''}.`);
if (!APPLY) { console.log('Prova a secco: niente è stato scritto. Aggiungi --applica per ripristinare davvero.'); process.exit(0); }
let batch = fs.batch(), k = 0;
for (const p of paths) { batch.set(fs.doc(p), dec(b.documenti[p])); if (++k % 400 === 0) { await batch.commit(); batch = fs.batch(); } }
await batch.commit();
console.log(`Ripristinati ${k} documenti.`);
process.exit(0);
