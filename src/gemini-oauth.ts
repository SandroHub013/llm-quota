// Antigravity public OAuth client (same one gsd-2/9router use). The old
// 071006060591-... id was deleted by Google (Error 401: invalid_client).
// This client only allows a loopback redirect: http://localhost:51121/oauth-callback,
// so login spins up a throwaway listener on port 51121 (see server.ts).
export const GEMINI_CLIENT_ID = "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
export const GEMINI_CLIENT_SECRET = "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";
export const GEMINI_REDIRECT = "http://localhost:51121/oauth-callback";
export const GEMINI_SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  // Antigravity-specific, required by the managed-project quota endpoints.
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs",
];
export const GEMINI_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const CLOUDCODE_URL = "https://cloudcode-pa.googleapis.com/v1internal";
// Requests must identify as Antigravity, otherwise loadCodeAssist returns no managed
// project and the individual tier is reported UNSUPPORTED_CLIENT.
export const GEMINI_UA = "antigravity/1.0 (Windows NT 10.0; Win64; x64)";
export const CODE_ASSIST_METADATA = {
  ideType: "ANTIGRAVITY",
  platform: "PLATFORM_UNSPECIFIED",
  pluginType: "GEMINI",
};
