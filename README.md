# Fanta Bet Serie A

App Vite + Firebase (Firestore e login Google). Per installarla e pubblicarla segui **[GUIDA.md](GUIDA.md)**.

- `npm run dev`: prova in locale
- `npm run deploy`: build e pubblicazione su Firebase Hosting, con le regole Firestore
- `npm run import`: importa `dati/fantabet-export.json` (usa `-- --prova` per una prova a secco)
- `npm run aggiorna`: aggiorna calendario, risultati e marcatori da ESPN (gratis, senza chiave)
- `npm run prova-notifica -- <uid>`: manda una notifica di prova ai dispositivi di quell'account
