# Desk pass — what is broken on https://yuvraj-wake.truto.dev

Read by clicking the deployed site on 2026-08-31, laptop (1280×) and phone (375×812),
then traced to the line that causes it. Nothing here is inferred from the prompt alone;
every item has a live symptom and a cause.

---

## A. Desk rows

### A1 — Sentry issues are filed under Slack

**Live:** the Slack tab reads 47. Forty of those rows are `TRUTO-39 · Error`,
`TRUTO-2Y · SyntaxError`, `TRUTO-APP-1BY · FetchError`. The Sentry tab reads 13.
The forty Sentry issues that arrived through `#sentry-alerts` sit on the Slack tab,
and the Slack tab's real content — nine human threads — is buried under them.

**Cause:** `src/web/pages/Home.tsx:191`

```tsx
const matchSource = useCallback(
  (c: CardT) => filter === 'all' || c.sources.some(s => s.source === filter),
  [filter],
)
```

The tab asks *which pipe carried this row*, not *what this row is*. A `#sentry-alerts`
card is minted with `source: 'slack'`, `kind: 'alert'`, `meta.short_id: 'TRUTO-39'`
(`src/server/sources/slack.ts:523-548`), so Slack claims it. Only if the Sentry API
card has independently merged into the same group does Sentry claim it too — which is
why Sentry shows 13 and not 50.

**Ruling.** A row belongs to the source it *is about*. A Slack member that is a Sentry
issue — `kind: 'alert'` carrying a Sentry short id or a `sentry.io/issues` link — buckets
to Sentry. Datadog and Grafana alerts have no Sentry identity (`short_id: null`,
`slack.ts:616,654,702`) and stay on Slack. A human thread that merely *names* `TRUTO-38`
in prose stays on Slack: it is a conversation, not an issue. No third source called
"alerts" is invented; the two tabs that exist just stop lying.

### A2 — A selected row looks exactly like a hovered row

**Live:** clicking a row opens the pane but the row does not visibly change under the cursor.

**Cause:** `src/web/components/CardTable.tsx:297`

```tsx
${focused ? 'bg-ink-700' : selected ? 'bg-ink-800' : 'hover:bg-ink-800'}
```

`selected` and `hover` are the **same token**. Selection has no colour of its own.
On mobile (`:474`) there is no hover and no focus at all — `selected ? 'bg-ink-800' : ''`.

### A3 — New activity is a 2px edge, and `+N` is a whisper

**Live:** rows with unread replies carry a hairline on their left edge that does not read
as anything at a glance, and the count renders as small dim text next to a 200-character
title, where it disappears.

**Cause:** `src/web/components/CardTable.tsx:80` and `:83-90`

```tsx
const EDGE = { boxShadow: 'inset 2px 0 0 var(--color-accent)' } as const
```
```tsx
<span className="text-accent-ink tnum text-sm shrink-0" title="new since you last looked">
  +{card.activity.count}
</span>
```

Both facts — *this row moved* and *by how much* — are told in the two quietest ways available.

### A4 — Swipe stops at the Desk

Swipe is already source-agnostic on Desk cards: `useSwipe(card.group_key, 3)` is called
unconditionally in both `CardRow` and `CardLine`, so Slack, Gmail, GitHub, Sentry and
Claude rows all swipe today. **The gap is elsewhere** — Claude sessions, tasks and goals
are on other pages and have no swipe at all.

---

## B. Work

### B1 — Work with nothing on it is a blank page

**Live, phone:** header, the words `No tasks`, `VOICE NOTES`, `Record a note`, then
roughly 1,200px of nothing.

**Cause:** `src/web/pages/Work.tsx:333` renders `<Empty>No tasks</Empty>`, and `Empty`
(`primitives.tsx:471`) is one 13px muted line in a 44px box. There is no CTA, no
description, nothing that says what the page is for.

### B2 — Tasks and Goals are two words, not a control

**Cause:** `src/web/pages/Work.tsx:277-295`. Two bare `<button>`s whose entire selected
state is `text-fg` vs `text-fg-mute` — a colour swap on 13px text. No fill, no border,
no underline, no weight change. The repo already ships a `Segmented` primitive
(`primitives.tsx:107`) that is not used here.

### B3 — Deadline and Remind me are dead chips

**Live:** both fields render `Today 5pm · Tomorrow 9am · Mon 9am · Pick… · None`.

**Cause:** `src/web/components/TaskSheet.tsx:27-31` and `:350-361`. Worse than described:
**the three preset chips never show an active state** — they are rendered without
`active=`, so picking "Tomorrow 9am" leaves every chip unpressed and only a sentence
below changes. `None` is the only chip that lights up. On a phone the row wraps to two lines.

