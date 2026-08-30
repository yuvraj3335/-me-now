# WAVE — the brief for Wake's rebuild

Written 2026-08-30 from five specialist audits of **https://yuvraj-wake.truto.dev** (the public
URL, not localhost, not the repo) plus 32 headless screenshots and a live DOM measurement pass.
Every number below is measured, not remembered.

Wake is one human's ops console. One human: **yuvraj@truto.one**. Ink and amber. No glass, no
chatbot, no agent in the product. Open in Claude is a pack-then-link.

**Definition of done:** every row of the VERDICT table answers **NO** on the public URL, no new
screenshot can be paired with FAIL 1–9, and `rg` over `src/web` finds no banned string as product
chrome. Nothing else counts. Not localhost. Not this file.

---

## PART 1 — WHAT IS TRUE ON THE PUBLIC URL TODAY

### 1.1 The nine FAIL photographs

| # | Photograph | Status | Hardest evidence |
|---|---|---|---|
| 1 | NOW laptop dark | **MATCHES (4 of 5 clauses)** | `KIND` header at x=225, the word `Session` at x=248 — 23px apart. `Now 0` costs 109px of dead band (group head y131 → first Open row y240). Detail pane = 5-row PULL REQUEST table **and** 3-row SESSION table **and** a bordered resume box **and** a 1776-character `<pre>` of Wake's own handoff pack. `Open` is `bg-accent`. |
| 2 | NOW phone detail dark | **MATCHES** | Same `CardDetail` full-screen via portal (`Home.tsx:284`). Five stacked blocks, four 32px buttons + `⋯`. |
| 3 | Open in Claude | **MATCHES (3 of 3)** | `launch.tsx:41-45` `STEPS = 1 Context / 2 Instruction / 3 Read it`; native `<select>` for the repo whose popup paints over the object list; `<Button size="lg" variant="primary">Instruction</Button>` — an amber brick whose job is "next tab". |
| 4 | Work | **HALF FIXED** | Tutorial empty state and voice essay gone. `TaskSheet.tsx:190-195` still has a `min-h-[68px]` **Detail textarea**, and stickies are gated behind `{task && …}` so a task made from a card cannot receive one. |
| 5 | Pulse | **MATCHES (4 of 5)** | Subtitles and footer essay gone. Throughput paints **one 11px bar in 572px of axis** (30 slots, 29 zero). `Not enough history` in a 572×132 hole. `4 replies on 1 day — not enough to trend` is a hint sentence in a stat foot. On phone `grid-cols-3` has no breakpoint and 838px of the page renders at `opacity:0` (`whileInView` + `once:true`). |
| 6 | Settings laptop dark | **MATCHES, every clause** | **Nine** `rounded-panel bg-ink-850 border border-edge p-4` cards in `lg:grid-cols-2 xl:grid-cols-3 items-start`. Columns end at y598 / y573 / y733 → 160px and 192px of ragged bottom. MAIL card repeats Gmail. Amber `Turn on` at x644–713. `Target / Brief limit 12,000 characters / Templates / Sessions seen`. `Connect one from a terminal`. |
| 7 | NOW phone light (all) | **MATCHES (6 of 7)** | Page title `text-lg/500`, group title `text-md/500` — same weight, same colour, 4px apart, four times per screen. 63px dead band under `Nothing waiting`. Row = truncated title + `Session · truto · you left this open` + two 32px icons. **No Fetch.** Chip row content is 442px in a 358px box with `no-scrollbar` — **the Gmail chip is 100% off-screen**. Light `--color-rule` is **1.21:1**. |
| 8 | NOW phone light (Slack) | **MATCHES VERBATIM** | Three empty chapters at y119/217/315, `Done and not mine` at y413, then the five-source paragraph wrapping to a second line that **begins with an orphan `·` at x=17** and ends in amber `Slack sync failed 1m`. **331px of chrome and six lines to say nothing.** |
| 9 | Settings phone light | **MATCHES, every clause** | Nine `#ffffff` cards on `#f7f7f9`. Three label x (33, 51, 52) and three value x (157, 159, 194) in one 357px column. Source rows **45 / 65 / 45 / 65 / 65**. `Connect` bordered vs `Disconnect` bare, left edges 5px apart. `Connect one from a terminal`. MAIL card underneath. |

Genuinely fixed since the last pass, and to be preserved: `<th>`/`<td>` agree on four of six
columns; the tutorial empty states are gone; Pulse's subtitles and footer essay are gone; there is
no arbitrary `text-[Npx]` anywhere in `src/web`.

### 1.2 The VERDICT table, as the site is today

