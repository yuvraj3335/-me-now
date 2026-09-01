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
 * right edge, and the strip of buttons *inside* that window is what tracks the
 * finger. The reveal is identical to the eye — the leading edge follows the
 * thumb, pixel for pixel — and it cannot paint outside the row it belongs to
 * under any container.
 *
 * The window's own size is fixed and the strip moves by `transform`, which is
 * the difference between a swipe that follows a thumb and one that does not.
 * The width used to be the animation, written from `dx` on every `pointermove`;
 * width is a layout property, so every frame of every swipe re-laid-out the
 * row, its cells and the buttons, on the main thread, while the finger was
 * still moving. Reported as "it's not smooth", and correctly.
 *
 * **Nothing is rendered while the drawer is shut.** Not at `opacity: 0`, not at
 * `width: 0` with buttons inside it. `group-hover:opacity-100` on a phone is a
 * control that is permanently invisible and permanently tappable, and this file
 * would be the second place in the product to learn that.
 *
 * **`Status` opens its picker in place**, over the row, because the alternative
 * is a menu — and a menu here is the kebab wearing a different hat.
 *
 * **The offset is a motion value, not React state.** It used to be `useState`,
 * written on every `pointermove` — so a swipe re-rendered the row, its cells and
 * every button in the drawer once per frame, on the main thread, while the
 * finger was still moving. Moving the *width* out of the animation (see above)
 * fixed the layout half of that and left the render half in place. A motion
 * value is written straight to the element's transform without React seeing it,
 * so a gesture now costs exactly two renders — one when the drawer mounts and
 * one when it unmounts — instead of one per frame. `live` is that mount, and it
 * is the only piece of this still in state.
 *
 * **It settles on a spring** rather than snapping to its end value the instant
 * the finger lifts. The row was tracking a thumb one-to-one a frame earlier, and
 * a hard jump to `-width` is where a surface stops feeling attached to the hand.
 */

import { animate, motion, useMotionValue, useTransform, type MotionValue } from 'motion/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  axisFor, clampSwipe, openSwipeKey, setOpenSwipe, snapSwipe,
  SWIPE_ENGAGE_PX, SWIPE_SPRING, swipeWidth, useOpenSwipe, type SwipeAxis,
} from '../lib/swipe'
import { statusColor, statusWash } from './status'
import { STATUS_LABEL, type CardStatus } from '../lib/types'