### B4 — The pane is destroyed by a branch flip, not by a close

**Cause:** `src/web/pages/Work.tsx:329-338`. The page returns a **structurally different
tree** when it is empty:

| index | empty branch | main branch |
|---|---|---|
| 0 | `<header>` | `<div class="min-w-0 grow …">` |
| 1 | `<p>` (Empty) | `<aside>` |
| 2 | `<VoiceNotes/>` | `{sheets}` |
| 3 | `{sheets}` | — |

React reconciles positionally, so the instant that condition flips it **unmounts and
remounts the entire subtree** — header, the aside, the recorder, and all three sheets.
Saving the *first* task flips it: `TaskSheet.save()` does `await reload(); onClose()`,
and `reload()` lands `tasks.length === 1` while the sheet is still open. The sheet is
torn down mid-flight, its exit animation never runs, and the aside beside it is rebuilt
from scratch. That is the disappearance.

Two further facts found on the way:
- The aside has **no close control of any kind** — no cross, no collapse. `Work.tsx` imports `X`
  and uses it only to dismiss a fired reminder.
- `task={editing}` (`Work.tsx:316`) is a **frozen snapshot**. `reload()` replaces the store's
  task objects but never updates `editing`, so notes added to an open task do not appear
  until the sheet is closed and reopened.

### B5 — The phone zoom trap is a cascade bug

**Cause:** `src/web/styles.css:364-373`. The guard exists and is correct in intent:

```css
@media (pointer: coarse) { input, textarea, select { font-size: max(16px, 1em); } }
```

But it sits inside `@layer base`, and Tailwind v4 emits `.text-base { font-size: 14px }`
into `@layer utilities`, which outranks it regardless of the media query. Every field
using `inputClass` resolves to **14px** on iOS, so the page zooms on focus and never
zooms back. The comment describes an intent the cascade does not deliver.

Compounding it: `Sheet` is capped at `max-h-[88vh]` (`primitives.tsx:195`) — `vh`, not
`dvh`, alone in an app that uses `dvh` everywhere else.

**And the reachability half turned out not to be the sheet at all.** Work's sheets
already pass a `footer`, and the footer measures correctly — but `App.tsx:161` is
`<main className="relative z-10 …">`, which opens a stacking context, and every `Sheet`
in the product renders *inside* main rather than portalling. So a sheet's `z-50` is
capped at main's `z-10`, while the phone tab bar at `App.tsx:189` is `z-30` and a
**sibling** of main — it paints over the bottom 53px of every sheet on every page.
Hit-tested: `elementFromPoint` at the centre of `Add task` returned **"Sessions"**.
That is the real reason he could not press it, and it also meant the modal scrim never
covered the desktop left rail.

---

## C. Fetch and Sync

**Live:** one button, `Fetch`, relabelled per tab (`Fetch Slack`, `Fetch Sentry`).

`Fetch` = `POST /api/fetch` → `ingest(only)` **plus** the Claude/MCP box collectors
(`src/server/fetch/index.ts:153-172`).

A poll of Wake's own connected sources already exists — `POST /api/refresh` → `ingest()`
(`src/server/api.ts:324`) — but it is reachable **only from the command palette**, it is
unlabelled as a peer of Fetch, and it takes **no argument**, even though `ingest()` accepts
one. There is no way to say "just re-poll Slack".

---

## D. Sessions

**Live:** 30 sessions across 5 repos (`truto` 21, `truto-app` 4, `truto-monitoring` 3,
`truto-skills` 1, `/tmp` 1), every one of them on screen at once, each a three-line dump
of title / last prompt / `branch — N turns in view — age`. Thirteen trash icons are greyed.

**Causes:**
- Row shape: `src/web/components/sessions.tsx:102-196`.
- No repo picker and no Active/Archived/All: the page's entire state is
  `sessions | err | doomed | page` (`sessions.tsx:32-36`). Repos appear only as
  non-interactive `<h2>` headings. A **server-side repo filter already exists**
  (`claudecode/router.ts:81-93`, `?repo=`) and the client wrapper already supports it
  (`launch.ts:195-203`) — it is simply never called with one.
- **Archive does not exist at any layer.** `grep -rni archiv` over the four files returns
  one hit, inside a comment. There is no `archived` field on `SessionInfo`, `SessionRow`,
  or the client `Session`, and no route.
- The greyed trash is `disabled={!!s.live}` (`sessions.tsx:188`). The *reason* is sound —
  unlinking a running transcript does not stop the process, it just leaves it appending to
  a file with no name — but `disabled:pointer-events-none` means the explanatory
  `title` **can never be shown**, on any device. So the reason exists in the code and
  nowhere else.
