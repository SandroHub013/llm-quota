# Provider integration compliance

> Status: audit required before the next release. Checked against public terms and
> documentation on 2026-07-28. This is a technical risk assessment, not legal advice.

LLM Quota is local-first, but local execution does not by itself authorize an integration.
Several current adapters read credentials issued to first-party CLIs and call private or
undocumented endpoints. The user owning an account or token does not necessarily grant another
client permission to reuse that client identity.

The remediation is tracked in [issue #10](https://github.com/SandroHub013/llm-quota/issues/10).

## What “100% functionality” can mean

The dashboard, CLI, and widget can remain fully functional for every provider: show supported
metrics when available, otherwise return `no_endpoint` and link to the official dashboard.

Full live subscription-quota parity is different. It is compliant only when at least one of these
exists:

1. a documented provider API;
2. a documented first-party local protocol intended for integrations;
3. a provider-owned CLI command with supported structured output; or
4. written provider permission covering the endpoint, authentication method, and client identity.

If none exists, there is no technical workaround that provides both live parity and ToS certainty.
Browser automation, private endpoint discovery, borrowed OAuth clients, token-file reuse, and an
opt-in “unofficial mode” do not create permission.

## Integration gate

A provider adapter is releasable only when all of these are true:

- **Supported interface:** every network endpoint has a public documentation URL or written
  permission from the provider.
- **Correct identity:** requests identify as LLM Quota, never as a browser or first-party CLI.
- **Correct credentials:** users provide credentials intended for third-party API access, or an
  official local protocol owns authentication. LLM Quota does not take over another client's
  refresh-token lifecycle.
- **Explicit consent:** the UI names the credential source and the data sent before enabling it.
- **Least privilege:** scopes are limited to quota/usage reads; no onboarding, billing mutation, or
  unrelated cloud-platform scope is requested.
- **Evidence:** the adapter records the terms/docs URL, review date, endpoint, auth method, and any
  written approval.
- **Safe fallback:** loss of the supported interface produces `no_endpoint`, not scraping or a
  hidden private fallback.

Open source code, a public OAuth client ID, or an endpoint visible in first-party traffic is
implementation evidence—not permission for a third-party client.

## Current adapter assessment

| Provider | Current path | Risk | Approved route to parity |
|---|---|---:|---|
| Claude Code | Reads Claude Code OAuth credentials and calls `/api/oauth/usage` automatically | **High** | Anthropic documents interactive `/usage`, Enterprise Analytics, and Admin APIs. Personal-plan automation needs a supported JSON/SDK surface or written permission. |
| Codex / ChatGPT | Reads and rewrites Codex OAuth credentials, calls `backend-api/wham/usage`, and identifies as `codex_cli_rs` | **High today** | Migrate to the documented `codex app-server` JSON-RPC method `account/rateLimits/read`; the official process owns auth and refresh. |
| Gemini Code Assist | Uses another product's OAuth client, scopes, metadata, user-agent, and `v1internal` endpoints | **Critical** | Remove the flow. Request structured headless quota output from Gemini CLI, or use a documented Google quota API with LLM Quota's own verified OAuth client. |
| Kimi Code | Reads and rewrites Kimi CLI credentials and calls its `/usages` route | **Medium/High** | Request usage through Kimi's official Agent SDK/wire protocol or a documented `kimi usage --json` command. |
| Moonshot API | Calls `/v1/users/me/balance` with a user API key | **Unverified** | Keep only after Moonshot documents or approves the billing route; public Kimi API docs currently cover model API calls. |
| z.ai Coding Plan | Calls the undocumented `/api/monitor/usage/quota/limit` route | **High** | Remove until z.ai publishes a quota API or grants written permission. |
| OpenCode Zen | Calls the documented `/zen/v1/models`, but uses a browser user-agent and may reuse another tool's key | **Low/Medium** | Keep the documented endpoint with an explicit API key and truthful LLM Quota identity. Ask OpenCode for a documented balance endpoint. |

Risk means likelihood and impact of an unsupported integration, not a legal conclusion.

## Provider-by-provider migration

### Claude Code

Anthropic's Consumer Terms restrict automated access unless it uses an Anthropic API key or is
otherwise explicitly permitted. The official Claude Code `/usage` command displays plan limits,
but there is no documented machine-readable personal-plan contract.

- Enterprise: use the Enterprise Analytics API with a customer-created analytics key.
- API organizations: use the Usage & Cost Admin API with a customer-created Admin key.
- Personal subscriptions: request `claude usage --json`, an Agent SDK quota method, or written
  authorization. Return `no_endpoint` until one exists.

### Codex / ChatGPT

Codex already exposes the required data through an integration surface. Start `codex app-server`,
complete its documented initialization handshake with `clientInfo.name = "llm_quota"`, call
`account/rateLimits/read`, map the returned windows, and terminate the child process. Do not read,
refresh, decode, or rewrite `~/.codex/auth.json`.

This route can preserve the current Codex plan and reset-window functionality without client
impersonation.

### Gemini

The current flow must not ship: it presents LLM Quota as Antigravity and calls `v1internal` using
another application's OAuth identity. Google's API Terms require documented access methods and an
accurate API-client identity.

Gemini CLI documents `/stats model`, including current quota information, but not a stable headless
quota response. Ask Google to expose that data through structured headless output or a supported
local protocol. For API/project users, use documented Gemini API or Google Cloud quota surfaces
with LLM Quota's own OAuth consent screen, privacy policy, verification, and least-privilege scopes.

### Kimi Code and Moonshot API

Kimi CLI's official source includes `/usage`; Kimi's Agent SDK is explicitly intended for products
and automation. Ask Moonshot to expose the usage snapshot through that SDK/wire protocol or a
stable JSON command. Let the official process own OAuth tokens.

For API-key balance, obtain a public contract for `/v1/users/me/balance` before relying on it. A
model API key being documented does not automatically document every account endpoint.

### z.ai

The public docs describe Bearer-authenticated `/api/paas/v4` APIs. They do not document the monitor
quota route used by LLM Quota. Ask z.ai for a supported read-only coding-plan usage endpoint and
return `no_endpoint` meanwhile.

### OpenCode Zen

The Zen docs explicitly publish `/zen/v1/models`, so the existing key-validity/model-count feature
has a supported basis. Remove the browser user-agent, identify truthfully, and prefer a key the user
explicitly provides to LLM Quota. Live balance needs a documented endpoint from OpenCode.

## Rollout order

1. Freeze new undocumented integrations and publish this audit.
2. Replace Codex with `codex app-server`.
3. Remove Gemini client impersonation and all private fallback routes.
4. Disable unsupported Claude, Kimi/Moonshot, and z.ai live paths; retain dashboard links.
5. Open provider/upstream requests for structured usage output and billing APIs.
6. Add official organization/API modes where documented.
7. Add tests that reject internal endpoints, borrowed OAuth IDs, and spoofed user-agents.

Do not collect real credentials or response bodies while requesting provider approval. A provider
can confirm endpoint and schema using synthetic examples.

## Evidence

- [Anthropic Consumer Terms](https://www.anthropic.com/legal/consumer-terms)
- [Claude Code usage and cost documentation](https://code.claude.com/docs/en/costs#using-the-usage-command)
- [Anthropic Usage & Cost API](https://platform.claude.com/docs/en/manage-claude/usage-cost-api)
- [OpenAI Terms of Use](https://openai.com/policies/terms-of-use/) and
  [EU Terms of Use](https://openai.com/policies/eu-terms-of-use/)
- [Codex app-server auth endpoints](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md#auth-endpoints)
- [OpenAI organization Usage API](https://platform.openai.com/docs/api-reference/usage)
- [Google API Terms](https://developers.google.com/terms)
- [Gemini CLI quota documentation](https://github.com/google-gemini/gemini-cli/blob/main/docs/resources/quota-and-pricing.md#check-usage-and-limits)
- [Kimi API documentation](https://platform.kimi.ai/docs/overview)
- [Kimi CLI usage implementation](https://github.com/MoonshotAI/kimi-cli/blob/main/src/kimi_cli/ui/shell/usage.py)
- [Z.AI API introduction](https://docs.z.ai/api-reference/introduction)
- [OpenCode Zen documentation](https://opencode.ai/docs/zen/)
