const ENTITIES = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(value) {
  if (value == null) return "";
  return String(value).replace(/[&<>"']/g, (char) => ENTITIES[char]);
}

// API payloads carry collection timestamps that change on every request even when
// the visible data does not. Ignoring them lets the live dashboard skip needless
// DOM replacements (and the visual "refresh" they would cause).
export function dataSignature(value) {
  return JSON.stringify(value, (key, current) =>
    key === "generatedAt" || key === "updatedAt" ? undefined : current,
  );
}
