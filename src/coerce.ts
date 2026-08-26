/**
 * Turning someone else's `unknown` into a string we are willing to print.
 *
 * Every payload this tool reads — a JSONL usage record, a JSON-RPC error, a provider
 * envelope — is `unknown` by design, because the tools writing them change shape without
 * telling us. `String()` accepts all of that happily and prints `[object Object]` into a
 * model name, a session id, or a string about to be handed to `JSON.parse`. Only a
 * primitive is worth printing; anything else takes the fallback the caller already wrote
 * for the missing case.
 */
export function text(value: unknown, fallback: string): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
    return String(value);
  }
  return fallback;
}
