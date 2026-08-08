# Valutazione dei Terms of Service dei provider

**Data della verifica:** 2 agosto 2026  
**Codice verificato:** branch `prototype/widget-liquid-glass`, commit `cd6fb55`  
**Ambito:** OpenAI/Codex, Anthropic/Claude, Google Gemini/Antigravity, Z.ai, Moonshot/Kimi, OpenCode Zen, GitHub e raccolta locale dei token.

> **Documento storico:** la verifica è stata eseguita sul branch
> `prototype/widget-liquid-glass` al commit `cd6fb55`, non sul codice attuale di `main`.
> Le descrizioni di OAuth, endpoint privati e riscrittura delle credenziali riportano quel
> prototipo e non descrivono la release corrente. Non è un parere legale.
>
> I termini applicabili dipendono da paese, tipo di account, piano e accordi aggiuntivi
> sottoscritti dall'utente.

## Risposta breve

Non risulta che **l'intero progetto** violi automaticamente i Terms of Service. Diverse funzioni sono a basso rischio: lettura dei log locali, calendario GitHub tramite API GraphQL ufficiale, `models.list` con API key Gemini e saldo Moonshot tramite endpoint documentato.

L'implementazione corrente contiene però integrazioni che non dovrebbero essere distribuite così come sono:

- **Gemini/Antigravity: rosso, violazione espressa.** L'app usa client ID e secret di Antigravity, si identifica come Antigravity e chiama il backend interno `cloudcode-pa ... /v1internal`. I termini Antigravity vietano espressamente a software terzo di accedere al servizio tramite Antigravity OAuth.
- **Claude consumer OAuth: alto rischio/probabile conflitto.** I termini consumer vietano accesso automatizzato salvo API key o permesso esplicito; il progetto legge il token di Claude Code e interroga un endpoint OAuth non documentato per integrazioni terze.
- **Z.ai Coding Plan: alto rischio.** Il progetto chiama direttamente un endpoint dichiarato dallo stesso codice come non documentato, mentre Z.ai limita il piano ai tool supportati e fornisce un plugin ufficiale per consultare la quota.
- **Codex e Kimi OAuth: area grigia medio-alta.** Gli endpoint compaiono nei client open source ufficiali, ma il progetto prende in carico credenziali e refresh token di un altro client invece di usare la superficie d'integrazione supportata.
- **OpenCode Zen: endpoint consentito, comportamento da correggere.** `/zen/v1/models` è documentato; il problema è il falso user-agent Chrome inserito esplicitamente per superare un blocco Cloudflare, oltre al polling inutile di un provider che non espone quota numerica.

## Scala usata

| Livello | Significato |
| --- | --- |
| Rosso | La condotta corrente coincide con un divieto espresso del provider. |
| Alto | Probabile conflitto tra una clausola espressa e il comportamento osservato; manca una superficie pubblica che autorizzi l'integrazione. |
| Medio-alto | Area grigia concreta: esiste evidenza di uso ufficiale dell'endpoint, ma non un'autorizzazione chiara a riusare identità o credenziali del client ufficiale. |
| Medio | La chiamata può essere documentata, ma alcuni header, frequenza o modalità di accesso aumentano il rischio. |
| Basso | Uso di API/CLI documentata o sola lettura locale, con credenziali gestite dalla superficie ufficiale. |

I livelli sono inferenze prudenziali, non una dichiarazione del provider né una certezza giuridica.

## Comportamento trasversale osservato

