You own this session end to end. The operator is offline. He will
not answer. Do not ask him anything. Do not wait. Do not write
questions. If two readings exist, pick the one that is classier
and faster to understand at 7am, write one line, continue.

Finish the entire loop in this session. No handoff. No plan-and-
stop. No markdown-and-stop.

    see the live site → specialists → one brief → implement
    everything in that brief → test → commit → push → make it
    live → test the public URL → fix leftovers → live again
    until the public URL is the product.

This host is personal. Nobody else is using it. You may revamp
UI, UX, behaviour, and internals as far as you need. Do not make
the product dishonest. Do not add a chatbot. Do not send mail.
Do not disconnect working sources. Do not commit secrets. Do not
force-push.

The last agent already “shipped Gate B.” The operator then
photographed the public URL and called it miserable. Those six
photographs are attached to this prompt. They ARE the product
today. They are not old. They are the FAIL. If your work still
looks like them, you failed, even if every feature works.

════════════════════════════════
PRODUCT
════════════════════════════════

Wake is Yuvraj’s ops console. One human. First surface of the
day: what is on him, what he started, what he is working on.

    Public URL     https://yuvraj-wake.truto.dev
    Disk           ~/work/wake
    Remote         https://github.com/yuvraj3335/-me-now
    Deploy         push origin/main → DevBox timer, or
                   ssh yuvraj-devbox '~/work/wake/deploy/wake-deploy.sh'
                   (ssh yuvraj-devbox works; yuvraj.truto.dev often
                   fails publickey)

He is yuvraj@truto.one. Not Redroot. Not engineering@.
Ink and amber. No glass. No in-app agent. Open in Claude is a
pack-then-link for doing work.

If detailed.md is not yet true on the public URL, that leftover
is part of this brief. Do not start “polish only” on a lie.
Do not treat detailed.md, WAVE.md, or a previous agent’s
comments as proof the UI is good. The photographs are proof
it is not.

Look at these as products for feeling — density, craft, first
glance, how a control feels in the hand. Do not copy source,
framework, or colour.

    ~/work/truto-app
    ~/work/truto-monitoring

Do not use the Truto backend repo. Wake is React.

════════════════════════════════
WHY THE LAST SHIP FAILED
════════════════════════════════

Previous agents read “no help-text essays” and then wrote
longer comments explaining why the essay should stay. They
read “not boxy” and built a masonry of eight Settings cards
with holes between them. They read “Pulse is professional”
and floated four charts in a black void, each with a second
sentence teaching you what the title already said. They read
“detail pane, not a fat modal” and dumped the packed brief,
the Instruction, two fact tables, a command box, and four
amber-outline slabs into the pane.

That is the failure mode. Do not repeat it.

    A heading is enough. If you need a sentence under it,
    the heading is wrong or the control is wrong.
    Alignment is a grid, not “roughly left.”
    Empty is empty. It is not a tutorial.
    Provider text is data. Product copy is chrome.
    Chrome does not explain itself.

════════════════════════════════
THE SIX PHOTOGRAPHS — FAIL IF STILL TRUE
════════════════════════════════

These are the operator’s shots of the live site. Quote them
in WAVE.md. After Gate B, none of these may still be true.

1. NOW · LAPTOP (list | detail)
   The table headers KIND TITLE WHY SOURCE WHEN do not sit on
   the same x as the cells. SOURCE and WHEN read as one word.
   “Now 0 / Nothing waiting” is a dead band the height of a
   paragraph. The right pane is a dump: markdown excerpt,
   PULL REQUEST table, SESSION table, `claude --resume` box,
   then a “You:” / “Packed by Wake at …” / “## Instruction”
   essay. Four fat buttons on the bottom: Open (solid amber),
   Claude, Task, Done.

2. NOW · PHONE DETAIL
   Same dump, full screen. Key/value pairs with a random gap.
   The packed brief is the body. Four bulky rectangles plus
   ⋯ sit on the home-indicator.

