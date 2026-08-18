import type { Provider } from "./types.js";
import { claude } from "./claude.js";
import { codex } from "./codex.js";
import { gemini } from "./gemini.js";

// `moonshot` is deliberately not registered, so no Kimi card is rendered and no
// request is made for it. The adapter in ./moonshot.ts stays on disk because the
// endpoint it calls is fine — it is the card that was misleading.
//
// Kimi Code plan quota has no compliant machine-readable source today:
//   - the official status line passes model, cwd, git branch, permission mode,
//     plan mode, context usage, session id and version, and explicitly no quota,
//     rate limit, subscription or cost field, so the status-line bridge used for
//     Claude and Antigravity has nothing to read;
//   - the plan windows shown by the CLI's own `/usage` come from
//     api.kimi.com/coding/v1/usages authenticated with the CLI's OAuth token,
//     which this project must not borrow (see docs/research/provider-terms-assessment.md);
//   - `kimi web` exposes only session, file and terminal routes locally, and
//     Kimi restricts plan benefits to its own list of authorised tools.
//
// What was left, the documented Open Platform balance, is API credit and not
// plan quota, so a card built on it answered a question nobody asked. Kimi token
// spend still appears in the local ledger, which reads ~/.kimi-code/sessions
// without any credential (src/usage.ts).
//
// Re-register this adapter once Moonshot documents a quota surface a third-party
// dashboard may call.
// `zai` is deliberately not registered either. The card was built on the official
// status-line bridge reading $state.glm_quota, but nothing publishes that field:
// Z.ai's own Usage Query Plugin ships only a slash command, an agent and a skill
// (docs.z.ai/devpack/extension/usage-query-plugin, "only available for the
// Personal plan", Claude Code only), so ~/.llm-quota/official/zai.json is never
// written and the card sat at "bridge active" forever.
//
// The plugin's script reads the quota from /api/monitor/usage/quota/limit with the
// user's key in the Authorization header — the same route this project removed as
// high risk (docs/research/provider-terms-assessment.md). Re-register this adapter
// only together with a decision on that route, or once Z.ai publishes a field the
// bridge can read.
// `minimax` is not registered yet, and for the one reason that is not a judgement call:
// the endpoint its own documentation describes — GET /v1/token_plan/remains with a bearer
// key — answers `1004: cookie is missing, log in again` and asks for a browser session
// instead (MiniMax-AI/MiniMax-M2#88, open since March 2026). Lifting a session cookie is
// the conduct this project removed for Antigravity and refused for Z.ai.
//
// Unlike Kimi and Z.ai, nothing about this is a policy problem: MiniMax publishes plan
// windows, documents bearer auth for them, and simply does not honour it. The adapter is
// written, tested against the documented payload and ready; registering it is one line
// the day a real key returns counters. Meanwhile MiniMax token spend is priced in the
// local ledger like any other model (src/usage.ts).
export const providers: Provider[] = [claude, codex, gemini];

export function getProvider(id: string): Provider | undefined {
  return providers.find((p) => p.id === id);
}
