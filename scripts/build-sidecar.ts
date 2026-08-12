/**
 * Compiles the Bun server into the sidecar the desktop shell ships.
 *
 * Tauri resolves an `externalBin` entry by appending the Rust target triple of the
 * build, so the file has to be named `llm-quota-server-<triple>` (plus `.exe` on
 * Windows) or the bundler reports the sidecar as missing. The triple comes from
 * `rustc -vV` rather than from Node's `process.platform`, because those two disagree
 * on exactly the axis that matters — Apple silicon versus Intel, gnu versus musl.
 *
 * Run: bun run sidecar            (host triple)
 *      bun run sidecar -- <triple>  (cross build, e.g. aarch64-apple-darwin)
 */
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const OUTPUT_DIR = resolve(ROOT, "src-tauri", "binaries");

/**
 * Rust target triple → Bun compile target. Passing the triple alone would name the
 * file for one architecture and fill it with another: `bun build --compile` targets
 * the host unless told otherwise, so a cross build would ship, say, an x64 server
 * inside the arm64 macOS bundle and fail at launch with a format error.
 *
 * The x64 targets use Bun's default build, which assumes AVX2 — every x86 CPU from
 * 2013 on. The `-baseline` variants exist for older ones; add them here if a report
 * ever arrives, since the symptom is an illegal-instruction crash with no message.
 */
const BUN_TARGETS: Record<string, string> = {
  "x86_64-pc-windows-msvc": "bun-windows-x64",
  "x86_64-apple-darwin": "bun-darwin-x64",
  "aarch64-apple-darwin": "bun-darwin-arm64",
  "x86_64-unknown-linux-gnu": "bun-linux-x64",
  "aarch64-unknown-linux-gnu": "bun-linux-arm64",
};

export function bunTargetFor(triple: string): string {
  const target = BUN_TARGETS[triple];
  if (!target) {
    throw new Error(
      `no Bun compile target is mapped for "${triple}". Add it to BUN_TARGETS in scripts/build-sidecar.ts.`,
    );
  }
  return target;
}

export function parseHostTriple(rustcVersionVerbose: string): string {
  const host = rustcVersionVerbose.match(/^host:\s*(\S+)$/m)?.[1];
  if (!host) throw new Error("could not read the host triple from `rustc -vV`");
  return host;
}

async function hostTriple(): Promise<string> {
  const rustc = Bun.spawnSync(["rustc", "-vV"]);
  if (!rustc.success) {
    throw new Error("`rustc -vV` failed — install the Rust toolchain (https://rustup.rs) to build the desktop app");
  }
  return parseHostTriple(rustc.stdout.toString());
}

/**
 * The resource fields Windows reads out of an executable: the icon Explorer draws,
 * and the publisher and description that fill the properties dialog and the
 * SmartScreen prompt. Without them a compiled Bun binary ships wearing Bun's own
 * mascot and no company name — and this binary is published on its own, not only
 * embedded in the bundle, so it is the file some users see first.
 *
 * Windows wants four version components; the package carries three.
 */
export function windowsBranding(version: string, description: string): string[] {
  return [
    `--windows-icon=${resolve(ROOT, "src-tauri", "icons", "icon.ico")}`,
    "--windows-title=LLM Quota",
    "--windows-publisher=Alessandro Boni",
    `--windows-version=${version}.0`,
    `--windows-description=${description}`,
    "--windows-copyright=Copyright © 2026 Alessandro Boni. MIT licensed.",
  ];
}

if (import.meta.main) {
  const triple = process.argv[2] ?? (await hostTriple());
  const windows = triple.includes("windows");
  const suffix = windows ? ".exe" : "";
  const outfile = resolve(OUTPUT_DIR, `llm-quota-server-${triple}${suffix}`);

  const manifest = await Bun.file(resolve(ROOT, "package.json")).json();
  const branding = windows ? windowsBranding(manifest.version, manifest.description) : [];

  await mkdir(OUTPUT_DIR, { recursive: true });
  const build = Bun.spawnSync(
    [
      "bun", "build", "--compile", "--minify",
      `--target=${bunTargetFor(triple)}`,
      ...branding,
      "src/server.ts", "--outfile", outfile,
    ],
    { cwd: ROOT, stdio: ["inherit", "inherit", "inherit"] },
  );
  if (!build.success) process.exit(build.exitCode ?? 1);

  console.log(`  sidecar → src-tauri/binaries/llm-quota-server-${triple}${suffix}`);
}
