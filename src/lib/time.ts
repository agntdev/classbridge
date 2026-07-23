/**
 * Timezone-aware session time helpers. Session start_time is stored as ISO-8601
 * UTC; display converts into the viewer's timezone.
 */

import { now } from "./clock.js";

export const COMMON_TIMEZONES = [
  "UTC",
  "America/New_York",
  "America/Chicago",
  "America/Los_Angeles",
  "Europe/London",
  "Europe/Berlin",
  "Asia/Tokyo",
  "Asia/Singapore",
  "Australia/Sydney",
] as const;

export type CommonTimezone = (typeof COMMON_TIMEZONES)[number];

/** True if the IANA timezone id is usable by Intl. */
export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

/**
 * Format an absolute instant for a viewer timezone.
 * Falls back to UTC with a clear note when the timezone is invalid.
 */
export function formatInTimezone(isoOrMs: string | number, timezone: string): string {
  const date = typeof isoOrMs === "number" ? new Date(isoOrMs) : new Date(isoOrMs);
  if (Number.isNaN(date.getTime())) return "invalid time";

  const tz = isValidTimezone(timezone) ? timezone : "UTC";
  const note = tz === timezone ? "" : " (UTC — your timezone couldn't be applied)";

  try {
    const formatted = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    }).format(date);
    return formatted + note;
  } catch {
    return date.toISOString() + " (UTC)";
  }
}

/**
 * Parse a user-entered session time. Accepts:
 *  - ISO-8601 (`2026-07-24T15:00:00Z`, `2026-07-24T15:00:00+02:00`)
 *  - `YYYY-MM-DD HH:mm` interpreted in `timezone`
 * Returns ISO UTC string, or null if unparseable / in the past.
 */
export function parseSessionTime(
  input: string,
  timezone: string,
  opts?: { allowPast?: boolean },
): string | null {
  const raw = input.trim();
  if (!raw) return null;

  // ISO with explicit offset or Z
  if (/^\d{4}-\d{2}-\d{2}T/.test(raw) || /Z$/i.test(raw) || /[+-]\d{2}:\d{2}$/.test(raw)) {
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) return null;
    if (!opts?.allowPast && d.getTime() <= now().getTime()) return null;
    return d.toISOString();
  }

  // YYYY-MM-DD HH:mm or YYYY-MM-DDTHH:mm (local in teacher timezone)
  const m = raw.match(
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/,
  );
  if (!m) return null;

  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = Number(m[6] ?? "0");

  const tz = isValidTimezone(timezone) ? timezone : "UTC";
  const utcMs = zonedLocalToUtc(year, month, day, hour, minute, second, tz);
  if (utcMs === null) return null;
  if (!opts?.allowPast && utcMs <= now().getTime()) return null;
  return new Date(utcMs).toISOString();
}

/**
 * Convert a wall-clock local time in `timeZone` to UTC epoch ms.
 * Iteratively corrects for the zone offset (handles DST).
 */
function zonedLocalToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  timeZone: string,
): number | null {
  let guess = Date.UTC(year, month - 1, day, hour, minute, second);
  if (Number.isNaN(guess)) return null;

  for (let i = 0; i < 5; i++) {
    const parts = getTzParts(guess, timeZone);
    if (!parts) return null;
    const asUtc = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
    );
    const targetAsUtc = Date.UTC(year, month - 1, day, hour, minute, second);
    const next = guess - (asUtc - targetAsUtc);
    if (Math.abs(next - guess) < 500) {
      guess = next;
      break;
    }
    guess = next;
  }

  const v = getTzParts(guess, timeZone);
  if (
    !v ||
    v.year !== year ||
    v.month !== month ||
    v.day !== day ||
    v.hour !== hour ||
    v.minute !== minute
  ) {
    // Still accept the best guess for rare DST gaps; caller validates NaN
    if (!v) return null;
  }
  return guess;
}

function getTzParts(
  utcMs: number,
  timeZone: string,
): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
} | null {
  try {
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    const parts = dtf.formatToParts(new Date(utcMs));
    const get = (type: string) =>
      Number(parts.find((p) => p.type === type)?.value ?? NaN);
    return {
      year: get("year"),
      month: get("month"),
      day: get("day"),
      hour: get("hour"),
      minute: get("minute"),
      second: get("second"),
    };
  } catch {
    return null;
  }
}

/** Milliseconds until start; negative if already started. */
export function msUntil(iso: string): number {
  return new Date(iso).getTime() - now().getTime();
}

export function formatPrice(amount: number, currency = "USD"): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
    }).format(amount);
  } catch {
    return `$${amount.toFixed(2)}`;
  }
}
