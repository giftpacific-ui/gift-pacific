/**
 * Schedule dates entered in admin forms. `<input type="date">` yields
 * "YYYY-MM-DD"; treating that as UTC midnight made an END date finish at the
 * START of that day (and shifted starts by the store's UTC+6 offset). Here a
 * date-only START means 00:00 and a date-only END means 23:59:59.999 in
 * Bangladesh time (UTC+6, no DST), so "ends Dec 25" really includes Dec 25.
 */
const DHAKA_OFFSET_MS = 6 * 60 * 60 * 1000;

export type ScheduleParse = { ok: true; value: Date | null } | { ok: false };

export function parseScheduleDate(raw: string | null | undefined, edge: "start" | "end"): ScheduleParse {
  const text = raw?.trim();
  if (!text) return { ok: true, value: null };

  const dateOnly = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnly) {
    const [y, m, d] = [Number(dateOnly[1]), Number(dateOnly[2]), Number(dateOnly[3])];
    const check = new Date(Date.UTC(y, m - 1, d));
    if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) return { ok: false };
    const dayStartUtc = Date.UTC(y, m - 1, d) - DHAKA_OFFSET_MS;
    return { ok: true, value: new Date(edge === "start" ? dayStartUtc : dayStartUtc + 24 * 60 * 60 * 1000 - 1) };
  }
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? { ok: false } : { ok: true, value: parsed };
}

/** Parses an optional start/end pair; returns an error message or the dates. */
export function parseScheduleWindow(
  startsAt: string | null | undefined,
  endsAt: string | null | undefined,
): { ok: true; startsAt: Date | null; endsAt: Date | null } | { ok: false; message: string } {
  const start = parseScheduleDate(startsAt, "start");
  const end = parseScheduleDate(endsAt, "end");
  if (!start.ok || !end.ok) return { ok: false, message: "Enter valid start/end dates." };
  if (start.value && end.value && start.value.getTime() >= end.value.getTime()) {
    return { ok: false, message: "The start date must be before the end date." };
  }
  return { ok: true, startsAt: start.value, endsAt: end.value };
}

export function isWithinWindow(now: Date, startsAt: Date | null, endsAt: Date | null): boolean {
  return (!startsAt || startsAt.getTime() <= now.getTime()) && (!endsAt || endsAt.getTime() >= now.getTime());
}
