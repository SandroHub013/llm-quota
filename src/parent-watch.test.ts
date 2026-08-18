/**
 * The sidecar's own exit condition. It exists because the shell's exit handler covers
 * only the ordinary quit: an update replaces the shell and restarts it, a crash skips
 * the handler, and the sidecar that survives keeps port 4747 while serving the version
 * that was just replaced.
 */
import { expect, test } from "bun:test";
import { isProcessAlive, watchParent } from "./parent-watch.js";

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("a run with no parent watches nothing", () => {
  // From source and from the CLI there is no shell to outlive.
  for (const pid of [undefined, 0, -1, Number.NaN, 1.5]) {
    expect(watchParent(pid as number | undefined, { exit: () => { throw new Error("exited"); } })).toBeUndefined();
  }
});

test("a live parent keeps the server running", async () => {
  let exited = false;
  const timer = watchParent(1234, { isAlive: () => true, exit: () => { exited = true; }, intervalMs: 5 });
  await tick(40);
  clearInterval(timer!);

  expect(exited).toBe(false);
});

test("a parent that goes takes the server with it, once", async () => {
  const codes: number[] = [];
  let alive = true;
  watchParent(1234, { isAlive: () => alive, exit: (code) => codes.push(code), intervalMs: 5 });

  await tick(20);
  expect(codes).toEqual([]);

  alive = false;
  await tick(40);

  // Zero, and only once: the watch stops itself rather than calling exit every tick.
  expect(codes).toEqual([0]);
});

/**
 * A pid that belongs to another user answers EPERM, not "no such process". Reading that
 * as death would stop a server whose shell is running perfectly well.
 */
test("only \"no such process\" counts as gone", () => {
  const throwing = (code: string) => () => {
    const error: NodeJS.ErrnoException = new Error(code);
    error.code = code;
    throw error;
  };

  expect(isProcessAlive(1234, () => undefined)).toBe(true);
  expect(isProcessAlive(1234, throwing("EPERM"))).toBe(true);
  expect(isProcessAlive(1234, throwing("ESRCH"))).toBe(false);
});

test("watching this very process never exits it", async () => {
  let exited = false;
  const timer = watchParent(process.pid, { exit: () => { exited = true; }, intervalMs: 5 });
  await tick(30);
  clearInterval(timer!);

  expect(exited).toBe(false);
});
