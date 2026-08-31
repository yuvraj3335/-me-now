/**
 * Sync — pipe 1, as a control.
 *
 * There are two pipes and only one of them had a button. `Fetch` goes out to
 * the connectors on this box and asks them the two standing questions; `Sync`
 * re-polls the sources Wake is already connected to, with its own credentials.
 * They can see different things, so neither replaces the other — and until now
 * Sync was reachable only from ⌘K, one line in a command list, unlabelled as
 * the peer of the button sitting next to it.
 *
 * It is deliberately the quieter of the two. Fetch reaches machines outside
 * Wake, takes the better part of a minute and can start a model; Sync re-asks
 * credentials Wake already holds and is over in a second or two. One bordered
 * control on that row is enough and it belongs to the expensive one, so this is
 * a ghost.
 *
 * Why this one carries a menu when Fetch deliberately does not: Fetch is scoped
 * by the tab strip because you press it about the thing in front of you. The
 * reason to press Sync is almost always something you just did somewhere else —
 * you merged the pull request, you answered in Slack — and that is rarely the
 * tab you are standing on. So the source list rides the control. The main press
 * still follows the tab, which is what keeps the two buttons from ever
 * disagreeing about what "here" means.
 */

import { useCallback, useState } from 'react'
import type { JSX } from 'react'
import { ChevronDown, Loader2, RefreshCw } from 'lucide-react'
import { refresh, useStore, type SyncReport } from '../lib/api'
import { pipesFor } from '../lib/bucket'
import { toast } from '../lib/toast'
import type { SourceName } from '../lib/types'
import { ago, timeOfDay } from '../lib/time'
import { Button, Menu, type MenuItem } from './primitives'
import { SOURCE_LABEL } from './sources'

type Scope = SourceName | 'all'

/** What either control on the header row answers with when it is done. */
export type ResultLine = { text: string; title?: string }

/**
 * Tailwind's `lg`: the width at which the header row can afford a sentence.
 *
 * It used to be `sm`, and 640px is not enough room — measured rather than
 * guessed. *Two* controls sit on this row and each has an answer of its own,
 * and each answer is a full sentence: `Slack synced 55 · 0 new · 11:55am` is 33
 * characters, `Fetched 12 · 3 new · 11:55am` is 28. Two of those plus two
 * labelled buttons plus the page title need about 850px, so between 640 and
 * 1024 both lines were squeezed until each was truncating the timestamp that is
 * the point of it. Below this width the answer is a toast, in full.
 */
const ROOM_FOR_A_SENTENCE = '(min-width: 64rem)'

/**
 * The answer, on every width — used by Sync and by Fetch, from one place.
 *
 * Both controls printed their result into a `hidden sm:inline` span, so below
 * 640px both of them spun, stopped, and said nothing at all: the one width
 * where the operator cannot see the desk change under the button, and the one
 * where he has most likely walked away from it. The line stays where it is
 * where there is room for it, and where there is not it goes to the toast bar —
 * which is already how this product answers a phone, is `aria-live`, and gets
 * out of the way on its own.
 *
 * One hook rather than two implementations, because the failure being fixed is
 * exactly that these two siblings drifted apart once already.
 */
export function useResultLine(): [ResultLine | null, (l: ResultLine) => void] {
  const [line, setLine] = useState<ResultLine | null>(null)
  const say = useCallback((l: ResultLine) => {
    setLine(l)
    // Asked at the moment the answer lands rather than subscribed to: this is
    // one reading of one number, and a resize between the press and the result
    // is not a thing worth re-rendering the header for.
    if (!window.matchMedia(ROOM_FOR_A_SENTENCE).matches) toast(l.text)
  }, [])
  return [line, say]
}

/**
 * The same five, in the same order, as the tab strip above the desk. The order
 * is fixed and the list is complete: a picker that reordered itself by
 * freshness would move the row you were reaching for at the moment a poll
 * landed, and one that hid a source nobody had connected would hide the only
 * place you could notice it.
 */
const ORDER: SourceName[] = ['slack', 'gmail', 'github', 'sentry', 'claude']

const label = (s: SourceName) => SOURCE_LABEL[s]
const names = (xs: SourceName[]) => xs.map(label).join(' and ')

/**
 * What the poll did, in one line.
 *
 * Read off the report rather than off the request, and that is not pedantry:
 * `ingest()` refuses to run two polls at once and hands a second caller the
 * first one's promise, so asking for GitHub while a poll is already in flight
 * is answered with that poll's report. The line names the sources the report
 * names, which is the only version of this that cannot lie.
 *
 * One source gets a sentence about that source, because there is exactly one
 * thing to say and `Synced 0 · 0 new` is not it when the source has no
 * credential. Several get a tally with the exceptions named after it.
 */
