/** Quota, balance, and spend indicators for providers supported by current Pi releases. */

import {
  DynamicBorder,
  type ExtensionAPI,
  type ExtensionContext,
  type KeybindingsManager,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  Input,
  Spacer,
  Text,
  type Focusable,
  type TUI,
} from "@earendil-works/pi-tui";
import {
  clampPercent,
  colorForPercent,
  detectProvider,
  fetchAllUsages,
  fetchClaudeUsageWithFallback,
  fetchCodexUsage,
  fetchDeepSeekBalance,
  fetchKimiUsage,
  fetchMiniMaxUsage,
  fetchMoonshotBalance,
  fetchOpenRouterUsage,
  fetchZaiUsage,
  providerToPiProviderId,
  resolveUsageEndpoints,
  type AccountBalance,
  type AccountSpend,
  type ProviderKey,
  type UsageByProvider,
  type UsageData,
  type UsageTokens,
} from "./core";

const POLL_INTERVAL_MS = 2 * 60 * 1000;
const STATUS_KEY = "usage-bars";
const PROVIDERS: readonly ProviderKey[] = [
  "codex",
  "claude",
  "zai",
  "zai-cn",
  "kimi",
  "minimax",
  "minimax-cn",
  "openrouter",
  "deepseek",
  "moonshot",
  "moonshot-cn",
];

const PROVIDER_LABELS: Record<ProviderKey, string> = {
  codex: "Codex",
  claude: "Claude",
  zai: "ZAI Coding Plan (Global)",
  "zai-cn": "ZAI Coding Plan (China)",
  kimi: "Kimi For Coding",
  minimax: "MiniMax Coding Plan (Global)",
  "minimax-cn": "MiniMax Coding Plan (China)",
  openrouter: "OpenRouter",
  deepseek: "DeepSeek",
  moonshot: "Moonshot/Kimi API (Global)",
  "moonshot-cn": "Moonshot/Kimi API (China)",
};

function formatFinancialAmount(amount: number, unit: string): string {
  if (/^[A-Z]{3}$/.test(unit)) {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: unit,
      minimumFractionDigits: 2,
      maximumFractionDigits: 5,
    }).format(amount);
  }
  const formatted = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(amount);
  return `${formatted} ${unit}`;
}

function formatAccountBalance(balance: AccountBalance): string {
  return `${balance.label} · ${formatFinancialAmount(balance.amount, balance.unit)}`;
}

function formatAccountSpend(spend: AccountSpend): string {
  const values = [
    spend.daily === undefined ? undefined : `today ${formatFinancialAmount(spend.daily, spend.unit)}`,
    spend.weekly === undefined ? undefined : `week ${formatFinancialAmount(spend.weekly, spend.unit)}`,
    spend.monthly === undefined ? undefined : `month ${formatFinancialAmount(spend.monthly, spend.unit)}`,
  ].filter((value): value is string => Boolean(value));
  if (values.length === 0 && spend.lifetime !== undefined) {
    values.push(`lifetime ${formatFinancialAmount(spend.lifetime, spend.unit)}`);
  }
  return `Spent · ${values.join(" · ")}`;
}

interface SubscriptionItem {
  name: string;
  provider: ProviderKey;
  data: UsageData;
  isActive: boolean;
}

interface CredentialResolution {
  token?: string;
  error?: string;
}