| # | Question | Today | Evidence |
|---|---|:--:|---|
| 1 | Settings wraps a section in a rounded bordered card? | **YES** | 9 × `Settings.tsx:388`, `border-radius:10px`, `border 1px rgb(51,51,61)` |
| 2 | A Mail section separate from Sources? | **YES** | `Settings.tsx:198-221`, 387×100 card repeating the Gmail row |
| 3 | Target / char limit / templates / sessions-seen as a card? | **YES** | `Settings.tsx:249-254` |
| 4 | "Connect one from a terminal" without a Connect failure? | **YES** | `Settings.tsx:192-193`, gated on presence not failure; visible with `connectError === null` |
| 5 | Push is an amber Turn on brick? | **YES** | `variant={pushOn ? 'default' : 'primary'}`, `rgb(233,162,59)`, 70×32 |
| 6 | Connect and Disconnect two control styles? | **YES** | `variant={s.ok ? 'ghost' : 'default'}` |
| 7 | Source rows two lines / uneven height? | **YES** | 45 / 65 / 45 / 65 / 65 |
| 8 | A 0-item pile as a titled chapter plus a sentence? | **YES** | `Home.tsx:207-237` renders all three unconditionally; 109px laptop, 98px phone |
| 9 | Empty copy contains "from Slack" / "in flight"? | **YES** | `emptyWord`, `Home.tsx:319-320` |
| 10 | Sync is a wrapping paragraph of all sources? | **YES** | `Home.tsx:391-408`, y=1324 on a 900px viewport |
| 11 | No control labelled Fetch in the filter row? | **YES** | `rg Fetch src/web` → 0 hits |
| 12 | Phone row joins kind · repo · why on one muted line? | **YES** | `CardTable.tsx:327` |
| 13 | Page title and group title the same type size? | **YES** in spirit | 20/500 vs 16/500, same colour, same weight. The rule is eyebrow + count. |
| 14 | Detail shows a Wake pack as the body? | **YES** | `<pre>` 1776 chars: `You:`, `Packed by Wake at …`, `## Instruction` |
| 15 | Two fact tables instead of one ≤4 rows? | **YES** | one `Block` **per source**, `CardDetail.tsx:265-321` |
| 16 | Resume is a bordered box? | **YES** | `bg-ink-850 border border-edge rounded-control h-8` |
| 17 | Open is amber? | **YES** | hand-rolled `<a class="bg-accent text-on-accent">`, `CardDetail.tsx:179-184` |
| 18 | Pulse has a subtitle or a hint sentence? | **YES** | `4 replies on 1 day — not enough to trend`; `Your sharpest hour` / `Hover to compare` |
| 19 | A long empty axis, or a "not enough history" hole? | **YES** | both; 4 axes at 1/30 density, and a 572×132 hole |
| 20 | Work empty says "A clear desk"? | **NO** | live copy is `No tasks` |
| 21 | New task has a DETAIL textarea? | **YES** | `TaskSheet.tsx:190-195` |
| 22 | Open in Claude is a 1/2/3 tour or an amber Instruction brick? | **YES** | both |
| 23 | Mail inbox teaches a terminal command? | **YES** | `Mail.tsx:730-750` |
| 24 | `rg src/web` hits a banned string as chrome? | **YES** | 16 sites |
| 25 | A new screenshot pairs with FAIL 1–9? | **YES** | 6 full matches, 2 partial |

**21 of 25 rows are YES.** This is not a polish backlog.

### 1.3 The kill list — is it still present?

Every item named in the prompt is still on disk and still on screen, except where noted.

* `emptyWord()` + ` from ${SOURCE_LABEL}` — **present**, `Home.tsx:319-320`.
* `groups[]` rendering Now / Open / Parked at 0 — **present**, `Home.tsx:207-237` and `:242-261`.
* `SyncLine` five-source wrapping paragraph — **present**, `Home.tsx:391-408`, at `text-xs`.
* `FilterRow` has no Fetch — **present** (i.e. still absent).
* Slack selectable while its poll fails — **present**; chip reads `lastSync.connected`, Settings reads `s.ok`, and they disagree.
* `CardLine` truncated title + `kind · who · where · why` + clock + check — **present**, `CardTable.tsx:327-354`.
* `CardDetail` excerpt + PR table + SESSION table + bordered resume + `SessionExcerpt` + four fat buttons + amber Open — **present**, all seven.
* `Settings.Section` = `rounded-panel bg-ink-850 border border-edge p-4` — **present**, ×9.
* `lg:grid-cols-2 xl:grid-cols-3 items-start` masonry — **present**.
* MAIL card, amber Turn on, Open-in-Claude internals, uneven source rows, bordered Connect vs ghost Disconnect, `Connect one from a terminal` — **all present**.
* iPhone / Web Push sentences standing on the board — **present**, `Settings.tsx:241,244`.
* Work `EmptyDesk` tutorial and voice essay — **gone**. `+ Task` amber brick and the DETAIL textarea — **present**.
* Pulse `hint=` prop — **gone**; hint sentences survived in stat feet. Sparse bars, holes, `Not enough history` — **present**.
* Mail `NotConnected` lecture — **present**, `Mail.tsx:696-753`.
* `launch.tsx` 1/2/3 rail, amber Instruction brick, repo `<select>` — **present**.

### 1.4 What the live machine actually holds

```
GET /api/connections + /api/state, 2026-08-30
slack   ok:false connected:1 via:wake-oauth  hasWakeToken:true
        detail: "400 from https://mcp.slack.com/mcp: App is not enabled for Slack MCP
                 server access. Please enable it here:
                 https://api.slack.com/apps/A0BT7FHS57H/app-assistant"
github  ok:true  count:4   via:"gh cli"
gmail   ok:false connected:0  needsClientId:true
sentry  ok:true  count:0   via:wake-oauth  hasWakeToken:true
claude  ok:true  count:22  via:filesystem
now:0  open:19  parked:1  tasks:0  goals:0  notes:0
```

**`now: 0` is not an empty desk. It is a broken pipe.** Now is fed by Slack DMs/mentions and by
GitHub review-requests. Slack 400s on every poll because the Slack *app* is not entitled for MCP —
Wake's own OAuth succeeded, the token is real, the provider refuses the app. Gmail has no
obtainable credential. Sentry returns zero and cannot say whether that is "nothing" or "failed
silently". So 19 of 20 rows on the desk are Claude Code sessions nobody is waiting on.

**A rebuild that fixes only the pixels ships a beautifully aligned page that says "Nothing waiting".**
That is why Fetch is the first item of work in this brief and not the last.

### 1.5 Honesty bugs in the ingest layer (server, invisible, load-bearing)

1. **The diagnosis is shown only when there is nothing to diagnose.** `Settings.tsx:183` gates
   `s.detail` on `s.ok &&`. Slack's `detail` contains the exact URL that fixes it. It is fetched,
   held in state, and never painted.
2. **A token that authenticates but is refused reads as "not connected"** in Settings and
   "sync failed" on Now — two screens, two wrong claims, about one 400.
3. **Every adapter turns an upstream failure into a successful empty poll.** `slack.ts:200-207`,
   `github.ts:103-109`, `sentry.ts:90-99`, `gmail.ts:112-114` all swallow rejections.
4. **A successful empty poll deletes that source's cards** — `ingest.ts:148-154` sets `gone = 1`.
   (3) + (4) is a data-loss path: rate-limit GitHub's four searches and the desk wipes itself and
   reports "synced".
5. **`oauthable` means "we know a URL", not "Connect can work".** Gmail publishes no OAuth
   metadata, so its Connect button can only 400. A button that cannot work is worse than none.
6. **The terminal fallback is offered as the fix for a state it cannot fix**, and is shadowed by
   the credential chain order anyway.
