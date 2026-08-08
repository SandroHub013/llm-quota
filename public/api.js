export async function requestJson(path, options, request = fetch) {
  const response = await request(path, options);
  if (!response.ok) throw new Error(`http_${response.status}`);
  try {
    return await response.json();
  } catch {
    throw new Error("invalid_json");
  }
}

export async function loadQuota(request = fetch) {
  const body = await requestJson("/api/quota", undefined, request);
  if (!Array.isArray(body?.providers)) throw new Error("invalid_quota_response");
  return body.providers;
}

export async function loadUsage(request = fetch) {
  const body = await requestJson("/api/usage", undefined, request);
  if (!Array.isArray(body?.rows) || !Array.isArray(body?.daily) || !body?.tokens || !Number.isFinite(body?.estimatedCostEur)) {
    throw new Error("invalid_usage_response");
  }
  return body;
}

export async function loadGitHubContributions(request = fetch) {
  const body = await requestJson("/api/prototype/github-contributions", undefined, request);
  if (body?.status === "unavailable" && typeof body.message === "string") return body;
  if (body?.status !== "ok" || !Array.isArray(body.weeks) || !Number.isFinite(body.total)) {
    throw new Error("invalid_github_contributions_response");
  }
  return body;
}

// The usage view (source/agent filters) is server-side state shared with the
// desktop widget; the browser keeps only display prefs like currency and sort.
export async function loadUsageView(request = fetch) {
  return usageView(await requestJson("/api/usage-view", undefined, request));
}

export async function storeUsageView(view, request = fetch) {
  return usageView(await requestJson("/api/usage-view", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source: view.source, agent: view.agent }),
  }, request));
}

function usageView(body) {
  if (typeof body?.source !== "string" || typeof body?.agent !== "string") {
    throw new Error("invalid_usage_view_response");
  }
  return { source: body.source, agent: body.agent };
}

export async function loadProvider(id, request = fetch) {
  return provider(await requestJson(`/api/quota/${encodeURIComponent(id)}`, undefined, request));
}

export async function saveProviderKey(id, key, request = fetch) {
  return provider(await requestJson(`/api/key/${encodeURIComponent(id)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key }),
  }, request));
}

export async function installOfficialBridge(id, request = fetch) {
  return provider(await requestJson(`/api/official-bridge/${encodeURIComponent(id)}`, {
    method: "POST",
  }, request));
}

export async function removeOfficialBridge(id, request = fetch) {
  return provider(await requestJson(`/api/official-bridge/${encodeURIComponent(id)}`, {
    method: "DELETE",
  }, request));
}

function provider(body) {
  if (!body?.id || !Array.isArray(body.metrics)) throw new Error("invalid_provider_response");
  return body;
}
