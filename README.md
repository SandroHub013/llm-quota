# LLM Quota

Dashboard unificata e CLI local-first per monitorare lo stato delle quote dei tuoi abbonamenti e provider AI: **Claude Code, Codex (ChatGPT), z.ai, OpenCode Zen, Gemini, Moonshot AI**.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

---

## ⚡ Caratteristiche

- 🔒 **Local-first & Privacy-focused**: Non richiede server esterni o database cloud. Le tue API Key e token restano sempre sul tuo dispositivo.
- 🔑 **Riuṣa le sessioni esistenti**: Riconosce automaticamente i token OAuth salvati dalle CLI ufficiali (`Claude Code`, `Codex`, `OpenCode`).
- 🌐 **Dashboard Web**: Interfaccia reattiva e moderna per monitorare tutti i provider in un unico punto.
- 💻 **Widget Desktop Windows**: Floating widget integrato su Windows (interagibile tramite protocollo `llmquota://widget`).
- 🤖 **CLI per Agenti AI & Terminale**: Output compatto in testo o JSON sanitizzato (`llm-quota status --json`), perfetto per integrarli in agenti, script e prompt.

---

## 🚀 Requisiti e Installazione

### Requisiti
- [Bun](https://bun.sh) (consigliato v1.0+) oppure Node.js v18+
- Python 3 (opzionale, richiesto solo per il widget GUI su Windows)

### Quickstart

1. **Clona il repository**:
   ```bash
   git clone https://github.com/SandroHub013/llm-quota.git
   cd llm-quota
   ```

2. **Installa le dipendenze**:
   ```bash
   bun install
   ```

3. **Avvia la Dashboard**:
   ```bash
   bun run dev          # http://localhost:4747 (con hot reload)
   ```
   oppure in produzione:
   ```bash
   PORT=8080 bun start
   ```

---

## 🪟 Widget Desktop (Windows)

Per registrare ed abilitare il pulsante **Widget Desktop**:

```bash
python widget.py --register-protocol
```

Questo registra il protocollo `llmquota://widget`. Cliccando su **Widget** nella dashboard web, verrà lanciato l'applicativo GUI Tk direttamente sul desktop interattivo.

---

## 🖥️ CLI per Agenti e Terminale

Quando il server è in esecuzione, puoi interrogare lo stato delle quote direttamente da riga di comando:

```bash
# Esegui tramite il binario installato o via bun
bun run cli status             # Output sintetico in formato testo
bun run cli status --json      # JSON sanitizzato per prompt/agenti AI
bun run cli provider codex     # Controlla solo un provider specifico
bun run cli doctor             # Health check dello stato del server
```

### Codici di Uscita (Exit Codes)
- `0`: Sistema sano e quote sufficienti
- `1`: Warning (almeno una quota residua ≤ 20%)
- `2`: Errore di autenticazione o provider non raggiungibile
- `3`: Server offline o parametri errati

Per server remoto o porta personalizzata: `LLM_QUOTA_URL=http://localhost:4747 bun run cli status`

---

## 🗝️ Gestione delle Credenziali

| Provider | Fonte delle credenziali | Monitoraggio |
|---|---|---|
| **Claude Code** | `~/.claude/.credentials.json` (OAuth) | **Live**: finestra 5h + quota settimanale %, reset time |
| **Codex** | `~/.codex/auth.json` (OAuth ChatGPT) | Piano attivo + finestre d'uso |
| **z.ai** | Key in `opencode` o inserimento manuale | **Live**: token 5h + mensile %, status web search |
| **OpenCode Zen**| Key in `opencode` o inserimento manuale | Validità chiave API + numero modelli |
| **Gemini** | Login Google in-app o Key AI Studio | **Live**: quota modelli via Code Assist / AI Studio |
| **Moonshot** | API Key manuale | **Live**: credito residuo ed utilizzo |

> Le API Key inserite manualmente vengono salvate in locale in `~/.llm-quota/config.json` e **mai inviate a terzi o committate**.

---

## 🛠️ Architettura del Progetto

```text
src/
├── server.ts              # Backend Hono (API endpoints: /api/quota, /api/key)
├── credentials.ts         # Parser credenziali locali e configurazione utente
├── cli.ts                 # CLI riga di comando per sviluppatori ed agenti
├── providers/             # Adapter per ciascun provider AI (fetch → QuotaResult)
public/                    # Frontend SPA (HTML5/CSS3/Vanilla JS, zero CDN est.)
widget.py                  # Desktop Widget Tkinter per Windows
```

Per aggiungere un nuovo provider AI: crea una nuova classe adapter in `src/providers/` implementando l'interfaccia `Provider` e registrala in `src/providers/index.ts`.

---

## 📜 Licenza

Rilasciato sotto licenza [MIT](LICENSE). Libero per uso personale e commerciale. Contributi e Pull Request sono i benvenuti!
