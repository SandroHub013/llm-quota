/**
 * Writes docs/coverage.json: the value the README's coverage badge renders.
 *
 * No coverage service. Uploading a repository's source to a third party to be told a
 * percentage back is a strange trade for a number this file can compute, and the badge
 * would then depend on an account nobody can hand over. Shields renders any JSON in its
 * endpoint shape, so the number lives here, in the repository, next to the code it is
 * about.
 *
 * Run: bun run coverage:badge          (writes the file)
 *      bun run coverage:badge --check  (fails if the file is stale — this is what CI runs)
 *
 * Rounded to whole percent on purpose. A badge that has to be regenerated because a
 * comment moved a line is a badge people learn to regenerate without reading.
 */
import { write } from "bun";

const BADGE = "docs/coverage.json";

/**
 * Points of drift `--check` tolerates. The shipped code branches on platform — a Windows
 * spawn path, a POSIX one — so Linux and Windows measure the same commit about a point
 * apart, and demanding the exact figure would fail whichever machine did not write it.
 * Enough for a platform, not for a regression.
 */
const DRIFT = 2;

/** Green enough to be honest, never green enough to be smug. */
const colorFor = (percent: number): string => {
  if (percent >= 90) return "brightgreen";
  if (percent >= 75) return "green";
  if (percent >= 60) return "yellow";
  return "orange";
};

/**
 * Bun prints one row per file and an `All files` row, with functions and lines as the
 * middle columns. Lines is the figure the badge carries: it is the one people mean.
 */
export function linesFromReport(report: string): number {
  const row = report.split("\n").find((line) => line.trimStart().startsWith("All files"));
  if (!row) throw new Error("no 'All files' row in the coverage report");

  // Matched rather than coerced: `Number("")` is 0, and a badge that says nobody tested
  // anything is the one wrong answer this parser could give without failing.
  const column = row.split("|").map((value) => value.trim())[2] ?? "";
  if (!/^\d+(?:\.\d+)?$/.test(column)) throw new Error(`unreadable coverage row: ${row}`);
  return Number(column);
}

export const badgeFor = (percent: number) => ({
  schemaVersion: 1,
  label: "coverage",
  message: `${Math.round(percent)}%`,
  color: colorFor(percent),
});

if (import.meta.main) {
  // stderr, because Bun prints the coverage table there.
  const run = Bun.spawnSync(["bun", "test", "--coverage"], { stderr: "pipe", stdout: "pipe" });
  const report = `${run.stderr.toString()}${run.stdout.toString()}`;
  if (run.exitCode !== 0) {
    console.error(report);
    throw new Error("the test run failed, so its coverage says nothing");
  }

  const badge = badgeFor(linesFromReport(report));
  const rendered = `${JSON.stringify(badge, null, 2)}\n`;

  if (process.argv.includes("--check")) {
    const current = await Bun.file(BADGE).text().catch(() => "");
    const claimed = Number.parseFloat(JSON.parse(current || "{}").message ?? "");
    if (!Number.isFinite(claimed) || Math.abs(claimed - Number.parseFloat(badge.message)) > DRIFT) {
      console.error(
        `${BADGE} is stale: it says ${JSON.parse(current || "{}").message ?? "nothing"}, the tests say ${badge.message}.\n` +
        "Run `bun run coverage:badge` and commit the result.",
      );
      process.exit(1);
    }
    console.log(`${BADGE} says ${JSON.parse(current).message}, the tests measured ${badge.message}`);
  } else {
    await write(BADGE, rendered);
    console.log(`${BADGE} → ${badge.message}`);
  }
}
