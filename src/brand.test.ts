import { expect, test } from "bun:test";

const read = (path: string) => Bun.file(path).text();

test("product surfaces use LLM Quota as the primary identity", async () => {
  const pkg = await Bun.file("package.json").json();
  const [readme, server, providers] = await Promise.all([
    read("README.md"),
    read("src/server.ts"),
    Promise.all([
      read("src/providers/codex.ts"),
      read("src/providers/gemini.ts"),
      read("src/providers/moonshot.ts"),
      read("src/providers/opencode-zen.ts"),
      read("src/providers/zai.ts"),
    ]).then((files) => files.join("\n")),
  ]);

  expect(pkg.name).toBe("llm-quota");
  expect(pkg.bin["llm-quota"]).toBe("src/cli.ts");
  // The README opens with a centred banner div, so the identity is not on line 1 —
  // what matters is that the first heading of the document is still the product name.
  expect(readme.match(/^#+ .*/m)?.[0]).toBe("# LLM Quota");
  expect(server).toContain("LLM Quota →");
  expect(providers).not.toContain("WebQuota");
});

test("widget button delegates GUI launch to the registered Windows protocol", async () => {
  const [app, server, widget] = await Promise.all([
    read("public/app.js"),
    read("src/server.ts"),
    read("widget.py"),
  ]);

  expect(app).toContain('window.location.href = "llmquota://widget"');
  expect(app).not.toContain('/api/widget');
  expect(server).not.toContain('app.post("/api/widget"');
  expect(widget).toContain("def register_protocol");
  expect(widget).toContain('"URL Protocol"');
});
