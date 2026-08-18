/**
 * Stops the server when the process that started it is gone.
 *
 * The desktop shell spawns this server as a sidecar and kills it when it exits. That
 * covers the ordinary quit and nothing else: an update replaces the shell's binary and
 * restarts it, a crash takes the shell without running its exit handler, and either way
 * the sidecar survives — still listening on 4747, still serving the version that was
 * just replaced. The next launch finds its port taken, falls back to an ephemeral one,
 * and every reader that was told 4747 (the widget, a wezterm status line, a bookmark)
 * goes on reading the old server. It reads as an app that updated and changed nothing.
 *
 * A parent that vanishes is the one signal that covers all of those, so the sidecar
 * watches for it rather than waiting to be told.
 */

/**
 * Signal 0 asks "is this pid there?" without delivering anything.
 *
 * EPERM means a process is there and belongs to someone else — alive, and not ours to
 * end. Only "no such process" is the answer this watch acts on.
 */
export const isProcessAlive = (
  pid: number,
  kill: (pid: number, signal: number) => unknown = (target, signal) => process.kill(target, signal),
): boolean => {
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "EPERM";
  }
};

export interface ParentWatchOptions {
  isAlive?: (pid: number) => boolean;
  exit?: (code: number) => void;
  intervalMs?: number;
}

/**
 * Returns the timer so a caller can stop watching; undefined when there is no parent to
 * watch, which is every run from source and every run of the CLI.
 *
 * The timer is unref'd: this watch is a reason to stop the process, never a reason to
 * keep it alive.
 */
export function watchParent(
  pid: number | undefined,
  { isAlive = isProcessAlive, exit = (code) => process.exit(code), intervalMs = 2_000 }: ParentWatchOptions = {},
): ReturnType<typeof setInterval> | undefined {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return undefined;

  const timer = setInterval(() => {
    if (isAlive(pid)) return;
    clearInterval(timer);
    // 0, not a failure: outliving the shell is the expected end of a sidecar's life.
    exit(0);
  }, intervalMs);
  timer.unref?.();
  return timer;
}