export function syncLine(r: SyncReport): { text: string; title: string } {
  const one = r.sources.length === 1 ? r.sources[0] : undefined
  const landed = r.sources.reduce((n, s) => n + s.count, 0)
  const quiet = r.sources.filter(s => s.connected && !s.ok).map(s => s.source)
  const off = r.sources.filter(s => !s.connected).map(s => s.source)

  const head = one
    ? !one.connected
      ? `${label(one.source)} not connected`
      : !one.ok
        ? `${label(one.source)} didn't answer`
        : `${label(one.source)} synced ${one.count}`
    : `Synced ${landed}`

  // How many groups are new is only worth printing when something was asked and
  // answered. `0 new` under `Sentry not connected` is noise wearing a number,
  // and it is the exact shape of the green tick over a dead account that the
  // report's `connected` field exists to prevent.
  const answered = one ? one.connected && one.ok : true

  return {
    text: [
      head,
      answered ? `${r.newGroups} new` : null,
      // Already said by `head` when there is only one of them.
      one || !quiet.length ? null : `${names(quiet)} didn't answer`,
      one || !off.length ? null : `${names(off)} not connected`,
      timeOfDay(r.at),
    ].filter(Boolean).join(' · '),
    title: r.sources
      .map(s => `${label(s.source)}: ${s.error ?? `${s.count} in ${s.ms}ms`}`)
      .join('\n'),
  }
}

