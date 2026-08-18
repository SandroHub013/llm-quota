/**
 * The coverage badge is a JSON file in this repository rather than a number held by a
 * service, which means the parser that produces it is the whole mechanism. It reads a
 * table Bun prints for people, so it is worth pinning: a column that moves would send a
 * wrong number to the README rather than fail loudly.
 */
import { expect, test } from "bun:test";
import { badgeFor, linesFromReport } from "../scripts/coverage-badge.js";

const REPORT = `
--------------------------------|---------|---------|-------------------
File                            | % Funcs | % Lines | Uncovered Line #s
--------------------------------|---------|---------|-------------------
All files                       |   80.18 |   77.20 |
 src\\codex-app-server.ts        |   90.91 |   97.62 | 20-21
 src\\usage.ts                   |   95.00 |   93.10 |
--------------------------------|---------|---------|-------------------
`;

test("the badge carries lines, not functions", () => {
  // 77.20 sits in the third column; 80.18 is the one it would be easy to take instead.
  expect(linesFromReport(REPORT)).toBe(77.2);
});

test("a report without the summary row fails rather than guessing", () => {
  expect(() => linesFromReport("no table here")).toThrow("no 'All files' row");
  expect(() => linesFromReport("All files | | |")).toThrow("unreadable coverage row");
});

test("the badge rounds to whole percent, so a moved line does not stale it", () => {
  expect(badgeFor(77.2).message).toBe("77%");
  expect(badgeFor(77.4).message).toBe("77%");
  expect(badgeFor(76.8).message).toBe("77%");
});

test("the colour says what the number means", () => {
  expect(badgeFor(94).color).toBe("brightgreen");
  expect(badgeFor(77.2).color).toBe("green");
  expect(badgeFor(61).color).toBe("yellow");
  expect(badgeFor(40).color).toBe("orange");
});

test("the file shields reads is in the shape shields reads", async () => {
  const badge = JSON.parse(await Bun.file("docs/coverage.json").text());

  expect(badge.schemaVersion).toBe(1);
  expect(badge.label).toBe("coverage");
  expect(badge.message).toMatch(/^\d{1,3}%$/);
});
