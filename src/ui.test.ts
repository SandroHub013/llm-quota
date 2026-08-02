import { expect, test } from "bun:test";
import { dataSignature, escapeHtml } from "../public/ui.js";

test("provider text is escaped before card HTML rendering", () => {
  expect(escapeHtml(`<img src=x onerror="alert('x')"> & ok`)).toBe(
    "&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt; &amp; ok",
  );
});

test("escaping handles nullish provider fields", () => {
  expect(escapeHtml(undefined)).toBe("");
  expect(escapeHtml(null)).toBe("");
});

test("live data signatures ignore collection timestamps but keep visible changes", () => {
  const first = { total: 12, generatedAt: "2026-08-02T10:00:00Z", nested: { updatedAt: "old" } };
  const same = { total: 12, generatedAt: "2026-08-02T10:01:00Z", nested: { updatedAt: "new" } };
  const changed = { ...same, total: 13 };

  expect(dataSignature(first)).toBe(dataSignature(same));
  expect(dataSignature(first)).not.toBe(dataSignature(changed));
});
