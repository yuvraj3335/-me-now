/**
 * The drawer behind a row, and the gesture that opens it.
 *
 * Three solid, labelled actions — `Done`, `Status`, `Delete` — on anything that
 * has a status: a card on the desk, a task, a goal. Not a kebab, not a hover
 * toolbar, not a long-press menu. A word you can read at arm's length and a box
 * a thumb hits without aiming. Three at 88px is 264px, which on the narrowest
 * row in the product — a 390px phone — leaves the row's kind glyph and the first
 * few words of its title showing, so it stays obvious which row is about to be
 * acted on.
 *
 * **The drawer is a clip window, not a moving row.** The obvious implementation
 * slides the row left and lets the actions show through behind it, and that is
 * what this looked like for about an hour. It cannot work on the desk: a row
 * there is a `<tr>`, its cells are `<td>`s, and translating them takes them out
 * from under the table — the first cell's title slides across the nav rail and
 * the page grows a horizontal scrollbar, which is the one thing this product
 * measures itself against. So the actions live in a window pinned to the row's
 * right edge whose *width* tracks the finger. The reveal is identical to the eye
 * — the panel's left edge follows the thumb, pixel for pixel — and it cannot
 * paint outside the row it belongs to under any container.
 *
 * **Nothing is rendered while the drawer is shut.** Not at `opacity: 0`, not at
 * `width: 0` with buttons inside it. `group-hover:opacity-100` on a phone is a
 * control that is permanently invisible and permanently tappable, and this file
 * would be the second place in the product to learn that.
 *
 * **`Status` opens its picker in place**, over the row, because the alternative
 * is a menu — and a menu here is the kebab wearing a different hat.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  axisFor, clampSwipe, openSwipeKey, setOpenSwipe, snapSwipe, SWIPE_ACTION_W, SWIPE_ENGAGE_PX,
  swipeWidth, useOpenSwipe, type SwipeAxis,
} from '../lib/swipe'

/* ---------------------------------- hook ---------------------------------- */

export type SwipeBind = {
  ref: (node: HTMLElement | null) => void
  onPointerDown: (e: React.PointerEvent) => void
  onPointerMove: (e: React.PointerEvent) => void
  onPointerUp: (e: React.PointerEvent) => void
  onPointerCancel: (e: React.PointerEvent) => void
  onClickCapture: (e: React.MouseEvent) => void
  'data-swipe': SwipeTouch
  style?: React.CSSProperties
}

/**
 * Which axes the *browser* is allowed to claim on a swipeable row.
 *
 * `pan-y` everywhere except the Work page. Both values are declared in
 * `styles.css` rather than written inline, and the reason is two separate facts
 * that inline styles cannot express:
 *
 *   * `touch-action` does not apply to a table row. The property's own "applies
 *     to" list excludes table rows, row groups, columns and column groups, so a
 *     `style={{ touchAction: 'pan-y' }}` on the desk's `<tr>` was dropped by
 *     every browser and the row fell back to `auto` — on an iPad in landscape,
 *     which is the one device the declaration was written for. The cells take
 *     it, so the stylesheet puts it on them.
 *   * framer writes `touch-action: pan-x` inline on a `Reorder.Item`, and an
 *     inline declaration is not something another inline declaration can
 *     outrank. `pan-x` hands the browser the horizontal axis — the one axis this
 *     gesture needs — so a thumb swipe on a task row could be taken over as a
 *     pan mid-gesture and cancelled. `none` gives the row's whole gesture to the
 *     app, which is what framer's own drag wants anyway; it costs nothing,
 *     because `pan-x` had already given up vertical scrolling on those rows.
 *
 * `manipulation` is the third, and it is a row that *loses* this argument on
 * purpose: a row inside a table that scrolls sideways. There the horizontal
 * axis is the only way to reach half the columns, so the browser gets it and a
 * finger scrolls the table. See the phone desk in `CardTable.tsx` and the rule
 * in `styles.css` for the measurement behind that, and `takesTouch` below for
 * the half of it a stylesheet cannot say.
 */
