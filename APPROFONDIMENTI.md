# Fanta Bet: dettagli e problemi comuni

Questo file non serve per partire: per installare l'app basta GUIDA.md.

## Come funziona la sicurezza

Le regole in `firestore.rules`, già caricate al passo 4, fanno in modo che:

- **la scadenza la controlla il server** con la sua ora, non con l'orologio del telefono: dopo la scadenza nessun giocatore può salvare;
- **dopo la consegna la schedina è bloccata**: solo tu puoi riaprirla ("Riapri al giocatore") o modificarla;
- **l'ora di consegna la mette il server**, quindi nessuno può falsificarla per prendersi per primo un risultato esatto o un marcatore;
- **ognuno scrive solo la propria schedina e i propri messaggi in chat**, e solo se l'hai collegato a un giocatore;
- **tu (l'organizzatore) puoi tutto**: giornate, risultati, punti manuali, registro, collegamenti.

Un limite, uguale a quello dell'artefatto: chi ha fatto l'accesso potrebbe leggere i dati grezzi del database con strumenti tecnici, comprese le schedine degli altri prima che siano visibili nell'app.

## Modifiche future

Dopo una modifica ai file dell'app, ripubblica con `npm run deploy`. Se cambi `aggiorna-risultati.mjs`, ricarica il file anche su GitHub.

## Problemi comuni

| Problema | Soluzione |
|---|---|
| "Configurazione Firebase mancante" | Apri l'app dal link `.web.app` (non aprendo i file dal computer) dopo aver fatto `npm run deploy`. |
| `auth/unauthorized-domain` all'accesso | Authentication → Impostazioni → Domini autorizzati: aggiungi il dominio da cui apri l'app. |
| Un socio non riesce a salvare la schedina | Non è collegato a un giocatore (Classifica → Giocatori), oppure la scadenza è passata o la schedina è già consegnata. |
| L'import dice "non ha ancora fatto l'accesso" | Quella persona deve aprire l'app e accedere una volta, oppure lascia `""` nella mappa. |
| L'Action di GitHub è rossa | Apri l'esecuzione e leggi l'errore. Di solito manca un segreto o è stato incollato male. |

## Risultati automatici: cosa fa lo script

Ogni 20 minuti, dalle 11 a mezzanotte circa:
- crea la giornata successiva con il calendario e la scadenza 1 minuto prima del primo calcio d'inizio;
- inserisce i risultati al 90° e i marcatori (autogol esclusi);
- conferma la giornata quando tutte le partite hanno un risultato o sono segnate come nulle;
- non sovrascrive mai un risultato scritto a mano. I rinvii li decidi tu ("Rinviata, pronostico nullo").

Google non offre un servizio pubblico per i risultati, per questo i dati arrivano da ESPN (gratis, senza chiave).
Nelle schedine conviene scrivere il cognome del marcatore.