3. OPEN IN CLAUDE
   A three-step landing page (1 Context · 2 Instruction ·
   3 Read it). A repo dropdown covers half the sheet.
   “Instruction” is a saturated amber brick.

4. WORK
   Empty desk is a tutorial: “A clear desk. Work arrives two
   ways…”. Voice notes teach you they stay on the machine.
   + Task is a landing-page CTA. New task is a fat modal:
   TASK, DETAIL (a body field), two identical pill rows,
   seven colour circles, a full-width Add task brick.

5. PULSE
   Subtitle: “How fast you’re actually moving.”
   Three numbers floating with no shared baseline.
   Charts are islands. Each title has a hint sentence.
   Throughput is one amber stick on 08-30 in a month of air.
   Response time is “Not enough history yet” in a hole.
   The pile splits Arrived / Cleared into two lonely charts.
   The clock and weekday bars do not share a height.
   Footer essay about the activity log.

6. SETTINGS
   Eight cards of different heights in a broken grid. YOU
   is two rows and a hole. SOURCES is a novel. MAIL
   repeats Gmail. NOTIFICATIONS is an amber Turn on brick.
   OPEN IN CLAUDE lists Target URL, 12,000 characters,
   template counts. “Connect one from a terminal” is on
   the board. Nothing shares a vertical rhythm.

If a reviewer can match a new screenshot to one of these
six, WAVE.md is still false.

════════════════════════════════
WHAT MUST EXIST
════════════════════════════════

THE DESK
    Now is not a pile of identical cards. A table he can scan.
    Filters: Slack, Gmail, GitHub, Sentry, Claude Code.
    Laptop: nav on the left, list | detail. Phone: nav on the
    bottom, panes. Opening a row does not bury the list behind
    a fat modal of buttons.

    He takes a row → makes a task that still knows why it
    exists → writes notes on that task (create-a-note, and a
    sticky-note surface that feels like paper, not a “body”
    field) → Open in Claude from the task with description,
    source, and notes already in the brief → Pulse to see if
    he is moving. One product, not four leftover screens.

    Pulse is a serious analytics surface. First glance: am I
    moving. Then ranges, comparisons, sources, honest empty.
    Function and craft.

BOTH PIPES — do not pick one. Same stack. Dedup.

    Pipe 1 — Wake’s own login. Where Wake actually has a
    credential, it can fill the desk without a click. GitHub
    via gh. Mail may auto-refresh if Wake has a direct Gmail
    token. Slack and Sentry only auto-fill after Wake has its
    own login (Connect or a token on disk). Give them that
    path. claude.ai “Connected” in Claude Code is NOT Wake’s
    login. Do not poll Slack with an empty file.

    Pipe 2 — Fetch. One obvious control. He presses it. Wake
    asks Claude on the box (Slack, Gmail, Sentry, and whatever
    else Claude already has Connected) plus a cheap Sonnet to
    pull what is on Yuvraj and TrutoEngineering: Slack, mail,
    PRs, Sentry assigned to him. Structured objects land on
    the same desk. Fetch works even when Wake’s Slack/Sentry
    login is missing.

    After either pipe: filter, open, task, notes, Open in
    Claude, done — in Wake. The cheap model only collects.
    It is not a chat.

The photographs do not show Fetch. That is a product hole,
not a reason to hide it. Fetch lives in the same chrome as
the filters — a quiet control, same height, same type, not
a second hero button.

════════════════════════════════
HOW IT MUST FEEL — already decided, now checkable
════════════════════════════════

Classy. Superior. Aesthetic. Easy to see. Easy to use.
Laptop and phone both, not “desktop then squeeze.”

This is not a coat of paint at the end. Every feature you
ship is shown and used at this bar.

