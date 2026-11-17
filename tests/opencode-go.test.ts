import { expect, it } from "bun:test";
import { detectProvider, fetchAllUsages, fetchOpenCodeGoUsage, parseOpenCodeGoUsage } from "../extensions/usage-bars/core";

it("reads Go quota percentages and reset times without rescaling them", () => {
  expect(parseOpenCodeGoUsage({ usage: {
    rolling: { status: "ok", percent: 0.25, resetsAt: "2026-06-01T05:00:00Z" },
    weekly: { status: "rate-limited", percent: 100, resetsAt: "2026-06-08T00:00:00Z" },
    monthly: { status: "ok", percent: 0, resetsAt: "invalid" },
  } }, Date.parse("2026-06-01T00:00:00Z"))).toMatchObject({
    session: 0.25, sessionResetsIn: "5h", weekly: 100, weeklyResetsIn: "7d",
    monthly: 0, monthlyResetsIn: undefined,
  });
});

it("hides unavailable quota windows and rejects payloads without usable windows", () => {
  expect(parseOpenCodeGoUsage({ usage: {
    rolling: { status: "unavailable", percent: 0 },
    weekly: { status: "ok", percent: -1 },
    monthly: { status: "ok", percent: 12 },
  } })).toMatchObject({ sessionHidden: true, weeklyHidden: true, monthly: 12 });
  expect(parseOpenCodeGoUsage({ usage: { rolling: { status: "ok", percent: "10" } } })).toBeNull();
});

it("matches OpenCode Go by provider ID and inference host", () => {
  expect(detectProvider({ provider: "opencode-go", baseUrl: "https://opencode.ai/inference/go/anthropic" })).toBe("opencode-go");
  expect(detectProvider({ provider: "opencode", baseUrl: "https://opencode.ai/inference/anthropic" })).toBeNull();
  expect(detectProvider({ provider: "opencode-go", baseUrl: "https://proxy.example/go" })).toBeNull();
});

it("fetches Go usage for the configured account without following redirects", async () => {
  const results = await fetchAllUsages({ "opencode-go": "go-key" }, {
    fetchFn: async (url, init) => {
      expect(url).toBe("https://opencode.ai/zen/go/v1/usage");
      expect(init).toMatchObject({ headers: { Authorization: "Bearer go-key" }, redirect: "error" });
      return Response.json({ usage: { monthly: { status: "ok", percent: 42 } } });
    },
  });
  expect(results["opencode-go"]).toMatchObject({ monthly: 42 });
  expect(await fetchOpenCodeGoUsage("go-key", { fetchFn: async () => new Response(null, { status: 401 }) }))
    .toMatchObject({ error: "HTTP 401" });
});
