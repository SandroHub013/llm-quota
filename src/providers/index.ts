import type { Provider } from "./types.js";
import { claude } from "./claude.js";
import { codex } from "./codex.js";
import { zai } from "./zai.js";
import { gemini } from "./gemini.js";
import { moonshot } from "./moonshot.js";

export const providers: Provider[] = [claude, codex, zai, gemini, moonshot];

export function getProvider(id: string): Provider | undefined {
  return providers.find((p) => p.id === id);
}
