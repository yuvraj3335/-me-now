import { AnimatePresence, motion } from 'motion/react'
import {
  useEffect, useRef, useState,
  type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject,
} from 'react'
import { createPortal } from 'react-dom'
import { useStill } from '../lib/motion'
import { navStrip, useOverlay } from '../lib/overlay'
import { toLocalInput, fromLocalInput } from '../lib/time'
import { PAGE_TITLE } from '../lib/typography'
import { WakeMark } from './WakeMark'
import { Check, ChevronDown, ChevronLeft, ChevronRight, X } from 'lucide-react'

/**
 * The two springs every panel in this product settles on.
 *
 * They were declared here and used nowhere for a long time, while every surface
 * animated on a duration and a cubic bézier instead. A timing curve is the right
 * tool for a thing that fades — a scrim has no mass and nothing to overshoot —
 * and the wrong one for a thing that *moves*, because the moment a panel is also
 * draggable, a fixed 180ms ease-out from wherever the thumb let go is where the
 * surface stops feeling attached to the hand.
 *
 * `spring` is for something small and near: a menu, a popover, a picker. `soft`
 * is for something with a panel's worth of travel — a sheet coming up from the
 * bottom edge. Both are damped past overshoot on purpose: this is furniture
 * settling, not a toy bouncing, and a dialog that wobbles under a heading is the
 * kind of motion that reads as cheap on the second viewing.
 *
 * `restDelta` is the pixel they may stop short by. A spring without one keeps
 * animating for a few hundred milliseconds while it converges on a difference no
 * display can draw, and anything gated on "is it still moving" stays true.
 */
export const spring = {
  type: 'spring', stiffness: 520, damping: 40, mass: 0.7, restDelta: 0.5,
} as const
export const softSpring = {
  type: 'spring', stiffness: 300, damping: 34, mass: 0.9, restDelta: 0.5,
} as const

/* --------------------------------- buttons -------------------------------- */

export type ButtonSize = 'sm' | 'md' | 'lg'
export type ButtonVariant = 'primary' | 'secondary' | 'default' | 'ghost' | 'danger'

/**
 * Three real heights, and the hit area is not the ink.
 *
 * There were nine painted control heights in this product against four row
 * heights — 24, 26, 28, 32, 36, 38, 44, 45, 48, 52, 60, 65 — and not one control
 * equalled a row, so everything collapsed to one 32px box. That collapse went
 * one step too far: a page-level commit and a row action ended up the same
 * 32px, and a commitment that is the same size as a row action reads as a row
 * action. The three heights are back, but as three *jobs* rather than three
 * paddings — 28 for something that lives inside a row, 32 for page chrome, 40
 * for the one control that commits. `lg` is allowed on a sheet-footer commit
 * and a page-header primary and nowhere else; never in a table row, never in a
 * chip rail.
 *
 * `.hit` grows the touch target to 44px on a coarse pointer while the painted
 * box stays small — see the note in `styles.css` for why that is scoped to
 * touch. `lg` takes it too. It used not to, on the grounds that 40px already
 * clears the target; 40 is not 44, and the box is centred rather than outset
 * now, so the whole of what `lg` costs a phone is two pixels above and below.
 *
 * Every label is `text-sm` bar `lg`. `text-xs` was on the filter chips, every
 * row action and every `sm` button — which is most of what gets read before a
 * decision, at 12px, under this file's own stated floor.
 *
 * `primary` is the amber fill. At most one per surface, and only when pressing
 * it commits something. It is never `Connect`, `Turn on`, `Instruction` or
 * `Fetch` — those are decisions, not commitments.
 */
const SIZE: Record<ButtonSize, string> = {
  sm: 'hit h-7 px-2 text-sm gap-2',
  md: 'hit h-8 px-3 text-sm gap-2',
  lg: 'hit h-10 px-4 text-base gap-2',
}

/**
 * Weight lives here rather than on the size, because weight is what the button
 * is *for*: a commit is semibold whatever height it is drawn at, and a ghost
 * stays medium even when it is the biggest thing on the row.
 *
 * `secondary` is the new one, and it is what an action bar is made of — a
 * filled, bordered, full-contrast button that is unmistakably pressable without
 * spending the accent. Four ghost labels in a row read as a caption.
 */
const VARIANT: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-on-accent font-semibold hover:brightness-110',
  secondary: 'bg-ink-800 border border-edge text-fg font-medium hover:bg-ink-700',
  default: 'border border-edge text-fg-dim font-medium hover:text-fg hover:bg-ink-800',
  ghost: 'text-fg-mute font-medium hover:text-fg-dim hover:bg-ink-800',
  danger: 'bg-bad text-on-bad font-semibold hover:brightness-110',
}

export function Button({
  children, onClick, variant = 'default', size = 'md', className = '',
  disabled, type = 'button', title, ariaLabel,
}: {
  children: ReactNode; onClick?: () => void
  variant?: ButtonVariant
  size?: ButtonSize
  className?: string; disabled?: boolean; type?: 'button' | 'submit'
  title?: string; ariaLabel?: string
}) {
  return (
    <button
      type={type}
      title={title}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={onClick}
      className={`relative inline-flex items-center justify-center rounded-control whitespace-nowrap
        transition-colors duration-100 disabled:opacity-40 disabled:pointer-events-none
        ${SIZE[size]} ${VARIANT[variant]} ${className}`}
    >
      {children}
    </button>
  )
}

/**
 * A set of sibling choices is one control, not N buttons.
 *
 * A row of lozenges is N controls that look like N decisions; a segmented box
 * is one control that looks like the one decision it is. Two of the deferral
 * ladders this replaced took a whole row of the detail pane each, to ask one
 * question between them.
 *
 * Use it for three or four short, fixed choices that fit side by side. Beyond
 * that — the five statuses, the four priorities — it is a `Select`: a segmented
 * control wide enough to hold five words is a toolbar.
 */