7. **`Disconnect` can be a no-op.** It deletes an `oauth_tokens` row; if the token came from the
   Claude bridge there is no row. The click succeeds and nothing changes.
8. **`stripNestedBrief` is dead.** Its regex (`launch.ts:124-132`) matches the *old* brief format;
   `renderPack` has not emitted that format for releases. Verified by running it against today's
   producer output: `stripped? false`. `test/launch.test.ts:225-247` is green because its fixture is
   a hand-typed copy of a format nothing produces. This is why the detail pane dumps the pack.
9. **`sources/search.ts`** — 134 lines of read-only cross-source search, already written, already
   safe — has **zero importers**. It is pipe 2's collection layer, dead on the vine.

### 1.6 Functional bugs, not taste

* **Destructive keys leak through the phone/narrow detail.** `overlay.ts` exists to stop `e`/`s`
  firing behind a modal; the full-screen detail push view (`Home.tsx:284-291`) does not call
  `useOverlay`. Below 1024px with a keyboard, `e` marks the **cursor** card done, not the one being
  read, and the undo toast renders under the `z-50` overlay.
* **`⋯` renders its content 1400px below the button that opened it.** The trigger is in the pinned
  action bar; the panel appends to the bottom of the scrolling body. Nothing appears to happen.
  Every deferral control in the product is behind it.
* **`columnsFor` drops `Why` between 1024 and 1087px** — the one column its own comment says must
  never be lost — and Title is still under its floor.
* **At 1440 the table keeps 68px of dots and throws away the repo name.** The laptop shows fewer
  facts per row than the phone.
* **The detail action bar is ~370px of `whitespace-nowrap` in a 352px pane** below 1440.
* **Filter chips reorder under the finger** — `Home.tsx:353-355` sorts by connectedness every render.
* **`Truto CLI` latches on `asking the CLI…`** forever if `/api/settings/truto` fails (`.catch(() => {})`).
* **Pulse's below-fold panels render at `opacity:0`** in any capture, print, or background tab.
* **Ageing buckets on `first_seen_at`**, so a 4-day-old PR is reported in the `today` bucket while
  the list two clicks away renders it as `4d`.
* **`totals` is computed on every analytics request and rendered nowhere**, and contradicts `pace`.

### 1.7 The grid, measured

Rail is 0–199 with its edge at x=199, so **x=200 is the laptop content origin**.

