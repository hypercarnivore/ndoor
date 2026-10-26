/**
 * Calendar math in a named IANA time zone.
 *
 * The graph stores instants (UTC). Anything shown to a person, such as the
 * day a post was made or the week a chart bar covers, has to follow that
 * person's calendar, or an evening post lands in tomorrow's bar. The UI sends
 * its browser time zone with every request; these helpers bucket by it.
 */

export const UTC = 'UTC';

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(zone: string): Intl.DateTimeFormat {
  let format = formatters.get(zone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      weekday: 'short',
    });
    formatters.set(zone, format);
  }
  return format;
}

/** The machine's own zone, which is the viewer's zone when nothing else is said. */
export function systemTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || UTC;
}

/** A valid IANA zone name from untrusted input, or the machine's own zone. */
export function resolveTimezone(candidate?: string | null): string {
  if (candidate && candidate.length <= 64) {
    try {
      formatter(candidate);
      return candidate;
    } catch {
      // Unknown zone name: fall through.
    }
  }
  return systemTimezone();
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** Calendar date of an instant in `zone`: month is 1 to 12, `weekday` is 0 for Monday. */
function parts(ms: number, zone: string): { year: number; month: number; day: number; weekday: number } {
  const found: Record<string, string> = {};
  for (const part of formatter(zone).formatToParts(new Date(ms))) found[part.type] = part.value;
  return {
    year: Number(found.year),
    month: Number(found.month),
    day: Number(found.day),
    weekday: WEEKDAYS.indexOf(found.weekday),
  };
}

const pad = (value: number) => String(value).padStart(2, '0');

/** The calendar day (YYYY-MM-DD) of an instant in `zone`. */
export function dayOf(ms: number, zone: string = UTC): string {
  const { year, month, day } = parts(ms, zone);
  return `${year}-${pad(month)}-${pad(day)}`;
}

/** The calendar month (YYYY-MM) of an instant in `zone`. */
export function monthOf(ms: number, zone: string = UTC): string {
  const { year, month } = parts(ms, zone);
  return `${year}-${pad(month)}`;
}

/** The Monday (YYYY-MM-DD) that starts the week containing an instant, in `zone`. */
export function weekOf(ms: number, zone: string = UTC): string {
  const { year, month, day, weekday } = parts(ms, zone);
  return new Date(Date.UTC(year, month - 1, day - weekday)).toISOString().slice(0, 10);
}