class UsageSelectorComponent extends Container implements Focusable {
  private readonly searchInput: Input;
  private readonly listContainer: Container;
  private readonly hintText: Text;
  private readonly requestController = new AbortController();
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly keybindings: KeybindingsManager;
  private readonly onCancelCallback: () => void;
  private readonly activeProvider: ProviderKey | null;
  private readonly fetchAllFn: (signal: AbortSignal) => Promise<UsageByProvider>;
  private allItems: SubscriptionItem[] = [];
  private filteredItems: SubscriptionItem[] = [];
  private selectedIndex = 0;
  private loading = true;
  private hint: "loading" | "ready" | "error" = "loading";
  private disposed = false;
  private _focused = false;

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.searchInput.focused = value;
  }

  constructor(
    tui: TUI,
    theme: Theme,
    keybindings: KeybindingsManager,
    activeProvider: ProviderKey | null,
    fetchAll: (signal: AbortSignal) => Promise<UsageByProvider>,
    onCancel: () => void,
  ) {
    super();
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    this.activeProvider = activeProvider;
    this.fetchAllFn = fetchAll;
    this.onCancelCallback = onCancel;

    this.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
    this.addChild(new Spacer(1));
    this.hintText = new Text("", 0, 0);
    this.addChild(this.hintText);
    this.addChild(new Spacer(1));
    this.searchInput = new Input();
    this.addChild(this.searchInput);
    this.addChild(new Spacer(1));
    this.listContainer = new Container();
    this.addChild(this.listContainer);
    this.addChild(new Spacer(1));
    this.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));

    this.updateHint();
    this.updateList();
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      const results = await this.fetchAllFn(this.requestController.signal);
      if (this.disposed || this.requestController.signal.aborted) return;
      this.loading = false;
      this.hint = "ready";
      this.buildItems(results);
    } catch {
      if (this.disposed || this.requestController.signal.aborted) return;
      this.loading = false;
      this.hint = "error";
    }
    this.updateHint();
    this.updateList();
    this.tui.requestRender();
  }

  private updateHint(): void {
    if (this.hint === "loading") {
      this.hintText.setText(this.theme.fg("dim", "Fetching quota, balance, and spend from configured providers…"));
    } else if (this.hint === "error") {
      this.hintText.setText(this.theme.fg("error", "Failed to fetch usage data"));
    } else {
      this.hintText.setText(
        this.theme.fg("muted", "Only showing configured usage providers. ") +
          this.theme.fg("dim", "✓ = active provider"),
      );
    }
  }

  private buildItems(results: UsageByProvider): void {
    this.allItems = PROVIDERS.flatMap((provider) => {
      const data = results[provider];
      return data
        ? [{
            name: PROVIDER_LABELS[provider],
            provider,
            data,
            isActive: this.activeProvider === provider,
          }]
        : [];
    });
    this.filteredItems = this.allItems;
    this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filteredItems.length - 1));
  }

  private filterItems(query: string): void {
    const normalized = query.trim().toLowerCase();
    this.filteredItems = normalized
      ? this.allItems.filter((item) =>
          item.name.toLowerCase().includes(normalized) || item.provider.includes(normalized))
      : this.allItems;
    this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filteredItems.length - 1));
  }

  private renderBar(percent: number, width = 16): string {
    const value = clampPercent(percent);
    const filled = Math.round((value / 100) * width);
    return this.theme.fg(colorForPercent(value), "█".repeat(filled)) +
      this.theme.fg("dim", "░".repeat(width - filled));
  }

  private renderItem(item: SubscriptionItem, selected: boolean): void {
    const theme = this.theme;
    const pointer = selected ? theme.fg("accent", "→ ") : "  ";
    const activeBadge = item.isActive ? theme.fg("success", " ✓") : "";
    const name = selected ? theme.fg("accent", theme.bold(item.name)) : item.name;
    this.listContainer.addChild(new Text(`${pointer}${name}${activeBadge}`, 0, 0));

    const indent = "    ";
    if (item.data.error) {
      this.listContainer.addChild(new Text(indent + theme.fg("error", item.data.error), 0, 0));
    } else {
      const session = clampPercent(item.data.session);
      const weekly = clampPercent(item.data.weekly);
      const sessionReset = item.data.sessionResetsIn
        ? theme.fg("dim", `  resets in ${item.data.sessionResetsIn}`)
        : "";
      const weeklyReset = item.data.weeklyResetsIn
        ? theme.fg("dim", `  resets in ${item.data.weeklyResetsIn}`)
        : "";
      const sessionLabel = (item.data.sessionLabel ?? "Session").slice(0, 9).padEnd(10);
      const weeklyLabel = (item.data.weeklyLabel ?? "Weekly").slice(0, 9).padEnd(10);

      if (!item.data.quotaHidden) {
        if (!item.data.sessionHidden) {
          this.listContainer.addChild(new Text(
            indent + theme.fg("muted", sessionLabel) + this.renderBar(session) + " " +
              theme.fg(colorForPercent(session), `${session}%`.padStart(4)) + sessionReset,
            0,
            0,
          ));
        }
        if (!item.data.weeklyHidden) {
          this.listContainer.addChild(new Text(
            indent + theme.fg("muted", weeklyLabel) + this.renderBar(weekly) + " " +
              theme.fg(colorForPercent(weekly), `${weekly}%`.padStart(4)) + weeklyReset,
            0,
            0,
          ));
        }
      }
      if (item.data.accountBalance) {
        this.listContainer.addChild(new Text(
          indent + theme.fg("muted", formatAccountBalance(item.data.accountBalance)),
          0,
          0,
        ));
      }
      for (const balance of item.data.accountBalanceDetails ?? []) {
        this.listContainer.addChild(new Text(
          indent + theme.fg("dim", formatAccountBalance(balance)),
          0,
          0,
        ));
      }
      if (item.data.accountSpend) {
        this.listContainer.addChild(new Text(
          indent + theme.fg("muted", formatAccountSpend(item.data.accountSpend)),
          0,
          0,
        ));
      }
      if (item.data.notice) {
        this.listContainer.addChild(new Text(indent + theme.fg("muted", item.data.notice), 0, 0));
      }

      if (typeof item.data.extraSpend === "number" && typeof item.data.extraLimit === "number") {
        this.listContainer.addChild(new Text(
          indent + theme.fg("muted", "Extra    ") +
            theme.fg("dim", `$${item.data.extraSpend.toFixed(2)} / $${item.data.extraLimit}`),
          0,
          0,
        ));
      }
      if (item.data.warning) {
        this.listContainer.addChild(new Text(indent + theme.fg("warning", `⚠ ${item.data.warning}`), 0, 0));
      }
    }
    this.listContainer.addChild(new Spacer(1));
  }

  private updateList(): void {
    this.listContainer.clear();
    if (this.loading) {
      this.listContainer.addChild(new Text(this.theme.fg("muted", "  Loading…"), 0, 0));
      return;
    }
    if (this.filteredItems.length === 0) {
      this.listContainer.addChild(new Text(this.theme.fg("muted", "  No matching configured providers"), 0, 0));
      return;
    }
    this.filteredItems.forEach((item, index) => this.renderItem(item, index === this.selectedIndex));
  }

  private refresh(): void {
    this.updateList();
    this.tui.requestRender();
  }

  handleInput(keyData: string): void {
    if (this.keybindings.matches(keyData, "tui.select.up")) {
      if (this.filteredItems.length > 0) {
        this.selectedIndex = this.selectedIndex === 0
          ? this.filteredItems.length - 1
          : this.selectedIndex - 1;
        this.refresh();
      }
      return;
    }
    if (this.keybindings.matches(keyData, "tui.select.down")) {
      if (this.filteredItems.length > 0) {
        this.selectedIndex = this.selectedIndex === this.filteredItems.length - 1
          ? 0
          : this.selectedIndex + 1;
        this.refresh();
      }
      return;
    }
    if (
      this.keybindings.matches(keyData, "tui.select.cancel") ||
      this.keybindings.matches(keyData, "tui.select.confirm")
    ) {
      this.onCancelCallback();
      return;
    }

    this.searchInput.handleInput(keyData);
    this.filterItems(this.searchInput.getValue());
    this.refresh();
  }

  override invalidate(): void {
    super.invalidate();
    this.updateHint();
    this.updateList();
  }

  dispose(): void {
    this.disposed = true;
    this.requestController.abort();
  }
}

