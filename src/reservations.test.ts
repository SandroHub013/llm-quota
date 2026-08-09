import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquire, active, release, slotsFor } from "./reservations.js";

const homes: string[] = [];
afterEach(async () => Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true }))));

async function freshHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "llm-quota-reserve-"));
  homes.push(home);
  return home;
}

test("slots shrink with the binding window and close at the floor", () => {
  expect(slotsFor(80)).toBe(3);
  expect(slotsFor(50)).toBe(1);
  expect(slotsFor(21)).toBe(1);
  expect(slotsFor(20)).toBe(0);
  expect(slotsFor(0)).toBe(0);
  // Unknown capacity is a single probe, never an implicit "plenty".
  expect(slotsFor(undefined)).toBe(1);
});

// The failure this whole module exists for: several workers read the same cached
// 25%, all clear the floor, and together they empty the provider.
test("a second worker is refused while one holds the only slot at 25%", async () => {
  const home = await freshHome();

  const first = await acquire("claude", 25, { home });
  expect(first.granted).toBe(true);
  expect(first.slots).toBe(1);

  const second = await acquire("claude", 25, { home });
  expect(second.granted).toBe(false);
  expect(second.reason).toBe("saturated");
  expect(second.held).toBe(1);

  // A different provider is unaffected — the cap is per provider.
  expect((await acquire("codex", 90, { home })).granted).toBe(true);

  expect(await release(first.id!, home)).toBe(true);
  expect((await acquire("claude", 25, { home })).granted).toBe(true);
});

test("nothing is admitted at or below the floor", async () => {
  const home = await freshHome();
  const result = await acquire("gemini", 20, { home });
  expect(result).toMatchObject({ granted: false, reason: "floor", slots: 0 });
  expect(await active("gemini", home)).toEqual([]);
});

test("three workers fit above 50%, the fourth does not", async () => {
  const home = await freshHome();
  const granted = [];
  for (let index = 0; index < 4; index++) granted.push(await acquire("codex", 90, { home }));
  expect(granted.filter((result) => result.granted)).toHaveLength(3);
  expect(granted[3]).toMatchObject({ granted: false, reason: "saturated" });
});

// A worker that crashes never calls release. Without expiry the provider would
// stay saturated by a process that no longer exists.
test("an expired reservation stops holding its slot", async () => {
  const home = await freshHome();
  const stale = await acquire("claude", 25, { ttlMs: 1, home });
  expect(stale.granted).toBe(true);
  await Bun.sleep(5);

  expect(await active("claude", home)).toEqual([]);
  expect((await acquire("claude", 25, { home })).granted).toBe(true);
});

test("releasing an unknown id reports it instead of silently succeeding", async () => {
  const home = await freshHome();
  expect(await release("00000000-0000-0000-0000-000000000000", home)).toBe(false);
});

// Workers are separate processes, so the store is guarded by an on-disk lock
// rather than an in-process queue. Concurrent acquires must not overfill.
test("concurrent acquires never exceed the slot count", async () => {
  const home = await freshHome();
  const results = await Promise.all(
    Array.from({ length: 8 }, () => acquire("codex", 90, { home })),
  );
  expect(results.filter((result) => result.granted)).toHaveLength(3);
  expect(await active("codex", home)).toHaveLength(3);
});
