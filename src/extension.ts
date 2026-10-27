import * as vscode from "vscode";
import {
  extractUsageData,
  formatResetTime,
  type UsageData,
  type ZaiApiResponse,
} from "./usage";

/**
 * The structure persisted to `globalState` for caching API responses.
 */
interface CacheData {
  /** Schema version used to invalidate stale cache entries across extension updates. */
  version: string;
  /** Unix timestamp (ms) at which the cache entry was written. */
  timestamp: number;
  /** The raw API response that was cached. */
  data: ZaiApiResponse;
}

/** Schema version embedded in every cache entry; increment to bust old caches. */
const CACHE_VERSION = "1.1";
/** Key used to store the cache object in `vscode.ExtensionContext.globalState`. */
const CACHE_KEY = "zaiUsage.cache";
/** Key used to store the API key in `vscode.ExtensionContext.secrets`. */
const API_KEY_SECRET = "zaiUsage.apiKey";
/** The z.ai quota/limit API endpoint. */
const API_URL = "https://api.z.ai/api/monitor/usage/quota/limit";

/**
 * Activates the extension.
 * @param context - The extension context provided by VSCode.
 */
export function activate(context: vscode.ExtensionContext): void {
  const priority = vscode.workspace
    .getConfiguration("zaiUsage")
    .get<number>("statusBarPriority", 10000);

  const statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    priority,
  );
  statusBarItem.text = getLabel("...");
  statusBarItem.show();

  let intervalId: ReturnType<typeof setInterval> | undefined;

  /**
   * Returns the polling interval in milliseconds from the workspace configuration.
   * The value is clamped to a minimum of 10 seconds to prevent API flooding.
   *
   * @returns The refresh interval in milliseconds (minimum 10,000 ms).
   */
  function getRefreshInterval(): number {
    const seconds = vscode.workspace
      .getConfiguration("zaiUsage")
      .get<number>("refreshInterval", 60);
    // Clamp to a minimum of 10 seconds to prevent API flooding from invalid config values.
    return Math.max(seconds, 10) * 1000;
  }

  /**
   * Builds the status bar label by prepending the configured prefix to a given suffix.
   * Uses a custom icon when the `useIcon` setting is enabled, otherwise falls back to "z.ai:".
   *
   * @param suffix - The text to append after the prefix (e.g. "75.3% (2h30m)").
   * @returns The fully composed status bar label string.
   */
  function getLabel(suffix: string): string {
    const useIcon = vscode.workspace
      .getConfiguration("zaiUsage")
      .get<boolean>("useIcon", true);
    const prefix = useIcon ? "$(zai-icon)" : "z.ai:";
    return `${prefix} ${suffix}`;
  }

  /**
   * Retrieves the cached API response from the extension's global state.
   * Returns `null` when no cache exists or when the stored cache version does not
   * match the current {@link CACHE_VERSION}.
   *
   * @returns The cached {@link CacheData} object, or `null` if absent or stale.
   */
  function getCache(): CacheData | null {
    const cache = context.globalState.get<CacheData>(CACHE_KEY);
    if (!cache || cache.version !== CACHE_VERSION) {
      return null;
    }
    return cache;
  }

  /**
   * Persists the given API response to the extension's global state as a versioned cache entry.
   * The entry records the current timestamp so that {@link isCacheValid} can later evaluate
   * whether the data is still fresh.
   *
   * @param data - The raw {@link ZaiApiResponse} to store in the cache.
   * @returns `void`
   */
  function setCache(data: ZaiApiResponse): void {
    context.globalState.update(CACHE_KEY, {
      version: CACHE_VERSION,
      timestamp: Date.now(),
      data,
    } satisfies CacheData);
  }

  /**
   * Determines whether a cached API response is still valid and can be used
   * without issuing a new network request.
   *
   * A cache is considered invalid when any of the following conditions are met:
   * - The cache object is `null`.
   * - The elapsed time since caching exceeds the configured refresh interval.
   * - The `nextResetTime` stored in the cache is in the past, meaning a usage
   *   reset has already occurred and fresh data is required.
   *
   * @param cache - The {@link CacheData} to validate, or `null`.
   * @returns `true` if the cache is fresh and can be used; `false` otherwise.
   */
  function isCacheValid(cache: CacheData | null): boolean {
    if (!cache) {
      return false;
    }
    if (Date.now() - cache.timestamp >= getRefreshInterval()) {
      return false;
    }
    // If nextResetTime stored in the cache is in the past, invalidate and fetch fresh data.
    const usage = extractUsageData(cache.data);
    if (usage?.nextResetTime && usage.nextResetTime <= Date.now()) {
      return false;
    }
    return true;
  }

  /**
   * Calls the z.ai quota API with the provided API key and returns the parsed response.
   *
   * Returns `null` on any of the following failure conditions:
   * - A non-2xx HTTP status code is received.
   * - The HTTP 200 response payload contains `success: false` (the API may return
   *   authentication errors with a 200 status, so the payload must be inspected).
   * - A network or parsing error is thrown.
   *
   * @param apiKey - The Bearer token used to authenticate the API request.
   * @returns A promise that resolves to the {@link ZaiApiResponse}, or `null` on failure.
   */
  async function fetchFromApi(apiKey: string): Promise<ZaiApiResponse | null> {
    try {
      const response = await fetch(API_URL, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });

      if (!response.ok) {
        console.error(
          "[z.ai Usage] API HTTP error:",
          response.status,
          await response.text(),
        );
        return null;
      }

      const data: ZaiApiResponse = await response.json();

      // The API may return an authentication error within a 200 response — always inspect the payload.
      if (data.success === false) {
        console.error("[z.ai Usage] API error response:", data.code, data.msg);
        return null;
      }

      return data;
    } catch (error) {
      console.error("[z.ai Usage] Error:", error);
      return null;
    }
  }

  /**
   * Orchestrates the full usage-data retrieval flow: secret lookup → cache check →
   * optional API call → stale-cache fallback.
   *
   * Resolution order:
   * 1. If no API key is stored, returns `noApiKey: true` immediately.
   * 2. If a valid cache entry exists, returns the cached data without an API call.
   * 3. Calls the API; on success, writes the response to the cache and returns it.
   * 4. On API failure, falls back to the expired cache if one is available.
   * 5. Returns `usage: null` when all sources are unavailable.
   *
   * @returns A promise resolving to an object with:
   *   - `usage` — The parsed {@link UsageData}, or `null` when unavailable.
   *   - `apiCalled` — `true` when a live API request was made successfully.
   *   - `noApiKey` — `true` when no API key is stored in the secret store.
   */
  async function fetchUsage(): Promise<{
    usage: UsageData | null;
    apiCalled: boolean;
    noApiKey: boolean;
  }> {
    const apiKey = await context.secrets.get(API_KEY_SECRET);
    if (!apiKey) {
      return { usage: null, apiCalled: false, noApiKey: true };
    }

    const cache = getCache();

    if (cache && isCacheValid(cache)) {
      return {
        usage: extractUsageData(cache.data),
        apiCalled: false,
        noApiKey: false,
      };
    }

    const apiData = await fetchFromApi(apiKey);

    if (apiData) {
      setCache(apiData);
      return {
        usage: extractUsageData(apiData),
        apiCalled: true,
        noApiKey: false,
      };
    }

    // Fall back to the expired cache when the API call fails.
    if (cache) {
      return {
        usage: extractUsageData(cache.data),
        apiCalled: false,
        noApiKey: false,
      };
    }

    return { usage: null, apiCalled: false, noApiKey: false };
  }

  /**
   * Starts (or restarts) the polling interval that periodically calls
   * {@link updateStatusBar}.
   *
   * If a previous interval is already running it is cleared before a new one
   * is created, ensuring that configuration changes (e.g. `refreshInterval`)
   * take effect immediately without spawning duplicate timers.
   *
   * @returns `void`
   */
  function startInterval(): void {
    if (intervalId !== undefined) {
      clearInterval(intervalId);
    }
    intervalId = setInterval(updateStatusBar, getRefreshInterval());
  }

  /**
   * Clears any highlight applied to the status bar item, restoring its default
   * appearance.
   *
   * @returns `void`
   */
  function clearStatusBarColor(): void {
    statusBarItem.backgroundColor = undefined;
    statusBarItem.color = undefined;
  }

  /**
   * Configures the status bar item to reflect the "no API key" state.
   *
   * Sets the item's label to "Set API Key" and attaches the `zaiUsage.setApiKey`
   * command so that clicking the item opens the API key input prompt.
   *
   * @returns `void`
   */
  function applyNoApiKeyState(): void {
    clearStatusBarColor();
    statusBarItem.command = "zaiUsage.setApiKey";
    statusBarItem.text = getLabel("Set API Key");
    statusBarItem.tooltip = "Click to set your z.ai API key";
  }

  /**
   * Fetches the latest usage data and updates the status bar item accordingly.
   *
   * Possible outcomes:
   * - **No API key**: delegates to {@link applyNoApiKeyState} to prompt the user.
   * - **Fetch failure**: displays a dash and an error tooltip.
   * - **Success**: renders every quota window with its compact label, percentage
   *   and reset countdown (e.g. `5h 5% (2h30m) · mo 21% (6d 3h)`); the tooltip
   *   shows the plan level reported by the API along with full details.
   * - **Exhausted**: when any window is fully consumed, the item is highlighted
   *   with the warning color and shows that window's remaining time until reset.
   *
   * After a successful live API call ({@link fetchUsage} returns `apiCalled: true`),
   * the polling interval is restarted via {@link startInterval} so that the next
   * refresh is scheduled relative to the moment fresh data was obtained.
   *
   * @returns A promise that resolves once the status bar has been updated.
   */
  async function updateStatusBar(): Promise<void> {
    const { usage, apiCalled, noApiKey } = await fetchUsage();

    if (noApiKey) {
      applyNoApiKeyState();
    } else if (usage === null) {
      statusBarItem.command = "zaiUsage.updateStatusBar";
      clearStatusBarColor();
      statusBarItem.text = getLabel("-");
      statusBarItem.tooltip =
        "Unable to fetch z.ai usage data (click to refresh)";
    } else {
      statusBarItem.command = "zaiUsage.updateStatusBar";
      const refreshSec = getRefreshInterval() / 1000;

      // Get display mode setting (default: "usage")
      const displayMode = vscode.workspace
        .getConfiguration("zaiUsage")
        .get<string>("displayMode", "usage");
      const isRemaining = displayMode === "remaining";

      // Render every quota window, e.g. "5h 5% (2h30m) · mo 21% (6d 3h)".
      // Each window gets its compact label, percentage (per the display mode,
      // clamped to 0-100) and its own reset countdown. When the API reports a
      // single window the label is omitted.
      const parts = usage.limits.map((limit) => {
        const pct = Math.min(Math.round(limit.percentage * 10) / 10, 100);
        const displayPct = isRemaining
          ? Math.round((100 - pct) * 10) / 10
          : pct;
        const reset = formatResetTime(limit.nextResetTime);
        const value = `${displayPct}%${reset ? ` ${reset}` : ""}`;
        return usage.limits.length > 1 ? `${limit.shortLabel} ${value}` : value;
      });
      statusBarItem.text = getLabel(parts.join(" · "));

      // When any quota window is exhausted, highlight the item with the
      // standard warning color (light yellow); the exhausted window's reset
      // countdown is shown inline next to its percentage.
      if (usage.exhausted) {
        statusBarItem.backgroundColor = new vscode.ThemeColor(
          "statusBarItem.warningBackground",
        );
        statusBarItem.color = new vscode.ThemeColor(
          "statusBarItem.warningForeground",
        );
      } else {
        clearStatusBarColor();
      }

      // Build the tooltip: the plan level reported by the API plus every
      // quota window with its percentage, credits and reset countdown.
      const tooltip = new vscode.MarkdownString();
      tooltip.appendMarkdown(
        `**z.ai usage**${usage.plan ? ` — plan: **${usage.plan}**` : ""}${usage.exhausted ? " — **limit exhausted**" : ""}`,
      );
      for (const limit of usage.limits) {
        const credits =
          limit.used !== null && limit.total !== null
            ? ` (${limit.used.toLocaleString("en-US")}/${limit.total.toLocaleString("en-US")} credits)`
            : "";
        const reset = formatResetTime(limit.nextResetTime);
        const resetSuffix = reset
          ? ` — resets in ${reset.replace(/[()]/g, "")}`
          : "";
        tooltip.appendMarkdown(
          `\n\n- ${limit.label}: **${limit.percentage}%**${credits}${resetSuffix}`,
        );
      }
      tooltip.appendMarkdown(
        `\n\n(auto-refreshes every ${refreshSec}s. click to refresh immediately)`,
      );
      statusBarItem.tooltip = tooltip;
    }

    if (apiCalled) {
      startInterval();
    }
  }

  /**
   * Handles the `zaiUsage.setApiKey` command.
   *
   * Prompts the user for a Bearer token, verifies it against the z.ai API,
   * and — on success — persists it to the secret store and refreshes the status bar.
   * On verification failure the stored key and cache are both cleared.
   */
  const setApiKeyCmd = vscode.commands.registerCommand(
    "zaiUsage.setApiKey",
    async () => {
      const apiKey = await vscode.window.showInputBox({
        prompt: "Enter your z.ai API key",
        placeHolder: "Bearer token...",
        password: true,
        ignoreFocusOut: true,
      });

      if (!apiKey) {
        return;
      }

      statusBarItem.text = getLabel("$(loading~spin) Verifying...");
      const result = await fetchFromApi(apiKey);

      if (result === null) {
        await context.secrets.delete(API_KEY_SECRET);
        await context.globalState.update(CACHE_KEY, undefined);
        vscode.window.showErrorMessage(
          "z.ai Usage: Failed to verify API key. Please check the key and try again.",
        );
        await updateStatusBar();
        return;
      }

      await context.secrets.store(API_KEY_SECRET, apiKey);
      setCache(result);
      vscode.window.showInformationMessage(
        "z.ai Usage: API key saved successfully.",
      );
      await updateStatusBar();
      startInterval();
    },
  );

  /**
   * Handles the `zaiUsage.clearApiKey` command.
   *
   * Removes the stored API key from the secret store, clears the usage cache,
   * and transitions the status bar to the "no API key" state.
   */
  const clearApiKeyCmd = vscode.commands.registerCommand(
    "zaiUsage.clearApiKey",
    async () => {
      await context.secrets.delete(API_KEY_SECRET);
      await context.globalState.update(CACHE_KEY, undefined);
      applyNoApiKeyState();
      vscode.window.showInformationMessage("z.ai Usage: API key cleared.");
    },
  );

  /**
   * Handles the `zaiUsage.updateStatusBar` command.
   *
   * Manually refreshes the status bar by calling {@link updateStatusBar}.
   * This command can be bound to the status bar item or triggered via command palette.
   *
   * Shows a loading indicator for at least 400ms to prevent flickering.
   */
  const updateStatusBarCmd = vscode.commands.registerCommand(
    "zaiUsage.updateStatusBar",
    async () => {
      statusBarItem.text = "$(loading~spin) Refreshing...";
      // Wait at least 400ms to prevent flickering
      await new Promise((resolve) => setTimeout(resolve, 400));
      await updateStatusBar();
    },
  );

  updateStatusBar();
  startInterval();

  context.subscriptions.push(
    statusBarItem,
    setApiKeyCmd,
    clearApiKeyCmd,
    updateStatusBarCmd,
    /**
     * Listens for workspace configuration changes and re-applies them immediately.
     *
     * When `zaiUsage.refreshInterval`, `zaiUsage.useIcon`, or `zaiUsage.displayMode` changes,
     * the status bar is refreshed and the polling interval is restarted so the new settings take
     * effect without requiring a window reload.
     *
     * When `zaiUsage.statusBarPriority` changes, the user is notified that a window
     * reload is required for the new priority to take effect, because the priority is
     * set at status bar item creation time and cannot be changed at runtime.
     */
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration("zaiUsage.refreshInterval") ||
        e.affectsConfiguration("zaiUsage.useIcon") ||
        e.affectsConfiguration("zaiUsage.displayMode")
      ) {
        updateStatusBar();
        startInterval();
      }
      if (e.affectsConfiguration("zaiUsage.statusBarPriority")) {
        void (async () => {
          const selection = await vscode.window.showInformationMessage(
            "z.ai Usage: Status bar priority changed. Reload the window to apply.",
            "Reload Window",
          );
          if (selection === "Reload Window") {
            await vscode.commands.executeCommand(
              "workbench.action.reloadWindow",
            );
          }
        })();
      }
    }),
    {
      dispose: () => {
        if (intervalId !== undefined) clearInterval(intervalId);
      },
    },
  );
}

/**
 * Deactivates the extension.
 * Called when VSCode is shutting down or the extension is disabled.
 */
export function deactivate(): void {}
