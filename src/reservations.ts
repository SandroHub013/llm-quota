/**
 * Admission control for quota-spending workers.
 *
 * A quota floor read from a snapshot is a state check, not admission control:
 * five workers launched in the same minute all observe the same 25% — the
 * dashboard caches `/api/quota` for 55 seconds — all pass the floor, and together
 * they empty the provider before anything re-reads it. Retry and re-route then
 * multiply the loss.
 *
 * So a worker takes a slot before it starts and gives it back when it finishes,
 * and the number of slots shrinks as the binding window drains. Slots, not token
 * budgets: nothing here yet measures what a dispatch actually costs, and a
 * reservation denominated in invented percentages would be worse than one
 * denominated in something honest.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export interface Reservation {
  id: string;
  provider: string;
  acquiredAt: string;
  expiresAt: string;
  note?: string;
}

export interface AcquireResult {
  granted: boolean;
  id?: string;
  reason?: "floor" | "saturated";
  held: number;
  slots: number;
}

export const DEFAULT_TTL_MS = 30 * 60_000;
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_STALE_MS = 30_000;

export function reservationPaths(home = homedir()) {
  const root = join(home, ".llm-quota");
  return { store: join(root, "reservations.json"), lock: join(root, "reservations.lock") };
}

/**
 * Slots allowed at a given remaining percentage on the binding window.
 *
 * The bands mirror the CLI's own exit codes so one number means one thing
 * everywhere: at or below the floor nothing is admitted, and between the floor
 * and half-full only one worker runs at a time, which is what stops a burst of
 * parallel dispatches from stepping off the cliff together.
 */
export function slotsFor(remaining: number | undefined): number {
  if (remaining == null) return 1; // unknown capacity: one probe at a time
  if (remaining <= 20) return 0;
  if (remaining <= 50) return 1;
  return 3;
}

export async function acquire(
  provider: string,
  remaining: number | undefined,
  options: { ttlMs?: number; note?: string; home?: string } = {},
): Promise<AcquireResult> {
  const home = options.home ?? homedir();
  const ttl = options.ttlMs ?? DEFAULT_TTL_MS;
  const slots = slotsFor(remaining);

  return withLock(home, async () => {
    const entries = prune(await readStore(home));
    const held = entries.filter((entry) => entry.provider === provider).length;
    if (slots === 0) return { granted: false, reason: "floor" as const, held, slots };
    if (held >= slots) return { granted: false, reason: "saturated" as const, held, slots };

    const now = Date.now();
    const reservation: Reservation = {
      id: randomUUID(),
      provider,
      acquiredAt: new Date(now).toISOString(),
      expiresAt: new Date(now + ttl).toISOString(),
      ...(options.note ? { note: options.note } : {}),
    };
    await writeStore(home, [...entries, reservation]);
    return { granted: true, id: reservation.id, held: held + 1, slots };
  });
}

export async function release(id: string, home = homedir()): Promise<boolean> {
  return withLock(home, async () => {
    const entries = prune(await readStore(home));
    const remaining = entries.filter((entry) => entry.id !== id);
    if (remaining.length === entries.length) return false;
    await writeStore(home, remaining);
    return true;
  });
}

/** Live reservations, expired ones dropped. Read-only: takes no lock. */
export async function active(provider?: string, home = homedir()): Promise<Reservation[]> {
  const entries = prune(await readStore(home));
  return provider ? entries.filter((entry) => entry.provider === provider) : entries;
}

function prune(entries: Reservation[]): Reservation[] {
  const now = Date.now();
  // A worker that crashed never released its slot. Without an expiry the
  // provider would stay permanently saturated by a process that no longer exists.
  return entries.filter((entry) => {
    const expiry = Date.parse(entry.expiresAt);
    return Number.isFinite(expiry) && expiry > now;
  });
}

async function readStore(home: string): Promise<Reservation[]> {
  const { store } = reservationPaths(home);
  if (!existsSync(store)) return [];
  try {
    const parsed = JSON.parse(await readFile(store, "utf8"));
    if (!Array.isArray(parsed?.entries)) return [];
    return parsed.entries.filter(
      (entry: any) =>
        entry && typeof entry.id === "string" && typeof entry.provider === "string"
        && typeof entry.expiresAt === "string",
    );
  } catch {
    return [];
  }
}

async function writeStore(home: string, entries: Reservation[]): Promise<void> {
  const { store } = reservationPaths(home);
  await mkdir(dirname(store), { recursive: true, mode: 0o700 });
  const temporary = `${store}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify({ version: 1, entries }, null, 2)}\n`, "utf8");
    await rename(temporary, store);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

/**
 * `mkdir` is the mutex: it is atomic and fails when the directory exists, on
 * every platform and without a dependency. Workers are separate processes, so an
 * in-process queue — the one guarding the config file — would not see them.
 */
async function withLock<T>(home: string, operation: () => Promise<T>): Promise<T> {
  const { lock } = reservationPaths(home);
  await mkdir(dirname(lock), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      await mkdir(lock);
      break;
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
      if (await stale(lock)) {
        await rm(lock, { recursive: true, force: true }).catch(() => {});
        continue;
      }
      if (Date.now() > deadline) throw new Error("reservation_lock_timeout");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  try {
    return await operation();
  } finally {
    await rm(lock, { recursive: true, force: true }).catch(() => {});
  }
}

async function stale(lock: string): Promise<boolean> {
  try {
    const { stat } = await import("node:fs/promises");
    const info = await stat(lock);
    return Date.now() - info.mtimeMs > LOCK_STALE_MS;
  } catch {
    return false;
  }
}
