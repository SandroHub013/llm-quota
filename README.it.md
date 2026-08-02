<div align="center">

# LLM Quota

**Una sola dashboard per tutti gli abbonamenti AI che paghi.**

Claude Code · Codex · Gemini · z.ai · Moonshot — su un unico asse dei reset.
Gira sulla tua macchina. Non parla con nessuno tranne i provider.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![CI](https://github.com/SandroHub013/llm-quota/actions/workflows/ci.yml/badge.svg)](https://github.com/SandroHub013/llm-quota/actions/workflows/ci.yml)
[![Runtime: Bun](https://img.shields.io/badge/runtime-Bun-000?logo=bun)](https://bun.sh)

**[→ Sito llm-quota](https://sandrohub013.github.io/llm-quota/)**

[Avvio rapido](#avvio-rapido) · [Provider](#provider-supportati) · [CLI](#cli-per-terminale-e-agenti-ai) · [Privacy](#privacy) · [🇬🇧 English](README.md)

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

- ⏳ **Orizzonte reset** — i reset dei cinque provider misurabili su un solo asse temporale. Passando su un
  marcatore si illumina la card corrispondente, e viceversa.
- 🔑 **Riusa le sessioni che hai già** — legge i token OAuth che le CLI ufficiali (`claude`,
  `codex`, `opencode`) hanno già scritto su disco. Per quasi tutti i provider, zero login nuovi.
- 💶 **Registro token locale** — somma la cronologia di Codex, Claude Code, OpenCode e Kimi
  Code per modello, effort e main/subagent, stimandone in euro il valore API equivalente e
  mostrando un indice di efficienza basato sul riuso del contesto.
- 🔒 **Local-first** — nessun cloud, nessun database, nessun account. Chiavi e token non lasciano
  mai la macchina.
- 🚫 **Zero richieste di terze parti** — font e loghi sono serviti da `public/`. La pagina non
  carica nulla da CDN, font host o servizi di favicon. [Garantito da un test.](src/frontend.test.ts)
- 🤖 **CLI pensata per agenti AI** — `llm-quota status --json` produce JSON sanitizzato ed exit
  code sensati: un agente può verificare il proprio budget prima di partire con un job lungo.
- 🪟 **Widget desktop Windows** — widget Tk flottante sempre in primo piano, lanciato dalla
  dashboard tramite il protocollo `llmquota://widget`.
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

È tutta l'installazione. Se già usi Claude Code, Codex o OpenCode, quei provider si accendono
subito: la dashboard raccoglie i token che quelle CLI hanno già salvato.

<details>
<summary>Installare la CLI globalmente</summary>

```bash
bun add -g github:SandroHub013/llm-quota
llm-quota status
```
Vengono registrati sia `llm-quota` sia `webquota`.
</details>

<details>
<summary>Altre opzioni</summary>

```bash
bun run dev            # hot reload
PORT=8080 bun start    # porta personalizzata
```
</details>

---

## Provider supportati

| Provider | Credenziali lette da | Cosa ottieni |
|---|---|---|
| **Claude Code** | `~/.claude/.credentials.json` (OAuth) | Live: finestra 5h + quota settimanale %, orario reset |
| **Codex** (ChatGPT) | `~/.codex/auth.json` (OAuth) | Piano attivo + finestre d'uso |
| **z.ai** | Config `opencode` o chiave incollata | Live: token 5h + mensile %, stato web search |
| **Gemini** | Login Google in-app o chiave AI Studio | Live: quota per modello via Code Assist / AI Studio |
| **Moonshot** | Chiave API incollata | Live: credito residuo e utilizzo |

OpenCode resta una fonte del registro token locale, ma Zen non compare nelle card quota: il suo
endpoint pubblico espone il catalogo modelli, non utilizzo numerico, limiti o tempi di reset.

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
```

Gli exit code la rendono scriptabile — e permettono a un agente di decidere da solo se partire:

| Codice | Significato |
|---|---|
| `0` | Sistema sano, quota disponibile |
| `1` | Warning — almeno una quota ≤ 20% |
| `2` | Errore di autenticazione o provider irraggiungibile |
| `3` | Server offline o parametri errati |

Per host o porta diversi: `LLM_QUOTA_URL=http://localhost:4747`.

---

## Widget desktop (Windows)

```bash
python widget.py --register-protocol
```

Registra il protocollo `llmquota://widget`. Il pulsante **Widget** nella dashboard lancia poi il
widget Tk flottante sul desktop.

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
- Le credenziali vengono lette da disco, usate per chiamare il provider, e mai scritte altrove.

---

## Architettura

```text
src/
├── server.ts          # Backend Hono (/api/quota, /api/key, /api/auth/gemini)
├── credentials.ts     # Parser credenziali locali e config utente
├── cli.ts             # CLI per sviluppatori e agenti
└── providers/         # Un adapter per provider (fetch → QuotaResult)
public/                # SPA frontend — HTML, CSS, JS vanilla, nessun build step
├── fonts/             # Font variabili self-hosted (woff2, subset latino)
└── logos/             # Marchi ufficiali dei provider, congelati
widget.py              # Widget desktop Tkinter per Windows
```

Stack: [Bun](https://bun.sh) + [Hono](https://hono.dev) + TypeScript. Una sola dipendenza runtime.
Nessun bundler, nessun framework, nessun build step per il frontend.

```bash
bun test          # 31 test
bun run typecheck
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
