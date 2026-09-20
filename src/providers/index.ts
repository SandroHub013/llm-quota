import type { Provider } from "./types.js";
import { claude } from "./claude.js";
import { codex } from "./codex.js";
import { gemini } from "./gemini.js";
import { grok } from "./grok.js";
import { kimi } from "./kimi.js";
import { zai } from "./zai.js";

// MiniMax stays unregistered: its documented bearer endpoint still answers
// `1004: cookie is missing` (MiniMax-AI/MiniMax-M2#88). Lifting a session cookie
// is still refused. The adapter in ./minimax.ts is ready the day a real key
// returns counters.
export const providers: Provider[] = [claude, codex, gemini, grok, kimi, zai];

export function getProvider(id: string): Provider | undefined {
  return providers.find((p) => p.id === id);
}
