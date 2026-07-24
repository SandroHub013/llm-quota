import { expect, test } from "bun:test";
import { escapeHtml } from "../public/ui.js";

test("provider text is escaped before card HTML rendering", () => {
  expect(escapeHtml(`<img src=x onerror="alert('x')"> & ok`)).toBe(
    "&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt; &amp; ok",
  );
});

test("escaping handles nullish provider fields", () => {
  expect(escapeHtml(undefined)).toBe("");
  expect(escapeHtml(null)).toBe("");
});
