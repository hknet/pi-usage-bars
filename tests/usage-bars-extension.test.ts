import { afterEach, describe, expect, it } from "bun:test";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import usageBarsExtension from "../extensions/usage-bars/index";

interface Harness {
  handlers: Map<string, (event: unknown, ctx: ExtensionContext) => unknown>;
  commands: Map<string, { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }>;
  emitted: Array<{ name: string; data: unknown }>;
}

function createHarness(options: { usageFlag?: boolean } = {}): Harness {
  const harness: Harness = {
    handlers: new Map(),
    commands: new Map(),
    emitted: [],
  };
  const pi = {
    on(name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) {
      harness.handlers.set(name, handler);
    },
    registerCommand(name: string, command: Harness["commands"] extends Map<string, infer T> ? T : never) {
      harness.commands.set(name, command);
    },
    registerFlag() {},
    getFlag(name: string) {
      return name === "usage" && options.usageFlag === true;
    },
    events: {
      emit(name: string, data: unknown) {
        harness.emitted.push({ name, data });
      },
    },
  } as unknown as ExtensionAPI;
  usageBarsExtension(pi);
  return harness;
}

function createContext(
  mode: "tui" | "rpc" | "json" | "print",
  provider = "openai",
  options: { configured?: boolean; source?: string; token?: string; authHeaders?: Record<string, string> } = {},
) {
  const statuses: Array<string | undefined> = [];
  const statusKeys: string[] = [];
  const notifications: string[] = [];
  let authCalls = 0;
  let customCalls = 0;
  let shutdownCalls = 0;
  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };
  const context = {
    mode,
    hasUI: mode === "tui" || mode === "rpc",
    model: { provider, id: "test-model" },
    ui: {
      theme,
      setStatus: (key: string, value: string | undefined) => {
        statusKeys.push(key);
        statuses.push(value);
      },
      notify: (message: string) => notifications.push(message),
      custom: async () => { customCalls += 1; },
    },
    shutdown: () => { shutdownCalls += 1; },
    modelRegistry: {
      getProvider: () => ({}),
      getProviderAuthStatus: () => ({ configured: options.configured ?? false }),
      getProviderAuth: async () => {
        authCalls += 1;
        if (options.token) {
          return { auth: { apiKey: options.token }, source: options.source };
        }
        if (options.authHeaders) {
          return { auth: { headers: options.authHeaders }, source: options.source };
        }
        return undefined;
      },
    },
  } as unknown as ExtensionCommandContext;
  return {
    context,
    statuses,
    statusKeys,
    notifications,
    authCalls: () => authCalls,
    customCalls: () => customCalls,
    shutdownCalls: () => shutdownCalls,
  };
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("usage-bars extension lifecycle", () => {
  it("prints one-line JSON and shuts down for --usage", async () => {
    const harness = createHarness({ usageFlag: true });
    const mock = createContext("print", "google");
    const lines: string[] = [];
    const originalLog = console.log;
    console.log = (line?: unknown) => { lines.push(String(line)); };
    try {
      await harness.handlers.get("session_start")?.(
        { type: "session_start", reason: "startup" },
        mock.context,
      );
    } finally {
      console.log = originalLog;
    }

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual({
      extension: "@hk_net/pi-usage-bars",
      status: "unsupported",
      provider: "google",
    });
    expect(mock.shutdownCalls()).toBe(1);
  });

  it("does not poll or create timers in non-TUI modes", async () => {
    const harness = createHarness();
    const mock = createContext("print", "openai-codex", {
      configured: true,
      source: "OAuth",
      token: "token",
    });

    const result = await harness.handlers.get("session_start")?.(
      { type: "session_start", reason: "startup" },
      mock.context,
    );
    expect(result).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(mock.authCalls()).toBe(0);
    expect(mock.statuses).toHaveLength(0);
  });

  it("uses Pi provider auth and emits usage updates in TUI mode", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      rate_limit: {
        primary_window: { used_percent: 12 },
        secondary_window: { used_percent: 34 },
      },
    }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

    const harness = createHarness();
    const mock = createContext("tui", "openai-codex", {
      configured: true,
      source: "OAuth",
      token: "resolved-by-pi",
    });
    harness.handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, mock.context);
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(mock.authCalls()).toBe(1);
    expect(harness.emitted).toContainEqual({
      name: "@hk_net/pi-usage-bars:update",
      data: expect.objectContaining({ provider: "codex", session: 12, weekly: 34 }),
    });
    expect(mock.statuses.at(-1)).toContain("Codex");
    expect(mock.statusKeys.at(-1)).toBe("@hk_net/pi-usage-bars");

    harness.handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, mock.context);
  });

  it("resolves kimi-coding tokens exposed only via the Authorization header", async () => {
    let requestHeaders: HeadersInit | undefined;
    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      requestHeaders = init?.headers;
      return new Response(JSON.stringify({
        usage: {
          limit: "2048",
          used: "512",
          remaining: "1536",
          resetTime: "2026-01-09T15:23:13.716839300Z",
        },
        limits: [{
          window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
          detail: {
            limit: "200",
            used: "50",
            remaining: "150",
            resetTime: "2026-01-06T13:33:02.717479433Z",
          },
        }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    const harness = createHarness();
    const mock = createContext("tui", "kimi-coding", {
      configured: true,
      source: "OAuth",
      authHeaders: { Authorization: "Bearer kimi-token-from-header" },
    });
    harness.handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, mock.context);
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(mock.authCalls()).toBe(1);
    expect(harness.emitted).toContainEqual({
      name: "@hk_net/pi-usage-bars:update",
      data: expect.objectContaining({ provider: "kimi", session: 25, weekly: 25 }),
    });
    expect(mock.statuses.at(-1)).toContain("Kimi");
    expect(requestHeaders).toMatchObject({ Authorization: "Bearer kimi-token-from-header" });

    harness.handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, mock.context);
  });

  it("renders a weekly-only Codex window without a fabricated session lane", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      plan_type: "team",
      rate_limit: {
        primary_window: {
          used_percent: 72,
          limit_window_seconds: 604800,
          reset_after_seconds: 573719,
        },
        secondary_window: null,
      },
    }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

    const harness = createHarness();
    const mock = createContext("tui", "openai-codex", {
      configured: true,
      source: "OAuth",
      token: "resolved-by-pi",
    });
    harness.handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, mock.context);
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(harness.emitted).toContainEqual({
      name: "@hk_net/pi-usage-bars:update",
      data: expect.objectContaining({ provider: "codex", weekly: 72, sessionHidden: true }),
    });
    expect(mock.statuses.at(-1)).toContain("Codex W ");
    expect(mock.statuses.at(-1)).toContain("72%");
    expect(mock.statuses.at(-1)).not.toContain(" S ");

    harness.handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, mock.context);
  });

  it("polls OpenRouter through Pi auth and emits financial usage", async () => {
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      const body = url.endsWith("/credits")
        ? { data: { total_credits: 30, total_usage: 10 } }
        : { data: { limit: null, limit_remaining: null, usage_daily: 1, usage_weekly: 2, usage_monthly: 3 } };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    const harness = createHarness();
    const mock = createContext("tui", "openrouter", {
      configured: true,
      source: "Environment variable",
      token: "resolved-by-pi",
    });
    harness.handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, mock.context);
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(mock.authCalls()).toBe(1);
    expect(harness.emitted).toContainEqual({
      name: "@hk_net/pi-usage-bars:update",
      data: expect.objectContaining({
        provider: "openrouter",
        accountBalance: { amount: 20, unit: "USD", label: "Balance" },
        accountSpend: expect.objectContaining({ monthly: 3 }),
      }),
    });
    expect(mock.statuses.at(-1)).toContain("OpenRouter");
    expect(mock.statuses.at(-1)).toContain("$20.00");

    harness.handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, mock.context);
  });

  it("aborts an active provider request during session shutdown", async () => {
    let requestAborted = false;
    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          requestAborted = true;
          reject(new DOMException("Aborted", "AbortError"));
        }, { once: true });
      })) as unknown as typeof fetch;

    const harness = createHarness();
    const mock = createContext("tui", "openai-codex", {
      configured: true,
      source: "OAuth",
      token: "resolved-by-pi",
    });
    harness.handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, mock.context);
    await new Promise((resolve) => setTimeout(resolve, 10));
    harness.handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, mock.context);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(requestAborted).toBeTrue();
    expect(mock.statuses.at(-1)).toBeUndefined();
  });

  it("replaces an active poll cleanly when a session runtime starts again", async () => {
    let calls = 0;
    let firstRequestAborted = false;
    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      calls += 1;
      if (calls === 1) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            firstRequestAborted = true;
            reject(new DOMException("Aborted", "AbortError"));
          }, { once: true });
        });
      }
      return new Response(JSON.stringify({
        rate_limit: {
          primary_window: { used_percent: 21 },
          secondary_window: { used_percent: 43 },
        },
      }), { status: 200 });
    }) as unknown as typeof fetch;

    const harness = createHarness();
    const first = createContext("tui", "openai-codex", {
      configured: true,
      source: "OAuth",
      token: "first-session-token",
    });
    const replacement = createContext("tui", "openai-codex", {
      configured: true,
      source: "OAuth",
      token: "replacement-session-token",
    });
    harness.handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, first.context);
    await new Promise((resolve) => setTimeout(resolve, 10));
    harness.handlers.get("session_start")?.({ type: "session_start", reason: "reload" }, replacement.context);
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(firstRequestAborted).toBeTrue();
    expect(harness.emitted).toContainEqual({
      name: "@hk_net/pi-usage-bars:update",
      data: expect.objectContaining({ provider: "codex", session: 21, weekly: 43 }),
    });
    harness.handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, replacement.context);
  });

  it("keeps only one polling interval across repeated session starts", () => {
    const realSetInterval = globalThis.setInterval;
    const realClearInterval = globalThis.clearInterval;
    const activeIntervals = new Set<number>();
    let nextInterval = 1;
    globalThis.setInterval = ((_handler: TimerHandler, _timeout?: number) => {
      const id = nextInterval++;
      activeIntervals.add(id);
      return id;
    }) as unknown as typeof setInterval;
    globalThis.clearInterval = ((id: number) => {
      activeIntervals.delete(id);
    }) as unknown as typeof clearInterval;

    try {
      const harness = createHarness();
      const first = createContext("tui");
      const second = createContext("tui");
      harness.handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, first.context);
      harness.handlers.get("session_start")?.({ type: "session_start", reason: "reload" }, second.context);
      expect(activeIntervals.size).toBe(1);

      harness.handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, second.context);
      expect(activeIntervals.size).toBe(0);
    } finally {
      globalThis.setInterval = realSetInterval;
      globalThis.clearInterval = realClearInterval;
    }
  });

  it("cancels an old provider poll and refreshes the newly selected model provider", async () => {
    let codexRequestAborted = false;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("chatgpt.com")) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            codexRequestAborted = true;
            reject(new DOMException("Aborted", "AbortError"));
          }, { once: true });
        });
      }
      const body = url.endsWith("/credits")
        ? { data: { total_credits: 20, total_usage: 5 } }
        : { data: { usage_monthly: 2 } };
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;

    const harness = createHarness();
    const mock = createContext("tui", "openai-codex", {
      configured: true,
      source: "OAuth",
      token: "resolved-by-pi",
    });
    harness.handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, mock.context);
    await new Promise((resolve) => setTimeout(resolve, 10));
    harness.handlers.get("model_select")?.({
      type: "model_select",
      model: { provider: "openrouter", id: "test-model" },
      previousModel: { provider: "openai-codex", id: "test-model" },
      source: "set",
    }, mock.context);
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(codexRequestAborted).toBeTrue();
    expect(harness.emitted).toContainEqual({
      name: "@hk_net/pi-usage-bars:update",
      data: expect.objectContaining({ provider: "openrouter" }),
    });
    harness.handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, mock.context);
  });

  it("aborts /usage requests when the custom component closes", async () => {
    let selectorRequestAborted = false;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          selectorRequestAborted = true;
          reject(new DOMException("Aborted", "AbortError"));
        }, { once: true });
      })) as unknown as typeof fetch;

    const harness = createHarness();
    const mock = createContext("tui", "openai-codex", {
      configured: true,
      source: "OAuth",
      token: "resolved-by-pi",
    });
    const context = mock.context as any;
    context.modelRegistry.getProvider = (provider: string) => provider === "openai-codex" ? {} : undefined;
    context.modelRegistry.getProviderAuthStatus = (provider: string) => ({
      configured: provider === "openai-codex",
    });
    context.ui.custom = async (factory: (...args: any[]) => any) => {
      let component: { handleInput?(data: string): void; dispose?(): void } | undefined;
      await new Promise<void>((resolve) => {
        void Promise.resolve(factory(
          { terminal: { rows: 24 }, requestRender() {} },
          context.ui.theme,
          { matches: (data: string, binding: string) => data === "escape" && binding === "tui.select.cancel" },
          resolve,
        )).then((created) => {
          component = created;
          setTimeout(() => component?.handleInput?.("escape"), 10);
        });
      });
      component?.dispose?.();
    };

    await harness.commands.get("usage")?.handler("", mock.context);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(selectorRequestAborted).toBeTrue();
  });

  it("relies on model_select rather than checking the model every turn", () => {
    const harness = createHarness();
    expect(harness.handlers.has("model_select")).toBeTrue();
    expect(harness.handlers.has("turn_start")).toBeFalse();
  });

  it("polls Baseten through Pi auth and renders current-month credits used", async () => {
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      expect(String(input)).toContain("https://api.baseten.co/v1/billing/usage_summary?");
      expect(String(input)).toContain("start_date=");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer resolved-by-pi");
      return new Response(JSON.stringify({
        dedicated_usage: { credits_used: 2 },
        model_apis_usage: { credits_used: 3 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    const harness = createHarness();
    const mock = createContext("tui", "baseten", {
      configured: true,
      source: "Environment variable",
      token: "resolved-by-pi",
    });
    harness.handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, mock.context);
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(mock.authCalls()).toBe(1);
    expect(harness.emitted).toContainEqual({
      name: "@hk_net/pi-usage-bars:update",
      data: expect.objectContaining({
        provider: "baseten",
        quotaHidden: true,
        accountUsage: { amount: 5, unit: "credits", label: "Credits used this month" },
      }),
    });
    expect(mock.statuses.at(-1)).toContain("Baseten");
    expect(mock.statuses.at(-1)).toContain("Credits used this month");

    harness.handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, mock.context);
  });

  it("polls Vercel AI Gateway through Pi auth and renders balance", async () => {
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      expect(String(input)).toBe("https://ai-gateway.vercel.sh/v1/credits");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer resolved-by-pi");
      return new Response(JSON.stringify({ balance: "18.75", total_used: "6.25" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const harness = createHarness();
    const mock = createContext("tui", "vercel-ai-gateway", {
      configured: true,
      source: "Environment variable",
      token: "resolved-by-pi",
    });
    harness.handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, mock.context);
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(mock.authCalls()).toBe(1);
    expect(harness.emitted).toContainEqual({
      name: "@hk_net/pi-usage-bars:update",
      data: expect.objectContaining({
        provider: "vercel",
        quotaHidden: true,
        accountBalance: { amount: 18.75, unit: "USD", label: "Balance" },
        accountSpend: { unit: "USD", lifetime: 6.25 },
      }),
    });
    expect(mock.statuses.at(-1)).toContain("Vercel AI Gateway");
    expect(mock.statuses.at(-1)).toContain("$18.75");

    harness.handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, mock.context);
  });

  it("polls Fireworks through Pi auth and renders current-month spend", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      urls.push(String(input));
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer resolved-by-pi");
      if (String(input).includes("/accounts?pageSize=")) {
        return new Response(JSON.stringify({
          accounts: [{ name: "accounts/test-account" }],
          totalSize: 1,
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({
        lineItems: [{ totalCost: { currencyCode: "USD", units: "4", nanos: 500_000_000 } }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    const harness = createHarness();
    const mock = createContext("tui", "fireworks", {
      configured: true,
      source: "Environment variable",
      token: "resolved-by-pi",
    });
    harness.handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, mock.context);
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(mock.authCalls()).toBe(1);
    expect(urls[0]).toBe("https://api.fireworks.ai/v1/accounts?pageSize=200");
    expect(urls[1]).toContain("/accounts/test-account/billing/summary?");
    expect(harness.emitted).toContainEqual({
      name: "@hk_net/pi-usage-bars:update",
      data: expect.objectContaining({
        provider: "fireworks",
        quotaHidden: true,
        accountSpend: { unit: "USD", monthly: 4.5 },
      }),
    });
    expect(mock.statuses.at(-1)).toContain("Fireworks");
    expect(mock.statuses.at(-1)).toContain("Month · $4.50");

    harness.handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, mock.context);
  });

  it("guards the custom command outside interactive TUI mode", async () => {
    const harness = createHarness();
    const mock = createContext("rpc");
    await harness.commands.get("usage")?.handler("", mock.context);
    expect(mock.customCalls()).toBe(0);
    expect(mock.notifications).toEqual(["/usage is available in interactive mode"]);
  });
});