export function Sync({ source }: { source: SourceName | 'all' }): JSX.Element {
  const { state, syncing } = useStore()
  const [mine, setMine] = useState(false)
  const [line, say] = useResultLine()

  /**
   * Busy is the store's, plus this control's own for the last tick of a press.
   *
   * The store's flag is what makes the palette's Sync visible here — it is the
   * same poll, and a control sitting still through one it did not start is
   * denying what the page is doing. The local half is not redundant with it:
   * `refresh` clears the store in its `finally`, which runs a tick before the
   * line arrives, so on the store's flag alone the button would go idle under
   * the *previous* result for a frame. Cleared beside the line, they land
   * together.
   */
  const busy = mine || syncing

  const word = source === 'all' ? null : label(source)
  const runs = new Map((state?.lastSync ?? []).map(r => [r.source, r]))

  /**
   * How stale each source is, beside its name in the menu — the one fact you
   * need at the moment you are choosing which one to re-poll.
   *
   * An age is printed only when there was a real poll of a real account behind
   * it. One ingest run stamps every source with the same timestamp, including
   * the ones with no credential attached, so a bare `4m` next to Gmail would
   * claim a poll that never happened. Those get the product's own mark for
   * nothing-here and the reason goes in the result line when you press them.
   */
  const metaFor = (s: SourceName) => {
    const r = runs.get(s)
    return r && r.connected && r.ok ? ago(r.at) : '—'
  }

  const items: ReadonlyArray<MenuItem<Scope>> = [
    { id: 'all', label: 'Everything' },
    ...ORDER.map((s): MenuItem<Scope> => ({
      id: s, label: label(s), meta: metaFor(s), group: 'One source',
    })),
  ]

  const run = async (scope: Scope) => {
    setMine(true)
    const r = await refresh(scope === 'all' ? undefined : scope)
    setMine(false)
    say(r.ok
      ? syncLine(r.report)
      : { text: `Sync failed · ${timeOfDay(Date.now())}`, title: r.error })
  }

  /**
   * The pollers this press will actually run, so the tooltip can say so.
   *
   * A name on this desk means the rows filed under it, not the pipe that
   * carried them — that is the whole of the bucketing ruling, and it has to
   * hold in the menu too or the same five words mean two different things one
   * control apart. So `Sentry` re-polls Slack as well, because that is where
   * the alerts on the Sentry tab come from, and the tooltip names it rather
   * than leaving the operator to notice a second source in the result line.
   */
  const pipes = source === 'all' ? [] : pipesFor(source)
  const carriers = pipes.filter(p => p !== source)

  /* The chevron cannot be a `Button`: it is a menu trigger and has to say so
     with `aria-haspopup` and `aria-expanded`, which `Button` does not take and
     must not grow for one caller. So it borrows the size and the ghost weight
     by hand — `h-8 text-sm` and the same three colour states — including the
     `.hit` collar and the positioning that keeps that collar hanging off this
     control rather than off the whole page column. */
  const chevron = 'hit relative inline-flex items-center justify-center h-8 pl-1 pr-2 text-sm '
    + 'rounded-control rounded-l-none transition-colors duration-100 '
    + 'disabled:opacity-40 disabled:pointer-events-none '
    + 'text-fg-mute hover:text-fg-dim hover:bg-ink-800'

  return (
    <span className="flex items-center gap-3 min-w-0">
      {/* Capped rather than free, because Fetch's own line sits on this row too
          and an uncapped one pushes the other control sideways as it lands. The
          cap is 34ch because the line this control always produces is 33 —
          `Slack synced 55 · 0 new · 11:55am` — and at the old 22 it truncated
          its own timestamp on every single press. Anything longer than the
          usual sentence still elides, and the whole of it is on `title`.

          The line is also the half of this row that gives way. It may shrink
          (`min-w-0` here and on the wrapper above), the two controls may not
          (`shrink-0` on each), so a long answer landing in a narrow header
          truncates itself rather than pushing a button off the screen — which
          is exactly what it did on a phone, where `<main>` clips its own
          horizontal overflow and there was no way to scroll to what had left.

          Below `lg` this span is not rendered at all and the same sentence is a
          toast — see `useResultLine`. */}
      {line && !busy && (
        <span className="hidden lg:inline min-w-0 text-sm text-fg-mute tnum truncate max-w-[34ch]"
          title={line.title}>
          {line.text}
        </span>
      )}

      <span className="inline-flex items-center shrink-0">
        <Button size="md" variant="ghost" className="rounded-r-none pr-2"
          onClick={() => void run(source)} disabled={busy}
          /* The source is in the name even where it is not on the screen.
             `display: none` takes a word out of the accessibility tree as well
             as out of the layout, so below `lg` — where the label is the verb
             alone — this is what keeps the control called `Sync Claude Code` to
             a screen reader. It tracks the busy word rather than pinning `Sync`,
             so the visible label is always a substring of the spoken one. */
          ariaLabel={word ? `${busy ? 'Syncing' : 'Sync'} ${word}` : undefined}
          title={!word
            ? 'Poll every source Wake is connected to'
            : carriers.length
              ? `Poll ${names(pipes)} again — part of the ${word} tab arrives through ${names(carriers)}`
              : `Poll ${word} again with the credential Wake already holds`}>
          {/* Same rule as Fetch: the word is the control and the glyph is
              decoration, so the glyph is dropped on the narrow screens where
              this row cannot spend 22px on decoration. Nothing is lost — the
              label is what carries the busy state anyway. */}
          <span className="hidden lg:inline-flex">
            {busy ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
          </span>
          {/* Unscoped, the verb holds one width across both states so the
              chevron beside it does not slide out from under the finger
              mid-press. It is centred in that column rather than left-aligned
              the way Fetch's is: Fetch has nothing to its right, so its slack
              can sit at the end, and here the same slack would open a gap
              between the word and the chevron and split one control into two.

              Scoped, there is no fixed column at all — a 56px box against a
              four-letter word is that same gap, and `Sync  Slack` reads as two
              labels. So the scoped button does change width between its states,
              which is the trade Fetch makes for the same reason: both halves
              are disabled for the whole of the state that moves.

              And the source name is only *printed* from `lg`. `Sync Claude Code`
              is 131px and `Fetch Claude Code` is 141: with a chevron and a page
              title that is 305px of controls in the 343 a 375px phone has, so
              the second button hung 58px past the right edge of a column that
              clips its own overflow — unreachable, on the width he actually
              reads on. The name is not information the row is missing: the tab
              strip six pixels below keeps the pressed source's name on a phone
              precisely so this can be a verb — and the `ariaLabel` above is what
              keeps the control called `Sync Claude Code` where the word is not
              printed, since `display: none` takes it out of the name too. */}
          <span className={word ? '' : 'w-14 text-center'}>
            {busy ? 'Syncing' : 'Sync'}
            {word ? <span className="hidden lg:inline">{` ${word}`}</span> : null}
          </span>
        </Button>

        <Menu<Scope>
          items={items}
          /* The check marks what the big half does, not what the last pick was:
             picking a row runs it there and then and leaves the tab alone, so
             the button's scope is still the tab's and the menu says so. */
          value={source}
          onPick={s => void run(s)}
          align="end"
          ariaLabel="Sync one source"
          trigger={({ open, toggle }) => (
            <button type="button" onClick={toggle} disabled={busy}
              aria-haspopup="menu" aria-expanded={open}
              aria-label="Sync one source" title="Choose a single source to poll"
              className={chevron}>
              <ChevronDown size={13} aria-hidden
                className={`transition-transform duration-100 ${open ? 'rotate-180' : ''}`} />
            </button>
          )}
        />
      </span>
    </span>
  )
}
