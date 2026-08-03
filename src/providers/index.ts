import type { Provider } from "./types.js";
import { claude } from "./claude.js";
import { codex } from "./codex.js";
import { zai } from "./zai.js";
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
export const providers: Provider[] = [claude, codex, zai, gemini];

export function getProvider(id: string): Provider | undefined {
  return providers.find((p) => p.id === id);
}