VISUAL SYSTEM — violate any one and the page is not done.

    Type
        One sans for the product. Mono only for ids, paths,
        commands, emails, resume lines.
        Use the tokens already in src/web/styles.css
        (eyebrow / sm / md / lg / display). Do not invent
        text-[10.5px] … text-[38px] on a page.
        A screen may use display at most three times, and
        only for Pulse’s three hero numbers.
        Labels are eyebrow. Values are sm. Row titles are md.
        If two sizes sit next to each other and you cannot
        say why, delete one.

    Colour
        Ink ground. Amber at most three times on a screen,
        and only for “this one” — never for Open, never for
        a Settings brick, never for a chart title.
        Dark text must read without squinting (fg / fg-dim;
        mute is labels only). Light mode unbroken: hairlines
        visible, amber-as-text uses accent-ink.

    Alignment
        One vertical grid per page. Labels share one x.
        Values share one x. Section titles share one x.
        A table’s <th> sits on the same x as its <td>.
        If SOURCE and WHEN collide, the columns are wrong.
        Gutters are one token. No “floating” islands.
        No masonry. No items-start card grid that leaves a
        hole beside a tall tile. If a block has no sibling
        in that row, it is full width or it is in a single
        column — never a lonely card in a 3-col wreck.

    Structure
        Hairlines, not boxes. A row is a row. A section is
        a title plus rows. You may use a quiet edge on a
        sheet or a sticky. You may not wrap every group in
        a rounded card “to make it tidy.”
        Do not fix misalignment by adding more boxes.

    Controls
        Tool, not landing page. Height of a row, not a CTA.
        Text or a 14px icon. One primary on a surface, and
        only when something is being committed (Fetch, Add,
        pack). Connect / Disconnect / Turn on / Open are
        not primaries.
        Hit targets on the phone: 44px. No 22px × icons
        in a cluster of four slabs.

    Copy
        Headings are enough. Empty is a noun or nothing
        (“Nothing waiting”, “—”, blank).
        Product chrome does not teach. Provider text may
        appear as data, clipped.
        Banned strings — if any of these exist as product
        copy on the public URL, WAVE.md is false:

            How fast you’re actually moving
            How fast you're actually moving
            tasks finished each day
            how long something waits before you touch it
            what arrived vs what you cleared
            when the work actually happens
            what is piling up, and how stale it is
            tasks completed against each
            Every number here is counted from your own
            A clear desk.
            Work arrives two ways
            a task made from a card keeps a link
            Nothing recorded. A voice note stays
            Connect one from a terminal
            Link tasks to this goal from any task
            Packed by Wake
            ## Instruction
            You:
            Gmail is not connected
            Fix it from a terminal
            It must be a directly-added HTTP server
            Reading what's on you          (except a 200ms load)
            Reading what's queued…        (except a 200ms load)
            Pick a thread.
            Not enough history yet
            no history yet
            not enough data
            Nothing here yet

        “Packed by Wake” / “## Instruction” / “You:” may
        exist inside a stored session excerpt. They must
        not render as the body of the detail pane. Clip
        the excerpt to three lines. Expand on tap. Never
        pretty-print a Wake pack as the card.

    Motion
        No exit animations that stall navigation.
        No waiting on a frame that may never come.
        Sheets and panes, not bounce.

    Phone
        Bottom nav: Now Mail Work Pulse Settings — or
        Now Mail Work More, with Pulse and Settings one
        tap behind More. Not a squeezed laptop.
        Detail is a full-screen pane with the same
        content rules as the laptop pane, not a second
        design. No horizontal scroll. Filters wrap or
        scroll as one chrome row with Fetch.
        Work / Pulse / Settings / Mail: one column,
        shared x, no card masonry.

    Laptop
        Left rail. List | detail on Now and Mail.
        Fetch sits with the filters, where the hand is,
        not in Settings, not as a hero under the title.

If you would sigh at a screen, it is not done.
If a feature works but feels cheap, it is not done.
If you kept a sentence because a previous comment said
it was “the honest empty,” delete the sentence.

════════════════════════════════
PER SURFACE — what 7am must see
════════════════════════════════

NOW
    Title. Refresh as an icon. Filters + Fetch as one row.
    Table: Kind · Title · Why · When. Source as dots in
    When’s neighbourhood or a narrow glyph column — headers
    must match cells. Groups Now / Open / Parked are labels
    on the table, not empty chapters. “Now 0” is one line,
    not a void.
    Row click opens the pane. Later / Done stay 14px icons
    on the row.