interface UsageState extends UsageByProvider {
  activeProvider: ProviderKey | null;
  available: Partial<Record<ProviderKey, boolean>>;
}

export default function (pi: ExtensionAPI): void {
  const endpoints = resolveUsageEndpoints();
  const state: UsageState = {
    codex: null,
    claude: null,
    zai: null,
    "zai-cn": null,
    kimi: null,
    minimax: null,
    "minimax-cn": null,
    openrouter: null,
    deepseek: null,
    moonshot: null,
    "moonshot-cn": null,
    activeProvider: null,
    available: {},
  };

  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let pollInFlight: Promise<void> | undefined;
  let pollQueued = false;
  let currentContext: ExtensionContext | undefined;
  let sessionController: AbortController | undefined;

  const renderPercent = (theme: Theme, value: number) => {
    const percent = clampPercent(value);
    return theme.fg(colorForPercent(percent), `${percent}%`);
  };

  const renderBar = (theme: Theme, value: number) => {
    const percent = clampPercent(value);
    const width = 8;
    const filled = Math.round((percent / 100) * width);
    return theme.fg(colorForPercent(percent), "█".repeat(filled)) +
      theme.fg("dim", "░".repeat(width - filled));
  };

  function updateStatus(): void {
    const ctx = currentContext;
    if (!ctx || ctx.mode !== "tui") return;
    const provider = state.activeProvider;
    if (!provider || state.available[provider] === false) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
      return;
    }

    const data = state[provider];
    const theme = ctx.ui.theme;
    const label = PROVIDER_LABELS[provider];
    if (!data) {
      ctx.ui.setStatus(STATUS_KEY, theme.fg("dim", `${label} usage: loading…`));
      return;
    }
    if (data.error) {
      ctx.ui.setStatus(STATUS_KEY, theme.fg("warning", `${label} usage unavailable (${data.error})`));
      return;
    }
    if (data.quotaHidden) {
      const financial = [
        data.accountBalance ? formatAccountBalance(data.accountBalance) : undefined,
        data.accountSpend?.monthly === undefined
          ? undefined
          : `Month · ${formatFinancialAmount(data.accountSpend.monthly, data.accountSpend.unit)}`,
      ].filter((value): value is string => Boolean(value));
      const summary = financial.length > 0 ? financial.join(" · ") : data.notice;
      ctx.ui.setStatus(
        STATUS_KEY,
        summary ? theme.fg("dim", `${label} `) + theme.fg("muted", summary) : undefined,
      );
      return;
    }

    const session = clampPercent(data.session);
    const weekly = clampPercent(data.weekly);
    const sessionPrefix = data.sessionLabel === "5-hour"
      ? "5h "
      : data.sessionLabel === "Interval"
        ? "I "
        : data.sessionLabel === "Key limit"
          ? "L "
          : "S ";
    const quotaLanes: string[] = [];
    if (!data.sessionHidden) {
      quotaLanes.push(
        theme.fg("muted", sessionPrefix) + renderBar(theme, session) + " " + renderPercent(theme, session) +
          (data.sessionResetsIn ? theme.fg("dim", ` ⟳ ${data.sessionResetsIn}`) : ""),
      );
    }
    if (!data.weeklyHidden) {
      quotaLanes.push(
        theme.fg("muted", "W ") + renderBar(theme, weekly) + " " + renderPercent(theme, weekly) +
          (data.weeklyResetsIn ? theme.fg("dim", ` ⟳ ${data.weeklyResetsIn}`) : ""),
      );
    }
    const status =
      theme.fg("dim", `${label} `) +
      quotaLanes.join(" ") +
      (data.accountBalance ? theme.fg("muted", ` · ${formatAccountBalance(data.accountBalance)}`) : "") +
      (data.accountSpend?.monthly === undefined
        ? ""
        : theme.fg("muted", ` · Month ${formatFinancialAmount(data.accountSpend.monthly, data.accountSpend.unit)}`)) +
      (data.stale ? theme.fg("warning", " stale") : "") +
      (data.warning && !data.stale ? theme.fg("warning", " ⚠") : "");
    ctx.ui.setStatus(STATUS_KEY, status);
  }

  function updateProviderFrom(model: ExtensionContext["model"]): boolean {
    const previous = state.activeProvider;
    state.activeProvider = detectProvider(model);
    if (previous !== state.activeProvider) {
      updateStatus();
      return true;
    }
    return false;
  }

  async function resolveCredential(ctx: ExtensionContext, provider: ProviderKey): Promise<CredentialResolution> {
    const providerId = providerToPiProviderId(provider);
    if (!ctx.modelRegistry.getProvider(providerId)) return {};
    const status = ctx.modelRegistry.getProviderAuthStatus(providerId);
    if (!status.configured) return {};

    try {
      const resolved = await ctx.modelRegistry.getProviderAuth(providerId);
      if (provider === "claude" && resolved?.source !== "OAuth") return {};
      const token = resolved?.auth.apiKey;
      if (token) return { token };
      // Some OAuth flows (e.g. kimi-coding) expose the token only as a Bearer
      // Authorization header rather than as apiKey.
      const authorization = resolved?.auth.headers?.Authorization ?? resolved?.auth.headers?.authorization;
      if (typeof authorization === "string" && authorization.startsWith("Bearer ")) {
        return { token: authorization.slice("Bearer ".length) };
      }
      return { error: "configured authentication did not resolve a token" };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  async function fetchProvider(
    ctx: ExtensionContext,
    provider: ProviderKey,
    signal: AbortSignal,
  ): Promise<void> {
    const credential = await resolveCredential(ctx, provider);
    if (signal.aborted) return;
    state.available[provider] = Boolean(credential.token || credential.error);
    if (credential.error) {
      state[provider] = { session: 0, weekly: 0, error: `auth resolution failed (${credential.error})` };
      return;
    }
    if (!credential.token) {
      state[provider] = null;
      return;
    }

    if (provider === "codex") state.codex = await fetchCodexUsage(credential.token, { signal });
    if (provider === "claude") state.claude = await fetchClaudeUsageWithFallback(credential.token, { signal });
    if (provider === "zai") state.zai = await fetchZaiUsage(credential.token, "zai", { endpoints, signal });
    if (provider === "zai-cn") state["zai-cn"] = await fetchZaiUsage(credential.token, "zai-cn", { endpoints, signal });
    if (provider === "kimi") state.kimi = await fetchKimiUsage(credential.token, { endpoints, signal });
    if (provider === "minimax") {
      state.minimax = await fetchMiniMaxUsage(credential.token, "minimax", { endpoints, signal });
    }
    if (provider === "minimax-cn") {
      state["minimax-cn"] = await fetchMiniMaxUsage(credential.token, "minimax-cn", { endpoints, signal });
    }
    if (provider === "openrouter") {
      state.openrouter = await fetchOpenRouterUsage(credential.token, { endpoints, signal });
    }
    if (provider === "deepseek") {
      state.deepseek = await fetchDeepSeekBalance(credential.token, { endpoints, signal });
    }
    if (provider === "moonshot") {
      state.moonshot = await fetchMoonshotBalance(credential.token, "moonshot", { endpoints, signal });
    }
    if (provider === "moonshot-cn") {
      state["moonshot-cn"] = await fetchMoonshotBalance(credential.token, "moonshot-cn", { endpoints, signal });
    }
  }

  async function runPoll(): Promise<void> {
    const ctx = currentContext;
    const signal = sessionController?.signal;
    const provider = state.activeProvider;
    if (!ctx || !signal || signal.aborted || ctx.mode !== "tui" || !provider) {
      updateStatus();
      return;
    }

    await fetchProvider(ctx, provider, signal);
    if (signal.aborted) return;
    const data = state[provider];
    if (data && !data.error) pi.events.emit("usage:update", { provider, ...data });
    updateStatus();
  }

  async function poll(): Promise<void> {
    if (pollInFlight) {
      pollQueued = true;
      return pollInFlight;
    }
    do {
      pollQueued = false;
      pollInFlight = runPoll().catch(() => undefined).finally(() => {
        pollInFlight = undefined;
      });
      await pollInFlight;
    } while (pollQueued && !sessionController?.signal.aborted);
  }

  async function fetchAllForContext(ctx: ExtensionContext, signal: AbortSignal): Promise<UsageByProvider> {
    const resolutions = await Promise.all(PROVIDERS.map(async (provider) =>
      [provider, await resolveCredential(ctx, provider)] as const));
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");

    const tokens: UsageTokens = {};
    const authErrors: Partial<Record<ProviderKey, string>> = {};
    for (const [provider, resolution] of resolutions) {
      if (resolution.token) tokens[provider] = resolution.token;
      if (resolution.error) authErrors[provider] = resolution.error;
    }

    const results = await fetchAllUsages(tokens, { endpoints, signal });
    for (const provider of PROVIDERS) {
      const error = authErrors[provider];
      if (error) results[provider] = { session: 0, weekly: 0, error: `auth resolution failed (${error})` };
    }
    return results;
  }

  pi.on("session_start", (_event, ctx) => {
    currentContext = ctx;
    sessionController?.abort();
    sessionController = new AbortController();
    updateProviderFrom(ctx.model);

    if (pollTimer) clearInterval(pollTimer);
    pollTimer = undefined;
    if (ctx.mode !== "tui") return;

    updateStatus();
    void poll();
    pollTimer = setInterval(() => void poll(), POLL_INTERVAL_MS);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    sessionController?.abort();
    sessionController = undefined;
    pollQueued = false;
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = undefined;
    if (ctx.mode === "tui") ctx.ui.setStatus(STATUS_KEY, undefined);
    currentContext = undefined;
  });

  pi.on("turn_start", (_event, ctx) => {
    currentContext = ctx;
    if (updateProviderFrom(ctx.model)) void poll();
  });

  pi.on("model_select", (event, ctx) => {
    currentContext = ctx;
    updateProviderFrom(event.model);
    void poll();
  });

  pi.registerCommand("usage", {
    description: "Show quota, balance, and spend for configured providers",
    handler: async (_args, ctx) => {
      currentContext = ctx;
      updateProviderFrom(ctx.model);
      if (ctx.mode !== "tui") {
        if (ctx.hasUI) ctx.ui.notify("/usage is available in interactive mode", "warning");
        return;
      }

      await ctx.ui.custom<void>((tui, theme, keybindings, done) =>
        new UsageSelectorComponent(
          tui,
          theme,
          keybindings,
          state.activeProvider,
          (signal) => fetchAllForContext(ctx, signal),
          () => done(),
        ));
      void poll();
    },
  });
}
