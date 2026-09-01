# Handoff — what the launch sheet needs from files it does not own

Written by the agent that owns `src/web/components/launch.tsx`,
`src/web/lib/launch.ts`, `src/web/lib/cardContext.ts`, `src/web/lib/slackThreads.ts`
and `test/ui-contract.test.ts`.

Everything below is a change in somebody else's file. Nothing here is blocking —
the sheet ships and works without any of it — but items **1** and **2** are
sentences the product is currently saying that are no longer true, and item 1 is
a lie that lands inside the session it is lying about.

---

## 1. `templates.ts` — two blocks of copy that say the opposite of what happens

**File:** `src/server/claudecode/templates.ts`, the `continue-session` template.
**Owner:** whoever owns templates.

The blurb the picker renders:

```ts
blurb: 'Carry a session already underway on the DevBox into a fresh conversation.',
```

There is no fresh conversation. Picking a session resumes *that* session —
`--resume <id>` in the directory it already ran in — and the sheet now says so
in the sentence under the session menu. Suggested:

```ts
blurb: 'Pick up a session already underway on the DevBox, where it stopped.',
```

The worse half is the instruction, because it is not on screen — it is written
**into the brief that the resumed session receives**:

```ts
instruction: `Pick up the work below. It comes from a Claude Code session on my machine, quoted here as context.

You are not resuming that session and you cannot: a link opens a new conversation, so the transcript is not loaded — only what is quoted below is. Treat it as a handover note from someone who has stopped talking, not as a conversation you are still in. …
```

That paragraph now arrives as the first message of the very session it is
describing in the third person, telling it that it is not itself. Every clause
in it is false: the transcript **is** loaded, it **is** the conversation it is
still in, and there is nothing to reconstruct. It needs rewriting, not deleting
— the template still has a job, which is "re-establish where this got to before
carrying on".

## 2. `router.ts` — `/state` still drops `kind`, so the Humanizer arrives as an eleventh investigation

**File:** `src/server/claudecode/router.ts`, the `/state` handler, in the
`templates: TEMPLATES.map(...)` projection.
**Owner:** the terminal/router agent.

This is the one-liner `HANDOFF_HUMANIZER.md` §1 asked for and it has not landed.
Verified against a running server on this branch: every template comes back with
`kind: undefined`.

```ts
templates: TEMPLATES.map(t => ({
  id: t.id, label: t.label, blurb: t.blurb, slots: t.slots,
  skills: t.skills, defaultRepo: t.defaultRepo, instruction: t.instruction,
  // A voice template is worn over an investigation rather than picked instead
  // of one, and the picker is the only place that distinction can be shown.
  kind: t.kind ?? 'investigation',
})),
```

**The sheet does not crash without it and does not need guarding.** The picker
splits on `t.kind === 'voice'`, so with the field absent the voice group is
empty, its heading is not printed, and the list renders exactly as it did
before — eleven flat rows with `Humanizer` last, which is where `TEMPLATES`
already puts it. Degraded, honestly. With the line applied (verified by patching
the response in the browser) the heading `VOICE, WORN OVER THE ABOVE` appears
above the Humanizer row, and selecting it leaves `Slack thread` selected.

## 3. `test/launch.test.ts` — two tests still assert the pack prints a resume command

**File:** `test/launch.test.ts` lines ~626 and ~649.
**Owner:** whoever owns the server packer.

They were failing on this branch when I picked the work up, from the packer's
own change rather than mine, and they pass again now — flagged only so the
amendment is a decision rather than a thing that quietly went away:

```ts
expect(body).toContain(`claude --resume ${SESSION_ID} --permission-mode bypassPermissions`)
expect(body).toContain('You are not resuming it')
```

Both are the defined failure of this work. If they come back, they come back as
the opposite assertion.

## 4. `CardDetail.tsx` — a dead read of `meta.resume_cmd`

**File:** `src/web/components/CardDetail.tsx` line ~183.

```ts
const resume = claude?.meta?.resume_cmd as string | undefined
```

`resume_cmd` has been removed from Claude Code session cards, so this is always
`undefined` now. The rendering that used it is already gone (line ~379 explains
the removal in a comment). The binding itself can go with it.

I made the equivalent change in the file I do own: `metaFor` in
`src/web/lib/cardContext.ts` used to copy `meta.resume_cmd` into a brief as
`resume_with`, and now carries `session: m.session_id` instead — the id every
other part of this release keys on.

## 5. `DECISIONS.md` #35 is superseded and still reads as current

**File:** `DECISIONS.md`, "35. The hand-off still opens a new conversation".

It is cited by name in the header of `launch.tsx` (I have rewritten that header
to say the decision has been overtaken) and its reasoning is sound for the world
it was written in — `claude.ai/new?q=` really cannot reach an existing
conversation. What changed is that the hand-off no longer goes through a URL at
all. It wants a superseding entry rather than an edit, because the reasoning is
worth keeping: #35 is why the picker was honest for as long as it could not
resume.

## 6. Nothing needed from `sessions.tsx`, `App.tsx`, `route.ts` or `terminal.ts`

`openTerminalAndGo` is used exactly as `HANDOFF_LAUNCH_API.md` specifies, from
two places on the sheet: the commit (`{ packId, brief }`) and the session
block's `Open the session` (`{ sessionId }`). No change is needed in any of
them.

---

## What the sheet now assumes about the wire, so it is on the record

* **`/api/claude/state` may carry `terminal.available`.** When it does and
  `ok` is false, the commit is disabled and `available.missing` is printed under
  it verbatim — verified against a box with no `claude` binary, which renders
  *"this machine cannot start a Claude Code session: the claude binary
  (WAKE_CLAUDE_BIN) is not available"*. The field is optional in the browser's
  type, so a `/state` without it means "assume the box is fine and report the
  503 if there is one".
* **`GET /api/cards/:group/slack`** is read once per sheet, keyed by the desk
  row's `group_key`. That key reaches the sheet on `PackItem.group`, a
  browser-only field set by `cardContext` and stripped by `launchApi.createPack`
  — it is how the sheet finds the row, never part of a brief. Nothing needs to
  pass it as a prop, which is why `CardDetail.tsx` did not have to change.
* **`POST /api/slack/link`** refusals are rendered as the server sent them.
  Verified with a direct-message archive link, which renders *"Wake does not
  carry direct messages"* under the field.