NOW DETAIL
    Title. One why · when line.
    One fact table, ≤4 rows, 96px labels. Merge PR + session
    into one table if both exist (repo, #, project — not two
    novels).
    Excerpt: 3 lines, fade, expand.
    Resume: one mono line with a copy glyph, not a box.
    Seen-in: one line, dots + names.
    Actions: Open · Claude · Task · Done as text/icon in
    one bar. Amber, if used at all, is Task or Claude —
    never Open. ⋯ for Later / Not mine / Park.

OPEN IN CLAUDE
    A sheet, not a product tour. Context is the list.
    Repo is a field; its menu may not cover the list.
    Instruction is the next beat, not a brick labelled
    Instruction. The packed brief is reviewable. The
    hand-off is a real link. No chatbot.

WORK
    Title + count. Tasks | Goals as text, not pills with
    a speech.
    Empty Up next: blank. No tutorial.
    + is a small control, top right, same weight as a
    filter.
    New task: title. Stickies (paper, colour, short) —
    not a DETAIL textarea. Deadline / remind: one line of
    words, not two rows of fat pills. Colour: the sticky’s
    paper, not a swatch parade you must explain.
    A task made from a row already knows why. Show that as
    one quiet line, not a paragraph.
    Voice: a mic. Zero notes = no paragraph.

MAIL
    List | thread on laptop. Panes on phone.
    Same grid as Now. No essay when Gmail is down: the
    source row in Settings is the place to Connect. Mail
    may say “Gmail · not connected” as a status line and
    a Connect text action. No terminal lecture on the
    inbox.

PULSE
    Title. 7d 30d 90d as text.
    Three hero numbers on one baseline, three labels on
    the next, three comparisons on the third. That is the
    glance.
    Then a 2×2 (laptop) / stack (phone) of charts that
    share gutters and a baseline. Title only. No hint=.
    Sparse data stays compact — do not draw a month of
    empty axis for one day. Empty series is “—” in the
    chart’s title row, not a hole with a sentence.
    Clock and weekday share a row and a height.
    No footer essay.

SETTINGS
    Not a dashboard of cards. One column on phone. On
    laptop, one column or two columns that share row
    rhythm — a list of sections, not a masonry.
    You: email, GitHub. Once.
    Sources: one row each. Dot, name, state word, one
    fact, Connect|Disconnect as text. Slack and Sentry
    have a real Wake login path. Do not disconnect
    Sentry. Do not show “synced” when lastSync failed.
    Mail is Gmail in Sources. Delete the extra Mail card.
    Push: a switch. Not an amber Turn on.
    Appearance: the segmented control, in the list.
    Everything else (handoff URL, char limit, skill
    counts, CLI fallback) lives behind one disclosure
    or is gone. A Connect failure may reveal the
    terminal fallback under THAT row. It is not chrome.

════════════════════════════════
GATE A — SPECIALISTS, THEN ONE FILE
════════════════════════════════

Public URL. Real browser. Desktop and phone-width. Dark and
light. Localhost is not the product. Access login is not a
Wake bug. WARP / Access — you deal with them.

Create sub-agents. Each has one job. They do not implement
Wake. You take the artifact. You delete them: no leftover
agents, worktrees, branches, temp clones, processes.

    UI designer
        Every screen against the six photographs and the
        visual system above. Type, contrast, density,
        controls, empty states, stickies, Pulse, Fetch,
        tables, sheets. What classy looks like here.
        What still matches a photograph.

    UX specialist
        How each feature is used: Fetch, both pipes, row →
        detail, make task, notes, Open in Claude, Pulse,
        Settings. Friction. Phone vs laptop. What the
        experience must be. The pane must be a glance,
        not a briefing.

    QA specialist
        What is actually true on the public URL today.
        Click everything. Quote the live copy. Note
        whether Fetch exists. Note Slack/Sentry/Gmail
        state without disconnecting anything.

    Visual / craft
        Alignment, hierarchy, aesthetic. Laptop and phone.
        Draw the grid. Mark every x that does not match.

    Engineer
        Product-level only: both pipes, Claude login vs
        Wake login, task/notes/Pulse, Fetch. Not a file
        recipe.