export type SwipeTouch = 'pan-y' | 'none' | 'manipulation'

/**
 * Bind a row to the gesture.
 */
export function useSwipe(
  key: string,
  actionCount: number,
  touch: SwipeTouch = 'pan-y',
) {
  const width = swipeWidth(actionCount)
  const open = useOpenSwipe() === key

  /**
   * Whether a finger on this row is this gesture's at all.
   *
   * The stylesheet says which axes the browser may claim, and that is most of
   * the answer — but it is a race rather than a rule. A row that yields both
   * axes still receives `pointerdown` and the first `pointermove`, and a fast
   * flick can deliver twenty pixels of travel in that first move: the drawer
   * engages, the browser then decides the same touch is scrolling the table,
   * and both are true for the frame or two before `pointercancel` lands. A
   * drawer flashing open under a scroll is the exact failure this file's
   * engagement threshold exists to prevent, arriving from the other side. So on
   * those rows a touch is never a swipe, said once, in the only place that can
   * see what kind of pointer this is.
   *
   * A mouse and a pen are untouched, which is what keeps the drawer working on
   * the narrow laptop that renders the same table — and a trackpad never came
   * through here at all, it comes through `wheel` below.
   */
  const takesTouch = touch !== 'manipulation'

  const [dx, setDx] = useState(0)
  /** The offset as of this instant, for handlers that fire between renders. */
  const dxRef = useRef(0)
  const put = useCallback((v: number) => { dxRef.current = v; setDx(v) }, [])

  const from = useRef<{ x: number; y: number; base: number } | null>(null)
  const axis = useRef<SwipeAxis>('undecided')
  /** A gesture that engaged has to eat the click it is about to produce. */
  const engaged = useRef(false)
  const node = useRef<HTMLElement | null>(null)

  /** A wheel gesture is in flight: no finger to read, so it says so itself. */
  const wheeling = useRef(false)

  const close = useCallback(() => { setOpenSwipe(null); put(0) }, [put])

  // The store decides which row is open; the offset follows it. That is what
  // lets one row opening close another without every row watching every other.
  // Not while a gesture is in progress, in either input's case: the finger and
  // the two fingers are both already deciding where this row sits.
  useEffect(() => {
    if (from.current || wheeling.current) return
    put(open ? -width : 0)
  }, [open, width, put])

  /**
   * A row that leaves takes its openness with it.
   *
   * `openKey` is module-global and it is what the desk's keyboard layer checks
   * before every shortcut — a drawer open somewhere owns the keyboard until it
   * is shut. Nothing released the key when the row holding it unmounted, so
   * opening a drawer on Work with a trackpad and then navigating away (neither
   * of which is a `pointerdown` outside the row, which is the only other thing
   * that closes one) left `openKey` set for the rest of the session, with no
   * drawer anywhere on screen and no key that could clear it: j, k, Enter, e, s
   * and Escape all dead on the desk, permanently.
   */
  useEffect(() => () => { if (openSwipeKey() === key) setOpenSwipe(null) }, [key])

  /**
   * Anywhere else is a way out.
   *
   * Capture phase, so a tap on some other row's own handler still closes this
   * one first, and `pointerdown` rather than `click`, so the drawer is already
   * shut by the time the tap it began with resolves.
   */
  useEffect(() => {
    if (!open) return
    const away = (e: Event) => {
      if (node.current?.contains(e.target as Node)) return
      close()
    }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    document.addEventListener('pointerdown', away, true)
    document.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('pointerdown', away, true)
      document.removeEventListener('keydown', esc)
    }
  }, [open, close])

  /**
   * A trackpad's two-finger swipe, which is not a pointer event at all.
   *
   * Bound by hand rather than through `onWheel` because React attaches wheel
   * listeners passively, and a passive listener cannot call `preventDefault` —
   * so without this the same two fingers that open the drawer also trigger the
   * browser's back-navigation gesture, and the reader leaves Wake.
   */
  useEffect(() => {
    const el = node.current
    if (!el || width <= 0) return
    let settle: ReturnType<typeof setTimeout> | null = null
    /** How far this gesture has travelled sideways, across its whole stream. */
    let travelled = 0
    /** Whether it ever travelled far enough to be a gesture at all. */
    let engagedWheel = false

    // A wheel has no "finger up", so the end of one is a gap in the stream —
    // which is also where the travel resets, or a session's worth of one-pixel
    // drifts would eventually add up to a gesture nobody made.
    const end = () => {
      wheeling.current = false
      travelled = 0
      if (!engagedWheel) return
      engagedWheel = false
      /*
       * 120ms is long enough for another row to have taken the store.
       *
       * The wheel path publishes on the *first* engaged frame rather than at the
       * end, so this timer fires after a gesture that already said which row is
       * open — and macOS momentum keeps extending it well past the point where
       * two fingers have moved on. Flick one row half-open, flick the next: the
       * first row's timer would land afterwards and publish its own verdict,
       * shutting the drawer the reader had just opened, or stealing the key back
       * to a row with no drawer showing — and `openSwipeKey` is what the desk
       * hands the keyboard to. A row that no longer owns the store closes
       * itself and says nothing.
       */
      if (openSwipeKey() !== key) { put(0); return }
      const landed = snapSwipe(dxRef.current, width)
      setOpenSwipe(landed ? key : null)
      put(landed)
    }

    const onWheel = (e: WheelEvent) => {
      // Vertical wheels are the page's. So is a trackpad's diagonal drift.
      if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return
      /*
       * Claimed before it is acted on, and acted on only past the threshold.
       *
       * `preventDefault` has to happen on every horizontal frame or the same two
       * fingers trigger the browser's back-navigation gesture and the reader
       * leaves Wake. Moving the row has a threshold instead, the pointer path's
       * own: the deceleration phase of a vertical two-finger scroll emits frames
       * where `deltaY` has decayed to zero and a pixel of horizontal residue is
       * left, and without this every one of them opened whichever row the cursor
       * happened to be over by a pixel — a sliver of green flashing at the right
       * edge of a row nobody was aiming at.
       */
      e.preventDefault()
      travelled += Math.abs(e.deltaX)
      if (settle) clearTimeout(settle)
      settle = setTimeout(end, 120)
      if (travelled < SWIPE_ENGAGE_PX) return

      const next = clampSwipe(dxRef.current - e.deltaX, width)
      if (next === 0 && dxRef.current === 0) return

      /*
       * The store hears about this now, not 120ms after the fingers stop.
       *
       * Exactly one row is open in the whole product, and the pointer path holds
       * that by publishing on `pointerup`, plus a document-level `pointerdown`
       * that shuts whatever was open. A wheel fires neither — so a second row
       * swiped on a trackpad sat fully open beside the first for the length of
       * the gesture and all of macOS's momentum after it, and the first only
       * closed once the timer finally landed.
       */
      wheeling.current = true
      engagedWheel = true
      setOpenSwipe(key)
      put(next)
    }

    el.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      el.removeEventListener('wheel', onWheel)
      if (settle) clearTimeout(settle)
      wheeling.current = false
    }
  }, [key, width, put])

  const bind: SwipeBind = {
    ref: n => { node.current = n },
    'data-swipe': touch,
    style: {
      /*
       * A drag across a row is a gesture, not a text selection.
       *
       * Without this, swiping the desk highlights the row's title and `why` on
       * the way past — blue-on-amber over the one row the reader is acting on —
       * and the highlight outlives the gesture. It is only suppressed while the
       * drawer is actually moving, so a title can still be selected and copied
       * from a row at rest.
       */
      ...(dx !== 0 ? { userSelect: 'none' as const } : null),
    },

    onPointerDown: e => {
      // Secondary buttons are a context menu's business, not a drawer's.
      if (e.button > 0) return
      // And a finger on a row whose table scrolls sideways belongs to the
      // table, not to this. See `takesTouch`.
      if (!takesTouch && e.pointerType === 'touch') return
      from.current = { x: e.clientX, y: e.clientY, base: dxRef.current }
      axis.current = 'undecided'
      engaged.current = false
    },

    onPointerMove: e => {
      const start = from.current
      if (!start || width <= 0) return
      /*
       * Nothing is pressed, so nothing is being dragged.
       *
       * Until the gesture engages there is no pointer capture, so a pointer that
       * leaves the row mid-drag stops delivering moves here and its `pointerup`
       * lands somewhere else entirely — leaving this row believing a gesture is
       * still in progress. The next time the mouse merely *passes over* it, the
       * drawer would open under a cursor nobody pressed. One read of `buttons`
       * closes that, and it is correct for touch too, where a finger on the
       * glass reports 1.
       */
      if (e.buttons === 0) { from.current = null; return }
      const ddx = e.clientX - start.x
      const ddy = e.clientY - start.y

      if (axis.current === 'undecided') {
        const won = axisFor(ddx, ddy)
        // The page's scroll and a task's reorder both live on Y, and both are
        // more common than this. Losing the axis ends the gesture outright
        // rather than leaving it watching, so a scroll that drifts sideways
        // halfway down the list cannot open a drawer under the thumb.
        if (won === 'y') { from.current = null; return }
        if (won !== 'x') return
        axis.current = 'x'
        engaged.current = true
        // Whatever the first few pixels of travel already selected.
        window.getSelection?.()?.removeAllRanges()
        // Only now: capturing on pointerdown would steal every tap. And in a
        // try, because capture throws `NotFoundError` for a pointer that is no
        // longer down — which happens for real when a gesture is interrupted,
        // and would otherwise take the whole move handler down with it.
        try {
          ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
        } catch { /* the drag still works without it; it just ends at the edge */ }
      }

      put(clampSwipe(start.base + ddx, width))
    },

    onPointerUp: () => {
      const started = from.current
      from.current = null
      if (!started || axis.current !== 'x') return
      const landed = snapSwipe(dxRef.current, width)
      setOpenSwipe(landed ? key : null)
      put(landed)
    },

    onPointerCancel: () => {
      from.current = null
      // A cancelled pointer produces no click, so there is none to eat. The
      // latch is cleared by the next `pointerdown` anyway; clearing it here as
      // well is what keeps that true for a click that arrives without one — a
      // button inside the row activated from the keyboard.
      engaged.current = false
      if (axis.current === 'x') put(open ? -width : 0)
    },

    /**
     * A swipe is not a tap, and an open row is not a tap either.
     *
     * Capture, so the row's own `onClick` never runs. Without the first branch
     * every swipe would also open the detail it was trying to act on; without
     * the second, the tap that means "put this away" would open it instead.
     */
    onClickCapture: e => {
      if (engaged.current) {
        engaged.current = false
        e.preventDefault()
        e.stopPropagation()
        return
      }
      if (open && !(e.target as HTMLElement).closest?.('[data-swipe-action]')) {
        e.preventDefault()
        e.stopPropagation()
        close()
      }
    },
  }

  return { dx, open, width, bind, close }
}

