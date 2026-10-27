/**
 * Parsing helpers for the z.ai quota/limit API.
 *
 * Extracted from the extension entry point so the response-shape logic can be
 * exercised with plain Node (no VS Code extension host required).
 */

/**
 * Represents a single usage limit entry returned by the z.ai quota API.
 *
 * The current API returns `CREDIT_LIMIT` entries with absolute credit numbers
 * and a 0-100 `percentage`. A legacy `TOKENS_LIMIT` shape (percentage as a
 * 0-1 fraction, no credit fields) is still accepted for backward compatibility.
 */
export interface ZaiLimit {
  /** The type identifier of the limit (e.g. `"CREDIT_LIMIT"`). */
  type: string;
  /** Window-unit identifier used by the current API (observed: `3` for N-hour windows, `6` for monthly windows). */
  unit?: number;
  /** Window length for the given unit (e.g. `5` for a 5-hour window, `1` for one month). */
  number?: number;
  /** Total credits granted within the window. */
  usage?: number;
  /** Credits already consumed within the window. */
  currentValue?: number;
  /** Credits still available within the window. */
  remaining?: number;
  /** Usage as a percentage. Current API: 0-100 integer; legacy API: 0-1 fraction. */
  percentage: number;
  /** Unix timestamp (ms) at which this limit will reset. */
  nextResetTime?: number;
}

/**
 * The top-level response shape returned by the z.ai quota/limit API endpoint.
 */
export interface ZaiApiResponse {
  /** Whether the API call succeeded. `false` indicates an application-level error. */
  success?: boolean;
  /** Application-level error code, present when `success` is `false`. */
  code?: number;
  /** Human-readable error message, present when `success` is `false`. */
  msg?: string;
  /** The payload containing the quota limits and the subscription plan level. */
  data?: {
    /** Array of per-window quota limit entries. */
    limits?: ZaiLimit[];
    /** The subscription plan level (e.g. `"pro"`). */
    level?: string;
  };
}

/**
 * A single quota window parsed from an API response, ready for display.
 */
export interface LimitUsage {
  /** Human-readable label for the window (e.g. `"5-hour credits"`). */
  label: string;
  /** Usage percentage 0-100, rounded to one decimal place. */
  percentage: number;
  /** Credits consumed within the window, or `null` when not reported. */
  used: number | null;
  /** Total credits granted for the window, or `null` when not reported. */
  total: number | null;
  /** Unix timestamp (ms) of the next reset, or `null` when not reported. */
  nextResetTime: number | null;
}

/**
 * Simplified usage statistics derived from a {@link ZaiApiResponse}.
 */
export interface UsageData {
  /** Usage percentage of the most-consumed limit (the binding constraint). */
  percentage: number;
  /** Reset timestamp of the most-consumed limit, or `null` if unknown. */
  nextResetTime: number | null;
  /** Subscription plan level from the API (e.g. `"pro"`), or `null` if absent. */
  plan: string | null;
  /** All parsed limit windows, used to build the status bar tooltip. */
  limits: LimitUsage[];
}

/**
 * Computes the usage percentage of a single limit entry as a 0-100 value.
 *
 * Prefers the precise `currentValue / usage` ratio when both fields are
 * present; otherwise falls back to the `percentage` field, normalizing the
 * legacy 0-1 fraction format to percent.
 *
 * @param limit - The raw {@link ZaiLimit} entry from the API.
 * @returns The usage percentage (0-100), or `null` when it cannot be derived.
 */
function limitPercentage(limit: ZaiLimit): number | null {
  if (
    typeof limit.usage === "number" &&
    limit.usage > 0 &&
    typeof limit.currentValue === "number"
  ) {
    return (limit.currentValue / limit.usage) * 100;
  }
  if (typeof limit.percentage === "number" && limit.percentage >= 0) {
    // Current API reports integers 0-100; the legacy API reported a 0-1 fraction.
    return limit.percentage <= 1 ? limit.percentage * 100 : limit.percentage;
  }
  return null;
}

/**
 * Builds a human-readable label for a limit entry based on its window unit.
 *
 * Known units are labeled semantically; unknown units fall back to the raw
 * type identifier plus the unit number so the tooltip stays informative
 * if the API introduces new window kinds.
 *
 * @param limit - The raw {@link ZaiLimit} entry from the API.
 * @returns A display label such as `"5-hour credits"` or `"monthly credits"`.
 */
function limitLabel(limit: ZaiLimit): string {
  if (limit.unit === 3) {
    return `${limit.number ?? "?"}-hour credits`;
  }
  if (limit.unit === 6) {
    return "monthly credits";
  }
  return limit.unit !== undefined
    ? `${limit.type} (unit ${limit.unit})`
    : limit.type;
}

/**
 * Extracts usage statistics from a raw API response.
 *
 * Parses every entry in `data.limits`, reads the plan level from `data.level`,
 * and selects the most-consumed limit as the binding constraint shown in the
 * status bar.
 *
 * @param data - The raw {@link ZaiApiResponse} returned by the z.ai quota API.
 * @returns A {@link UsageData} object, or `null` when no usable limit entries exist.
 */
export function extractUsageData(data: ZaiApiResponse): UsageData | null {
  const rawLimits = data.data?.limits;
  if (!Array.isArray(rawLimits) || rawLimits.length === 0) {
    return null;
  }

  const limits: LimitUsage[] = [];
  for (const raw of rawLimits) {
    const pct = limitPercentage(raw);
    if (pct === null) {
      continue;
    }
    limits.push({
      label: limitLabel(raw),
      percentage: Math.round(pct * 10) / 10,
      used: typeof raw.currentValue === "number" ? raw.currentValue : null,
      total: typeof raw.usage === "number" ? raw.usage : null,
      nextResetTime:
        typeof raw.nextResetTime === "number" ? raw.nextResetTime : null,
    });
  }

  if (limits.length === 0) {
    return null;
  }

  // The status bar shows the most-consumed window — the constraint that
  // exhaustion will hit first.
  const binding = limits.reduce((a, b) =>
    b.percentage > a.percentage ? b : a,
  );

  return {
    percentage: binding.percentage,
    nextResetTime: binding.nextResetTime,
    plan: data.data?.level ?? null,
    limits,
  };
}

/**
 * Formats the time remaining until a quota reset into a short human-readable
 * string such as `"(2h30m)"` or `"(45m)"`.
 *
 * Returns an empty string when `nextResetTime` is falsy, non-positive, or
 * already in the past.
 *
 * @param nextResetTime - The Unix timestamp (in milliseconds) of the next reset,
 *   or `null` if unknown.
 * @returns A formatted countdown string like `"(1h5m)"`, or `""` if not applicable.
 */
export function formatResetTime(nextResetTime: number | null): string {
  if (!nextResetTime || nextResetTime <= 0) {
    return "";
  }
  const diffMs = nextResetTime - Date.now();
  if (diffMs <= 0) {
    return "";
  }
  const diffSec = Math.floor(diffMs / 1000);
  const diffHours = Math.floor(diffSec / 3600);
  const diffMins = Math.floor((diffSec % 3600) / 60);
  const parts: string[] = [];
  if (diffHours > 0) parts.push(`${diffHours}h`);
  parts.push(`${diffMins}m`);
  return `(${parts.join("")})`;
}