You compile one coherent brief. Specialists gone.

    ~/work/wake/WAVE.md

Finished when another agent can execute it with the operator
still offline. It contains:

    what is true on the public URL (proven), including
      which of the six photographs still match
    the kill list of banned strings, still present or not
    what will be true (desk, both pipes, Fetch, tasks,
      notes, Pulse, the visual system, the per-surface
      rules)
    how each feature should feel to use (not how to code it)
    laptop and phone
    what must not break
    choices made without asking
    definition of done — only checkable on the public URL,
      including “no photograph still matches” and “no
      banned string exists as product copy”

Do not implement during Gate A.

════════════════════════════════
GATE B — IMPLEMENT EVERYTHING, THEN MAKE IT LIVE
════════════════════════════════

Only after WAVE.md is complete.

ONE implementer. World: WAVE.md, the six photographs,
public URL, ~/work/wake. Makes every item true. Revamps
as far as needed. Does not shrink the brief. Does not add
a chat. Does not ask. Does not keep a banned sentence
because a comment said it was honest.

Then that work is tested (the implementer does not ship
blind). Then commit. Push to the remote this host already
deploys from. Make it live. Done is not “pushed.” Done is
https://yuvraj-wake.truto.dev serving the new product.
Delete the implementer.

You (orchestrator) test the public URL yourself: every
destination, Fetch, both pipes as they can work, Now →
task → notes → Open in Claude, Pulse, Settings, desktop
and phone-width, dark and light, the feel of the controls.

Photograph the same six angles. If any still matches, or
any banned string remains, or anything feels cheap: ONE
fixer on leftovers only. Delete it. Test live again.
Loop until the public URL matches WAVE.md and you would
not sigh.

Append what shipped to WAVE.md.

Leave local dirty files that are not this work uncommitted.
Do not commit .env or secrets.

════════════════════════════════
DONE — all true on the public URL
════════════════════════════════

    Desk: table, filters, panes, left nav / bottom nav.
    Fetch obvious in the filter chrome; Claude MCP + cheap
    Sonnet fills Slack, mail, PRs, Sentry into the same
    stack.
    Wake’s own logins still fill what they can.
    Slack/Sentry have a real Wake login path (not claude.ai
    Connected-as-Wake-token).
    Dedup across pipes. No fake “synced.”
    Task keeps its story. Notes + stickies. Open in Claude
    from a task has description and notes.
    Pulse is professional: three numbers, then charts that
    share a grid, honest compact empty, no hint sentences.
    Settings is a list, not a masonry of cards.
    The detail is a glance: title, four facts, clipped
    excerpt, quiet actions.
    The whole thing is classy on laptop and phone:
    alignment, type, contrast, controls, how each feature
    is shown and used.
    None of the six photographs still match.
    No banned string exists as product copy.
    No chatbot. No Redroot. No help-text relapse.

FORBIDDEN
    Ask. Wait. Plan-and-stop. Markdown-and-stop.
    Implement before WAVE.md is complete.
    Leave sub-agents behind.
    Localhost as the product.
    Chatbot. Send mail. Disconnect sources.
    Treat claude.ai Connected as Wake’s Slack token.
    Copy truto-app or monitoring into Wake.
    Force-push. Commit secrets.
    Keep a banned sentence and “hide” it behind a
    comment, a details summary that is itself an essay,
    or a hint= prop.
    Fix alignment by adding more cards.
    Spend amber on Open or Turn on.
    Dump a Wake pack into the detail pane.

THERE IS NO ONE TO PING
WARP / Access / deploy / tests — you deal with them.
Open https://yuvraj-wake.truto.dev now.
Attach the six photographs. They are the FAIL.
Do not answer this message with a plan.
