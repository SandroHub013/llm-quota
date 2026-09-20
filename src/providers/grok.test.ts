import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { fetchGrokQuota, parseGrokCredits } from "./grok.js";

function concat(...parts: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function varint(value: number): Uint8Array {
  const bytes: number[] = [];
  let remaining = BigInt(value);
  do {
    let byte = Number(remaining & 0x7fn);
    remaining >>= 7n;
    if (remaining > 0n) byte |= 0x80;
    bytes.push(byte);
  } while (remaining > 0n);
  return Uint8Array.from(bytes);
}

function scalar(field: number, value: number): Uint8Array {
  return concat(varint(field << 3), varint(value));
}

function fixed32(field: number, value: number): Uint8Array {
  const bytes = new Uint8Array(5);
  bytes[0] = (field << 3) | 5;
  new DataView(bytes.buffer).setFloat32(1, value, true);
  return bytes;
}

function message(field: number, value: Uint8Array): Uint8Array {
  return concat(varint((field << 3) | 2), varint(value.length), value);
}

const RESET = 1_800_000_000;
const payload = message(
  1,
  concat(
    fixed32(1, 33),
    message(8, concat(scalar(1, 2), message(3, scalar(1, RESET)))),
    message(7, concat(scalar(1, 2), fixed32(2, 41))),
    message(12, scalar(1, 250)),
  ),
);

test("Grok credits, product windows and prepaid become metrics", () => {
  const metrics = parseGrokCredits(payload);
  expect(metrics).toEqual([
    {
      label: "Credits",
      used: 33,
      limit: 100,
      remaining: 67,
      unit: "percent",
      resetAt: new Date(RESET * 1000).toISOString(),
    },
    {
      label: "Grok Build",
      used: 41,
      limit: 100,
      remaining: 59,
      unit: "percent",
      resetAt: new Date(RESET * 1000).toISOString(),
    },
    { label: "Prepaid", remaining: 250, unit: "credits", resetAt: new Date(RESET * 1000).toISOString() },
  ]);
});

test("an empty Grok payload is no metrics, not a crash", () => {
  expect(parseGrokCredits(new Uint8Array())).toEqual([]);
});

const originalAuth = process.env.GROK_AUTH_JSON;
const originalHome = process.env.GROK_HOME;
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "llm-quota-grok-"));
  process.env.GROK_HOME = join(tempDir, "grok");
  delete process.env.GROK_AUTH_JSON;
  delete process.env.GROK_AUTH_PATH;
  delete process.env.GROK_AUTH;
});

afterEach(() => {
  if (originalAuth === undefined) delete process.env.GROK_AUTH_JSON;
  else process.env.GROK_AUTH_JSON = originalAuth;
  if (originalHome === undefined) delete process.env.GROK_HOME;
  else process.env.GROK_HOME = originalHome;
  rmSync(tempDir, { recursive: true, force: true });
});

test("without a Grok session the card asks to log in", async () => {
  const result = await fetchGrokQuota({}, tempDir);
  expect(result.status).toBe("unauthenticated");
  expect(result.metrics).toEqual([]);
  expect(result.message).toContain("grok login");
});
