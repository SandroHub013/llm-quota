<div align="center">

# LLM Quota

> Questa è la traduzione italiana della documentazione. Dashboard, CLI e widget hanno
> intenzionalmente un'interfaccia in inglese.

**Una sola dashboard live per tutti gli abbonamenti AI che paghi.**

Claude Code · Codex · Gemini — su un unico asse dei reset.
Gira sulla tua macchina. Non parla con nessuno tranne i provider.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![CI](https://github.com/SandroHub013/llm-quota/actions/workflows/ci.yml/badge.svg)](https://github.com/SandroHub013/llm-quota/actions/workflows/ci.yml)
[![Runtime: Bun](https://img.shields.io/badge/runtime-Bun-000?logo=bun)](https://bun.sh)
[![GitHub Release Downloads](https://img.shields.io/github/downloads/SandroHub013/llm-quota/total?color=green&logo=github)](https://github.com/SandroHub013/llm-quota/releases)

**[→ Sito llm-quota](https://sandrohub013.github.io/llm-quota/)**

[Avvio rapido](#avvio-rapido) · [Personalizzazione](#la-tua-installazione-i-tuoi-dati) · [Provider](#provider-supportati) · [CLI](#cli-per-terminale-e-agenti-ai) · [Privacy](#privacy) · [🇬🇧 English](README.md)

![Dashboard LLM Quota](docs/dashboard-preview.jpg)

</div>

---

## Il problema

Paghi quattro o cinque abbonamenti AI. Ognuno ti limita in modo diverso, in una console diversa,
su un orologio diverso. Claude Code ha una finestra da 5 ore *e* un tetto settimanale. Codex ha
il suo. Gemini conta per modello. Nel momento in cui sbatti contro un limite, l'unica domanda che
conta è quella a cui nessuna percentuale risponde:

> **Quando torno operativo?**

LLM Quota mette tutti i reset di tutti i provider su un unico orizzonte — adesso → 7 giorni — così
vedi a colpo d'occhio quale abbonamento è libero, quale è in raffreddamento e quando rientrare.

## Caratteristiche

- ⏳ **Orizzonte reset** — i reset di ogni provider misurabile su un solo asse temporale. Passando su un
  marcatore si illumina la card corrispondente, e viceversa.
- ⚡ **Live senza ricaricare** — le quote si aggiornano silenziosamente ogni minuto, la spesa locale
  ogni cinque secondi e i countdown continuano tra una richiesta e l'altra. I dati invariati non ridisegnano l'interfaccia.
- 🔑 **Prima le superfici ufficiali** — Codex passa da `codex app-server`; Claude Code e
  Antigravity consegnano volontariamente il JSON quota tramite bridge locali opt-in della status
  line. LLM Quota non legge né rinnova mai il token OAuth di un altro client.
- 💶 **Registro token locale** — somma la cronologia di Codex, Claude Code, OpenCode, Kimi Code,
  pi, Prime Agent e NikCLI per modello, effort e main/subagent, stimandone in euro il valore API equivalente e
  mostrando un indice di efficienza basato sul riuso del contesto. Un calendario giornaliero in
  stile GitHub mostra quando sono stati usati token ed euro; la vista GitHub opzionale usa sempre
  l'account autenticato localmente con `gh`.
- 🔒 **Local-first** — nessun cloud, nessun database, nessun account. Chiavi e token non lasciano
  mai la macchina.
- 🚫 **Zero richieste di terze parti** — font e loghi sono serviti da `public/`. La pagina non
  carica nulla da CDN, font host o servizi di favicon. [Garantito da un test.](src/frontend.test.ts)
- 🤖 **CLI pensata per agenti AI** — `llm-quota status --json` produce JSON sanitizzato ed exit
  code sensati: un agente può verificare il proprio budget prima di partire con un job lungo.
- 🪟 **Widget desktop Windows** — widget Tk flottante sempre in primo piano, lanciato dalla
  dashboard tramite il protocollo `llmquota://widget`. Aggiorna silenziosamente le quote ogni
  minuto, la spesa locale ogni cinque secondi e mantiene vivi i countdown tra una richiesta e l'altra.
  Mostra le stesse card della dashboard; OpenCode resta incluso soltanto nella spesa locale.
- ♿ **Accessibile** — navigazione da tastiera, `prefers-reduced-motion` rispettato, tutte le card
  principali a schermo senza scroll nei comuni viewport desktop e laptop.

---

## Avvio rapido

**Richiede [Bun](https://bun.sh) 1.0+.** (Il server usa `Bun.serve`; Node non è supportato.)
Python 3 è opzionale, serve solo per il widget Windows.

```bash
git clone https://github.com/SandroHub013/llm-quota.git
cd llm-quota
bun install
bun start          # → http://localhost:4747
```

È tutta l'installazione. Codex si popola tramite il suo app-server ufficiale. Nelle card Claude e
Gemini puoi scegliere una volta **Enable official bridge** per ricevere le quote dai rispettivi
client ufficiali, su Windows, macOS e Linux allo stesso modo. Si installa con un clic, si rimuove
con un clic, e in entrambi i casi la status line che già usavi resta al suo posto.

<details>
<summary>Installare la CLI globalmente</summary>

```bash
bun add -g llm-quota      # oppure: npm install -g llm-quota
llm-quota status
```
Vengono registrati sia `llm-quota` sia `webquota`. Il pacchetto gira comunque su Bun: npm è solo il
canale di distribuzione. Per seguire il branch invece di una release, usa
`bun add -g github:SandroHub013/llm-quota`.
</details>

<details>
<summary>Altre opzioni</summary>

```bash
bun run dev            # hot reload
PORT=8080 bun start    # porta personalizzata su macOS / Linux
```

```powershell
$env:PORT=8080; bun start    # porta personalizzata su Windows
```
</details>

---

## La tua installazione, i tuoi dati

Nessun account, username, valore quota o totale di spesa runtime è legato all'autore del progetto:

- L'autenticazione Codex resta dentro `codex app-server`: LLM Quota non apre il relativo file auth.
- I bridge Claude/Antigravity, attivati esplicitamente, salvano soltanto finestre quota e reset;
  escludono identità, transcript e access token e preservano la status line personalizzata esistente.
- Il registro token analizza la cronologia locale dell'utente per Codex, Claude Code, OpenCode,
  Kimi Code, pi, Prime Agent e NikCLI. Hermes non tiene alcuna traccia locale dei token, quindi la
  sua spesa non è conteggiabile.
- Il calendario contribution opzionale interroga l'utente autenticato nella CLI ufficiale GitHub.
  Esegui `gh auth login` per abilitarlo; senza `gh`, il calendario della spesa locale continua a funzionare.
- Una dashboard su una porta locale personalizzata passa automaticamente la propria origine al widget Windows.
  CLI e widget avviato manualmente accettano anche `LLM_QUOTA_URL`; il widget accetta inoltre `--server-url`.

Screenshot e anteprime social usano dati campione sintetici: non contengono account del maintainer,
credenziali o cronologie d'uso reali.

---

## Provider supportati

| Provider | Fonte supportata | Cosa ottieni |
|---|---|---|
| **Claude Code** | JSON ufficiale della status line (opt-in) | Quota 5h + settimanale %, reset e freschezza della fonte |
| **Codex** (ChatGPT) | JSON-RPC ufficiale `codex app-server` | Piano attivo + finestre d'uso |
| **Gemini / Antigravity** | JSON ufficiale della status line Antigravity (opt-in) | Quota residua per bucket e reset |
| **z.ai** | Card disabilitata | La status line del GLM Coding Plan non espone alcun campo quota; i token restano nel registro locale |
| **Kimi / Moonshot** | Card disabilitata | La quota del piano Kimi Code non ha una fonte machine-readable conforme; i token restano nel registro locale |

Oggi vengono spedite tre card provider. OpenCode, pi, Prime Agent e NikCLI sono fonti solo del
registro: non pubblicano quota di piano, quindi contribuiscono alla spesa locale e a nessuna card.
Il gateway Zen di OpenCode è stato rimosso del tutto, perché l'endpoint pubblico espone il catalogo modelli e non
utilizzo numerico, limiti o tempi di reset.
Kimi è disabilitato per lo stesso motivo: la sua status line ufficiale non porta campi di quota, rate
limit o abbonamento, le finestre del piano dietro `/usage` sono raggiungibili solo con il token
OAuth della CLI Kimi Code, e il balance documentato di Open Platform è credito API, non quota del
piano. Nemmeno il plugin di Z.ai pubblica un campo quota, quindi la sua card è stata ritirata
invece di restare a promettere un dato che non arriva.

Le chiavi inserite a mano restano in locale in `~/.llm-quota/config.json`. Non vengono mai inviate
a nessuno tranne al provider a cui appartengono, e mai committate.

**Vuoi aggiungere un provider?** Crea un adapter in `src/providers/` che implementi l'interfaccia
`Provider` e registralo in `src/providers/index.ts`. È tutto il contratto — vedi
[CONTRIBUTING.md](CONTRIBUTING.md).

---

## CLI per terminale e agenti AI

Con il server in esecuzione:

```bash
bun run cli status            # riepilogo testuale compatto
bun run cli status --json     # JSON sanitizzato, sicuro da incollare in un prompt
bun run cli provider codex    # un solo provider
bun run cli doctor            # health check
bun run cli stats             # contatori di download pubblici del progetto
```

Gli exit code la rendono scriptabile — e permettono a un agente di decidere da solo se partire:

| Codice | Significato |
|---|---|
| `0` | Sistema sano, quota disponibile |
| `1` | Warning — almeno una quota ≤ 20% |
| `2` | Errore di autenticazione o provider irraggiungibile |
| `3` | Server offline o parametri errati |

Per host o porta diversi: `LLM_QUOTA_URL=http://localhost:8080`.

---

## Widget desktop (Windows)

```bash
python widget.py --register-protocol
```

Registra il protocollo `llmquota://widget`. Il pulsante **Widget** nella dashboard lancia poi il
widget Tk flottante e gli passa automaticamente l'origine locale della dashboard. Per un avvio
manuale o remoto:

```powershell
python widget.py --server-url http://localhost:8080
python widget.py --register-protocol --server-url http://localhost:8080
```

---

## Privacy

È il punto del progetto, quindi vale la pena essere precisi:

- Nessuna telemetria, nessuna analytics, nessun crash reporting. Non c'è un server a cui riportare.
- Il frontend fa **zero** richieste di terze parti. I font (Syne, Schibsted Grotesk, JetBrains
  Mono — ~102 KB, subset latino) e i loghi provider sono serviti da `public/`. Un
  [test](src/frontend.test.ts) fallisce se un host esterno rientra dalla finestra.
- I loghi sono congelati nel repository di proposito: caricarli dal provider — o da un servizio di
  favicon, come faceva una versione precedente — direbbe a terzi quali abbonamenti AI possiedi, a
  ogni caricamento di pagina.
- I file OAuth di Codex, Claude, Gemini, OpenCode, Kimi, pi, Prime Agent e NikCLI non vengono letti
  né modificati: si leggono solo i transcript di sessione e i database locali. Le chiavi
  Open Platform inserite dall'utente vengono usate soltanto con l'API documentata del provider.

---

## Architettura

```text
src/
├── server.ts          # Backend Hono solo loopback (/api/quota, /api/key, /api/official-bridge)
├── codex-app-server.ts# Client JSON-RPC ufficiale Codex
├── official-bridge.ts # Wrapper status line Claude/Antigravity opt-in
├── usage.ts           # Cronologia CLI locale → registro token e calendario spesa
├── credentials.ts     # Config delle sole chiavi inserite dall'utente
├── cli.ts             # CLI per sviluppatori e agenti
├── cli-core.ts        # Riepilogo quota, formattazione ed exit code
└── providers/         # Un adapter per provider (fetch → QuotaResult)
public/                # SPA frontend — HTML, CSS, JS vanilla, nessun build step
├── fonts/             # Font variabili self-hosted (woff2, subset latino)
└── logos/             # Marchi ufficiali dei provider, congelati
widget.py              # Widget desktop Tkinter per Windows
```

Stack: [Bun](https://bun.sh) + [Hono](https://hono.dev) + TypeScript. Una sola dipendenza runtime.
Nessun bundler, nessun framework, nessun build step per il frontend.

```bash
bun test                        # TypeScript: server, provider, CLI, guard frontend
bun run typecheck
python -m unittest widget_test  # Python: il widget Windows
```

---

## Contribuire

Nuovi adapter, bug report e fix UI sono benvenuti — parti da [CONTRIBUTING.md](CONTRIBUTING.md).

## Licenza

[MIT](LICENSE). Libero per uso personale e commerciale.

### Marchi

La licenza MIT copre il codice di questo progetto, non i marchi altrui. I loghi in
`public/logos/` appartengono ai rispettivi titolari (Anthropic, OpenAI, Z.ai, OpenCode, Google,
Moonshot AI) e sono inclusi solo per identificare il servizio a cui ciascuna card si riferisce.
Questo progetto non è affiliato né approvato da nessuno di essi.