- Deleted sessions are not rendered because there is no soft delete: `deleteSession`
  `rmSync`s four paths under `~/.claude` and the next filesystem scan cannot see them.

**Phone delete confirm:** the `Delete` and `Cancel` buttons are rendered **inside the
scrolled body** (`sessions.tsx:275-286`), not in the `Sheet`'s sticky `footer` slot. With
the confirm input focused and the iOS keyboard up, they are below the fold with nothing
obvious to scroll.

---

## E. Write the brief

### E1 — Session sits above Repository

`src/web/components/launch.tsx:236-244`: `<SessionPicker>` is rendered first, `<RepoPicker>`
second. The narrower choice is asked before the one that should constrain it.

### E2 — The pickers are naked lists

`launch.tsx:541-581` (repo) and `:420-472` (session). The open list is a bare
`<div className="max-h-64 overflow-y-auto">` — **no background, no border, no radius, no
shadow, no z-index**. It expands in document flow and shoves the sections below it down.
Neither list marks which row is currently selected. There is no `Menu` primitive anywhere
in `src/web` to reuse — zero hits for `role="menu"`, `aria-haspopup`, `listbox`, `combobox`.

### E3 — The session list ignores the repository

`SessionPicker` **is not given `cwd`** (`launch.tsx:385-392`), so it cannot filter even in
principle. Verified live: with `truto` selected, the session menu lists TRUTO, TMP,
TRUTO-SKILLS, TRUTO-APP and TRUTO-MONITORING — all 30 sessions on the machine.

---

## F. The phone Desk

**Live:** the phone renders a one-column list — a kind glyph, a truncated title, a check.
No status, no due, no channel, no who. There is nothing to scroll horizontally because
there are no columns. A row from `#15five-truto` shows no customer and no person.

Long-press is **not implemented anywhere** in the product.

---

## What this pass does about it

A: bucket rows by what they are, give selection its own colour, make new-activity a
full-row wash and `+N` a real badge, extend swipe to sessions, tasks and goals.
B: a designed empty state, real pills, a real calendar for both time fields, one stable
tree so nothing remounts under him, and a phone sheet that does not zoom or hide its button.
C: Sync as a peer of Fetch, per-source.
D: tiles, repo first, Active/Archived/All, an archive Wake owns, and a delete whose reason
is visible instead of implied by a grey icon.
E: a real Menu primitive, repository before session, and a session list that respects it.
F: real columns that scroll sideways, a `customer — who` heading, and a long-press peek.

---

## What shipped, and what was argued down

Four commits on `main`, deployed to https://yuvraj-wake.truto.dev at `88716ee`:

- `14fa927` — the shared primitives the five surfaces needed: `Menu` (the product had no
  dropdown at all), `DateTimePicker`, `CountBadge`, `rowStateClass`. Plus the iOS
  focus-zoom cascade bug and `Sheet`'s `vh`→`dvh`.
- `5c58dbb` — the five surfaces: bucketing, the phone table, Work's one tree and its real
  detail pane, Sessions as tiles with an archive, repository-before-session, and Sync.
- `805b573` — the layering fix (`Sheet` portals), Mail's row treatment, one repository
  rule instead of two, and the bucket-aware glyph, scope and search.
- `8b04628` + `88716ee` — what two fresh-eyes QA passes over the deployed site found.

Three findings were argued down rather than fixed, with the measurements recorded in the
code beside them:

- **A `Where` column on the laptop Desk.** The QA's own condition was "without touching
  Title", and with the pane column reserved the list ends at x1016 of 1440 with its four
  columns full — `Where` costs Title ~140px. The honest version of the complaint is that
  *Kind's word* is redundant with its own glyph, which is a different change and a
  retirement of `test/table.test.ts`, not something to slip in under a QA pass.
- **The two "duplicate" add-task buttons.** Measured, they are 258px apart at 375 and
  738px apart at 1440, at opposite corners. A toolbar action and an empty state's answer
  to its own sentence are not one control twice.
- **Making the skills list a `Menu`.** `Menu` rows are `menuitemradio` and it closes on
  pick; a multi-select that shuts after every choice is worse than a porthole, and
  changing the shared primitive to suit it would put the two pickers this pass exists to
  fix at risk. It shows six and offers the rest instead, which removes the scroller
  inside a scroller without touching the primitive.

Known and deliberately left: `~/.local/share/wake` on the laptop fails ingest with
`table cards has no column named pile` — a stale local database that predates that
column. The devbox database is fine; this only affects running the server locally.
