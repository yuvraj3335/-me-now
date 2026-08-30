/**
 * How wide the detail pane is, and the fact that he gets to decide.
 *
 * The brief has called this pane resizable since the beginning and it never was
 * — it was two Tailwind widths, 360 and 400, chosen by a breakpoint. That is the
 * right default and the wrong ceiling: a Slack thread with a Cursor root-cause
 * essay in it and a pull request with a four-row fact table want different
 * amounts of room, and he is the one looking at them.
 *
 * The bounds are not taste. Below 320 the fact table's own two columns — a 96px
 * label and a value — stop leaving the value anything to be, and the action bar
 * wraps to three lines. Above 640 the list beside it loses `Where` and then
 * starts eating the elastic Title column, which is four pixels above its floor
 * at 1440 (see the width table in `CardTable.tsx`). So the pane may take room
 * from the list, and it may not take the list apart.
 *
 * 640 is the ceiling; it is not the whole bound. How much the list can actually
 * spare depends on how wide the window is, and that arithmetic lives with the
 * columns it is made of — `maxPaneFor` in `CardTable.tsx` — and arrives here as
 * `clampPane`'s second argument. A bound that only knows about the pane is a
 * bound that holds on the monitor the width was chosen on and fails on the
 * laptop `localStorage` hands it back to.
 */

export const PANE_MIN_W = 320
export const PANE_MAX_W = 640

/** What it is before anyone drags it, and what a double-click goes back to. */
export const PANE_DEFAULT_W = 400

/** One key, so a stale one from an earlier shape cannot be read as a width. */
const KEY = 'wake:pane'

/**
 * The width the pane may actually be, given its own bounds and the room there is.
 *
 * `max` is what the *list* can spare and it is passed in rather than assumed,
 * because this module has no business knowing the column table — `maxPaneFor` in
 * `CardTable.tsx` owns that arithmetic, beside the widths it is made of. It
 * matters because the width is persisted: dragged to 640 on a 1920px monitor and
 * restored on a 1280px laptop, a bound that only knew about the pane collapsed
 * the elastic Title column to nothing on every row of the desk.
 *
 * The 320 floor still wins if a viewport somehow leaves less than that. A pane
 * narrower than its own minimum is not a smaller pane, it is a broken one — and
 * the pane does not render below 1280 anyway, where there is room for both.
 */
export const clampPane = (w: number, max = PANE_MAX_W): number =>
  Math.min(Math.max(PANE_MIN_W, Math.min(PANE_MAX_W, max)), Math.max(PANE_MIN_W, Math.round(w)))

/**
 * The remembered width, or the default.
 *
 * Everything that is not a number in range is the default, including a key some
 * other version of this wrote: `localStorage` is shared with every past and
 * future build of the app, and a pane 4px wide because a string parsed to 4 is a
 * product that looks broken with no way to tell why.
 */
export function readPane(store?: Pick<Storage, 'getItem'>): number {
  const s = store ?? (typeof localStorage === 'undefined' ? null : localStorage)
  if (!s) return PANE_DEFAULT_W
  try {
    const raw = s.getItem(KEY)
    if (raw === null) return PANE_DEFAULT_W
    const n = Number(raw)
    return Number.isFinite(n) && n > 0 ? clampPane(n) : PANE_DEFAULT_W
  } catch {
    // Safari in private mode throws on `getItem`. A pane is not worth a crash.
    return PANE_DEFAULT_W
  }
}

export function writePane(w: number, store?: Pick<Storage, 'setItem'>): void {
  const s = store ?? (typeof localStorage === 'undefined' ? null : localStorage)
  if (!s) return
  try {
    s.setItem(KEY, String(clampPane(w)))
  } catch {
    /* Same as above: remembering is a convenience, not a requirement. */
  }
}