La rotta `/api/quota` esegue **tutti** gli adapter registrati e conserva i risultati per soli 55 secondi ([`src/server.ts:33-56`](../../src/server.ts#L33-L56), [`src/providers/index.ts:1-12`](../../src/providers/index.ts#L1-L12)). Ne consegue che anche OpenCode Zen, pur non essendo più utile come card quota, continua a ricevere richieste quando il dashboard aggiorna i provider.

Il progetto legge credenziali create da altri client in `~/.claude`, `~/.codex`, `~/.gemini`, `~/.kimi-code` e `~/.local/share/opencode`; per Codex, Gemini e Kimi può anche riscriverle dopo il refresh ([`src/credentials.ts:18-110`](../../src/credentials.ts#L18-L110)). Le API key inserite dall'utente sono salvate in JSON in `~/.llm-quota/config.json`, senza cifratura o ACL esplicite ([`src/credentials.ts:113-124`](../../src/credentials.ts#L113-L124)).

Diversi adapter includono nel risultato `raw` l'intero payload ricevuto dal provider; `/api/quota` lo restituisce al browser ([`src/server.ts:41-56`](../../src/server.ts#L41-L56)). Questo non prova una violazione ToS, ma aumenta l'impatto di un'eventuale esposizione del server.

## OpenAI / Codex

### Codice corrente

L'adapter:

- legge access token, refresh token e account ID da `~/.codex/auth.json`;
- rinnova autonomamente il token con il client ID pubblico di Codex e riscrive `auth.json`;
- si presenta con `originator: codex_cli_rs` e user-agent `codex_cli_rs/0.20.0 (LLM Quota)`;
- chiama direttamente `https://chatgpt.com/backend-api/wham/usage`, con fallback a `/backend-api/codex/usage`.

Prove: [`src/providers/codex.ts:5-8`](../../src/providers/codex.ts#L5-L8), [`src/providers/codex.ts:25-74`](../../src/providers/codex.ts#L25-L74), [`src/providers/codex.ts:79-105`](../../src/providers/codex.ts#L79-L105).

### Fonti ufficiali e valutazione

I [Terms of Use europei OpenAI, aggiornati il 16 gennaio 2026](https://openai.com/policies/terms-of-use/) vietano estrazione automatica o programmatica, reverse engineering e aggiramento di rate limit o misure protettive. La clausola è ampia e rende rischiosa una chiamata automatica ChatGPT gestita fuori dal client previsto.

Il rischio non è però equivalente a Gemini: il repository ufficiale OpenAI usa il backend ChatGPT/WHAM e, soprattutto, documenta in [`codex app-server`](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md) i metodi stabili `account/rateLimits/read` e `account/usage/read`. Quindi il dato è esposto da una superficie ufficiale, ma l'implementazione corrente evita proprio quella superficie e prende possesso dei token.

**Valutazione: medio-alto, non violazione certa.**

### Mitigazione

Usare `codex app-server` via JSON-RPC per `account/rateLimits/read` e `account/usage/read`; lasciare a Codex login, persistenza e refresh. Eliminare lettura/scrittura diretta di `auth.json`, il fallback privato e gli header che attribuiscono la richiesta a `codex_cli_rs`.

## Anthropic / Claude

### Codice corrente

L'adapter legge il bearer OAuth consumer da `~/.claude/.credentials.json`, chiama ogni minuto `https://api.anthropic.com/api/oauth/usage` con beta header `oauth-2025-04-20` e conserva il payload grezzo nel risultato ([`src/providers/claude.ts:5-13`](../../src/providers/claude.ts#L5-L13), [`src/providers/claude.ts:45-68`](../../src/providers/claude.ts#L45-L68), [`src/providers/claude.ts:90-108`](../../src/providers/claude.ts#L90-L108)). Nelle fonti pubbliche consultate non è documentata questa rotta come API per prodotti terzi.

### Fonti ufficiali e valutazione

I [Consumer Terms Anthropic, efficaci dall'8 ottobre 2025](https://www.anthropic.com/legal/consumer-terms) vietano crawl/scrape/harvesting e, salvo API key o permesso esplicito, accesso tramite mezzi automatizzati o non umani. Il polling del dashboard con OAuth consumer ricade plausibilmente nel divieto testuale.

Anthropic offre una [Usage and Cost Admin API](https://platform.claude.com/docs/en/manage-claude/usage-cost-api), documentata anche per dashboard e polling sostenuto una volta al minuto, ma richiede una Admin API key ed è esplicitamente indisponibile agli account individuali. Per gli abbonati Claude.ai Pro/Max, la [status line ufficiale di Claude Code](https://code.claude.com/docs/en/statusline) riceve invece un JSON locale con `rate_limits.five_hour` e `rate_limits.seven_day`, percentuale usata e timestamp di reset, dopo la prima risposta API della sessione.

**Valutazione: alto, probabile conflitto per account consumer.**

### Mitigazione

Disabilitare di default l'adapter OAuth consumer. Per organizzazioni usare Usage/Cost, Rate Limits o Analytics API ufficiali con la key prevista; per account individuali installare, con consenso dell'utente, un bridge PowerShell della status line che salvi in cache soltanto percentuali, reset e data di aggiornamento. Il bridge deve preservare l'eventuale status line esistente e non deve leggere il bearer OAuth né chiamare `/api/oauth/usage`.

## Google Gemini / Antigravity

### Codice corrente

Questa integrazione **non** si limita a riusare il login della Gemini CLI. Il progetto:

- include nel repository un client ID e un client secret dichiarati come appartenenti ad Antigravity;
- richiede scope ampi, inclusi `cloud-platform`, `cclog` ed `experimentsandconfigs`;
- usa user-agent `antigravity/1.0` e `ideType: ANTIGRAVITY`;
- avvia un proprio OAuth loopback, scambia il codice e salva access/refresh token in `~/.gemini/oauth_creds.json`;
- chiama le operazioni interne `loadCodeAssist`, `onboardUser` e `retrieveUserQuotaSummary` su `https://cloudcode-pa.googleapis.com/v1internal`.

Prove: [`src/gemini-oauth.ts:1-24`](../../src/gemini-oauth.ts#L1-L24), [`src/server.ts:94-167`](../../src/server.ts#L94-L167), [`src/providers/gemini.ts:8-38`](../../src/providers/gemini.ts#L8-L38), [`src/providers/gemini.ts:41-75`](../../src/providers/gemini.ts#L41-L75), [`src/providers/gemini.ts:106-163`](../../src/providers/gemini.ts#L106-L163).

### Fonti ufficiali e valutazione

I [Google Antigravity Additional Terms](https://antigravity.google/terms) affermano espressamente che usare software, tool o servizi terzi per accedere ad Antigravity — l'esempio è un tool terzo con Antigravity OAuth — costituisce breach e può comportare sospensione o chiusura dell'account. La [FAQ ufficiale Antigravity](https://antigravity.google/docs/faq) ribadisce il divieto e indica Vertex AI o una API key AI Studio come alternativa supportata.

La condotta viola inoltre più requisiti espressi delle [Google OAuth 2.0 Policies, modificate il 15 dicembre 2025](https://developers.google.com/identity/protocols/oauth2/policies): ogni app deve registrare un client appropriato proprio; un client secret non va mai committato in un repository pubblico; identità e ambiente devono essere rappresentati accuratamente; gli scope devono essere minimi. La [Google API Services User Data Policy, aggiornata il 15 febbraio 2024](https://developers.google.com/terms/api-services-user-data-policy) vieta API non documentate senza permesso e rappresentazioni false o fuorvianti delle credenziali client.

La FAQ Gemini CLI sul divieto di [“harvest or piggyback” dell'OAuth](https://github.com/google-gemini/gemini-cli/blob/main/docs/resources/faq.md) è coerente con questa conclusione, ma non è la prova principale: qui l'identità riutilizzata è Antigravity, non Gemini CLI.

**Valutazione: rosso, incompatibilità espressa.**

### Mitigazione immediata

1. Rimuovere/disabilitare OAuth Antigravity e tutte le chiamate `cloudcode-pa/v1internal`.
2. Rimuovere il secret dal codice e dalla storia pubblicata; il proprietario del client deve revocarlo/ruotarlo. La semplice cancellazione dall'ultimo commit non lo rende nuovamente segreto.
3. Conservare solo il fallback con API key verso [`models.list`, endpoint documentato](https://ai.google.dev/api/models), oppure integrare Vertex AI con un client del progetto correttamente registrato e API pubbliche.
4. Se Google non espone una percentuale di quota per l'account tramite API supportata, mostrare “quota non disponibile” e collegare AI Studio/Cloud Console.

Il fallback corrente `GET generativelanguage.googleapis.com/v1beta/models?key=...` è documentato e, isolato dall'OAuth Antigravity, ha rischio basso ([`src/providers/gemini.ts:167-184`](../../src/providers/gemini.ts#L167-L184)).

## Z.ai / GLM Coding Plan

### Codice corrente

Il progetto accetta una key inserita dall'utente oppure estrae `zai-coding-plan` dallo store OpenCode, poi chiama `https://api.z.ai/api/monitor/usage/quota/limit`. Il commento lo definisce esplicitamente “undocumented monitor endpoint” ([`src/providers/zai.ts:5-12`](../../src/providers/zai.ts#L5-L12), [`src/providers/zai.ts:30-69`](../../src/providers/zai.ts#L30-L69)).

### Fonti ufficiali e valutazione

I [Terms of Use Z.ai, aggiornati il 14 aprile 2026](https://docs.z.ai/legal-agreement/terms-of-use) vietano accesso automatizzato a dati non autorizzati, reverse engineering, estrazione e aggiramento di misure protettive. Le [Subscription Terms](https://docs.z.ai/legal-agreement/subscription-terms) e la [Usage Policy](https://docs.z.ai/devpack/usage-policy) limitano la quota Coding Plan ai tool ufficialmente supportati e prevedono restrizioni per tool/integrazioni non autorizzati.

Z.ai offre una superficie ufficiale specifica: il [Usage Query Plugin](https://docs.z.ai/devpack/extension/usage-query-plugin), installabile nel marketplace Claude Code, espone il comando `/glm-plan-usage:usage-query`. Questo rende ancora meno difendibile distribuire una chiamata diretta a una rotta non documentata come API pubblica.

**Valutazione: alto.** La sola lettura della quota è meno invasiva dell'uso del modello o di un proxy, ma non è presente un'autorizzazione pubblica per questo endpoint nel dashboard.

### Mitigazione

Disabilitare la chiamata diretta. Usare il plugin/comando ufficiale in una modalità autorizzata, mostrare il pannello Z.ai oppure ottenere permesso scritto e una API quota documentata. Non prelevare automaticamente la key dallo store di OpenCode.

## Moonshot / Kimi

### Kimi Code OAuth

Il progetto legge e riscrive le credenziali Kimi CLI, rinnova autonomamente il token usando il client ID pubblico del client ufficiale e chiama `https://api.kimi.com/coding/v1/usages` ([`src/providers/moonshot.ts:5-31`](../../src/providers/moonshot.ts#L5-L31), [`src/providers/moonshot.ts:49-104`](../../src/providers/moonshot.ts#L49-L104), [`src/credentials.ts:82-95`](../../src/credentials.ts#L82-L95)).

L'endpoint e il flusso non sono inventati: il repository ufficiale [`MoonshotAI/kimi-cli`](https://github.com/MoonshotAI/kimi-cli/blob/main/src/kimi_cli/ui/shell/usage.py) costruisce `{base_url}/usages` per il comando `/usage`, e il codice OAuth ufficiale è pubblico. Questo riduce il rischio rispetto a Gemini e Z.ai, ma non costituisce automaticamente una licenza per un altro programma a possedere e ruotare i token della CLI.

Le [Kimi Code Community Guidelines](https://www.kimi.com/code/docs/en/kimi-code/community-guidelines.html) limitano gli abbonamenti all'uso personale interattivo, vietano automazione non interattiva e spoofing dell'identità client. La [guida ufficiale ai coding agent terzi](https://www.kimi.com/en-cn/help/kimi-code/third-party-agents) indica una API key creata dall'utente e limita i benefit ai tool autorizzati. Un polling automatico del dashboard resta quindi un'area grigia concreta.

**Valutazione: medio-alto per OAuth/polling.**

Mitigazione: non leggere né riscrivere i token della CLI; preferire un comando/superficie machine-readable ufficiale, dati locali o un link a `/usage`/Console. Per una quota live da app terza, chiedere conferma scritta a Kimi.

### Moonshot Open Platform API key

Il fallback prova `/v1/users/me/balance` prima su `.ai` e poi su `.cn` ([`src/providers/moonshot.ts:108-140`](../../src/providers/moonshot.ts#L108-L140)). `GET https://api.moonshot.cn/v1/users/me/balance` è [documentato ufficialmente](https://platform.kimi.com/docs/api/balance) per la key della piattaforma cinese.

**Valutazione: basso per l'host regionale e la key corrispondenti documentati.** Usare solo l'host ufficiale associato alla piattaforma che ha emesso la key; non interpretare quel saldo API come quota dell'abbonamento Kimi Code.

Nota temporale: la pagina dei termini generali Kimi consultata il 2 agosto annunciava una nuova versione con efficacia dal 4 agosto 2026. Questa valutazione presente si fonda sulle linee guida Kimi Code e sulla documentazione API già operative, non attribuisce efficacia anticipata alla versione futura.

## OpenCode Zen

### Codice corrente

L'adapter usa una key fornita dall'utente o letta dallo store OpenCode e chiama `https://opencode.ai/zen/v1/models`. Imposta però un falso user-agent Chrome perché, secondo il commento nel codice, Cloudflare blocca i client non browser con errore 1010 ([`src/providers/opencode-zen.ts:24-30`](../../src/providers/opencode-zen.ts#L24-L30), [`src/providers/opencode-zen.ts:58-66`](../../src/providers/opencode-zen.ts#L58-L66)). L'adapter resta nell'array dei provider e viene quindi eseguito da `/api/quota` ([`src/providers/index.ts:1-9`](../../src/providers/index.ts#L1-L9)).

### Fonti ufficiali e valutazione

La [documentazione Zen](https://opencode.ai/docs/zen) invita esplicitamente a recuperare la lista completa dei modelli da `/zen/v1/models`: la chiamata in sé è supportata. I [Terms of Use OpenCode, efficaci dal 6 marzo 2026](https://opencode.ai/legal/terms-of-service) vietano estrazione automatica, scraping e violazioni della sicurezza di rete; falsificare un browser per superare un blocco protettivo è quindi una scelta rischiosa e non necessaria per la funzione quota.

**Valutazione: medio per il bypass/UA; basso per l'endpoint documentato usato onestamente.** Inoltre la risposta fornisce modelli disponibili, non percentuali di quota.

### Mitigazione

Poiché la card è stata rimossa e non esiste una quota numerica utile, rimuovere `opencodeZen` dall'array dei provider. Se si vuole conservare l'elenco modelli, usare un user-agent veritiero, aggiornamento manuale/cache lunga e rispettare 403/1010 senza tentare di aggirarli. La lettura locale del database OpenCode per il ledger token è una funzione separata e a basso rischio.

## GitHub contributions

Il prototipo invoca `gh api graphql`, interroga `viewer.contributionsCollection.contributionCalendar` e mantiene una cache di dieci minuti. Il token resta gestito dalla GitHub CLI e non viene letto dal processo ([`src/github-contributions.prototype.ts:58-83`](../../src/github-contributions.prototype.ts#L58-L83), [`src/github-contributions.prototype.ts:115-143`](../../src/github-contributions.prototype.ts#L115-L143), [`src/github-contributions.prototype.ts:189-197`](../../src/github-contributions.prototype.ts#L189-L197)).

I [GitHub Terms, efficaci dal 27 aprile 2026](https://docs.github.com/en/site-policy/github-terms/github-terms-of-service) regolano espressamente l'uso delle API anche tramite prodotti terzi; vietano richieste abusive, superamento dei rate limit tramite condivisione di token e spam. La [GitHub CLI](https://cli.github.com/manual/gh_api) documenta `gh api graphql`, mentre lo schema ufficiale espone [`ContributionCalendar`](https://docs.github.com/en/graphql/reference/users).

**Valutazione: basso.** Conservare cache/backoff, non loggare dati privati e non esporre all'esterno i conteggi di contributi privati/restricted.

## Ledger locale di token e costo stimato

`collectUsage` legge file JSONL locali di Codex, Claude e Kimi e il database SQLite locale di OpenCode; non usa i token di autenticazione né effettua chiamate ai provider ([`src/usage.ts:695-790`](../../src/usage.ts#L695-L790)). Il progetto etichetta già il costo come “Estimated API-equivalent value, not the amount charged by subscription plans” ([`src/usage.ts:681-692`](../../src/usage.ts#L681-L692)).

**Valutazione: basso.** È la parte più sicura su cui costruire calendario token, cache/reasoning ed efficienza. Mantenere le diciture “stima locale” e “valore API equivalente”, datare il listino, non presentare la cifra come fattura o spesa effettivamente addebitata e non inviare i log a terzi.

## Percorsi conformi per ottenere le quote

Questa sezione usa soltanto superfici descritte da fonti ufficiali. Per evitare percentuali fuorvianti, distingue quattro dati diversi:

- **quota live esatta:** limite, residuo/percentuale e reset emessi dal provider per la finestra corrente;
- **usage/costo:** consumo o addebito autorevole, anche se aggregato o ritardato;
- **stima locale:** token letti dai log/risposte e valorizzati con un listino; non è una fattura né una quota del piano;
- **non disponibile:** nessuna superficie machine-readable supportata trovata al 2 agosto 2026.

| Provider / contesto | Quota live esatta | Usage/costo ufficiale | Stima locale | Automazione conforme da app terza |
| --- | --- | --- | --- | --- |
| **Codex con account ChatGPT** | **Sì.** [`codex app-server`](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md) espone `account/rateLimits/read` (`usedPercent`, finestre e reset) e notifiche `account/rateLimits/updated`; include limite crediti/spend control quando il backend li fornisce. | `account/usage/read` restituisce riepilogo dell'attività token e bucket giornalieri. Il costo effettivo non va inferito se il campo non è fornito. | Sì, dai rollout JSONL, chiaramente etichettata. | **Sì:** avviare l'app-server e usare JSON-RPC su `stdio`, identificando l'app in `clientInfo`. Login, storage e refresh restano a Codex; non leggere `auth.json` e non chiamare WHAM direttamente. |
| **Claude consumer Pro/Max** | **Sì, tramite estensione locale ufficiale.** La [status line di Claude Code](https://code.claude.com/docs/en/statusline) passa allo script configurato `rate_limits.five_hour` e `rate_limits.seven_day`, con `used_percentage` e `resets_at`. I campi compaiono dopo la prima risposta API e ciascuna finestra può essere assente. | La stessa status line espone costo stimato della sessione e token correnti, inclusi cache read/write; non è una fattura dell'abbonamento. La Usage & Cost Admin API non supporta gli account individuali. | Sì, dai log Claude Code; token/costo API-equivalente soltanto. | **Sì, come bridge locale opt-in:** Claude Code invia il JSON su `stdin`, senza consumare token aggiuntivi. WebQuota può leggere una cache minima con percentuali, reset, origine e timestamp, senza bearer OAuth né `/api/oauth/usage`. Il dato si aggiorna quando Claude Code esegue la status line. |
| **Claude Platform / organizzazioni / Enterprise** | **Parziale.** Le risposte alle normali chiamate API espongono [header rate-limit](https://platform.claude.com/docs/en/api/rate-limits) con limite, residuo e reset della richiesta; la Rate Limits Admin API elenca i limiti configurati, non un saldo consumer globale. | **Sì:** [Usage & Cost Admin API](https://platform.claude.com/docs/en/manage-claude/usage-cost-api) per organizzazioni Platform; Analytics/Claude Code Analytics per i piani compatibili. Sono dati aggregati, non necessariamente istantanei. | Facoltativa, per riconciliazione e dettagli per sessione. | **Sì:** con Admin/Analytics API key creata dall'organizzazione e permessi appropriati. Non riusare le credenziali consumer. |
| **Antigravity CLI** | **Sì, tramite hook ufficiale locale.** La [status line](https://antigravity.google/docs/cli/statusline) passa allo script configurato un JSON `quota` con `remaining_fraction`, `reset_time` e `reset_in_seconds`. | Lo stesso payload contiene `context_window` con token input/output/cache della sessione; non documenta il costo fatturato. | Sì, dai dati ricevuti dal hook o dai log, con etichetta locale. | **Sì, come bridge locale opt-in:** lo script riceve `stdin` quando lo stato del client cambia e può inoltrare solo i campi necessari a WebQuota. Funziona mentre il client ufficiale è attivo e non richiede OAuth, secret o `v1internal`. |
| **Gemini API / AI Studio** | **Non disponibile via API documentata.** I [limiti attivi](https://ai.google.dev/gemini-api/docs/rate-limits) e l'uso si vedono in AI Studio e valgono per progetto/billing account, non per singola key; `models.list` non è una quota. | La pagina [Billing](https://ai.google.dev/gemini-api/docs/billing) espone Dashboard > Usage e spesa, con possibili ritardi. Le risposte espongono [`usageMetadata`](https://ai.google.dev/api/generate-content#UsageMetadata), inclusi token prompt, candidate, cache e thought, ma non il residuo della finestra. | Sì, da `usageMetadata` più listino datato. | **Sì** per chiamate Gemini con una API key propria; **no** per estrarre automaticamente il residuo dalla UI. Usare il bridge status-line sopra se l'obiettivo è la quota Antigravity. |
| **Vertex AI / Google Cloud** | Per quote standard, [Cloud Quotas e Cloud Monitoring](https://cloud.google.com/monitoring/alerts/using-quota-metrics) espongono limite e serie di utilizzo, ma il dato di rate usage è campionato e non equivale sempre a un residuo istantaneo. Per i modelli recenti in [Dynamic Shared Quota](https://cloud.google.com/vertex-ai/generative-ai/docs/quotas) **non esiste una quota fissa residua**: la capacità dipende dalla disponibilità e il segnale operativo è l'eventuale `429`. | **Sì:** [Cloud Billing export in BigQuery](https://cloud.google.com/billing/docs/how-to/export-data-bigquery) fornisce uso e costi dettagliati, con latenza di esportazione. | Sì, dai response metadata; utile come preview, non come fattura Cloud. | **Sì:** API Cloud Quotas/Monitoring/BigQuery con OAuth o service account del progetto e IAM minimo. L'app deve registrare credenziali proprie e dichiarare freschezza e granularità del dato. |
| **Z.ai GLM Coding Plan** | **Sì, nel percorso supportato:** il [Usage Query Plugin](https://docs.z.ai/devpack/extension/usage-query-plugin) mostra quota e statistiche con `/glm-plan-usage:usage-query` dentro Claude Code. Non è pubblicato come API generica per dashboard terze. | Console Z.ai per sottoscrizione/billing; la documentazione indica che lo storico di fatturazione può riflettere il giorno precedente. | Sì, dai log dei tool supportati; il costo a listino non rappresenta la quota del Coding Plan. | **No** per una card che interroga un endpoint monitor privato. Supportare il comando/plugin o un eventuale export esplicitamente documentato in futuro. |
| **Z.ai API Platform** | I limiti configurati sono consultabili nel pannello ufficiale; nell'[indice API/OpenAPI pubblico](https://docs.z.ai/llms.txt) non risulta un endpoint aggregato per saldo/quota residua. | Ogni [Chat Completion](https://docs.z.ai/api-reference/llm/chat-completion) restituisce i token della richiesta; billing e saldo aggregati restano nella console e possono avere ritardo. | Sì, sommando `usage` e applicando il [listino ufficiale](https://docs.z.ai/guides/overview/pricing), sempre come stima. | **Sì** per le API di inferenza documentate con API key propria; **no** per scraping della console o `/api/monitor/usage/quota/limit`. |
| **Kimi Code** | **Sì, nel client ufficiale:** il comando `/usage` della [Kimi CLI ufficiale](https://github.com/MoonshotAI/kimi-cli/blob/main/src/kimi_cli/ui/shell/usage.py) mostra le finestre del piano. Non è documentato come IPC/API stabile per un'altra app. | Non è stata trovata una API pubblica per costo/usage aggregato dell'abbonamento Kimi Code. | Sì, dai log CLI; costo API-equivalente soltanto. | **No** per riusare o ruotare l'OAuth della CLI. Mostrare istruzione/link a `/usage`, oppure integrare una futura superficie machine-readable autorizzata. |
| **Kimi/Moonshot Open Platform** | **Saldo esatto, non percentuale di piano:** [`GET /v1/users/me/balance` internazionale](https://platform.kimi.ai/docs/api/balance) e la [variante Cina](https://platform.kimi.com/docs/api/balance) restituiscono saldo disponibile, voucher e cash; host `.ai` e `.cn` hanno key separate. Non fornisce una percentuale senza un tetto noto. | Token per richiesta dalle risposte; costi ricavabili dal billing della piattaforma. | Sì, per andamento giornaliero e costo previsto. | **Sì:** endpoint documentato con API key Open Platform dell'utente e host regionale corretto. Non confondere il saldo con Kimi Code. |
| **OpenCode Zen / Console** | Per i modelli free **non è pubblicata una quota numerica**: [`/zen/v1/models`](https://opencode.ai/docs/zen) indica disponibilità/catalogo, non residuo o reset. Limiti mensili e saldo sono gestiti nella console. | **Sì, per OpenCode Console:** la [Usage API](https://console.opencode.ai/guides/usage) esporta CSV per organizzazione/membro/modello, inclusi input, output, reasoning, cache e costo; non è una quota live dei modelli free. | Sì; preferire il comando ufficiale [`opencode stats`](https://opencode.ai/docs/cli) e trattarne l'output come locale, oppure leggere il database dichiarando che lo schema non è un contratto pubblico stabile. | **Sì** per l'export Usage con service-account key e per gli endpoint Zen documentati. **No** per fingere un browser o aggirare Cloudflare; se manca la quota, mostrare “non disponibile”. |
| **GitHub** | **Sì, per la quota API:** gli header o [`GET /rate_limit`](https://docs.github.com/en/rest/rate-limit/rate-limit) restituiscono limite, usato, residuo e reset; non esiste un residuo “contributi”. | Il [ContributionCalendar GraphQL](https://docs.github.com/en/graphql/reference/users) restituisce conteggi giornalieri e totale contributi. Per prodotti GitHub fatturabili esiste una distinta [Billing usage API](https://docs.github.com/en/rest/billing/usage), soggetta a piano e permessi; è separata dal calendario. | Non necessaria; si può conservare una cache locale esplicitamente datata. | **Sì:** `gh api`/GraphQL o REST con token/CLI dell'utente, cache e backoff. Preferire gli header già ricevuti; `/rate_limit` può incidere sui secondary limits. |

Regola di prodotto consigliata: mostrare accanto a ogni numero `origine`, `autorevolezza` e `ultimo aggiornamento`. Una percentuale va calcolata soltanto quando sono noti sia il limite sia il consumo della stessa finestra; un saldo monetario, DSQ, un elenco modelli o token cumulativi non vanno convertiti artificialmente in “quota disponibile”. L'ordine di preferenza è: API/IPC ufficiale live → report ufficiale ritardato → stima locale → “non disponibile”.

## Misure trasversali consigliate

1. **Adapter rischiosi disabilitati per default.** Nessuna chiamata di rete finché l'utente non abilita consapevolmente il provider.
2. **Classificazione per origine.** Marcare ogni adapter come `documented_api`, `official_cli_or_ipc`, `local_only` o `unsupported`; in produzione consentire solo i primi tre.
3. **Non mutare credenziali di altri client.** Usare IPC/CLI/SDK ufficiale; mai riscrivere `auth.json` o credential store di CLI terze.
4. **Secret storage del sistema.** Windows Credential Manager/macOS Keychain/libsecret al posto di JSON in chiaro; permessi file minimi se serve un fallback.
5. **Solo loopback.** Vincolare esplicitamente il server a `127.0.0.1`; il codice corrente esporta `port` e `fetch` senza specificare `hostname` ([`src/server.ts:207-210`](../../src/server.ts#L207-L210)). Proteggere gli endpoint sensibili se si abilita qualsiasi accesso non locale.
6. **Niente payload grezzi al browser.** Restituire soltanto campi normalizzati, senza `raw`, bearer, ID account o messaggi diagnostici sensibili.
7. **Polling conservativo.** Aggiornamento manuale o intervalli lunghi, cache, backoff su 429/5xx, stop immediato su 401/403 e rispetto di `Retry-After`.
8. **Fail closed.** Se la superficie documentata non esiste o cambia, mostrare “non disponibile”; niente fallback a endpoint privati, identità imitate o aggiramento di blocchi.
9. **Disclosure chiara.** Documentare file letti, chiamate effettuate, frequenza, storage, revoca e assenza di telemetria; aggiungere “non affiliato ai provider”.

## Azioni immediate, in ordine

1. **P0 — Gemini:** spegnere OAuth Antigravity e `v1internal`; rimuovere il client secret pubblicato e farlo revocare/ruotare dal proprietario.
2. **P0 — Claude e Z.ai:** disabilitare il polling OAuth consumer e l'endpoint monitor non documentato; sostituire Claude con il bridge status-line ufficiale.
3. **P1 — Codex:** migrare a `codex app-server` (`account/rateLimits/read`, `account/usage/read`).
4. **P1 — Kimi:** smettere di leggere/ruotare OAuth CLI; usare superficie ufficiale o degradare a dati locali/console.
5. **P1 — OpenCode Zen:** rimuoverlo dall'elenco provider, oppure eliminare il falso Chrome UA e non usarlo come quota.
6. **P1 — sicurezza:** Credential Manager, bind `127.0.0.1`, rimozione di `raw`, opt-in e backoff.
7. **P2 — mantenere:** GitHub GraphQL, ledger locale e API key documentate, con etichette e privacy corrette.

## Matrice conclusiva: implementazione attuale

| Integrazione attuale | Rischio | Prova nel codice | Motivo | Azione immediata |
| --- | --- | --- | --- | --- |
| Gemini con OAuth/identità Antigravity e `cloudcode-pa/v1internal` | **Rosso** | [`src/gemini-oauth.ts:1-24`](../../src/gemini-oauth.ts#L1-L24), [`src/providers/gemini.ts:41-163`](../../src/providers/gemini.ts#L41-L163), [`src/server.ts:94-167`](../../src/server.ts#L94-L167) | I termini Antigravity vietano espressamente software terzo con Antigravity OAuth; identità falsa, client altrui, secret committato e API non documentata violano policy Google espresse. | Disabilitare/rimuovere, revocare il secret, API key/Vertex documentati soltanto. |
| Claude Code OAuth → `/api/oauth/usage` | **Alto** | [`src/providers/claude.ts:45-108`](../../src/providers/claude.ts#L45-L108) | Accesso automatizzato consumer senza API key o permesso pubblico; endpoint terzo non documentato. | Disabilitare; usare il JSON della status line per Pro/Max o Admin/Analytics API per organizzazioni. |
| Z.ai key/OpenCode key → monitor endpoint | **Alto** | [`src/providers/zai.ts:7-12`](../../src/providers/zai.ts#L7-L12), [`src/providers/zai.ts:40-69`](../../src/providers/zai.ts#L40-L69) | Endpoint ammesso dal codice come non documentato; Coding Plan limitato a tool supportati; esiste plugin usage ufficiale. | Usare plugin/superficie ufficiale o permesso scritto; niente estrazione automatica della key. |
| Codex `auth.json` → backend ChatGPT/WHAM | **Medio-alto** | [`src/providers/codex.ts:25-105`](../../src/providers/codex.ts#L25-L105) | Endpoint usato dal client ufficiale, ma token/refresh e identità CLI sono gestiti direttamente nonostante app-server supportato. | Migrare a `codex app-server`; non leggere/riscrivere `auth.json`. |
| Kimi Code OAuth → `/coding/v1/usages` | **Medio-alto** | [`src/providers/moonshot.ts:9-104`](../../src/providers/moonshot.ts#L9-L104) | Endpoint presente nella CLI ufficiale, ma polling e gestione token da app terza non sono autorizzati chiaramente e contrastano con uso interattivo. | CLI/IPC ufficiale, permesso scritto o solo dati locali/console. |
| OpenCode Zen `/zen/v1/models` con falso UA Chrome | **Medio** | [`src/providers/opencode-zen.ts:58-95`](../../src/providers/opencode-zen.ts#L58-L95), [`src/providers/index.ts:9`](../../src/providers/index.ts#L9) | Endpoint documentato, ma UA usato dichiaratamente per superare Cloudflare; nessuna quota numerica ottenuta. | Rimuovere adapter oppure UA onesto e cache/manual refresh; rispettare il blocco. |
| Gemini API key → `models.list` | **Basso** | [`src/providers/gemini.ts:167-184`](../../src/providers/gemini.ts#L167-L184) | Endpoint Gemini API documentato; valida la key ma non espone quota. | Mantenere separato da Antigravity e mostrare “quota non disponibile”. |
| Moonshot API key → saldo `/v1/users/me/balance` | **Basso** sull'host documentato | [`src/providers/moonshot.ts:108-140`](../../src/providers/moonshot.ts#L108-L140) | Endpoint `.cn` documentato; saldo Open Platform, non quota Kimi Code. | Associare key e host regionali corretti; etichettare il dato come saldo API. |
| GitHub CLI → GraphQL contribution calendar | **Basso** | [`src/github-contributions.prototype.ts:58-83`](../../src/github-contributions.prototype.ts#L58-L83), [`src/github-contributions.prototype.ts:115-197`](../../src/github-contributions.prototype.ts#L115-L197) | API e campi documentati; token gestito da `gh`; cache 10 minuti. | Mantenere, con privacy e rate-limit handling. |
| Scansione locale token/costi | **Basso** | [`src/usage.ts:681-790`](../../src/usage.ts#L681-L790) | Sola lettura locale; nessun accesso autenticato al provider; costo già dichiarato stimato. | Mantenere local-only, senza telemetria e con listino datato. |

## Conclusione

La strada sostenibile è chiara: **local-first non basta da solo; serve anche “official-surface-first”**. Il progetto può mantenere gran parte del suo valore usando log locali, API key documentate, GitHub GraphQL e IPC/CLI ufficiali. Deve invece eliminare impersonificazione, credenziali prese in prestito, endpoint non documentati e bypass di protezioni.

Dopo le azioni P0, il rischio residuo diventa gestibile; prima di esse, soprattutto per Antigravity, distribuire il progetto espone concretamente gli utenti a sospensione dell'account.
