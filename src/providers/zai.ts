import type { Provider, QuotaResult } from "./types.js";
import { nowIso } from "./util.js";

const CONSOLE = "https://z.ai/manage-apikey/apikey-list";

export const zai: Provider = {
  id: "zai",
  name: "z.ai",
  consoleUrl: CONSOLE,

  async fetch(): Promise<QuotaResult> {
    return {
      id: "zai",
      name: "z.ai",
      status: "no_endpoint",
      consoleUrl: CONSOLE,
      sourceKind: "unavailable",
      sourceLabel: "official plugin / console",
      metrics: [],
      message:
        "GLM Coding Plan quota is available through Z.ai's official Usage Query plugin; no public dashboard API is documented.",
      updatedAt: nowIso(),
    };
  },
};
