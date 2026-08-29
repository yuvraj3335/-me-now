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
