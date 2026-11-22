# Fanta Bet: come metterla online

Sono 9 passi. Fai un passo alla volta e copia i comandi così come sono.

---

## Passo 0: scarica la cartella

1. Scarica il file **fantabet-firebase.zip** che ti ho mandato in chat.
2. Fai doppio clic sullo zip: si crea la cartella **fantabet-firebase**.
3. Spostala sulla **Scrivania**. Quando la guida dice "la cartella", intende questa.

## Passo 1: installa i programmi (una volta sola)

1. Scarica e installa **Node.js LTS** da https://nodejs.org (basta premere sempre Avanti).
2. Apri il **Terminale** (su Mac cercalo con Spotlight, su Windows apri "PowerShell").
3. Scrivi questo e premi Invio:
   ```
   npm install -g firebase-tools
   ```
   Se su Mac ti dà errore, scrivi `sudo` prima del comando e inserisci la password del Mac.

## Passo 2: crea il progetto su Firebase

1. Vai su https://console.firebase.google.com e premi **Crea un progetto**. Chiamalo `fantabet`. Analytics: **no**.
2. **Database:** scrivi **Firestore** nella barra di ricerca in alto e aprilo. Premi **Crea database**, scegli **Standard**, come posizione **europe-west8 (Milano)**, poi **modalità di produzione**.
3. **Login:** scrivi **Authentication** nella barra di ricerca e aprilo. Premi **Inizia**, poi **Google**, poi **Attiva**, scegli la tua email e premi **Salva**.

## Passo 3: registra l'app

1. Premi l'**ingranaggio** in alto a sinistra, poi **Impostazioni progetto**.
2. In fondo alla pagina premi l'icona **`</>`**, scrivi `Fanta Bet` e premi **Registra app**.
3. Compare un riquadro con dei comandi: **ignoralo**. Non devi copiare niente. Chiudi pure quella schermata.

## Passo 4: pubblica l'app

1. Nel Terminale scrivi `cd ` (con lo spazio dopo), trascina dentro la finestra la cartella **fantabet-firebase** e premi Invio.
2. Scrivi questi comandi, uno alla volta:
   ```
   npm install
   firebase login
   npm run deploy
   ```
   - `firebase login` apre il browser: accedi con il tuo account Google.
3. Alla fine compare un link tipo **https://fantabet-xxxx.web.app**. È la tua app.

## Passo 5: fai accedere tutti una volta

Apri il link e premi **Accedi con Google**. Per ora l'app è vuota: è normale.
Manda il link a Luigi e Francesco e chiedi anche a loro di accedere una volta.

## Passo 6: scarica la chiave segreta

1. Su Firebase: **ingranaggio → Impostazioni progetto → Account di servizio → Genera nuova chiave privata**.
2. Rinomina il file scaricato in **`service-account.json`** e mettilo nella cartella **fantabet-firebase**.

⚠️ Non mandare questo file a nessuno.

## Passo 7: carica i dati vecchi

1. Apri il file **`scripts/mappa-utenti.json`** e scrivi le email Google tra le virgolette: la tua in `organizzatore` e accanto a Nicola, poi quelle di Luigi e Francesco. Se uno non ha ancora fatto l'accesso, lascia le virgolette vuote: lo colleghi dopo dall'app.
2. Scegli il nome e la password della tua lega e nel Terminale scrivi (con i tuoi valori):
   ```
   npm run import -- --lega "Fanta Bet" --password "lamiapassword"
   ```
3. Ricarica l'app: rivedi classifica, giornate, chat e registro come prima.

## Passo 8: risultati automatici

Calendario, risultati e marcatori arrivano da soli da ESPN, gratis e senza chiavi. Serve solo un repository GitHub con un segreto:
1. Su https://github.com crea un repository **Private** chiamato `fantabet` e caricaci il contenuto della cartella, **tranne** `node_modules`, `.env` e `service-account.json`.
2. In **Settings → Secrets and variables → Actions → New repository secret** crea `FIREBASE_SERVICE_ACCOUNT` e come valore incolla tutto il contenuto di `service-account.json`.
3. In **Actions → Aggiorna risultati** premi **Run workflow**: se il pallino diventa verde, è fatto.

---

## Fatto! Come lo usano i soci

- Mandagli il link, il **nome della lega** e la **password**.
- **Android:** menu ⋮ → **Installa app**. **iPhone:** Condividi → **Aggiungi alla schermata Home**.
- Loro accedono con Google, scrivono nome della lega e password in **Entra in una lega** e sono subito in gara. Chi era già nella lega sceglie il proprio nome.
- Chiunque può anche **creare una lega nuova** e diventarne l'organizzatore. Si passa da una lega all'altra con **cambia**, in alto.

Ti blocchi? Mandami uno screenshot. Le spiegazioni tecniche sono in `APPROFONDIMENTI.md`.
