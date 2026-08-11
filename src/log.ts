/**
 * Diagnostics for failures this project handles rather than propagates.
 *
 * A swallowed error is only defensible when the reason still reaches somebody.
 * Every deliberate `catch` that keeps running should call `warn` (or `warnOnce`
 * for a condition that repeats on a timer) so the cause is visible in the server
 * log instead of being inferred from a blank card.
 *
 * Output goes to stderr on purpose: `llm-quota status --json` writes its payload
 * to stdout, and a warning must never end up inside it.
 */

/** Best-effort one-line reason for anything a `catch` can be handed. */
export function reasonOf(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code ? `${code}: ${error.message}` : error.message;
  }
  return String(error);
}

const quiet = (): boolean => process.env.LLM_QUOTA_QUIET === "1";

/** Record a handled failure together with the context that makes it actionable. */
export function warn(context: string, error: unknown): void {
  if (quiet()) return;
  console.warn(`llm-quota: ${context}: ${reasonOf(error)}`);
}

const seen = new Set<string>();

/**
 * Same as `warn`, for conditions reached from a poll loop. The dashboard refreshes
 * every 5s, so an unwritable cache would otherwise print the same line forever.
 */
export function warnOnce(key: string, context: string, error: unknown): void {
  if (seen.has(key)) return;
  seen.add(key);
  warn(context, error);
}

/** Test-only: forget which `warnOnce` keys have already fired. */
export function resetWarnOnce(): void {
  seen.clear();
}