export function Segmented<T extends string>({
  options, value, onChange, ariaLabel, className = '',
}: {
  options: Array<{ id: T; label: string; disabled?: boolean }>
  value?: T | null
  onChange: (id: T) => void
  ariaLabel?: string
  className?: string
}) {
  return (
    /* The group used to clip itself, so the active segment's fill would stay
       inside the rounded corner. That also clipped each segment's touch target
       to the 32px the group paints — three theme segments measured 30px tall on
       a phone. The fill rounds its own outer corner instead: 5px, which is the
       group's 6px radius less the 1px border it sits inside. */
    <div role="group" aria-label={ariaLabel}
      className={`inline-flex h-8 rounded-control border border-edge ${className}`}>
      {options.map((o, i) => (
        <button
          key={o.id}
          disabled={o.disabled}
          onClick={() => onChange(o.id)}
          aria-pressed={value === o.id}
          className={`hit relative px-3 text-sm font-medium transition-colors duration-100
            first:rounded-l-[5px] last:rounded-r-[5px]
            disabled:opacity-40 disabled:pointer-events-none
            ${i > 0 ? 'border-l border-edge' : ''}
            ${value === o.id ? 'bg-ink-800 text-fg' : 'text-fg-mute hover:text-fg-dim hover:bg-ink-800'}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

/* ---------------------------------- menus --------------------------------- */

/**
 * One row of a `Menu`.
 *
 * `meta` is the one fact a chooser needs beside the name and never gets: `9
 * dirty` next to a repo, `live` next to a session, `2d` next to a goal. It is
 * the reason the picker is a menu rather than a `<select>`, which cannot carry
 * a second column at all.
 *
 * `group` is a heading printed above this row; consecutive rows sharing one
 * print it once. It is a property of the item rather than a separate nesting
 * level so that filtering a flat list cannot orphan a heading over nothing.
 */
export type MenuItem<T extends string = string> = {
  id: T
  label: string
  meta?: string
  group?: string
  disabled?: boolean
}

type Anchor = { left: number; width: number; maxHeight: number; top?: number; bottom?: number }

/** The panel's own breathing room: from the trigger, and from the screen edge. */
const MENU_GAP = 6
const MENU_MARGIN = 8
/** Narrower than this and a label plus its meta string is two lines. */
const MENU_MIN_W = 180

/**
 * Where the panel goes, measured rather than guessed.
 *
 * Read from the trigger's own rect at open time, and again on every scroll and
 * resize, because a `fixed` panel does not travel with the surface underneath
 * it. It flips above the trigger when what is below cannot hold a usable menu —
 * `usable` being four rows, not one, since a menu that fits by squeezing to a
 * single visible row is worse than one that opens upward.
 */
function place(el: HTMLElement, align: 'start' | 'end'): Anchor {
  const r = el.getBoundingClientRect()
  const vw = window.innerWidth
  const vh = window.innerHeight
  /*
   * The floor is the tab bar's top edge, not the viewport's bottom.
   *
   * `below` decides both how tall this panel may be and whether it opens
   * downward at all, and measuring it to the bottom of the viewport counted the
   * phone's own tab bar as free space — so a menu opened from a low trigger
   * drew its last rows across Desk, Mail and Work. `navStrip` is 0 from `sm`
   * up, where the bar is `display: none` and the rail is beside the page rather
   * than under it, so this changes nothing on a laptop.
   *
   * Only `below` moves. The `up` branch positions with a viewport-relative
   * `bottom`, so it keeps the real `vh` — subtracting the bar there would lift
   * an upward menu off its own trigger by the height of the bar.
   */
  const below = (vh - navStrip()) - r.bottom - MENU_GAP - MENU_MARGIN
  const above = r.top - MENU_GAP - MENU_MARGIN
  const up = below < 176 && above > below

  const width = Math.min(Math.max(r.width, MENU_MIN_W), vw - MENU_MARGIN * 2)
  const wanted = align === 'end' ? r.right - width : r.left
  const left = Math.min(Math.max(wanted, MENU_MARGIN), vw - width - MENU_MARGIN)

  // Never taller than the room it has, and never taller than the viewport even
  // when the room is the viewport: a menu that fills the screen is a page.
  const maxHeight = Math.max(120, Math.min(up ? above : below, Math.round(vh * 0.6)))

  return up
    ? { left, width, maxHeight, bottom: vh - r.top + MENU_GAP }
    : { left, width, maxHeight, top: r.bottom + MENU_GAP }
}

/**
 * A dropdown that is visibly a menu.
 *
 * Every picker in this product was a naked list painted straight into the page:
 * a row you press, and then N more rows appear underneath it and shove
 * everything below them down the screen. That is not a menu, it is an
 * accordion — it has no ground of its own, no edge, no elevation, it cannot say
 * which row is currently chosen, and on a 460px sheet it pushes the commit
 * button out of reach at the exact moment you were choosing what to commit.
 *
 * So this one is a real surface: its own `ink-850` ground, its own edge, its own
 * shadow (`.raised`, and see the note on `--color-shadow` for why a shadow is
 * allowed to exist at all), and it overlays rather than displaces.
 *
 * It is a portal, and `fixed` rather than `absolute`. An absolutely positioned
 * panel is clipped by the nearest scroll container, and the two callers this
 * exists for are *both* inside one — a sheet body and a page column — so an
 * anchored panel drawn in place would be cut off at exactly the point it became
 * a menu rather than three rows. Anchoring is done by measurement instead.
 *
 * The check is not decoration. Not one picker in the product told you which
 * value was already selected, so every one of them was a list of options with
 * the current answer hidden somewhere behind the trigger's own label.
 *
 * `z-[55]`: above a `Sheet` (50) because that is what it opens over, below the
 * palette (60) because ⌘K is allowed to cover everything.
 */
export function Menu<T extends string>({
  items, value, onPick, label, placeholder = '—', trigger,
  align = 'start', full, mono, ariaLabel, className = '',
}: {
  items: ReadonlyArray<MenuItem<T>>
  /** The row that gets the check. `null` when nothing is chosen yet. */
  value: T | null
  onPick: (id: T) => void
  /**
   * A quiet prefix inside the boxed trigger — `Repository`, `Range`. The
   * trigger reads `Repository  wake` rather than `wake`, which is what a
   * control in a sheet needs and a control in a page header does not; leave it
   * off there.
   */
  label?: string
  placeholder?: string
  /**
   * Draw the trigger yourself. It is handed the open state, the toggle and the
   * current item, and it does not need a ref: the wrapper is the anchor, so
   * whatever is rendered inside it is what the panel is measured against.
   */
  trigger?: (state: { open: boolean; toggle: () => void; current: MenuItem<T> | null }) => ReactNode
  /** Which edge of the trigger the panel lines up with. */
  align?: 'start' | 'end'
  /** Fill the width — what a control in a sheet does, not one in a header. */
  full?: boolean
  /** Repo paths, branches, channels: the texture is what tells them apart. */
  mono?: boolean
  ariaLabel?: string
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const [at, setAt] = useState<Anchor | null>(null)
  const anchorRef = useRef<HTMLSpanElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const still = useStill()

  const current = items.find(i => i.id === value) ?? null

  /** Every enabled row, in painted order — the list the keyboard walks. */
  const rows = () => [
    ...(panelRef.current?.querySelectorAll<HTMLButtonElement>('[data-menu-row]:not([disabled])') ?? []),
  ]

  // Escape and a pick put focus back on the trigger; an outside press does not,
  // because the thing that was pressed outside is where the person is going.
  const dismiss = () => setOpen(false)
  const close = () => {
    setOpen(false)
    anchorRef.current?.querySelector('button')?.focus()
  }

  useEffect(() => {
    if (!open) return
    const sync = () => { if (anchorRef.current) setAt(place(anchorRef.current, align)) }
    sync()
    window.addEventListener('resize', sync)
    // Capture, because the scroller that moves the trigger is usually an
    // ancestor and scroll does not bubble from an element to the window.
    window.addEventListener('scroll', sync, true)
    return () => {
      window.removeEventListener('resize', sync)
      window.removeEventListener('scroll', sync, true)
    }
  }, [open, align])

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node
      if (panelRef.current?.contains(t) || anchorRef.current?.contains(t)) return
      dismiss()
    }
    document.addEventListener('pointerdown', onDown, true)
    return () => document.removeEventListener('pointerdown', onDown, true)
  }, [open])

  /*
    The keyboard, taken over completely while the menu is up.

    Capture on `document`, which is what makes this work at all: `Sheet` binds
    Escape on `document` in the bubble phase and mounted first, so a bubble
    listener here would fire second and the sheet would already be gone —
    Escape would close the surface instead of the menu on it. A capture
    listener runs before every bubble listener on the same node, and
    `stopPropagation` there means the page's own `j`/`k`/`e`/`s` never see the
    keystroke either. Those keys are unconfirmed and two of them are
    destructive; a menu is modal to the keyboard for the same reason a sheet is.

    `stopPropagation` does not cancel a default action, so Enter and Space still
    activate the focused row the way they do on any button.
  */
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Tab') return dismiss()   // let focus leave; the menu is done
      e.stopPropagation()
      const list = rows()
      const here = list.findIndex(r => r === document.activeElement)
      const go = (n: number) => {
        e.preventDefault()
        list[Math.min(Math.max(n, 0), list.length - 1)]?.focus()
      }
      if (e.key === 'Escape') { e.preventDefault(); close() }
      else if (e.key === 'ArrowDown') go(here + 1)
      else if (e.key === 'ArrowUp') go(here - 1)
      else if (e.key === 'Home') go(0)
      else if (e.key === 'End') go(list.length - 1)
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [open])

  // The checked row takes focus, not the first one: a menu of forty repos opens
  // on the one you are using. A task rather than an animation frame — a hidden
  // document schedules no frames, and `palette.tsx` has the receipt.
  useEffect(() => {
    if (!open) return
    const id = setTimeout(() => {
      const list = rows()
      const target = list.find(r => r.getAttribute('aria-checked') === 'true') ?? list[0]
      target?.focus()
      target?.scrollIntoView({ block: 'nearest' })
    }, 0)
    return () => clearTimeout(id)
  }, [open])

  const toggle = () => setOpen(o => !o)
  let lastGroup = ''

  return (
    <span
      ref={anchorRef}
      className={`inline-flex ${full ? 'w-full [&>*]:w-full' : ''} ${className}`}
      // A trigger often sits in a row whose own click opens something, and
      // choosing a value is not asking to read the row — the same reason
      // `Select` stops these.
      onPointerDown={e => e.stopPropagation()}
      onClick={e => e.stopPropagation()}
    >
      {trigger
        ? trigger({ open, toggle, current })
        : (
          <button
            type="button"
            onClick={toggle}
            aria-haspopup="menu"
            aria-expanded={open}
            aria-label={ariaLabel ?? label}
            className="hit relative inline-flex items-center gap-2 h-8 px-3 rounded-control
                       border border-edge bg-ink-850 text-sm whitespace-nowrap
                       transition-colors duration-100 hover:bg-ink-800"
          >
            {label && <span className="text-fg-mute shrink-0">{label}</span>}
            <span className={`truncate min-w-0 ${full ? 'grow text-left' : ''}
              ${current ? 'text-fg' : 'text-fg-mute'} ${mono ? 'font-mono' : ''}`}>
              {current?.label ?? placeholder}
            </span>
            <ChevronDown size={13} aria-hidden
              className={`shrink-0 text-fg-mute transition-transform duration-100
                ${open ? 'rotate-180' : ''}`} />
          </button>
        )}

      {open && at && createPortal(
        <motion.div
          ref={panelRef}
          role="menu"
          aria-label={ariaLabel ?? label ?? 'Menu'}
          style={{ left: at.left, top: at.top, bottom: at.bottom, width: at.width, maxHeight: at.maxHeight }}
          // Entrance only. An exit that never runs — a hidden tab produces no
          // frames — leaves the panel on screen for good, and a menu that has
          // been picked from has no business lingering anyway.
          initial={still ? false : { opacity: 0, y: at.bottom !== undefined ? 4 : -4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={spring}
          className="fixed z-[55] overflow-y-auto overscroll-contain py-1
                     rounded-panel border border-edge glass"
        >
          {items.map(it => {
            const head = it.group && it.group !== lastGroup ? it.group : null
            lastGroup = it.group ?? ''
            const on = it.id === value
            return (
              <div key={it.id}>
                {head && (
                  <div className="text-eyebrow uppercase text-fg-mute px-3 pt-3 pb-1">{head}</div>
                )}
                <button
                  type="button"
                  data-menu-row
                  role="menuitemradio"
                  aria-checked={on}
                  disabled={it.disabled}
                  onClick={() => { close(); onPick(it.id) }}
                  className={`menu-row w-full flex items-center gap-3 px-3 text-left text-sm
                    outline-none transition-colors duration-100
                    disabled:opacity-40 disabled:pointer-events-none
                    hover:bg-ink-800 focus-visible:bg-ink-800
                    ${on ? 'text-fg' : 'text-fg-dim'}`}
                >
                  {/* The column is held whether or not the row is the chosen
                      one, so forty labels start on one x rather than jumping
                      16px at whichever row happens to be selected. */}
                  <Check size={14} aria-hidden
                    className={`shrink-0 text-accent-ink ${on ? '' : 'invisible'}`} />
                  <span className={`truncate grow min-w-0 ${mono ? 'font-mono' : ''}`}>{it.label}</span>
                  {it.meta && <span className="shrink-0 text-sm text-fg-mute tnum">{it.meta}</span>}
                </button>
              </div>
            )
          })}
          {!items.length && <p className="px-3 py-3 text-sm text-fg-mute">Nothing to choose from.</p>}
        </motion.div>,
        document.body,
      )}
    </span>
  )
}

/* --------------------------------- sheets --------------------------------- */

/**
 * One modal component for the whole app: a bottom sheet on a phone, a centred
 * panel on a laptop. Same content, so nothing is built twice.
 *
 * Opaque with a 1px edge. Elevation here is an edge on a flat surface — there is
 * no blur and no `shadow-2xl`, because a blurred translucent panel over a
 * near-black page reads as smear rather than as depth, and over an off-white one
 * it reads as nothing at all.
 *
 * The body scroll lock is not owned here: `useOverlay` owns it, so two sheets
 * closing in the wrong order cannot leave the page frozen at `hidden`.
 *
 * It portals to `document.body`, and that is the whole of why a sheet is
 * reachable on a phone.
 *
 * A sheet is `fixed inset-0 z-50`, but `z-50` is only a number inside whatever
 * stacking context it happens to be painted in. Every sheet in the product is
 * rendered by a page, every page is rendered inside the shell's `<main>`, and
 * `main` is `relative z-10` — a stacking context, so the sheet's 50 is a
 * ranking *among main's own children* and main's whole subtree still paints at
 * 10. The phone tab bar is `z-30` and a sibling of main, so it painted over the
 * bottom 53px of every sheet in the app: the footer, which is where the one
 * control that commits lives. Hit-tested at 375×812, the centre of `Add task`
 * returned the `Sessions` tab.
 *
 * Fixing it by lowering the bar or raising the number would be a fix for one
 * pair. The rule instead: **the shell owns everything above z-30, page content
 * is capped at main's 10, and anything that must cover the shell leaves the
 * page subtree.** `Menu`, `Peek` and the desk's push sheet already portal for
 * this reason; `Sheet` was the last overlay still drawn inside the page. Out
 * here, `z-50` means what it says, and it also survives a page that later grows
 * a `transform` or a `filter` — either of which would re-trap a fixed child no
 * matter what its z-index said.
 *
 * `main`'s `relative z-10` stays. It is not the bug; it is the cap that keeps a
 * page's own sticky headers under the rails, and it is what makes the rule
 * above enforceable rather than a convention every new overlay has to remember.
 */
/**
 * How much of the viewport the software keyboard is currently covering.
 *
 * `dvh` already handles the browser's own chrome — that is what the note on the
 * panel below is about — but it does not handle this. On iOS the keyboard does
 * not resize the layout viewport at all: `100dvh` stays exactly as tall as it
 * was, the page simply gets scrolled under a keyboard drawn on top of it. So a
 * bottom-anchored sheet keeps its footer at the bottom of a viewport that is no
 * longer visible, and the one control that commits ends up behind the keys —
 * which on this product is `Add`, `Send`, and `Delete permanently`.
 *
 * `visualViewport` is the only API that reports it. The inset is the gap
 * between the layout viewport and the visual one, less however far the page has
 * been scrolled to accommodate it; clamped at zero because pinch-zoom moves the
 * same numbers around and must not push the sheet anywhere.
 */
function useKeyboardInset(active: boolean): number {
  const [inset, setInset] = useState(0)

  useEffect(() => {
    const vv = typeof window !== 'undefined' ? window.visualViewport : null
    if (!active || !vv) return
    const measure = () =>
      setInset(Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop)))
    measure()
    vv.addEventListener('resize', measure)
    vv.addEventListener('scroll', measure)
    return () => {
      vv.removeEventListener('resize', measure)
      vv.removeEventListener('scroll', measure)
    }
  }, [active])

  // Nothing is left open across a keyboard dismissal, and a stale inset would
  // hold the next sheet up off the floor for no reason.
  useEffect(() => { if (!active) setInset(0) }, [active])

  return inset
}

export function Sheet({
  open, onClose, title, children, footer, wide,
}: {
  open: boolean; onClose: () => void; title?: string
  children: ReactNode; footer?: ReactNode
  /**
   * A reading width rather than a control width. 460px is right for a form of
   * short fields; it is wrong for anything you have to actually read, and a
   * brief reviewed through a 460px column of monospace is not reviewed.
   */
  wide?: boolean
}) {
  const still = useStill()
  useOverlay(open)
  const keyboard = useKeyboardInset(open)

  // Escape closes every overlay in the product.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  return createPortal(
    <AnimatePresence>
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-end sm:items-center sm:justify-center
                     pb-[var(--nav-h)] sm:pb-0"
          /*
            The strip the tab bar owns, kept clear on the phone.

            A sheet is `z-50` and the bar is `z-30`, so a footer that reached the
            bottom edge was still tappable — but it sat *over* all six
            destinations, and "nothing may cover the tab bar" is a rule this
            product already paid for once with the card detail. Reserving the
            strip here rather than on the panel means the panel's own
            `pad-bottom` is no longer needed below `sm`: `--nav-h` already
            contains the home indicator, and adding both counted it twice.

            When the keyboard is up it replaces the bar rather than joining it —
            the bar is behind the keys either way, so paying for both would
            push the sheet up by 53px of nothing.
          */
          style={{ paddingBottom: keyboard > 0 ? 0 : undefined }}
        >
          <motion.div
            className="absolute inset-0 glass-scrim"
            initial={still ? false : { opacity: 0 }} animate={{ opacity: 1 }}
            exit={still ? undefined : { opacity: 0 }}
            transition={{ duration: 0.18 }}
            onClick={onClose}
          />
          <motion.div
            role="dialog" aria-modal="true" aria-label={title}
            /*
              `dvh`, not `vh`, and it is not a preference.

              `vh` is the LARGE viewport: the height the page would have if the
              browser chrome were retracted. On iOS with the URL bar showing,
              88vh of that is taller than what is actually on screen, so the
              bottom of the sheet — which is where the footer is, which is where
              the one control that commits is — sat underneath the browser's own
              chrome, unreachable and un-scrollable-to. `dvh` is the viewport
              that is really there, and it re-measures as the chrome comes and
              goes. Every other height in this app was already `dvh`; this was
              the one that was not.
            */
            className={`relative w-full ${wide ? 'sm:max-w-[760px]' : 'sm:max-w-[460px]'} glass
                       border border-edge sm:rounded-panel rounded-t-panel
                       max-h-[88dvh] flex flex-col`}
            /*
              The keyboard is lifted out of the panel's way rather than scrolled
              around. `marginBottom` moves the whole bottom-anchored panel up by
              exactly what the keys cover, and the matching `maxHeight` stops it
              growing back down into them — without that second half an 88dvh
              sheet simply keeps its height and pushes its own header off the
              top of the screen instead.
            */
            style={keyboard > 0
              ? { marginBottom: keyboard, maxHeight: `calc(88dvh - ${keyboard}px)` }
              : undefined}
            // Not animated in when frames are not being produced. `y: '100%'`
            // is a real transform the moment it is applied, so a slide-up that
            // never runs leaves the panel a full panel-height below the fold —
            // its buttons unreachable, with nothing to scroll to reach them.
            initial={still ? false : { y: '100%', opacity: 0.6 }}
            animate={{ y: 0, opacity: 1 }}
            exit={still ? undefined : { y: '100%', opacity: 0.6 }}
            // A sheet has a panel's worth of travel and comes up under a thumb,
            // so it settles on a spring rather than running out a fixed 180ms.
            transition={softSpring}
          >
            {title && (
              <div className="flex items-center justify-between gap-3 px-4 h-12 shrink-0 border-b border-rule">
                <h2 className="text-md font-medium tracking-[-0.01em] truncate">{title}</h2>
                <Button variant="ghost" size="sm" onClick={onClose} ariaLabel="Close" title="Close">
                  <X size={14} />
                </Button>
              </div>
            )}
            {/*
              The bottom pad is on the content, not on the scroller.

              A `position: sticky` box is held inside the scrollport *less the
              scroll container's padding*, so a scroller with `py-4` parks a
              `bottom-0` bar 16px above its own bottom edge — measured — and
              rows then scroll through the strip underneath the one control on
              the surface that commits. Moving that 16px inside the scrolled
              content leaves every other sheet's breathing room exactly where it
              was and lets a sticky bar cancel it with `-mb-4`, the way it
              already cancels the horizontal pad with `-mx-4`.
            */}
            <div className="overflow-y-auto overscroll-contain min-h-0 px-4 pt-4 grow">
              <div className="pb-4">{children}</div>
            </div>
            {/*
              The commit strip, and it is stronger than `position: sticky`.

              Callers still put their primary button inside the scrolled body,
              which on a phone means the one control that commits scrolls away
              under the fold — so this slot has to be worth moving into. It is a
              flex sibling of the scrollport rather than a `sticky` box inside
              it: sticky is held within the scroll container and can be pushed by
              its padding, can be overlapped by the content it is holding above,
              and disappears entirely if an ancestor ever grows an
              `overflow: hidden`. A sibling that never scrolls cannot do any of
              those things. `shrink-0` here and `min-h-0` on the scroller above
              are the pair that guarantees it: the body gives up height, the
              footer never does, however tall the content gets.

              The ground is painted explicitly rather than inherited, so the
              strip stays opaque over whatever is passing behind it, and the
              overlay's `--nav-h` pad carries the home indicator — which is why
              this does not add a safe-area pad of its own and must not grow one:
              two would count the indicator twice.

              No layout is imposed on the slot. Four callers already pass their
              own row — `flex gap-2`, `space-y-2`, a bare full-width button — and
              a flex container here would silently re-arrange all of them.
            */}
            {footer && (
              <div className="px-4 py-3 shrink-0 bg-ink-850 border-t border-rule">{footer}</div>
            )}
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
    document.body,
  )
}

/* --------------------------------- fields --------------------------------- */

/**
 * A label and a control.
 *
 * `hint` is gone from the signature on purpose. Sixty-one distinct explanatory
 * strings shipped across five routes and six overlays, most of them a second
 * paragraph under a field — and a control that needs a paragraph is the wrong
 * control. Removing the prop is what keeps them from coming back without a code
 * change. The few strings that are safety controls rather than help text live
 * next to the action they guard, written out, not passed through here.
 */
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block mb-4">
      <div className="text-eyebrow uppercase text-fg-mute mb-2">{label}</div>
      {children}
    </label>
  )
}

export const inputClass =
  `w-full bg-ink-850 border border-edge rounded-control px-3 py-2 text-base text-fg
   placeholder:text-fg-mute outline-none transition-shadow
   focus:ring-1 focus:ring-accent/50`

/**
 * A closed set of values, as one control that fits inside a table row.
 *
 * A native `<select>`, deliberately. Every hand-rolled dropdown in a scrolling
 * table has to solve clipping, focus return and pointer capture, and iOS gives
 * a native one a wheel picker that is better than anything that could be built
 * here. `appearance-none` takes the platform chrome off and the chevron is
 * drawn back on behind `pointer-events-none`, so the whole box is the target.
 *
 * 28px, so it sits inside a 44px data row without setting the row's height —
 * and 44px to a finger, which is why the box is painted by the wrapper and not
 * by the control. A `<select>` generates no `::after`, so `.hit` cannot reach
 * it and all three desk filters plus Status and Priority measured 27px of
 * target; `.hit-native` grows the control itself and gives the height back as a
 * negative margin, which only works if the border it would otherwise draw at
 * 44px lives on something else. See the note in `styles.css`.
 *
 * `onClick`/`onPointerDown` stop propagating: a Status control lives in a row
 * whose own click opens the detail, and changing a status is not asking to read
 * the card.
 */
export function Select<T extends string>({
  value, options, onChange, ariaLabel, className = '',
}: {
  value: T
  options: ReadonlyArray<{ id: T; label: string }>
  onChange: (v: T) => void
  ariaLabel: string
  className?: string
}) {
  return (
    <span className={`relative inline-flex items-center shrink-0 h-7 rounded-control
                      border border-edge text-fg-dim hover:text-fg hover:bg-ink-800
                      transition-colors duration-100 ${className}`}>
      <select
        aria-label={ariaLabel}
        value={value}
        onChange={e => onChange(e.target.value as T)}
        onClick={e => e.stopPropagation()}
        onPointerDown={e => e.stopPropagation()}
        className="hit-native appearance-none h-full w-full pl-2 pr-5 border-0
                   bg-transparent text-sm text-inherit outline-none truncate"
      >
        {options.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
      </select>
      <ChevronDown size={13} aria-hidden
        className="absolute right-1 text-fg-mute pointer-events-none" />
    </span>
  )
}

/**
 * A real calendar, not four presets.
 *
 * `datetime-local` is the whole point: the operator asked to pick a date, and
 * every preset ladder this product shipped answered a different question — how
 * far away, rather than when. Presets may sit beside this; they may not replace
 * it. `toLocalInput`/`fromLocalInput` handle the wall-clock round trip and its
 * daylight-saving trap; see `lib/time.ts`.
 *
 * The Clear control is separate and only rendered once there is something to
 * clear, because an empty field with a cross beside it is two ways to say the
 * same nothing.
 *
 * The border sits on the wrapper for the same reason it does on `Select`: the
 * input grows to a 44px target on a finger and gives the height straight back,
 * and a border on the input would paint that target instead of the 32px field.
 * The focus ring follows the border, so `:has()` puts it on the wrapper.
 */
export function DateField({
  value, onChange, ariaLabel,
}: { value: number | null; onChange: (ms: number | null) => void; ariaLabel: string }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span className="relative inline-flex items-center h-8 rounded-control border border-edge
                       transition-shadow has-[input:focus]:ring-1 has-[input:focus]:ring-accent/50">
        <input
          type="datetime-local"
          aria-label={ariaLabel}
          value={toLocalInput(value)}
          onChange={e => onChange(fromLocalInput(e.target.value))}
          onClick={e => e.stopPropagation()}
          onPointerDown={e => e.stopPropagation()}
          className="hit-native [--hit-ink:32px] h-full px-2 border-0 bg-transparent
                     text-sm text-fg-dim outline-none"
        />
      </span>
      {value !== null && (
        <Button size="sm" variant="ghost" title="Clear" ariaLabel="Clear"
          onClick={() => onChange(null)}>
          <X size={13} />
        </Button>
      )}
    </span>
  )
}

/**
 * The weekday strip, in the reader's own locale, Monday first.
 *
 * Built from a known Monday — 2024-01-01 — rather than from a hard-coded list,
 * so a reader whose machine is set to French gets `LUN MAR MER`. `short` and
 * not `narrow`: narrow renders `M T W T F S S` in English, where two pairs are
 * the same letter, and a column header that cannot be told from its neighbour
 * is not a header.
 */
const WEEKDAYS = Array.from({ length: 7 }, (_, i) =>
  new Date(2024, 0, 1 + i).toLocaleDateString(undefined, { weekday: 'short' }))

/**
 * A month, a day and a time — not three chips and an escape hatch.
 *
 * What shipped was `Today 5pm`, `Tomorrow 9am`, `Mon 9am` and a native field
 * behind them. Those three answer *how far away*, which is a different question
 * from *when*, and the escape hatch answered the right one in a control that
 * looks like a fallback. An operator picking a deadline is picking a date; the
 * calendar is the primary control and the presets, if any survive, sit beside
 * it.
 *
 * No date library, and none is wanted for this. Everything here is `Date`
 * arithmetic on local wall-clock parts, which is also the only kind that
 * survives a daylight-saving boundary — the same reason `toLocalInput` in
 * `lib/time.ts` builds its string from parts instead of subtracting an offset.
 * That helper is reused for the time half rather than reimplemented.
 *
 * The layout is a CONTAINER query, not a viewport one. This is dropped into a
 * 460px sheet, a 760px wide sheet and a page column, and the question it has to
 * answer is "is there room beside the grid", which is a fact about the box it
 * was put in and not about the phone it is on. `@md` is 448px: below that the
 * time control goes under the calendar and the grid gets the whole width, which
 * is what keeps a 375px phone at 45px cells.
 */
export function DateTimePicker({
  value, onChange, ariaLabel = 'Date and time', className = '',
}: {
  /** Epoch milliseconds, or `null` for no date at all. */
  value: number | null
  onChange: (ms: number | null) => void
  ariaLabel?: string
  className?: string
}) {
  const now = new Date()
  const [view, setView] = useState(() => {
    const d = value !== null ? new Date(value) : now
    return { y: d.getFullYear(), m: d.getMonth() }
  })
  // The keyboard's own position, which is not the selection: arrowing across a
  // month should not set a deadline on every day it passes over.
  const [cursor, setCursor] = useState(() => new Date(value ?? Date.now()))
  const gridRef = useRef<HTMLDivElement>(null)

  // A value set from somewhere else — a preset chip beside this, an undo —
  // brings the view with it. Paging months by hand does not fight this: picking
  // a day in the month you paged to lands the value in that same month.
  useEffect(() => {
    if (value === null) return
    const d = new Date(value)
    setView({ y: d.getFullYear(), m: d.getMonth() })
    setCursor(d)
  }, [value])

  // Focus follows the cursor only when the grid already had it, so mounting the
  // picker inside a sheet does not steal focus from the field above it.
  useEffect(() => {
    const grid = gridRef.current
    if (!grid || !grid.contains(document.activeElement)) return
    grid.querySelector<HTMLElement>('[data-cursor="true"]')?.focus()
  }, [cursor])

  const key = (d: Date) => d.getFullYear() * 10000 + d.getMonth() * 100 + d.getDate()
  const selected = value !== null ? key(new Date(value)) : null
  const today = key(now)

  /*
    Six weeks, always, whether or not the month needs the sixth.

    A grid that is five rows in February and six in March changes height when
    you page it, which moves the control underneath it and — inside a sheet —
    can move the commit button out from under a thumb already travelling toward
    it. 42 cells is the cheapest way to make paging a month cost nothing.
  */
  const first = new Date(view.y, view.m, 1)
  const lead = (first.getDay() + 6) % 7   // Monday-first, so Sunday leads by 6
  const days = Array.from({ length: 42 }, (_, i) => new Date(view.y, view.m, 1 - lead + i))

  const step = (months: number) =>
    setView(v => {
      const d = new Date(v.y, v.m + months, 1)
      return { y: d.getFullYear(), m: d.getMonth() }
    })

  /**
   * A day, keeping whatever time was already set.
   *
   * 9am when there is none: a date chosen with no time means the morning of
   * that day, and midnight would mean the night before it to everybody except a
   * computer.
   */
  const pickDay = (d: Date) => {
    const had = value !== null ? new Date(value) : null
    onChange(new Date(
      d.getFullYear(), d.getMonth(), d.getDate(),
      had ? had.getHours() : 9, had ? had.getMinutes() : 0, 0, 0,
    ).getTime())
  }

  /** A time with no date yet lands on the day the cursor is standing on. */
  const pickTime = (hhmm: string) => {
    if (!hhmm) return
    const [h, mi] = hhmm.split(':')
    const base = value !== null ? new Date(value) : new Date(cursor.getTime())
    base.setHours(Number(h ?? 0), Number(mi ?? 0), 0, 0)
    onChange(base.getTime())
  }

  const move = (e: ReactKeyboardEvent<HTMLDivElement>, dayDelta: number, monthDelta = 0) => {
    e.preventDefault()
    // The day is clamped when the month moves, because JS rolls the overflow
    // forward: `new Date(y, 1, 31)` is the 2nd or 3rd of March, so paging back
    // from the 31st of March would land two months from where it was aimed.
    // Day 0 of the next month is the last day of this one.
    const last = new Date(cursor.getFullYear(), cursor.getMonth() + monthDelta + 1, 0).getDate()
    const day = monthDelta === 0 ? cursor.getDate() : Math.min(cursor.getDate(), last)
    const next = new Date(cursor.getFullYear(), cursor.getMonth() + monthDelta, day + dayDelta)
    setCursor(next)
    setView({ y: next.getFullYear(), m: next.getMonth() })
  }

  const onGridKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowLeft') move(e, -1)
    else if (e.key === 'ArrowRight') move(e, 1)
    else if (e.key === 'ArrowUp') move(e, -7)
    else if (e.key === 'ArrowDown') move(e, 7)
    else if (e.key === 'Home') move(e, -((cursor.getDay() + 6) % 7))
    else if (e.key === 'End') move(e, 6 - ((cursor.getDay() + 6) % 7))
    else if (e.key === 'PageUp') move(e, 0, -1)
    else if (e.key === 'PageDown') move(e, 0, 1)
  }

  return (
    <div role="group" aria-label={ariaLabel} className={`@container ${className}`}>
      <div className="flex flex-col gap-4 @md:flex-row @md:items-start">
        <div className="min-w-0 grow">
          <div className="flex items-center gap-2 mb-2">
            <Button size="sm" variant="ghost" onClick={() => step(-1)}
              title="Previous month" ariaLabel="Previous month">
              <ChevronLeft size={14} />
            </Button>
            {/* The month is the heading, and it is `tnum` because paging it must
                not shift the two controls either side of it. */}
            <span className="text-sm font-medium text-fg tnum grow text-center truncate">
              {first.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}
            </span>
            <Button size="sm" variant="ghost" onClick={() => step(1)}
              title="Next month" ariaLabel="Next month">
              <ChevronRight size={14} />
            </Button>
          </div>

          <div className="grid grid-cols-7 gap-1 mb-1" aria-hidden>
            {WEEKDAYS.map(d => (
              <span key={d} className="text-eyebrow uppercase text-fg-mute text-center truncate">{d}</span>
            ))}
          </div>

          <div ref={gridRef} className="grid grid-cols-7 gap-1" onKeyDown={onGridKey}>
            {days.map(d => {
              const k = key(d)
              const outside = d.getMonth() !== view.m
              const on = k === selected
              const isToday = k === today
              const isCursor = k === key(cursor)
              return (
                <button
                  key={k}
                  type="button"
                  data-cursor={isCursor}
                  tabIndex={isCursor ? 0 : -1}
                  aria-pressed={on}
                  aria-current={isToday ? 'date' : undefined}
                  aria-label={d.toLocaleDateString(undefined, {
                    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
                  })}
                  onClick={() => { setCursor(d); pickDay(d) }}
                  className={`cal-cell flex items-center justify-center rounded-control
                    text-sm tnum transition-colors duration-100
                    ${on ? 'bg-accent text-on-accent font-semibold'
                      : isToday ? 'text-fg font-medium ring-1 ring-edge hover:bg-ink-800'
                      : outside ? 'text-fg-mute hover:bg-ink-800'
                      : 'text-fg-dim hover:bg-ink-800'}`}
                >
                  {d.getDate()}
                </button>
              )
            })}
          </div>
        </div>

        {/*
          The time, beside the calendar where there is room and under it where
          there is not.

          A native `<input type="time">` on purpose, for the reason `Select`
          gives for a native popup: iOS hands it a wheel that is better than
          anything that could be built here, and a keyboard gets real digit
          entry for free. The border is on the wrapper because `.hit-native`
          grows the control itself to 44px on a finger and gives the height back
          as a negative margin — a border on the input would paint the target
          rather than the 32px field.
        */}
        <div className="flex items-center gap-3 @md:flex-col @md:items-stretch @md:w-40 shrink-0">
          <span className="text-eyebrow uppercase text-fg-mute shrink-0 @md:mb-1">Time</span>
          <span className="relative inline-flex items-center h-8 grow @md:grow-0 rounded-control
                           border border-edge transition-shadow
                           has-[input:focus]:ring-1 has-[input:focus]:ring-accent/50">
            <input
              type="time"
              aria-label="Time"
              value={value === null ? '' : toLocalInput(value).slice(11)}
              onChange={e => pickTime(e.target.value)}
              className="hit-native [--hit-ink:32px] h-full w-full px-2 border-0 bg-transparent
                         text-sm text-fg outline-none"
            />
          </span>
          <span className="flex items-center gap-2 shrink-0 @md:justify-between">
            {/* Back to this month, and nothing else. It moves the view and the
                cursor; it does not select today, because a control that
                sometimes navigates and sometimes commits is two controls. */}
            <Button size="sm" variant="ghost" onClick={() => {
              const t = new Date()
              setView({ y: t.getFullYear(), m: t.getMonth() })
              setCursor(t)
            }}>Today</Button>
            {/* Only once there is something to clear: an empty field with a
                Clear beside it is two ways of saying the same nothing. */}
            {value !== null && (
              <Button size="sm" variant="ghost" onClick={() => onChange(null)}>Clear</Button>
            )}
          </span>
        </div>
      </div>
    </div>
  )
}

/**
 * How many rows a page holds, everywhere in the product.
 *
 * One number rather than one per list: `Pager` renders the range it is standing
 * over, so a caller that sliced by 25 and a pager that counted by 50 would
 * print a range that does not describe the rows underneath it. `pageCount` and
 * `pageSlice` are here so nobody has to re-derive the clamp either.
 */
export const PAGE_SIZE = 50

export const pageCount = (total: number) => Math.max(1, Math.ceil(total / PAGE_SIZE))

/** The rows for `page`, with `page` clamped into the list that actually exists. */
export function pageSlice<T>(rows: readonly T[], page: number): T[] {
  const p = Math.min(Math.max(page, 1), pageCount(rows.length))
  return rows.slice((p - 1) * PAGE_SIZE, p * PAGE_SIZE) as T[]
}

/**
 * One page of a list, and how to get to the next.
 *
 * Prev and Next, and no numbered strip: a strip is N controls to say what two
 * plus a count already say, and at page 40 it is either a scrolling row of
 * digits or an ellipsis menu, which this product does not have. The range and
 * the total are the orientation; the two buttons are the movement.
 *
 * The disabled ends are real `disabled` attributes rather than a dimmed style,
 * so a screen reader and a finger get the same answer as the eye.
 *
 * It renders nothing when one page holds everything — a pager over 12 rows is
 * chrome reporting that there is no second page.
 */
export function Pager({
  page, pages, total, onPage,
}: { page: number; pages: number; total: number; onPage: (n: number) => void }) {
  if (total === 0 || pages <= 1) return null
  const from = (page - 1) * PAGE_SIZE + 1
  const to = Math.min(page * PAGE_SIZE, total)

  return (
    <div className="flex items-center gap-3 py-3">
      <span className="text-sm text-fg-mute tnum">{from}–{to} of {total}</span>
      <span className="ml-auto flex items-center gap-2">
        <Button size="md" variant="default" disabled={page <= 1}
          title="Previous page" ariaLabel="Previous page" onClick={() => onPage(page - 1)}>
          <ChevronLeft size={14} />
        </Button>
        <Button size="md" variant="default" disabled={page >= pages}
          title="Next page" ariaLabel="Next page" onClick={() => onPage(page + 1)}>
          <ChevronRight size={14} />
        </Button>
      </span>
    </div>
  )
}

export function Chip({
  active, onClick, children, dot, mark, disabled, title, ariaLabel, flexible,
}: {
  active?: boolean; onClick?: () => void; children: ReactNode
  /**
   * This chip may give up width rather than push its neighbours off the screen.
   *
   * A chip is `shrink-0` by default, which is right for a row that fits and
   * wrong for the one chip in it that carries a variable-length name. Six
   * controls and a name like `Claude Code` do not fit 358px, and the row is
   * required not to scroll, so that name truncates instead.
   */
  flexible?: boolean
  /** A colour swatch — a goal's colour, and nothing that has a mark of its own. */
  dot?: string
  /**
   * A mark the caller draws itself, which wins over `dot`.
   *
   * A phone has no hover, so a row of chips whose only identification is a
   * `title` attribute is a row of anonymous lozenges until you tap one. A chip
   * that stands for something with a glyph elsewhere in the product carries that
   * same glyph here.
   */
  mark?: ReactNode
  disabled?: boolean; title?: string; ariaLabel?: string
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={ariaLabel}
      aria-pressed={active}
      className={`hit relative inline-flex items-center gap-2 h-8 px-2 rounded-control text-sm
        font-medium transition-colors duration-100 whitespace-nowrap
        ${flexible ? 'min-w-0' : 'shrink-0'}
        disabled:opacity-40 disabled:pointer-events-none
        ${active ? 'bg-ink-800 text-fg border border-edge' : 'text-fg-mute hover:text-fg-dim hover:bg-ink-800 border border-transparent'}`}
    >
      {mark ?? (dot && <span className="w-2 h-2 rounded-full shrink-0" style={{ background: dot }} />)}
      {children}
    </button>
  )
}

/**
 * A whole surface that is empty says one word, on the row grid.
 *
 * One line at the content's own x, exactly one row tall. Never centred, never a
 * sentence, never a number, never an icon — and never naming the filter, since
 * the pressed chip already does. Naming it was three chapters' worth of apology
 * compressed into one line. Default `—`, because most callers are a value that
 * has nothing in it rather than a surface that is empty.
 *
 * An empty *group* does not use this. It is not rendered at all.
 */
export function Empty({ children = '—' }: { children?: ReactNode }) {
  return (
    <p className="text-sm text-fg-mute h-11 flex items-center">{children}</p>
  )
}

/**
 * A page's title, and the mark only a phone needs.
 *
 * On the laptop the rail carries the mark. A phone has no rail, and a header
 * band added just to hold a logo would cost 48px of the fold on the one screen
 * where the fold is the product — so the mark rides the title row instead. Six
 * routes hand-rolled that row and four of them forgot it: Mail, Sessions, Pulse
 * and Settings each opened with a bare word in the body font, which is what the
 * rail looked like before it had a mark at all.
 *
 * A fragment rather than a wrapper, so each header keeps its own flex row — the
 * count, the range control and the one commit all sit on that row and none of
 * them belong to this.
 */
export function PageTitle({ children }: { children: ReactNode }) {
  return (
    <>
      <WakeMark size={16} className="text-accent shrink-0 sm:hidden" />
      <h1 className={PAGE_TITLE}>{children}</h1>
    </>
  )
}

/* ---------------------------------- rows ---------------------------------- */

/**
 * A count that can be read at arm's length.
 *
 * The desk's "+2" was `text-accent-ink tnum text-sm` — amber 13px text with
 * nothing around it, sitting immediately after a 14px semibold title in the
 * same warm family. On a phone at 7am it is not a badge, it is a typo in the
 * title. The one badge in this product that works is the phone tab bar's, and
 * this is deliberately that badge, to the pixel: filled accent, `on-accent`
 * ink, 16px tall, `xs`/600, tabular, pill. Two badge shapes is one badge shape
 * too many, so if this changes, that one changes with it.
 *
 * No responsive sizes. A number that is legible on a laptop and a phone is the
 * same number at the same size; making it smaller on the smaller screen is
 * exactly backwards.
 *
 * `99+` because a three-digit badge sets the width of a column that is
 * otherwise elastic, and past ninety-nine the exact figure has stopped being
 * information.
 */
export function CountBadge({
  count, plus, title,
}: {
  count: number
  /**
   * Render `+3` rather than `3`. The desk means "three things arrived since you
   * last looked"; the tab bar means "three things are waiting". The fill says
   * amber either way — the sign is what separates a delta from a total.
   */
  plus?: boolean
  title?: string
}) {
  if (count <= 0) return null
  return (
    <span
      title={title}
      className="inline-flex items-center justify-center shrink-0 min-w-4 h-4 px-1
                 rounded-full bg-accent text-on-accent text-xs font-semibold leading-4
                 text-center tnum"
    >
      {plus ? '+' : ''}{count > 99 ? '99+' : count}
    </span>
  )
}

/**
 * What state a row is in, as one answer, for every list in the product.
 *
 * The bug this exists to end: a SELECTED row and a HOVERED row were both
 * `bg-ink-800`, on the desk and in Mail, so the row the detail pane was
 * actually showing was invisible the moment the pointer was anywhere near the
 * list. It was not a careless choice — `ink-700`, the only other step
 * available, measures 1.08:1 against `ink-800`, which is not a difference. The
 * fix had to be a new ground, not a different existing one; `row-sel` and
 * `row-new` are in `styles.css` with the measurements.
 *
 * Three channels, one per kind of fact:
 *
 *   LIGHTNESS says how much this row is being attended to. Hover is the
 *   faintest lift and it is transient. `row-sel` is 15% above it and it is not
 *   transient — that is the row the pane is showing, and it stays lit while you
 *   read it.
 *
 *   HUE says something arrived. `row-new` is the same lightness as hover and a
 *   different temperature, because "new since you last looked" is not a degree
 *   of "your pointer is here", and a warm wash reads across a whole row at a
 *   glance without being a stripe. It replaces the 2px amber bar on the row's
 *   first cell, which said the same thing in the corner of one column and could
 *   not be seen at all on the phone list, where the same 2px sat under a thumb.
 *
 *   THE LEADING EDGE says where the keyboard is. Exactly one row on a screen
 *   has the `j`/`k` cursor, so this is one amber mark and the accent budget
 *   survives it. It is a separate channel from the fill on purpose: the cursor
 *   crosses the selected row constantly, and a cursor that disappears for one
 *   row in twenty is a cursor you stop trusting. Selected-and-focused is a lit
 *   ground with a rule on it, and it reads as both, because it is both.
 *
 * Hover is emitted only on a row that has no other state. A hover tint on a
 * `row-new` wash would overwrite it — same property, and Tailwind orders
 * variants last — so the row would stop looking new for exactly as long as you
 * were pointing at it, which is when you are reading it.
 *
 * It returns a class string rather than rendering anything, because the four
 * lists that need it are a `<tr>`, an `<li>`, a `<button>` and a `<div>`. That
 * is also why the cursor is a background gradient rather than a border or a
 * box-shadow: a `<tr>` under `border-collapse` paints neither of those. See
 * `.row-cursor`.
 */
export type RowState = {
  /** This is the row the detail pane is showing. */
  selected?: boolean
  /** Mail's name for `selected`. One state, two vocabularies, no rename. */
  active?: boolean
  /** The `j`/`k` cursor is standing on this row. */
  focused?: boolean
  /** Something arrived here since it was last read. */
  unseen?: boolean
}

export function rowStateClass({ selected, active, focused, unseen }: RowState = {}): string {
  const chosen = selected || active
  const ground =
    chosen ? 'bg-row-sel'
    : focused ? 'bg-ink-700'
    : unseen ? 'bg-row-new'
    : 'hover:bg-ink-800'
  return `transition-colors duration-100 ${ground}${focused ? ' row-cursor' : ''}`
}

/**
 * Whether a rail still has something past its right edge.
 *
 * A hidden scrollbar is the right call — a scrollbar under six filter chips is
 * noise — but it leaves a rail that overflows looking like a rail that is
 * broken: the last chip is sliced by the screen edge and nothing says why. This
 * is the one bit of state the fade in `styles.css` needs; hang it on the
 * wrapper as `data-spill`.
 *
 * `spill` rather than `more`, which is the word this describes and the word the
 * product has already spent. `More` is what an overflow menu is called here,
 * and a contract test bans that setter's name across `src/web` on sight — this
 * is not one, so it does not borrow the name.
 *
 * Three listeners and a re-read, because four different things change the
 * answer: scrolling it, resizing the window, resizing the rail alone, and
 * putting one more chip in a rail that has not moved. The window listener is
 * not redundant with the observer — a `ResizeObserver` delivers on an animation
 * frame, and a hidden tab produces none, so the rail would come back from the
 * background still describing the width it had when it left.
 *
 * There used to be a second answer here, `moved` — is there anything *behind*
 * this scroller — for the 1px edge on the phone desk's pinned Title column.
 * Nothing is pinned any more, so it went with the pinning rather than staying on
 * as a fact with no reader.
 *
 * `spill` gained a second reader in its place, and it is worth knowing about
 * because it is not what the name suggests: on the phone desk its *absence* is
 * the signal. No spill means the table is scrolled to its end, which is the
 * moment the horizontal axis stops belonging to the scroller and starts
 * belonging to the row's swipe drawer. See `[data-atend]` in `styles.css`.
 */
export function useRail<T extends HTMLElement>(): {
  ref: RefObject<T | null>
  /** Something past the right edge. Its absence is "scrolled to the end". */
  spill: boolean
} {
  const ref = useRef<T>(null)
  const [spill, setSpill] = useState(false)

  const read = () => {
    const el = ref.current
    if (!el) return
    setSpill(el.scrollLeft + el.clientWidth < el.scrollWidth - 1)
  }

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.addEventListener('scroll', read, { passive: true })
    window.addEventListener('resize', read)
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => {
      el.removeEventListener('scroll', read)
      window.removeEventListener('resize', read)
      ro.disconnect()
    }
  }, [])

  useEffect(read)

  return { ref, spill }
}
