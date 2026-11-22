// Backup di tutto l'archivio Firestore in un file JSON (gratis, senza piano a pagamento).
// Gira da solo ogni settimana con GitHub Actions (.github/workflows/backup.yml): il file resta
// scaricabile per 90 giorni nella pagina "Actions" del repository (solo se il repository è privato).
// A mano:  npm run backup   -> crea backup-AAAA-MM-GG.json nella cartella del progetto.
// I token delle notifiche (utenti/*/push) non vengono salvati: si rifanno da soli.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, Timestamp, GeoPoint, DocumentReference } from 'firebase-admin/firestore';

const saFile = new URL('../service-account.json', import.meta.url);
const sa = process.env.FIREBASE_SERVICE_ACCOUNT ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
  : existsSync(saFile) ? JSON.parse(readFileSync(saFile, 'utf8')) : null;
if (!sa && !process.env.FIRESTORE_EMULATOR_HOST) { console.error('Manca la chiave dell\'account di servizio Firebase'); process.exit(1); }
initializeApp(sa ? { credential: cert(sa) } : { projectId: process.env.GCLOUD_PROJECT || 'demo-fantabet' });
const fs = getFirestore();

// i tipi speciali di Firestore diventano oggetti riconoscibili, così il ripristino li ricrea uguali
function enc(v) {
  if (v instanceof Timestamp) return { __ts: v.toDate().toISOString() };
  if (v instanceof GeoPoint) return { __geo: [v.latitude, v.longitude] };
  if (v instanceof DocumentReference) return { __ref: v.path };
  if (Array.isArray(v)) return v.map(enc);
  if (v && typeof v === 'object') { const o = {}; for (const k in v) o[k] = enc(v[k]); return o; }
  return v;
}
const SKIP = /^utenti\/[^/]+\/push$/;
const out = {}; let n = 0;
async function dumpCollection(col) {
  if (SKIP.test(col.path)) return;
  for (const ref of await col.listDocuments()) {
    const s = await ref.get();
    if (s.exists) { out[ref.path] = enc(s.data()); n++; }
    for (const sub of await ref.listCollections()) await dumpCollection(sub);
  }
}
for (const col of await fs.listCollections()) await dumpCollection(col);
const day = new Date().toISOString().slice(0, 10);
const file = process.env.BACKUP_FILE || `backup-${day}.json`;
writeFileSync(file, JSON.stringify({ progetto: sa?.project_id || 'emulatore', creato: new Date().toISOString(), documenti: out }, null, 1));
console.log(`Backup fatto: ${n} documenti in ${file}`);
process.exit(0);
