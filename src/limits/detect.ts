import type { ResetInfo } from "./types";
import { spawnSync } from "node:child_process";

/**
 * Usage-limit detection from a settled error, decoupled from Pi types so it is
 * unit-testable with synthetic inputs. Reads the last assistant error message
 * plus the most recent cached 429 response, and classifies per provider family.
 *
 * `detectUsageLimit` returns `null` when the error is not a usage limit. When it
 * IS a usage limit but no reset time could be parsed, it returns `{ reset: null }`
 * so the caller can notify the user instead of silently doing nothing.
 */

export type ProviderFamily = "codex" | "anthropic" | "gemini";

export interface Cached429 {
  status: number;
  headers: Record<string, string>;
  /** epoch ms when the 429 was captured. */
  at: number;
}

export interface DetectInput {
  provider: string;
  stopReason?: string;
  errorMessage?: string;
  cached429?: Cached429 | null;
  now: number;
}

export interface UsageLimit {
  provider: ProviderFamily;
  reset: ResetInfo | null;
}

/** How long a cached 429 stays relevant to a settled error. */
const CACHED_429_MAX_AGE_MS = 10 * 60 * 1000;

export function providerFamily(provider: string): ProviderFamily | null {
  if (provider === "openai-codex" || provider === "openai") return "codex";
  if (provider === "anthropic") return "anthropic";
  if (provider === "google" || provider === "google-gemini-cli") return "gemini";
  return null;
}

export function detectUsageLimit(input: DetectInput): UsageLimit | null {
  if (input.stopReason !== "error" || !input.errorMessage) return null;
  const family = providerFamily(input.provider);
  if (!family) return null;

  const message = input.errorMessage;
  const status = freshStatus(input);

  switch (family) {
    case "codex":
      return detectCodex(message, status, input.now);
    case "anthropic":
      return detectAnthropic(message, status, input);
    case "gemini":
      return detectGemini(message, status, input.now);
  }
}

function freshStatus(input: DetectInput): number | undefined {
  const cached = input.cached429;
  if (!cached) return undefined;
  return input.now - cached.at <= CACHED_429_MAX_AGE_MS ? cached.status : undefined;
}

function freshHeaders(input: DetectInput): Record<string, string> | null {
  const cached = input.cached429;
  if (!cached) return null;
  if (input.now - cached.at > CACHED_429_MAX_AGE_MS) return null;
  const lower: Record<string, string> = {};
  for (const [key, value] of Object.entries(cached.headers)) {
    lower[key.toLowerCase()] = value;
  }
  return lower;
}

// --- Codex -----------------------------------------------------------------

function detectCodex(message: string, status: number | undefined, now: number): UsageLimit | null {
  const isLimit =
    /hit your ChatGPT usage limit/i.test(message) ||
    /The ChatGPT user has reached their Subscription Sharing usage limit/i.test(message) ||
    /(usage_limit_reached|usage_not_included|rate_limit_exceeded)/i.test(message) ||
    status === 429;
  if (!isLimit) return null;

  const minutes = message.match(/~\s*(\d+)\s*min/i);
  if (minutes) {
    return {
      provider: "codex",
      reset: { at: new Date(now + Number(minutes[1]) * 60_000), source: "body" },
    };
  }

  if (/The ChatGPT user has reached their Subscription Sharing usage limit/i.test(message)) {
    // Fallback: ask Codex CLI for the reset time
    try {
      const result = spawnSync(
        "codex",
        ["exec", "foo", "--skip-git-repo-check"],
        { encoding: "utf8", timeout: 15_000 },
      );

      // ERROR: You’ve hit your usage limit. Upgrade ... or try again at 1:55 PM.
      // Or: try again at Oct 27th, 2026 6:57 AM
      const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
      const match = output.match(
        /try again at\s+(?:(\w+)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\s+)?(\d{1,2}):(\d{2})\s*(AM|PM)/i,
      );

      if (match) {
        const [, month, day, year, hh, mm, period] = match;

        const hour =
          (Number(hh) % 12) +
          (period.toUpperCase() === "PM" ? 12 : 0);

        let resetAt: Date;

        if (month && day && year) {
          const months = [
            "jan", "feb", "mar", "apr", "may", "jun",
            "jul", "aug", "sep", "oct", "nov", "dec",
          ];

          const monthIndex = months.indexOf(
            month.slice(0, 3).toLowerCase(),
          );

          if (monthIndex === -1) {
            throw new Error(`Invalid month: ${month}`);
          }

          resetAt = new Date(
            Number(year),
            monthIndex,
            Number(day),
            hour,
            Number(mm),
          );
        } else {
          resetAt = new Date(now);
          resetAt.setHours(hour, Number(mm), 0, 0);

          if (resetAt.getTime() <= now) {
            resetAt.setDate(resetAt.getDate() + 1);
          }
        }

        return {
          provider: "codex",
          reset: { at: resetAt, source: "body" },
        };
      }
    } catch {
      // Fallback when command execution fails
    }
  }

  return { provider: "codex", reset: null };
}

