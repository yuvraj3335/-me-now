const MIN = 60_000, HOUR = 3.6e6, DAY = 864e5

/** "3m", "4h", "2d" — short enough to sit in a card's meta line. */
export function ago(ts: number, now = Date.now()): string {
  const d = Math.max(0, now - ts)
  if (d < MIN) return 'now'
  if (d < HOUR) return `${Math.floor(d / MIN)}m`
  if (d < DAY) return `${Math.floor(d / HOUR)}h`
  if (d < 7 * DAY) return `${Math.floor(d / DAY)}d`
  if (d < 365 * DAY) return `${Math.floor(d / (7 * DAY))}w`
  return `${Math.floor(d / (365 * DAY))}y`
}

/** Forward-looking counterpart: "in 20m", "in 3d", "5h late". */
export function until(ts: number, now = Date.now()): string {
  const d = ts - now
  if (d < 0) return `${ago(ts, now)} late`
  if (d < MIN) return 'now'
  if (d < HOUR) return `in ${Math.floor(d / MIN)}m`
  if (d < DAY) return `in ${Math.floor(d / HOUR)}h`
  return `in ${Math.floor(d / DAY)}d`
}

export function duration(ms: number): string {
  if (ms < MIN) return `${Math.round(ms / 1000)}s`
  if (ms < HOUR) return `${Math.round(ms / MIN)}m`
  if (ms < DAY) return `${(ms / HOUR).toFixed(1)}h`
  return `${(ms / DAY).toFixed(1)}d`
}

export const dayLabel = (iso: string) =>
  new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' })

export const shortDate = (ts: number) =>
  new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })

export const timeOfDay = (ts: number) =>
  new Date(ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    .replace(/\s?([AP])M/i, (_, p: string) => p.toLowerCase() + 'm')

/**
 * A time he set, said back to him in words: `Thu 3 Sep, 2:35pm`.
 *
 * The storage was never wrong — a deadline of 14:30 round-trips as the correct
 * IST instant and comes back unchanged after a full reload. What he never saw
 * was the time itself: the list showed `in 4d`, the editor hint showed
 * `Due in 4d`, and the wall-clock he chose appeared nowhere. A relative
 * distance is not a commitment; a date and a time are.
 *
 * `Today` and `Tomorrow` replace the date when they apply, because on the day
 * itself the date is the part he already knows.
 */
export function wallClock(ts: number, now = Date.now()): string {
  const d = new Date(ts)
  const time = timeOfDay(ts)
  const midnight = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const days = Math.round((midnight(d) - midnight(new Date(now))) / 864e5)
  if (days === 0) return time
  if (days === 1) return `Tomorrow, ${time}`
  if (days === -1) return `Yesterday, ${time}`
  return `${d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}, ${time}`
}

/**
 * The same instant, with how far away it is: `Thu 3 Sep, 2:35pm · in 4d`, or
 * `late — Thu 3 Sep, 2:35pm` once it has passed.
 */
export function deadlineWords(ts: number, now = Date.now()): string {
  return ts < now ? `late — ${wallClock(ts, now)}` : `${wallClock(ts, now)} · ${until(ts, now)}`
}

/**
 * `<input type="datetime-local">` wants local wall-clock, not an ISO instant.
 *
 * Built from the parts rather than by subtracting an offset. The old version
 * used `new Date().getTimezoneOffset()` — *today's* offset, applied to an
 * instant that might sit on the other side of a daylight-saving boundary, which
 * is an hour wrong wherever the clocks move. It is harmless in IST and wrong
 * everywhere else, which is the worst kind of harmless.
 */
const pad = (n: number) => String(n).padStart(2, '0')

export function toLocalInput(ms: number | null): string {
  if (!ms) return ''
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function fromLocalInput(v: string): number | null {
  return v ? new Date(v).getTime() : null
}

/** Local start-of-day plus an hour offset — used by the snooze presets. */
export function atHour(daysAhead: number, hour: number): number {
  const d = new Date()
  d.setDate(d.getDate() + daysAhead)
  d.setHours(hour, 0, 0, 0)
  return d.getTime()
}

export function greeting(d = new Date()): string {
  const h = d.getHours()
  if (h < 5) return 'Still up'
  if (h < 12) return 'Good morning'
  if (h < 17) return 'Good afternoon'
  if (h < 22) return 'Good evening'
  return 'Late one'
}
