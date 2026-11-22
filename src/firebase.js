// Collegamento a Firebase: login Google (Auth) e archivio (Firestore).
// Espone a app.js un piccolo "db" con la stessa forma che usava l'artefatto
// (db.doc(path).set / onSnapshot, db.collection(path).onSnapshot), così la
// logica del gioco resta identica all'originale.
import { initializeApp } from 'firebase/app';
import { getAuth, connectAuthEmulator, signInWithEmailAndPassword, createUserWithEmailAndPassword, GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signInWithRedirect, signOut } from 'firebase/auth';
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  connectFirestoreEmulator, doc, collection, setDoc, getDoc, getDocs, updateDoc, onSnapshot, serverTimestamp, deleteField, Timestamp
} from 'firebase/firestore';

const envConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};
// Se il file .env non c'è, i codici li fornisce Firebase Hosting da solo (/__/firebase/init.json):
// basta pubblicare l'app con "npm run deploy".
// Codici del progetto Firebase "fanta-bet-serie-a" (sono pubblici per natura: la sicurezza la fanno le regole Firestore).
const PROJECT_CONFIG = {
  apiKey: 'AIzaSyC7ZQo7QeoS620NiSx61lMnG_6fLnkoev8',
  authDomain: 'fanta-bet-serie-a.firebaseapp.com',
  projectId: 'fanta-bet-serie-a',
  storageBucket: 'fanta-bet-serie-a.firebasestorage.app',
  messagingSenderId: '1028767563317',
  appId: '1:1028767563317:web:0f0d4e658cd0c7a10b7b7c',
};
const firebaseConfig = envConfig.apiKey ? envConfig : PROJECT_CONFIG;
export const configured = !!firebaseConfig.apiKey && !!firebaseConfig.projectId;

const app = configured ? initializeApp(firebaseConfig) : null;
const auth = app ? getAuth(app) : null;
const fs = app ? initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) }) : null;
// Solo per le prove in locale con gli emulatori Firebase (VITE_EMULATOR=1 nel file .env)
if (app && import.meta.env.VITE_EMULATOR) {
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectFirestoreEmulator(fs, '127.0.0.1', 8080);
  window.__testLogin = (email, pw = 'prova123') => signInWithEmailAndPassword(auth, email, pw).catch(() => createUserWithEmailAndPassword(auth, email, pw));
}

/* ---------- login ---------- */
export function watchUser(cb) { if (!auth) return cb(null); return onAuthStateChanged(auth, cb); }
export async function login() {
  const p = new GoogleAuthProvider();
  p.setCustomParameters({ prompt: 'select_account' });
  try { await signInWithPopup(auth, p); }
  catch (e) {
    // Su alcuni telefoni (e nell'app installata) i popup sono bloccati: si usa il redirect.
    if (['auth/popup-blocked', 'auth/operation-not-supported-in-this-environment', 'auth/cancelled-popup-request'].includes(e?.code)) return signInWithRedirect(auth, p);
    throw e;
  }
}
export const logout = () => signOut(auth);

/* ---------- conversione dati ---------- */
// Timestamp di Firestore -> stringa ISO, così il resto dell'app lavora sempre con stringhe.
function plain(v) {
  if (v instanceof Timestamp) return v.toDate().toISOString();
  if (Array.isArray(v)) return v.map(plain);
  if (v && typeof v === 'object') { const o = {}; for (const k in v) o[k] = plain(v[k]); return o; }
  return v;
}
const isSlip = p => /^schedine\/[^/]+\/giornate\/[^/]+$/.test(p);
const isRound = p => /^giornate\/[^/]+$/.test(p);
// schedine con l'ora di consegna già fissata dal server (consegnataTs): non va mai riscritta
const hasServerTs = new Set();

function readDoc(path, data) {
  if (!data) return data;
  if (isSlip(path)) {
    if (data.consegnataTs instanceof Timestamp) { hasServerTs.add(path); data = { ...data, consegnata: data.consegnataTs.toDate().toISOString() }; }
    else hasServerTs.delete(path);
    const { consegnataTs, ...rest } = data; data = rest;
  }
  if (isRound(path)) { const { deadlineTs, ...rest } = data; data = rest; }
  return plain(data);
}

function prepareWrite(path, data) {
  if (isRound(path)) {
    // la scadenza viene salvata anche come Timestamp: le regole la confrontano con l'ora del server
    const d = data.deadline ? new Date(data.deadline) : null;
    return { data: d && !isNaN(d) ? { ...data, deadlineTs: Timestamp.fromDate(d) } : data, opts: undefined };
  }
  if (isSlip(path)) {
    const out = { ...data };
    if (out.status === 'consegnato') {
      // ora di consegna = ora del server, impostata una sola volta
      if (!hasServerTs.has(path)) { out.consegnataTs = serverTimestamp(); delete out.consegnata; }
      else delete out.consegnata;
    } else { out.consegnataTs = deleteField(); }
    return { data: out, opts: { merge: true } };
  }
  return { data, opts: undefined };
}

/* ---------- leghe ---------- */
// Tutti i dati di una lega stanno sotto leghe/{id}/...; "utenti", "leghe" e "serieA" restano globali.
let league = null;
export function setLeague(id) { league = id; }
const full = p => (/^(utenti|leghe|serieA)(\/|$)/.test(p) || !league) ? p : `leghe/${league}/${p}`;
export const slug = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
// la password non viene mai salvata in chiaro: si salva l'impronta SHA-256 di "id-lega:password"
export async function pwHash(id, pw) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(id + ':' + pw));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export const db = fs && {
  doc(rel) {
    const path = rel, ref = doc(fs, full(rel));
    return {
      set(data) {
        if (/^utenti\//.test(path)) return setDoc(ref, data, { merge: true });
        const w = prepareWrite(path, data); return w.opts ? setDoc(ref, w.data, w.opts) : setDoc(ref, w.data);
      },
      raw(data, opts) { return opts ? setDoc(ref, data, opts) : setDoc(ref, data); },
      update(data) { return updateDoc(ref, data); },
      async get() { const s = await getDoc(ref); return s.exists() ? readDoc(path, s.data()) : null; },
      onSnapshot(cb, err) { return onSnapshot(ref, s => cb({ id: s.id, data: () => readDoc(path, s.data()) }), err); },
    };
  },
  collection(rel) {
    const path = rel, ref = collection(fs, full(rel));
    return {
      async get() { const s = await getDocs(ref); return s.docs.map(d => ({ id: d.id, data: readDoc(path + '/' + d.id, d.data()) })); },
      onSnapshot(cb, err) {
        return onSnapshot(ref, s => cb({ docs: s.docs.map(d => ({ id: d.id, data: () => readDoc(path + '/' + d.id, d.data()) })) }), err);
      },
    };
  },
};
export const deadlineTsOf = iso => { const d = iso ? new Date(iso) : null; return d && !isNaN(d) ? Timestamp.fromDate(d) : null; };