// --- Anthropic -------------------------------------------------------------

function detectAnthropic(
  message: string,
  status: number | undefined,
  input: DetectInput,
): UsageLimit | null {
  const isLimit =
    status === 429 ||
    /rate.?limit|rate_limit_error|usage limit|\b429\b/i.test(message);
  if (!isLimit) return null;

  const headers = freshHeaders(input);
  if (headers) {
    for (const key of [
      "anthropic-ratelimit-unified-5h-reset",
      "anthropic-ratelimit-unified-reset",
    ]) {
      const raw = headers[key];
      const ms = raw !== undefined ? parseEpochOrIso(raw) : null;
      if (ms !== null) {
        return {
          provider: "anthropic",
          reset: { at: new Date(ms), source: "header", window: "five_hour" },
        };
      }
    }
    const retryAfter = headers["retry-after"];
    const seconds = retryAfter !== undefined ? Number(retryAfter) : NaN;
    if (Number.isFinite(seconds)) {
      return {
        provider: "anthropic",
        reset: { at: new Date(input.now + Math.round(seconds * 1000)), source: "header" },
      };
    }
  }
  return { provider: "anthropic", reset: null };
}

/** Tolerant parse: numeric = epoch seconds (or ms if large); else ISO 8601. */
function parseEpochOrIso(raw: string): number | null {
  const trimmed = raw.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const n = Number(trimmed);
    return n < 1e12 ? n * 1000 : n;
  }
  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? null : parsed;
}

// --- Gemini ----------------------------------------------------------------

function detectGemini(message: string, status: number | undefined, now: number): UsageLimit | null {
  const isLimit =
    /RESOURCE_EXHAUSTED/.test(message) || /quota/i.test(message) || status === 429;
  if (!isLimit) return null;

  const timestamp = message.match(/"quotaResetTimeStamp"\s*:\s*"([^"]+)"/);
  if (timestamp) {
    const ms = Date.parse(timestamp[1]);
    if (!Number.isNaN(ms)) {
      return { provider: "gemini", reset: { at: new Date(ms), source: "body" } };
    }
  }

  const geminiBody = (seconds: number): UsageLimit => ({
    provider: "gemini",
    reset: { at: new Date(now + Math.round(seconds * 1000)), source: "body" },
  });

  // RetryInfo.retryDelay and "reset after" carry unit-suffixed compounds
  // (e.g. "600s", "0.53s", "14h24m54s"). The reset-after value is bounded by the
  // sentence, so its capture must NOT include "." or it grabs the trailing period.
  const retryDelay = message.match(/"retryDelay"\s*:\s*"([0-9.hms]+)"/);
  if (retryDelay) {
    const seconds = compoundSeconds(retryDelay[1]);
    if (seconds !== null) return geminiBody(seconds);
  }
  const resetAfter = message.match(/reset after\s+([0-9hms]+)/i);
  if (resetAfter) {
    const seconds = compoundSeconds(resetAfter[1]);
    if (seconds !== null) return geminiBody(seconds);
  }
  // "retry in Ns" carries a bare (possibly fractional) seconds value, no unit compound.
  const retryIn = message.match(/retry in\s+([0-9.]+)\s*s/i);
  if (retryIn) {
    const seconds = Number(retryIn[1]);
    if (Number.isFinite(seconds)) return geminiBody(seconds);
  }
  return { provider: "gemini", reset: null };
}

/** Sum an `h/m/s` compound (allows zero and fractional seconds), e.g. `14h24m54s`, `600s`, `34.07s`. */
function compoundSeconds(text: string): number | null {
  const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?$/.exec(text.trim());
  if (!match || (match[1] === undefined && match[2] === undefined && match[3] === undefined)) {
    return null;
  }
  return Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0);
}
