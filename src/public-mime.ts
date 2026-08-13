/**
 * The extensions the dashboard serves, and nothing else. This is the closed set the
 * static route gates on, and the same set the embedded asset manifest is generated
 * from — so a file the server would refuse to serve is never shipped inside the
 * compiled binary, and a file it would serve is never missing from it.
 *
 * Adding an extension here widens both at once. Regenerate the manifest afterwards:
 * `bun run generate:assets`.
 */
export const MIME: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
};

/** The dashboard entry point, served at `/` rather than by extension. */
export const INDEX = "index.html";

export function mimeFor(relative: string): string | undefined {
  return MIME[relative.slice(relative.lastIndexOf("."))];
}

/** True when `relative` is a path the static route can return. */
export function servable(relative: string): boolean {
  return relative === INDEX || mimeFor(relative) !== undefined;
}