* **Page pads in use: 12, 16, 20, 24** (+ the table's `px-2` → 232). Now sits at 216; Settings,
  Work and Pulse at 224. Switching tabs shifts every heading 8px.
* **Gutters in use: 16, 24, 32, 48.**
* **Label columns in use: 16, 64, 96, 112, 160.**
* **Row/control heights in use: 24, 26, 28, 32, 36, 38, 44, 45, 48, 52, 60, 65.** Nine painted
  control heights against four row heights, and not one control equals a row.
* **Gaps in use: 2, 4, 6, 8, 10, 12, 16, 24, 32** — `styles.css` says "nothing at 6, 10, 14, 20, 28"
  and the product violates its own comment 28 times (`gap-1.5` is the second-most-used gap).
* **Radii in use: 2, 3, 4, 6, 8, 10, 12, 9999.** Three are declared.
* **Seven left edges inside one 400px detail pane:** 1053, 1057, 1070, 1071, 1079, 1081, 1153.
* **Five right-hand verticals across five surfaces:** 844, 1029, 1035, 1040, 1056.
* **Light `--color-rule` is 1.21:1 and `--color-edge` 1.40:1.** The structure the whole design
  leans on is invisible in light, which is *why* light Settings compensates with white cards.
* **`--color-accent-ink` and `--color-warn` are byte-identical in both themes**, and light
  `--color-src-claude` `#8a5320` differs from `--color-accent-ink` `#8a5300` by 32 levels of blue.
  With 19 of 20 rows being Claude sessions, that is **38–44 amber marks on Now** against a budget
  of three. Fixing three tokens fixes more of that screen than any layout change.

### 1.8 Dead bands ≥24px carrying no information

| surface | worst run |
|---|---|
| Now laptop | 109px for the empty `Now` pile; 265px of chrome above the first row; **400×855 pane holding the words "No selection"** (27.8% of the viewport) |
| Now phone, Slack filter | six lines and **331px** to say nothing, then 269px blank |
| Now laptop, Slack filter | `<thead>` labelling zero rows; last ink at y=526, **373px blank** |
| Pulse laptop | 275px in the left column, **317×596 dead beside Ageing**, 120px in the right |
| Pulse phone | **838px present in the DOM, painting nothing** |
| Work laptop | last ink at y=141; **758px × 1216px dead** |
| Settings laptop | 160–192px ragged bottom + 789×302 empty beside a full column |
| Mail laptop | 628px |

---

## PART 2 — WHAT WILL BE TRUE

Everything in this part is the deliverable. Nothing here is optional and nothing here may be
narrowed. Where a specialist and this brief disagree, this brief wins.

### 2.1 The visual system, as numbers

| token | value |
|---|---|
| page pad | **24px laptop / 16px phone**, applied **once** at the page root. Content origin **x=224** laptop, **x=16** phone. Nothing is ever inset again inside it. |
| gutter | **24px**, one value, everywhere |
| label column | **96px**; values start at pad + 96 |
| row height | **44px** on both viewports, one line, truncated, 1px `rule` beneath |
| control height | **32px** box; painted glyph **≤14px**; touch target ≥44px via `.hit` |
| vertical rhythm | 8px base — **only 8 / 16 / 24 / 48**. Section title → first row 8; section → section 24; page title → first section 24 |
| radius | **6px on controls** (`--radius-control`). Chips/stickies may use 4. **No panel radius on a page** — there are no panels. |
| gaps | 4 / 8 / 12 / 16 / 24 / 32 / 48. **`gap-1.5` and `gap-2.5` are removed.** |

**Type.** Only the seven tokens. Page title = `lg`. **Group label = `text-eyebrow uppercase
text-fg-mute` + a `tnum` count.** Row title = `base` medium. Meta = `sm` mute. Labels = eyebrow or
`sm` mute. `xl` at most three times, Pulse heroes only. One sans; mono only for ids, paths,
commands, emails, repo names. **Anything read to decide is ≥13px** — the sync mark, the resume
line and the brief text all move off `text-xs`.

**Colour.**
* `--color-src-claude` becomes **a neutral graphite in both themes** — explicitly not a hue.
  Claude sessions are 90% of the desk; the dominant row type must be the quietest mark on it.
  Dark ≈ `#a3a3b0`, light ≈ `#55555f`; the implementer records the exact values.
* `--color-warn` must be **visibly not the accent** — a redder orange (dark ≈ `#e9843b`, light ≈
  `#a33c00`), and it is used in exactly one place: the Slack entitlement line in Settings.
* `--color-rule` must reach **≥1.5:1** and `--color-edge` **≥1.9:1** against the page **in both
  themes**; the computed ratios go in the stylesheet comment. Light `#e2e2e8` is not acceptable.
* `--color-ok` light must clear **7:1**, the floor the file already claims.
* **`bg-ink-850` is never a page-level fill.** Sheets and stickies only. The Now detail pane, the
  Mail search box, the resume box and every Settings card lose it.
* **Amber, at most three marks per screen, and only these three exist:** the nav badge when Now
  has something in it; `Undo` in a toast; the recording indicator in voice. **Amber is never
  Open, never Turn on, never Connect, never Instruction, never Fetch, never a chart series, never
  a count, never a filled rectangle around the active nav item.** Pulse heroes are `fg`.

**Structure.** Hairlines, not boxes. A section is an eyebrow title plus rows. `Settings.Section`'s
wrapper is deleted, not restyled. A sheet or a sticky may carry a quiet edge; a page may not.
**Alignment is never fixed by adding a card.**

**Controls.** 32px, text or a 14px glyph. One primary per surface and only when committing.
`Connect`, `Disconnect`, `Turn on`, `Open` are **ghost text of the same weight**. Two amber anchors
currently bypass the `Button` primitive by hand (`CardDetail.tsx:179`, `launch.tsx:484`) — both go
through `Button`/`Link` so their height and radius cannot drift.

**Copy.** Headings are enough. **Chrome does not teach.** An empty group is not rendered. A whole
surface that is empty says `Nothing` or `—`. Provider text is clipped to 3 lines with expand-on-tap.

**Motion.** No exit animation that stalls navigation; nothing waits on a frame that may never come.
`whileInView` is removed from Pulse. `?static=1` keeps working.

### 2.2 NOW

Title (`lg`, x=224). **One chrome row** beneath it: `All` + five source chips + a flexible spacer +
**`Fetch`**. The header refresh glyph is deleted — Fetch subsumes it.

* Filters are **always all five, always in fixed order, never reordered by connectedness**, never
  disabled, never off-screen. On phone the chips are 44px dot targets whose label appears only on
  the active one, so the row fits 390px with Fetch in it and **does not scroll**.
* A source whose last poll failed carries a **hollow** dot and the reason on `title`. That is the
  only sync mark on Now. **`SyncLine` is deleted.**
* Table columns: **Kind · Title · Why · When**, with source as unlabelled dots immediately left of
  When. The `SOURCE` header word goes — it was 7× wider than the dot it labelled and cost 68px.
  That reclaims enough width for **Where** (the repo, mono) to survive at 1440.
* `<th>` and `<td>` share an x in **every** column, including Kind: the glyph gets a fixed-width
  slot so the kind word starts on the header's x. The 2px row stripe is deleted.
* **A pile with zero rows is not rendered.** No heading, no count, no sentence. `<thead>` renders
  only when there is at least one row.
* **A filter that matches nothing anywhere is one line** at x=224, 44px tall: **`Nothing`**.
  Not "Nothing from Slack" — the chip already names the source, and that string is banned. The
  `Done and not mine` group is not rendered in that state either.
* Phone row is **44px, one line**: glyph (fixed slot), title (truncate, sharing one x with every
  other title), then `why` and the age at the right. Kind and repo move to the detail. Row actions
  are not two 32px boxes on every row.
* `Done and not mine` is an eyebrow group like the others and its rows use the real columns.
* Laptop: rail | list | detail. **The pane's resting state is the top row's detail**, not the words
  "No selection". The keyboard cursor stays `null` until someone navigates.
* Phone: the detail is the full-screen push view it already is, **and it calls `useOverlay(true)`**.

### 2.3 NOW DETAIL

Title. One line: `why · who · when`. Then **one** fact table of **at most four rows**, 96px labels,
merged across sources (repo, number, project — not one table per source, and never `Why` twice).
Excerpt clipped to **3 lines** with an expand, run through `stripNestedBrief` **on the read path**
so Wake never prints its own pack back to itself. Resume is **one mono line + a copy glyph**, no
box. Seen-in is **one line** of dots and names. Actions are `Open · Claude · Task · Done` as text
or 14px glyphs, **all ghost, no amber**, wrapping safely at 352px. `⋯` reveals its content
**adjacent to itself**, not 1400px away.

### 2.4 OPEN IN CLAUDE

**One sheet, no 1/2/3 rail.** The context list is the sheet. Repository is an inline field whose
menu **may not cover the list** — no native `<select>`. Templates are rows, not amber checkboxes.
The brief is the next beat, at `text-sm` or larger, and the only commit is the real
`<a href target="_blank">` that already exists (keep it — it is why the iOS app opens instead of
Safari). No amber navigation. No closing disclaimer. `handoffFor` stays shared between browser and
server so the count, the trim and the href cannot disagree.

**Launched from a task**, the brief carries the task's title as the instruction seed, its stickies
as `note` slots (the slot exists in every template and nothing has ever filled it), the originating
card expanded through `cardContext`, the goal as one line, and the repo hint.

### 2.5 WORK

Title + count. `Tasks | Goals` as text. Empty is blank — no paragraph. `+` is a small top-right
control (it may be the one primary on this surface). **The New-task sheet loses its DETAIL
textarea**, and **stickies are available at creation**, not only after a save — a form whose field
list changes on save is a form nobody trusts. Deadline and reminder are one line of words.
Provenance is one quiet line. Voice is a mic; zero notes is no paragraph.

**A task freezes its provenance at creation** — `origin_why`, `origin_url`, `origin_source`,
`origin_excerpt` (clipped), `origin_meta`. Today a task points at a `cards` row that `ingest.ts`
garbage-collects, so "from GitHub" vanishes exactly when the PR merges. Copy, do not reference.

**A task can be opened in Claude.** `task` joins `SlotKind`; the action appears on the task row and
in the sheet footer.

### 2.6 PULSE

Title, `7d 30d 90d` as text. Three `xl` numbers on **one baseline**, three labels, three
comparisons — responsive, so the phone does not wrap every label to three lines and leave a ragged
bottom. Then a 2×2 (laptop) / stack (phone) **sharing one 24px gutter and one baseline per row**.
Title only — no hints, no captions, no centred text, no footer.

* **A sparse series compacts to its own extent** and labels that extent. One bar in thirty slots is
  a formatting decision, not a data problem.
* **An empty series is an em dash on the title row.** The chart is not drawn. `Not enough history`
  and `Nothing here yet` are deleted.
* `whileInView` is removed. Ageing buckets on the card's real timestamp with `first_seen_at` as
  fallback. `totals` is either rendered and reconciled or deleted. Charts are neutral, not amber.

### 2.7 SETTINGS

**One column. No cards. No masonry.** Eyebrow section titles at x=224, the page title's x. Every
row 44px with a hairline. One label x (224), one value x (320). Actions right-aligned, **all ghost
text of the same weight**.

```
Settings                                                    lg, x=224

YOU
  Email          yuvraj@truto.one
  GitHub         yuvraj3335

SOURCES                                     ← one row each, 44px, one truncated fact, one x
  ● Slack        app not enabled · fix ↗                       Connect
  ● Gmail        no token Wake can obtain
  ● GitHub       gh · synced 09:12
  ● Sentry       connected · synced 09:12                   Disconnect
  ● Claude Code  7 projects · synced 09:12

NOTIFICATIONS
  Push           off                                          [switch]

APPEARANCE
  Theme          System · dark                     [System|Light|Dark]

THIS MACHINE
  Workspace      9 repos · /home/yuvraj/work
  Skills         28
  Truto CLI      35 profiles · Truto
  Voice          microphone available · 0 notes

AUDIT
  Audit trail                                                       ›
```

Deleted outright: the **MAIL** section, the **OPEN IN CLAUDE** section (`Target`, `Brief limit`,
`Templates`, `Sessions seen`), the `Connect one from a terminal` disclosure and its `CLI_FALLBACK`
map, `This browser has no Web Push` (the row simply does not render), the iPhone push sentence (the
row's value reads `add Wake to the Home Screen`), the `Which ones` disclosure (a `title=`), the
floating push-test sentence, and all nine `Section` wrappers.

**Honesty rules the rows must keep.** `Connect` vs `Disconnect` is chosen by `hasWakeToken`, never
by `ok` — the server already returns it and the UI has never read it. `s.detail` renders
**regardless of `ok`**, because the whole point of a diagnosis is the broken case; Slack's line
carries the provider's own remediation link. **A terminal fallback may only appear under a row that
just failed to connect** — never as standing chrome. Gmail offers no Connect button, because
`gmailmcp.googleapis.com` publishes no OAuth metadata and the button can only 400. **Sentry is not
disconnected by this work.**

### 2.8 MAIL

`list | thread` on the **same metrics as Now** — same page pad (24), same 44px rows, same pane
width token (400 at `lg`, 440 at `xl`), same hairline, one horizontal pad instead of three. Down
state is **two lines**: `Gmail · not connected` and `Connect` as ghost text. The `<h1>`, the
paragraph, the amber primary, `Check again` and the whole `<details>` terminal block are deleted.
`Pick a thread.` is deleted — the first thread is selected.

### 2.9 FETCH — pipe 2, and the reversal it costs

**Where.** In the filter row, right-aligned after a spacer. 32px, chip-typed, bordered
(`border-edge`, `fg-dim`) — **never amber**, never a hero, never on the title row. It is
distinguished from the filters by the border and the spacer: everything left of the spacer narrows
what you see, the one thing right of it changes what exists.

**What happens.** The label swaps to `Fetching` (the control does not change width) and nothing
else on the page moves. No modal, no drawer, no streaming text. `POST /api/fetch` may take 30–60s
and blocks nothing — triage continues, because Fetch only ever adds. Rows arrive in place, in their
correct pile, with no "new" badge: the desk is one desk. When it settles, one line where the sync
mark lives: `Fetched 6 · 2 new · 09:14`, `sm`, `fg-mute`, one row tall.

**A second press** is never disabled and never scolded. It re-runs, dedups, and reads
`Fetched 6 · 0 new`. "0 new" is a useful answer; "please wait" is chrome that teaches.

**Failure** is one line, `fg-mute`, never amber: `Fetch failed · 09:14` (reason on `title`), or
`Fetched 4 · 1 new · Sentry didn't answer`. A failed Fetch must not change any source's connected
state and must not make a chip flip.

**Server.**
1. Run `ingest()` first, so Fetch is never a worse refresh than the button it replaces.
2. Enumerate what the box can actually reach (`claude mcp list` / `~/.claude.json` names) and
   record which connectors were asked.
3. Where Wake already has an adapter, call **`sources/search.ts`** — it is written, read-only,
   reuses the poll sessions, and has zero callers today. Either Fetch consumes it or it should not
   exist.
4. Where Wake has no working credential — **which today is Slack, Sentry-in-depth and Gmail** —
   spawn the box's own `claude` (`WAKE_CLAUDE_BIN`, already set on the box and unused in `src`)
   headless: `-p --model sonnet --output-format json` with an **explicit read-only
   `--allowed-tools` allowlist**, a `--max-turns` ceiling and a wall-clock timeout. Verified live on
   the box: it returns strict JSON and reaches `mcp__claude_ai_Slack__*`,
   `mcp__claude_ai_Gmail__search_threads`, `mcp__claude_ai_Sentry__search_issues`. Two fixed
   questions: *what is waiting on Yuvraj* and *what is open on TrutoEngineering that he owns or is
   named on*. Envelope: one shot, no follow-up turn, ~$0.25 and single-digit seconds per connector.
5. **Wake extracts `refs` itself** with `extractRefs` from the returned text and url. Model-supplied
   refs are dropped on the floor — a fabricated `gh:` ref outranks every other reference type and
   would win the group label.
6. **`why` is never invented.** The model returns *evidence* (the quoted line that makes this an
   ask); Wake's deterministic code turns evidence into `why`. No evidence → a fixed neutral phrase.
   This preserves the only half of DECISIONS #3 that was ever load-bearing.
7. Everything goes through `formatUntrusted` + `inspect` + `redact` before storage, lands as a
   normal card under its **real** source name with `meta.found_by = 'fetch'`, and merges with pipe 1
   through the existing union-find. `card_state` suppression means a Fetch row for something already
   done or snoozed does not resurface.
8. **The `gone = 1` sweep must not delete Fetch rows.** `ingest.ts:148-154` marks gone every card of
   a source whose poll succeeded without returning it; Fetch is manual and the poller runs every 3
   minutes. Scope the sweep to the pipe that owns the sighting. Made wrong, this single line makes
   Fetch look like it does nothing.
9. One `sync_runs`-shaped record per connector asked, so "asked, answered, nothing" and "asked, did
   not answer" are different states — the exact discipline pipe 1 gets wrong in four files.

**It is not a chatbot, and these are the properties that keep it that way:** no free-text input
exists anywhere in the flow; no model prose ever reaches a pixel (only schema-valid objects are
read, anything else is dropped, silently); no transcript, no streaming, no second turn, no history;
no `conversations`/`turns`/`messages` tables are recreated; everything it did lands in
`audit_events`.

**The reversal, stated plainly.** DECISIONS #26 says *"Wake starts nothing"*, and
`test/ui-contract.test.ts:394-406` asserts that no file under `src/server` contains `CLAUDE_BIN` or
spawns `claude`. Fetch cannot exist without reopening that, and the operator has required Fetch.
The reasoning that closed it — a headless process with no terminal, whose permission prompts nobody
can answer — applies to an *interactive* session, not to a bounded, read-only, allowlisted
collection with no writes and no approvals. So:

* **DECISIONS.md gains #31**, written out, naming what changed and why.
* **The test is amended, not deleted, and not quietly.** It stops asserting "never spawn claude" and
  starts asserting the invariant that actually matters: the only spawn site is Fetch's collector; it
  passes `--print`; its `--allowed-tools` list contains no write-shaped tool name (`send`, `reply`,
  `create`, `update`, `delete`, `trash`, `label`, `post`, `draft`, `spam`); it carries a timeout and
  a turn ceiling; and no other file under `src/server` spawns it.

**Both pipes stay.** Pipe 1 keeps filling the desk with no click wherever Wake holds its own
credential (GitHub via `gh`, Claude Code from disk, Sentry via its own OAuth, Slack the moment the
app is entitled). **A claude.ai "Connected" connector is never treated as Wake's own login**, and no
source is ever polled with an empty credential file. Fetch is what makes the desk work *anyway*.

---

## PART 3 — HOW IT SHOULD FEEL

**Now at 7am.** One downward read answers "what is on me". Nothing above the first real row except
a title and one chrome row — **the first actionable row must sit at y ≤ 130 at 1440×900; today it
is at 265.** The page never spends a heading on a zero. A filtered dead end is one short line, not
three chapters and a paragraph. The dominant row type is the quietest thing on the screen, and the
one amber mark on the whole window means something is waiting.

**A control feels like a tool.** 32px, small ink, generous target. Nothing is filled unless
pressing it commits. Connect and Disconnect look like the same decision because they are.

**Settings feels like a list you scan, not a dashboard you parse.** One column, one label x, one
value x, one row height. A broken source states what is broken *and* what fixes it, on its own row,
in the place where you would go to fix it — and the fallback appears only after the thing fails.

**The detail is a glance, not a document.** You learn what it is, why it is on you, and the four
facts that matter, then you act. Wake never shows you its own paperwork.

**Fetch feels like pressing a key, not summoning something.** One control among the filters, a word
that changes to `Fetching`, then more rows on the same desk and one short line saying what landed.
Nothing to read, nothing to answer, nothing to close.

**Light is not dark inverted.** Hairlines are visible; there are no white cards floating on grey;
amber-as-text is dark enough to read. Every fix in this brief is checked in light first, because
three of the operator's newest four complaints are light-mode shots.

---

## PART 4 — WHAT MUST NOT BREAK

* **The deploy gate.** `deploy/wake-deploy.sh` runs `bun install` → `typecheck` → **`bun test`** →
  `build` and **only restarts if all four pass**. A failing test does not roll back — it silently
  leaves the box on the old build while the repo says it was fixed. That is exactly how two agents
  came to grade the wrong build. **Every change must end with a confirmed restart on the new SHA.**
* **`test/ui-contract.test.ts` structural contracts** that encode real invariants and must survive:
  the seven-size type scale and the ban on `text-[Npx]`; `text-eyebrow` always carrying `uppercase`;
  no glass; no hard-coded hex outside palettes; no structural token used as text; both themes
  complete and the system block byte-identical to light; every `initial=`/`exit=` gated on `still`;
  the body-scroll lock having exactly one owner; every modal counting itself; the hand-off being a
  real `<a target="_blank">` with no `window.open` and no `preventDefault`; voice never committing.
* **Contracts that a rewrite legitimately changes** — update them deliberately, one at a time, each
  with a comment saying what changed: the `"Done and not mine"` literal, the `"not connected"` /
  `"sync failed"` literals in `Home.tsx`, the `Panel`/`GroupHead`/`Field` name checks, the
  colgroup/thead assertion, the anti-spawn test (§2.9).
* **Server contracts the web reads by name:** `/api/state`'s shape, the grouped-card object
  (`group_key`, `pile`, `title`, `why`, `who`, `excerpt`, `url`, `kind`, `ts`, `first_seen_at`,
  `meta`, `sources[]`, `state`, `tasks`), and the meta keys consumed in `cardContext.ts`,
  `kinds.tsx` and `CardDetail.tsx`.
* **`?static=1`**, the service worker, the manifest, and the inline pre-stylesheet theme script that
  stops a white flash at 7am.
* **Do not disconnect Sentry. Do not send mail. Do not commit `.env` or secrets. Do not force-push.**

---

## PART 5 — CHOICES MADE WITHOUT ASKING

1. **Fetch spawns the box's `claude` headlessly** rather than Wake holding an Anthropic key. It is
   the only option that satisfies "Fetch must work when Wake's own Slack login is missing", because
   the credential it needs is the box's, not Wake's. Recorded as DECISIONS #31; the anti-spawn test
   is rewritten to guard the real invariant rather than deleted.
2. **A filtered empty says `Nothing`** — not "Nothing from Slack". The chip names the source and the
   suffix is a banned string. This overrides the UX specialist's suggested copy.
3. **All five filter chips are always present, always enabled, never reordered.** They are filters
   over rows, not connection indicators. This kills the reordering bug and the off-screen Gmail chip
   in one move; a failed source shows a hollow dot with the reason on `title`.
4. **`SyncLine` is deleted rather than shortened.** Failure lives on the chip and in Settings.
5. **`--color-src-claude` becomes neutral graphite**, not another hue. It is 90% of the desk; the
   right answer is for it to recede, not to compete.
6. **Amber is spent on exactly three things** — the Now badge, `Undo`, the recording indicator.
   Pulse heroes and chart bars are neutral. Fetch is bordered, not amber, even though the spec would
   permit it as the one primary: an amber chip in the filter row reads as a hero.
7. **Now keeps table-left / pane-right and Mail keeps list-left / thread-right.** Both are
   `list | detail` in reading order; "same grid" is satisfied by sharing the pad, the pane width
   token, the row height and the hairline — not by mirroring, which would starve whichever surface
   needs the width.
8. **The laptop pane defaults to the top row's detail** instead of "No selection". The keyboard
   cursor still starts at `null`, so nothing is destructible by accident.
9. **Gmail gets no Connect button.** It cannot work. Its row states the fact; Fetch covers the data.
10. **Slack's entitlement toggle is not code.** `api.slack.com/apps/A0BT7FHS57H/app-assistant` is an
    operator action in Slack's console. The product's job is to *say so on the Slack row with the
    link*, which it already has and throws away, and to fill the desk via Fetch regardless.
11. **Task provenance is frozen onto the task** (copied, not referenced), because cards are swept.

---

## PART 6 — ORDER OF WORK

Server first, because a beautiful page over a lying pipe is the failure that produced this brief.

1. **Ingest honesty, server only.** Close the credential-present-and-failing hole in all four
   adapters; stop `gone = 1` firing on a partial poll; render `detail` regardless of `ok`; derive
   Connect/Disconnect from `hasWakeToken`; drop Gmail's dead Connect; drop Slack's terminal fallback.
2. **Fetch, server first**, behind the API, proven against Slack while Wake's own Slack is still the
   broken case — that is the only proof it is a second pipe and not a refresh button. Reuse or
   delete `sources/search.ts`. Write DECISIONS #31. Amend the anti-spawn test with its reason.
3. **`stripNestedBrief` against the real producer** (build the fixture from `renderPack`, not from a
   format nothing emits), and the task → brief path with frozen provenance.
4. **Tokens and the grid** — the three colour tokens, the hairline floors, one page pad, one gutter,
   one label column, one row height, one control height, eyebrow group labels.
5. **Now**, including Fetch in the chrome row, zero-count groups gone, the 44px phone row, the
   detail as a glance, and `useOverlay` on the push view.
6. **Settings**, then **Pulse**, then **Work**, then **Mail**, then **Open in Claude**.
7. Banned-string sweep. Typecheck. `bun test`. Push. **Confirm the restart.** Re-shoot. Fill the
   VERDICT table from the live URL.

---

## DEFINITION OF DONE

Every VERDICT row **NO**, answered from a fresh screenshot of **https://yuvraj-wake.truto.dev** at
1440 and 390, dark and light. No new screenshot pairs with FAIL 1–9. No banned string appears as
product chrome anywhere in `src/web`. `bun run typecheck` and `bun test` green, and the box confirmed
restarted on the pushed SHA.

---

# WHAT CHANGED, AND THE VERDICT

Appended 2026-08-30 after Gate B. Shipped as fifteen commits on `main`, ending at
**`01c2cadf285d68d31f3bdaaa02caa9dec6d9dc05`**.

**Deploy confirmed, not assumed.** The box reports HEAD `01c2cadf…`, `systemctl --user is-active
wake` → `active`, `/healthz` ok. `bun run typecheck` clean and **283 tests pass, 0 fail** on the
box's committed state — which matters, because the pull deployer runs that gate first and *silently
does nothing* if it fails, and a rewrite that never lands looks exactly like a rewrite that did.

**How the live URL was graded.** Cloudflare Access began challenging headless requests from the
grading machine partway through, and its login is an email OTP — not something to complete on the
operator's behalf. So identity was proven instead of assumed: **the public URL serves
`assets/index-CeG7A_o9.js` + `index-CxueZjGq.css`, byte-identical to the box's `dist/` at
`01c2cad` and to what an SSH tunnel to the same process serves.** Photographs were taken from
`https://yuvraj-wake.truto.dev` itself; pixel measurements were taken through the tunnel, against
that same build and that same database.

## The pipes

`now: 0` was a broken pipe, and it is no longer broken.

| | before | after |
|---|---|---|
| Now / Open / Parked | 0 / 19 / 1 | **45 / 60 / 1** |
| Slack | `ok:0` — every poll 400ing | **38**, own credential |
| Gmail | no obtainable credential | **30** |
| Sentry | `ok:1, count:0` — green, and had never worked | **16** |
| Claude Code | 22, of which Wake's own runs | **21**, self-runs excluded |
| GitHub | 4 | 4 |

Sentry had never returned a row: `search_issues` requires `organizationSlug`, Wake never sent it,
and a swallowed exception reported a green sync of zero for the source's entire life. Three adapters
turned an upstream failure into a successful empty poll, and `ingest.ts` then marked that source's
cards `gone = 1` — a data-loss path that is now closed.

**Fetch exists and is a second pipe, not a refresh button.** It was proven by returning real Slack
asks while Wake's own Slack credential was still being refused, using the box's own reach. A live
run: `found:25, fresh:1` in 9.8s across four connectors, each with a distinguishable state. Its rows
survive the poller (`fetch|5, poll|41`, 0 swept). It costs about a dollar and up to a minute when it
goes through the box, against the ~$0.25 this brief assumed — recorded honestly in DECISIONS #31
along with the reopening of #26, and the anti-spawn test was rewritten to guard the real invariant
(one spawn site, `--print`, a read-only allowlist, a timeout, a turn ceiling) rather than deleted.

## The verdict — every row from the live build

| # | Question | | Evidence |
|---|---|:--:|---|
| 1 | Settings wraps a section in a rounded bordered card? | **NO** | 0 bordered elements on every page surface, 24 surface×viewport×theme probes |
| 2 | A Mail section separate from Sources? | **NO** | Gmail is one row in SOURCES; no MAIL section exists |
| 3 | Target / char limit / templates / sessions-seen as a card? | **NO** | section list is You · Sources · Notifications · Appearance · This machine · Audit |
| 4 | "Connect one from a terminal" without a Connect failure? | **NO** | 0 hits in rendered text and in source |
| 5 | Push is an amber Turn on brick? | **NO** | `Turn on` is ghost text; 0 amber fills on Settings |
| 6 | Connect and Disconnect two control styles? | **NO** | both ghost, same weight, right-aligned at x=1320 w=96 |
| 7 | Source rows two lines / uneven height? | **NO** | all rows **44px**, name x=224 w=96, value x=320 |
| 8 | A 0-item pile as a titled chapter plus a sentence? | **NO** | a zero pile is not rendered; the Slack filter draws one group |
| 9 | Empty copy contains "from Slack" / "in flight"? | **NO** | `emptyWord` deleted; 0 hits |
| 10 | Sync is a wrapping paragraph at the foot of Now? | **NO** | `SyncLine` deleted; state lives on the chip and in Settings |
| 11 | No control labelled Fetch in the filter row? | **NO** | `Fetch` present in the chrome row on all 8 Now captures |
| 12 | Phone row joins kind · repo · why on one muted line? | **NO** | 44px, one line: glyph, title, age |
| 13 | Page title and group title the same type size? | **NO** | title 20px at x=224; groups **11px uppercase** + tabular count at x=224 |
| 14 | Detail shows a Wake pack as the body? | **NO** | 0 `<pre>`; `Packed by Wake` / `## Instruction` 0 hits |
| 15 | Two fact tables instead of one ≤4 rows? | **NO** | one table, 2 rows (mail card) / 3 rows (session card) |
| 16 | Resume is a bordered box? | **NO** | one mono line, `background: transparent`, `border 0px`, in a 44px row |
| 17 | Open is amber? | **NO** | every detail action ghost; 0 amber fills in the pane |
| 18 | Pulse has a subtitle or a hint sentence? | **NO** | titles only; no captions, no footer |
| 19 | A long empty axis for one day's bar, or a "not enough history" hole? | **NO** | a series with ≤1 marked day is a 44px row printing its number — `THROUGHPUT 4 on 08-30`, `RESPONSE TIME —` |
| 20 | Work empty says "A clear desk"? | **NO** | it is `—` |
| 21 | New task has a DETAIL textarea? | **NO** | 0 textareas in the sheet; stickies available at creation |
| 22 | Open in Claude a 1/2/3 tour or an amber Instruction brick? | **NO** | one sheet, 0 `<select>`, one amber commit (`Write the brief`) |
| 23 | Mail inbox teaches a terminal command? | **NO** | 0 hits; the down state is two lines |
| 24 | A banned string as product copy in `src/web`? | **NO** | whitespace-normalised sweep of all 41 strings over every file, **comments included: 0** |
| 25 | A new screenshot pairs with FAIL 1–9? | **NO** | see below |

**Row 25, photograph by photograph.** 1 — `<th>` x `[224,320,644,804,916,936,992]` equals `<td>` x
exactly; no dead band; the detail is a 2-row table with no amber. 2 — the phone detail is title, one
line, one table, a 3-line clipped excerpt with `More`, one seen-in line, four ghost actions. 3 — one
sheet, no rail, no native select, one amber commit. 4 — no DETAIL textarea. 5 — sparse series are
rows, not stretched axes. 6 — one column, no cards, ghost `Turn on`. 7 — 44px one-line rows, six
identifiable filters plus `Fetch` in one non-scrolling row, visible light hairlines. 8 — the Slack
filter is a title, a chip row and 39 real rows. 9 — one column, one label x, one value x, uniform
row height, no terminal chrome.

**Measured system.** Seven font sizes and no arbitrary size. Zero bordered cards on any page
surface. Zero banned strings rendered. **No horizontal scroll in 108 combinations** — coarse and
fine pointer × 360/390/414/640/768/1024/1280/1440/1920 × six routes. Amber at most two marks per
screen, and zero on Now, Settings and Pulse at laptop width.

## What is not true, stated rather than glossed

- The first actionable row sits at **y≈151** at 1440×900, not the ≤130 this brief asked for. The
  stack is title 42 + chrome row 32 + `<thead>` 31 + group eyebrow 30. It was 265.
- With the new-task sheet open on a phone, four accent fills exist in the DOM: the commit, a colour
  swatch in a colour picker, and two nav badges behind the scrim.
- The Mail composer still pairs an amber `Write` trigger with an amber commit inside it — the same
  pattern the task sheet had, out of scope for the pass that fixed the task sheet.
- Fetch costs roughly a dollar and up to a minute when it routes through the box.
- Sentry's standing query lands org-wide review issues nobody owns. That is the poller's question,
  not a regression, and it is noise on the desk.
- `Truto CLI` shows a placeholder for 3–5s before resolving.
- Slack's app-level MCP entitlement and the Cloudflare Access login are operator actions in someone
  else's console, not code.