/* --------------------------------- drawer --------------------------------- */

export type StatusChoice = { id: string; label: string }

/**
 * A tone, not a colour.
 *
 * `on-ok` and `on-bad` exist because `ok` and `bad` invert between themes — the
 * green is light on a dark page and dark on a light one — so a fixed ink on top
 * of them would fail one theme outright. Same reason `on-accent` has existed
 * since the first commit.
 */
const TONE = {
  ok: 'bg-ok text-on-ok',
  ink: 'bg-ink-700 text-fg',
  bad: 'bg-bad text-on-bad',
} as const

export type SwipeDrawerProps = {
  /** The live offset from `useSwipe`. Nothing renders at 0. */
  dx: number
  width: number
  onDone: () => void
  /**
   * Deletes a task or a goal; on a card this is `Won't do`, which is how Wake
   * already dismisses work. The word on the button is `Delete` either way —
   * there is no second red action to tell it apart from, and a row that said
   * `Won't do` here and `Delete` two rows down would be two words for the same
   * gesture.
   */
  onDelete: () => void
  /** Omitted only by a row that genuinely has no second state to be in. */
  status?: {
    current: string | null
    options: readonly StatusChoice[]
    onPick: (id: string) => void
  }
  /** Closes the drawer once an action has been taken. */
  onClose: () => void
}

