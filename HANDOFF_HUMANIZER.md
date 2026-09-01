# Handoff — the Humanizer template

I added a template, `humanizer`, to `src/server/claudecode/templates.ts`. It is
the only row in that list that is not an investigation: it says nothing about
what to find out and everything about how the last message reads. It is meant to
be selected *on top of* another template.

I own `templates.ts` and the new tests only. Three things live in files I was
told not to touch. One of them is a bug today.

---

## 1. `/state` drops the new field. This one is broken now.

`src/server/claudecode/router.ts` builds its template list by naming each field:

```ts
templates: TEMPLATES.map(t => ({
  id: t.id, label: t.label, blurb: t.blurb, slots: t.slots,
  skills: t.skills, defaultRepo: t.defaultRepo, instruction: t.instruction,
})),
```

`kind` is not in that list, so the browser cannot see it. The Humanizer arrives
at the picker looking exactly like an eleventh thing to investigate, which is
the one thing it is not.

**Needed, in `router.ts`:**

```ts
  // A voice template is worn over an investigation rather than picked instead
  // of one, and the picker is the only place that distinction can be shown.
  kind: t.kind ?? 'investigation',
```

Defaulting here rather than in `templates.ts` keeps the ten rows that predate
the field unchanged and still gives the browser a value it can switch on.

## 2. The browser's mirror of `Template` has no `kind`

`src/web/lib/launch.ts` re-declares the type the `/state` payload arrives as.
Add the same optional field so the composer can read it:

```ts
kind?: 'investigation' | 'voice'
```

## 3. The picker should show it as a modifier

`src/web/components/launch.tsx` renders `meta.templates` as one flat list of
rows you pick from. The Humanizer is last in `TEMPLATES` on purpose, below
`Blank`, so it already falls to the bottom without any change — but a flat list
still says "pick one of these eleven jobs".

Whatever treatment you choose, the thing it has to communicate is that selecting
it does not deselect `Customer incident`. A rule, a small "voice" tag on the
row, or a separate heading would all do it. Nothing here is load-bearing for
correctness; the server composes it correctly either way.

---

## Optional, and deliberately not done: ordering in `buildPack`

`chosenTemplates` in `src/server/claudecode/launch.ts` preserves click order, and
`buildPack` concatenates the instructions in that order under `## What I need`.
So the voice section lands above `Customer incident` if it was clicked first.

I did not change that, and I do not think it is urgent. The Humanizer's own text
opens by declaring what it governs —

> VOICE. This section governs the words I will send, and nothing else. It
> replaces nothing else in this brief: the rest still says what to investigate,
> and none of it is softened.

— which is what stops a session reading it as step one of the investigation, and
`test/humanizer.test.ts` proves both orders survive intact.

If you want it structurally guaranteed rather than argued in prose, the change is
one line in `chosenTemplates`: sort voice templates to the end, so the voice is
always the last word before the packed objects.

```ts
// A voice template governs the reply, so it reads last — after the work it is
// worn over, not in the middle of that work's steps.
out.sort((a, b) => Number(a.kind === 'voice') - Number(b.kind === 'voice'))
```

That is a behaviour change to a shared file, so it is yours to make, not mine.

---

## What already works, so you do not need to re-derive it

- `humanizer` is selectable alongside anything. Its `slots` are the full set.
- Skills union for free: `buildPack` already flat-maps every selected template's
  `skills`, so a brief with `Customer incident` + `Humanizer` names four skills,
  deduplicated by `normaliseSkills`.
- `defaultRepo` is `null`, so adding it never overrules the repository the
  investigation template chose.
- With the Humanizer unselected, the brief is byte-identical to what it was
  before this change. `test/fixtures/brief-before-humanizer.ts` is the frozen
  text and `test/humanizer.test.ts` compares against it. If you change the
  packer's wording on purpose, that test is where it will surface — read the
  diff, agree with it, regenerate the fixture.