/** Whether a picker option is one of the five, or something else entirely. */
const isCardStatus = (id: string): id is CardStatus => id in STATUS_LABEL

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
  /**
   * Whether this finger is the drawer's, on a row inside a sideways table.
   *
   * `manipulation` rows used to refuse touch outright. That made the table
   * scroll and took `Done · Status · Delete` off the phone with it — a row could
   * not be acted on at all without opening it first, which is the opposite of
   * what a swipe drawer is for.
   *
   * The two are not simultaneous, though, and that is the way out. While there
   * is table left to the right, a horizontal drag means "show me the rest"; at
   * the end of the scroll it cannot mean that any more, because there is nothing
   * further to show. So the table gets the axis until it is scrolled out and the
   * drawer gets it afterwards — the same finger, without lifting.
   *
   * Read at `pointerdown` from the DOM rather than passed in as a prop: the
   * scroller is an ancestor, its position changes on a listener this row does
   * not own, and a prop would re-render every row in the table on every frame of
   * a scroll. The stylesheet keys `touch-action` off the same attribute, so the
   * browser has already been told whose axis it is before the gesture starts.
   */
  const touchIsOurs = (target: EventTarget | null): boolean => {
    if (touch !== 'manipulation') return true
    const scroller = (target as HTMLElement | null)?.closest?.('[data-hscroll]')
    // No scroller found means nothing is competing for the axis.
    return !scroller || scroller.hasAttribute('data-atend')
  }

  /**
   * Where the drawer is, written straight to the compositor.
   *
   * Nothing re-renders when this changes. `live` below is the only state a
   * gesture touches, and it changes twice per gesture rather than sixty times a
   * second.
   */
  const offset = useMotionValue(0)
  /** Whether the drawer is on screen at all — see the `return null` in the drawer. */
  const [live, setLive] = useState(false)
  /** The offset as of this instant, for handlers that fire between renders. */
  const dxRef = useRef(0)
  /** The spring currently carrying the row somewhere, and where it is headed. */
  const running = useRef<{ stop: () => void; to: number } | null>(null)

  /** Track the pointer exactly. Kills any spring: a finger outranks physics. */
  const put = useCallback((v: number) => {
    running.current?.stop()
    running.current = null
    dxRef.current = v
    offset.set(v)
    // React bails out on an identical value, so this is one render on the
    // 0 ↔ non-0 crossing and nothing at all on the frames in between.
    setLive(v !== 0)
  }, [offset])

  /**
   * Carry the row to a resting place on a spring.
   *
   * The drawer stays mounted for the whole of a closing animation and unmounts
   * on the last frame, or it would vanish instead of sliding shut. Re-entrant on
   * purpose: `pointerup` publishes to the store *and* settles, and the store then
   * fires the effect below with the same target — asking for a spring that is
   * already running to that exact value is a no-op rather than a restart, which
   * is what stops that pair producing a visible hitch.
   */
  const settle = useCallback((target: number) => {
    if (running.current?.to === target) return
    running.current?.stop()
    running.current = null
    if (target !== 0) setLive(true)
    const ctl = animate(offset, target, {
      ...SWIPE_SPRING,
      onUpdate: v => {
        dxRef.current = v
        /*
         * Unmount on what is on screen, not on `onComplete`.
         *
         * The spring is a touch under critically damped, so a flick-close
         * crosses zero within about 18ms and then spends the rest of its life
         * oscillating by a pixel or two in a range the drawer's own transform
         * clamps to "fully hidden". Waiting for `onComplete` therefore kept the
         * drawer mounted for ~340ms after it looked shut — and it is an
         * `absolute` 264px box with `onClick={stopPropagation}` on it, over a
         * 343px row. Measured: tapping a row's title within a third of a second
         * of closing it did nothing, and on the phone list the second tap of a
         * deliberate double-tap-to-peek was eaten.
         *
         * `v >= 0` is exactly the condition under which the strip is drawn fully
         * hidden, so unmounting there is invisible and gives the row its clicks
         * back on the frame it looks shut.
         */
        if (target === 0 && v >= 0) setLive(false)
      },
      onComplete: () => {
        running.current = null
        dxRef.current = target
        if (target === 0) setLive(false)
      },
    })
    running.current = { stop: () => ctl.stop(), to: target }
  }, [offset])

  /**
   * A row that unmounts mid-spring must not leave one running against a motion
   * value nothing is reading any more.
   *
   * `running.current` is cleared as well as stopped. `stop()` fires neither
   * `onUpdate` nor `onComplete`, so without this the ref keeps a dead controller
   * — and `settle`'s `running.current?.to === target` early-return then reads it
   * and skips a spring that should have run. In StrictMode that happens on every
   * mount: this effect's cleanup stops the `settle(0)` the sync effect just
   * started, and the re-run then sees a stale `{ to: 0 }` and does nothing.
   */
  useEffect(() => () => {
    running.current?.stop()
    running.current = null
  }, [])

  const from = useRef<{ x: number; y: number; base: number } | null>(null)
  const axis = useRef<SwipeAxis>('undecided')
  /** A gesture that engaged has to eat the click it is about to produce. */
  const engaged = useRef(false)
  const node = useRef<HTMLElement | null>(null)

  /** A wheel gesture is in flight: no finger to read, so it says so itself. */
  const wheeling = useRef(false)

  /**
   * Shut it, on a spring, the way a finger-release shuts it.
   *
   * This used to be `put(0)` — a teleport from `-width` to `0` in one `set`.
   * Two things went wrong with that. The drawer vanished instead of sliding
   * shut, which is what the docblock at the top of this file promises it does.
   * And `setOpenSwipe(null)` then flips `open`, so the sync effect below fires
   * `settle(0)`, and framer seeds a spring with `value.getVelocity()` — which
   * after an instantaneous 264px jump reads as **8800 px/s**. Measured: the
   * value overshot to +133px and took 409ms to come back, all of it invisible,
   * all of it written into `dxRef`. A second swipe on that row inside ~160ms
   * read `base` from that ref and needed 133px of travel before the drawer
   * moved at all, which is a gesture that feels dead for no reason on screen.
   */
  const close = useCallback(() => { setOpenSwipe(null); settle(0) }, [settle])

  // The store decides which row is open; the offset follows it. That is what
  // lets one row opening close another without every row watching every other.
  // Not while a gesture is in progress, in either input's case: the finger and
  // the two fingers are both already deciding where this row sits.
  useEffect(() => {
    if (from.current || wheeling.current) return
    settle(open ? -width : 0)
  }, [open, width, settle])

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
    // Named `idle` rather than `settle`: the hook now has a `settle` of its own
    // that springs the row to a resting place, and a local shadowing it here
    // would silently make every wheel gesture end by clearing a timeout instead.
    let idle: ReturnType<typeof setTimeout> | null = null
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
      if (openSwipeKey() !== key) { settle(0); return }
      const landed = snapSwipe(clampSwipe(dxRef.current, width), width)
      setOpenSwipe(landed ? key : null)
      settle(landed)
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
      if (idle) clearTimeout(idle)
      idle = setTimeout(end, 120)
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
      if (idle) clearTimeout(idle)
      wheeling.current = false
    }
  }, [key, width, put, settle])

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
      ...(live ? { userSelect: 'none' as const } : null),
    },

    onPointerDown: e => {
      // Secondary buttons are a context menu's business, not a drawer's.
      if (e.button > 0) return
      // A finger on a row whose table still has somewhere to scroll belongs to
      // the table. Once it does not, it belongs here. See `touchIsOurs`.
      if (e.pointerType === 'touch' && !touchIsOurs(e.target)) return
      // A finger outranks physics: stop whatever is still settling before
      // reading where the row is, or `base` is a value from mid-flight rather
      // than where the row actually sits.
      running.current?.stop()
      running.current = null
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

      // Elastic, not clamped: a thumb that keeps pulling past the last action
      // still gets movement, just less of it. A row that goes dead under a
      // finger reads as a stuck app; resistance reads as an end.
      put(clampSwipe(start.base + ddx, width))
    },

    onPointerUp: () => {
      const started = from.current
      from.current = null
      if (!started || axis.current !== 'x') return
      // Snapped from the hard range, so an overdragged row still lands on one
      // of the two resting places rather than keeping any of its stretch.
      const landed = snapSwipe(clampSwipe(dxRef.current, width), width)
      setOpenSwipe(landed ? key : null)
      settle(landed)
    },

    onPointerCancel: () => {
      from.current = null
      // A cancelled pointer produces no click, so there is none to eat. The
      // latch is cleared by the next `pointerdown` anyway; clearing it here as
      // well is what keeps that true for a click that arrives without one — a
      // button inside the row activated from the keyboard.
      engaged.current = false
      if (axis.current === 'x') settle(open ? -width : 0)
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

  return { offset, live, open, width, bind, close }
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
  accent: 'bg-accent text-on-accent',
} as const