export function SwipeDrawer({
  dx, width, onDone, onDelete, status, onClose,
}: SwipeDrawerProps) {
  const [picking, setPicking] = useState(false)

  // A drawer that shuts while its picker is up must not reopen holding it.
  useEffect(() => { if (dx === 0) setPicking(false) }, [dx])

  if (dx === 0) return null

  const shown = Math.min(width, Math.max(0, -dx))
  const act = (run: () => void) => () => { run(); onClose() }

  if (picking && status) {
    /*
     * `w-max` and no `max-w-full`.
     *
     * The drawer is anchored inside the row's last cell, which is 64px wide —
     * so a `max-width: 100%` here is 100% of *that*, and a picker wider than
     * 64px does not shrink, it overflows to the RIGHT, out of the row and
     * across the detail pane. Measured, before this comment existed. Sized to
     * its content and pinned to `right: 0` it grows leftward over the row
     * instead, which is where the room is.
     *
     * The padding is the phone's, not the desk's, for the same reason. Five
     * labels at `px-2` measure 356.5px against the 358px a 390px phone gives a
     * row: it fits, by a pixel and a half, which is not a margin — one font
     * fallback or one longer word and the first option is clipped. At `px-1`
     * they measure ~317px and the desk, which has 700px or more, still gets the
     * air at `sm`.
     *
     * `min-w-11` is what the padding cannot do. Sized by their labels alone,
     * `Done` is four characters — a 36px box, the narrowest target in the
     * product, sitting immediately left of `Won't do`, which takes the card off
     * the desk. The floor costs about eight pixels of the ~317 and makes every
     * option in the picker the same 44px this file spends a whole comment
     * defending one pixel of, further down.
     */
    return (
      <div
        data-swipe-action
        className="absolute top-0 -bottom-px right-0 z-10 flex items-stretch bg-ink-800 w-max"
        role="group"
        aria-label="Status"
      >
        {status.options.map(o => (
          <button
            key={o.id}
            onClick={act(() => status.onPick(o.id))}
            aria-pressed={o.id === status.current}
            className={`min-w-11 px-1 sm:px-2 text-sm font-medium whitespace-nowrap transition-colors duration-100
              ${o.id === status.current ? 'text-fg' : 'text-fg-mute hover:text-fg-dim'}`}
          >
            {o.label}
          </button>
        ))}
      </div>
    )
  }

  return (
    <div
      data-swipe-action
      /*
       * `-bottom-px`, not `inset-y-0`.
       *
       * A row is `h-11` — 44px — and one of those pixels is its bottom rule, so
       * an overlay stretched to the row's padding box measures 43 and every
       * action in it lands a pixel under the 44px touch target this product
       * holds itself to. Reaching over the rule costs nothing: the drawer is a
       * solid block that covers it while it is open, and there is nothing to
       * separate from underneath.
       */
      className="absolute top-0 -bottom-px right-0 z-10 overflow-hidden"
      style={{ width: shown }}
    >
      <div className="absolute inset-y-0 right-0 flex items-stretch" style={{ width }}>
        <SwipeButton tone="ok" label="Done" onClick={act(onDone)} />
        {status && (
          <SwipeButton tone="ink" label="Status" onClick={() => setPicking(true)} />
        )}
        <SwipeButton tone="bad" label="Delete" onClick={act(onDelete)} />
      </div>
    </div>
  )
}

function SwipeButton({
  tone, label, onClick,
}: { tone: keyof typeof TONE; label: string; onClick: () => void }) {
  return (
    <button
      data-swipe-action
      onClick={onClick}
      style={{ width: SWIPE_ACTION_W }}
      className={`shrink-0 flex items-center justify-center text-sm font-medium
        transition-[filter] duration-100 hover:brightness-110 ${TONE[tone]}`}
    >
      {label}
    </button>
  )
}