export type SwipeDrawerProps = {
  /**
   * The live offset from `useSwipe`, as a motion value.
   *
   * Not a number: a number would mean this component re-rendered on every frame
   * of every swipe, which is the thing the hook above stopped doing. `live` is
   * what says whether to render at all.
   */
  offset: MotionValue<number>
  live: boolean
  width: number
  onDone: () => void
  /**
   * Make a task from this row, and land it in Work without asking anything.
   *
   * Omitted by a row that has no origin worth carrying — a task cannot be made
   * from a task. Where it is offered it is the *first* action under the thumb,
   * because it is the only one of the four that is purely additive: the other
   * three all take the row somewhere, and the one that costs nothing should be
   * the one nearest the finger.
   */
  onTask?: () => void
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
  offset, live, width, onDone, onTask, onDelete, status, onClose,
}: SwipeDrawerProps) {
  const [picking, setPicking] = useState(false)

  /*
   * How far the strip of buttons is pushed out of its own window.
   *
   * Derived from the offset rather than computed in render, so it updates on
   * the compositor with the gesture instead of once per React render. The clamp
   * is here rather than in the hook because the hook now lets a finger pull
   * clamped — the offset cannot leave `[-width, 0]` — so this `min`/`max` is
   * belt and braces rather than the thing doing the work, and it is what keeps
   * a stray value from ever drawing the strip outside its own window.
   */
  const x = useTransform(offset, v => width - Math.min(width, Math.max(0, -v)))

  // A drawer that shuts while its picker is up must not reopen holding it.
  useEffect(() => { if (!live) setPicking(false) }, [live])

  // Nothing at rest, and the contract in `ui-contract.test.ts` is why: a drawer
  // that is always present is a control a touch device can never reveal and can
  // always press. Leaving it mounted to save the first frame's layout was tried
  // and is not worth that.
  if (!live) return null

  const act = (run: () => void) => () => { run(); onClose() }

  /*
   * The buttons that will actually paint, and the box each of them gets.
   *
   * Counted from the props rather than taken as a number, because the caller
   * already told `useSwipe` how wide to be and a second, hand-kept count here is
   * how the strip and its window drift apart. `Done` and `Delete` are always
   * drawn; `Task` and `Status` are each optional, and every combination is in
   * use — four on the desk, three on a session (no status), three on a task (no
   * task-from-a-task).
   */
  const count = 2 + (onTask ? 1 : 0) + (status ? 1 : 0)
  const each = width / count

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
      /*
       * The drawer's clicks are the drawer's.
       *
       * `onClickCapture` on the row deliberately lets a tap through when it
       * lands inside `[data-swipe-action]` — that is what stops "tap anywhere
       * to close" from eating the action you were aiming at. What nothing then
       * did was stop it *bubbling*, so pressing `Done` also ran the row's own
       * `onClick`: the card was finished and the detail pane opened on top of
       * it, acknowledging the card on the way out. Same for `Delete`, and same
       * for `Status`, which does not even go through `act`.
       *
       * One handler on the container rather than three on the buttons, because
       * the rule is about the drawer and not about any one action in it.
       */
      onClick={e => e.stopPropagation()}
        className="absolute top-0 -bottom-px right-0 z-10 flex items-stretch bg-ink-800 w-max"
        role="group"
        aria-label="Status"
      >
        {status.options.map(o => {
          /*
           * The five options are painted, and this is the whole reason the
           * picker was worth reopening.
           *
           * It used to render five words in `fg-mute` with the current one in
           * `fg`. That is a menu you have to *read*, on the surface where he is
           * least able to — mid-swipe, one thumb, holding a row open. Two of
           * the five even shared a colour on the row underneath, so picking the
           * right one and confirming you had were both jobs for the label text.
           *
           * The hue comes from `status.tsx` through a function rather than a
           * token spelled here, because there is exactly one status→colour
           * table in this product and a second one written in a drawer is how
           * the last one drifted. An id this file does not recognise — a filter
           * passing `any`, say — keeps the old neutral treatment rather than
           * guessing at a colour for it.
           */
          const st = isCardStatus(o.id) ? o.id : null
          const hue = st ? statusColor(st) : null
          const on = o.id === status.current
          return (
            <button
              key={o.id}
              onClick={act(() => status.onPick(o.id))}
              aria-pressed={on}
              // The wash marks the current one. `aria-pressed` says it too, but
              // a picker whose selected item is only announced is a picker he
              // cannot check at a glance, which is the state he is in here.
              style={st
                ? { color: statusColor(st), background: on ? statusWash(st) : undefined }
                : undefined}
              className={`min-w-11 px-1 sm:px-2 text-sm font-medium whitespace-nowrap transition-colors duration-100
                ${hue ? (on ? 'font-semibold' : 'opacity-80 hover:opacity-100')
                      : on ? 'text-fg' : 'text-fg-mute hover:text-fg-dim'}`}
            >
              {o.label}
            </button>
          )
        })}
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
      /* See the picker branch above: a drawer action must not also open the
         row it was pressed on. */
      onClick={e => e.stopPropagation()}
      /*
       * A fixed box that the actions slide *inside*, rather than a box whose
       * width is the animation.
       *
       * `width` changed on every pointermove, and width is a layout property:
       * each frame of a swipe re-laid-out the row, its cells and the strip of
       * buttons inside it, on the main thread, while the finger was still
       * moving. That is the whole of "it is not smooth". The box is a constant
       * size now and the strip inside it is moved with a transform, which the
       * compositor can do without laying anything out again.
       *
       * The box is only here while the row is open at all, so a constant width
       * costs a closed row nothing — see the `return null` above.
       */
      style={{ width }}
    >
      <motion.div
        className="absolute inset-y-0 right-0 flex items-stretch"
        style={{ width, x }}
      >
        {/* `Task`, not `+`. Every other action in this drawer is a word you can
            read at arm's length, and a glyph here would be the one control on
            the surface you have to already know. */}
        {onTask && <SwipeButton w={each} tone="accent" label="Task" onClick={act(onTask)} />}
        <SwipeButton w={each} tone="ok" label="Done" onClick={act(onDone)} />
        {status && (
          <SwipeButton w={each} tone="ink" label="Status" onClick={() => setPicking(true)} />
        )}
        <SwipeButton w={each} tone="bad" label="Delete" onClick={act(onDelete)} />
      </motion.div>
    </div>
  )
}

function SwipeButton({
  w, tone, label, onClick,
}: { w: number; tone: keyof typeof TONE; label: string; onClick: () => void }) {
  return (
    <button
      data-swipe-action
      onClick={onClick}
      /*
       * The width is handed down rather than read from the constant.
       *
       * The drawer's own box is `swipeWidth(actionCount)`, and a button sized
       * from a *different* number than the box divides the strip either short of
       * the row's edge or past it. Dividing the box by the buttons about to be
       * painted makes the two agree by construction, which matters now that the
       * per-action width is not one number — four actions use a narrower box so
       * a four-action drawer does not cover the whole of a 375px row.
       */
      style={{ width: w }}
      className={`shrink-0 flex items-center justify-center text-sm font-medium
        transition-[filter] duration-100 hover:brightness-110 ${TONE[tone]}`}
    >
      {label}
    </button>
  )
}
