/**
 * The Humanizer, which is the only template that is not about the work.
 *
 * Every other row says what to find out. This one says how the last message
 * reads, and it is worn over one of the others rather than picked instead of
 * one. That shape fails in two directions, and this file pins both.
 *
 *   1. **Smothering.** Selected alongside `Customer incident`, it must not
 *      replace, truncate or soften a word of that template's investigation.
 *   2. **Leaking.** Unselected, it must not exist. A voice rule that reached a
 *      brief nobody asked it to reach would change every reply this product
 *      drafts, silently, and nobody diffs a brief. That is what the frozen
 *      fixture is for: the byte-for-byte text of a brief with no voice in it.
 *
 * ── AMENDED: the position problem is now structural ───────────────────────
 *
 * This file used to test the two *click orders* separately, and then assert
 * that the voice section opened by declaring what it governed — because
 * `buildPack` concatenated the selected instructions into `## What I need` in
 * the order they happened to be clicked, so clicking the Humanizer first put a
 * paragraph about sentence length above `Customer incident`, where a session
 * reads it as step one of the investigation. The template defended itself with
 * three sentences of its own text: "VOICE. This section governs the words I
 * will send, and nothing else…".
 *
 * That was a workaround paying rent on a structural mistake, and it cost about
 * 200 of the template's ~1,100 characters. `buildPack` now separates the two
 * kinds: investigations render under `## What I need`, voice renders under
 * `## How the reply should read`, always last, whatever order the rows were
 * clicked in. So the test changed shape with the code — it no longer asks the
 * text to declare its own scope, it asks the *brief* to put it in the right
 * place, which is a stronger claim and one the instruction cannot get wrong.
 *
 * The characters that bought back went into `WHAT IT IS NOT`, which bans the
 * two evasions a model reaches for when it is asked to write in somebody's
 * voice: handing back options to choose between, and explaining the message
 * before giving it.
 */

import { describe, expect, test } from 'bun:test'
import { buildPack, renderPack } from '../src/server/claudecode/launch'
import { TEMPLATES, getTemplate } from '../src/server/claudecode/templates'
import { BRIEF_BEFORE_HUMANIZER } from './fixtures/brief-before-humanizer'

const humanizer = getTemplate('humanizer')!
const incident = getTemplate('customer-incident')!

/** The item every pack here carries, so the two orders differ in nothing else. */
const ITEMS = [
  { kind: 'slack' as const, ref: 'C123:1724.99', title: 'Acme thread', excerpt: 'our sync stopped', why: 'the report' },
]

function brief(templates: string[]): string {
  const built = buildPack({ template: templates[0]!, templates, items: ITEMS })
  if ('error' in built) throw new Error(built.error)
  return built.firstMessage
}

/**
 * One template's own words, lifted back out of the brief.
 *
 * Multi-select renders `### <label>` per template under a single `## What I
 * need`. Pulling a section back out and comparing it to the template's own
 * string is the difference between "the words are in there somewhere" and "that
 * template arrived intact and nothing was interleaved into it".
 */
function section(body: string, label: string): string {
  const start = body.indexOf(`### ${label}\n`)
  if (start === -1) throw new Error(`no "### ${label}" section in the brief`)
  const after = body.slice(start + `### ${label}\n`.length)
  const end = after.search(/\n(?:## |### )/)
  return (end === -1 ? after : after.slice(0, end)).trim()
}

/** A top-level `## <heading>` block, lifted whole. */
function block(body: string, heading: string): string {
  const start = body.indexOf(`## ${heading}\n`)
  if (start === -1) throw new Error(`no "## ${heading}" section in the brief`)
  const after = body.slice(start + `## ${heading}\n`.length)
  const end = after.search(/\n## /)
  return (end === -1 ? after : after.slice(0, end)).trim()
}

/**
 * The ten phrases he never wants to read in something sent under his name.
 *
 * Listed here as data rather than checked as a blob, so a failure names the one
 * that went missing from the instruction instead of saying the string changed.
 */
const BANNED = [
  'happy to help', 'great question', 'as an AI', 'I hope this helps',
  'let me know if you have any questions', 'circle back', 'reach out',
  'deep dive', 'leverage', 'utilize',
  // The two he banned himself, in consecutive turns, on a draft that was
  // otherwise finished: "Dont use workds like these -good catch, a" and then,
  // about the next attempt, "You're right, not even this". Both are the sound
  // of a model agreeing with him rather than answering, which is the one thing
  // a message sent under his name must never do.
  'good catch', "you're right",
]

describe('the Humanizer is a modifier, not an investigation', () => {
  test('it is typed as one', () => {
    expect(humanizer.kind).toBe('voice')
    // Exactly one voice row. If a second one ever appears, two of them selected
    // together are two registers arguing inside one brief, and this test is
    // where that conversation should start.
    expect(TEMPLATES.filter(t => t.kind === 'voice').map(t => t.id)).toEqual(['humanizer'])
    for (const t of TEMPLATES.filter(t => t.id !== 'humanizer')) {
      expect(t.kind ?? 'investigation', `${t.id} changed kind`).toBe('investigation')
    }
  })

  test('its label and blurb say it is about the words, not the work', () => {
    expect(humanizer.label).toBe('Humanizer')
    const blurb = humanizer.blurb.toLowerCase()
    expect(blurb).toContain('reply')
    // "not what to look into" is the whole point of the row and the only thing
    // that stops it reading as an eleventh kind of investigation.
    expect(blurb).toContain('not what')
  })

  test('it never tells anyone what to investigate', () => {
    // A voice template that starts naming the CLI, or an object to go and read,
    // has drifted into being a second investigation — at which point selecting
    // it alongside a real one puts two sets of orders in one brief.
    for (const trespass of ['Truto CLI', 'environment', 'integrated account', 'logs']) {
      expect(humanizer.instruction, `humanizer instruction reaches into "${trespass}"`)
        .not.toContain(trespass)
    }
  })

  test('it can be worn over anything, so it takes every slot', () => {
    for (const t of TEMPLATES) for (const s of t.slots) expect(humanizer.slots).toContain(s)
  })
})

describe('what the Humanizer demands of the reply', () => {
  test('the slop is named, one phrase at a time', () => {
    for (const phrase of BANNED) {
      expect(humanizer.instruction, `"${phrase}" is not banned by name`).toContain(phrase)
    }
  })

  test('it asks for short, plain, one-idea sentences', () => {
    const i = humanizer.instruction
    expect(i).toContain('Short sentences')
    expect(i).toContain('One idea each')
    expect(i.toLowerCase()).toContain('plainest word')
  })

  test('it asks for the fact, the cause and the next step, and nothing else', () => {
    const i = humanizer.instruction
    expect(i).toContain('The fact, then the cause if it is known, then the next step')
    expect(i).toContain('Nothing else')
  })

  test('it says what to do when the cause is not known', () => {
    // The failure this replaces: a model that does not know the cause writes
    // three paragraphs about the investigation instead of one sentence about
    // the gap.
    const i = humanizer.instruction
    expect(i).toContain('If the cause is not known')
    expect(i.toLowerCase()).toContain('do not pad the gap')
  })

  test('it forbids the shapes as well as the phrases', () => {
    const i = humanizer.instruction.toLowerCase()
    for (const shape of ['no headings', 'bullet-point essay', 'no sign-off', 'no jargon', 'no filler']) {
      expect(i, `"${shape}" is not forbidden`).toContain(shape)
    }
    // It has to sound typed, not published.
    expect(i).toContain('slack')
    expect(i).toContain('not a blog post')
    expect(i).toContain('not a status report')
  })

  test('it asks for the message itself, not a document containing one', () => {
    expect(humanizer.instruction).toContain('DELIVER. The message itself, ready to paste')
  })
})

describe('the Humanizer worn over Customer incident', () => {
  test('the investigation arrives whole, and the voice lands in its own section', () => {
    for (const order of [['customer-incident', 'humanizer'], ['humanizer', 'customer-incident']]) {
      const body = brief(order)
      // Byte-for-byte the template's own text, lifted back out of the brief.
      // Not `toContain` on a fragment: the claim is that nothing was dropped,
      // reworded or interleaved, and only equality says that.
      expect(block(body, 'What I need'), `order ${order.join('+')}`)
        .toBe(incident.instruction.trim())
      expect(block(body, 'How the reply should read'), `order ${order.join('+')}`)
        .toContain(humanizer.instruction.trim())
    }
  })

  /**
   * The click order cannot move the voice any more, and that is the whole fix.
   *
   * `buildPack` still concatenates in click order — nothing in `templates.ts`
   * reorders anything — but the two kinds no longer share a list to be ordered
   * within. Whichever row was pressed first, the orders come before the register
   * they are written in, which is also the order the work happens in.
   */
  test('the voice is last whichever order it was clicked in', () => {
    for (const order of [['customer-incident', 'humanizer'], ['humanizer', 'customer-incident']]) {
      const body = brief(order)
      expect(body.indexOf('## What I need'), `order ${order.join('+')}`)
        .toBeLessThan(body.indexOf('## How the reply should read'))
      // And the investigation is not inside the voice section, nor the reverse.
      expect(block(body, 'What I need')).not.toContain('paste into Slack')
      expect(block(body, 'How the reply should read')).not.toContain('root cause')
    }
  })

  test('the section says what it governs, so the instruction does not have to', () => {
    const body = brief(['customer-incident', 'humanizer'])
    const voice = block(body, 'How the reply should read')
    expect(voice).toContain('This governs the wording of what I will send, and nothing else.')
    expect(voice).toContain('It replaces none of the above.')
    // And the template got those characters back rather than spending them on
    // defending its own position in a list it is no longer in.
    expect(humanizer.instruction).not.toContain('VOICE.')
    expect(humanizer.instruction).not.toContain('It replaces nothing else in this brief')
  })

  test('the investigation still says what to investigate', () => {
    const body = brief(['customer-incident', 'humanizer'])
    expect(body).toContain('Take this report to a root cause and a safe reply')
    expect(body).toContain('Truto CLI')
    expect(body).toContain('do not guess an environment')
    expect(body).toContain('DO NOT. Mutate anything. Send the reply.')
  })

  test('and the voice rules are in the same brief', () => {
    const body = brief(['customer-incident', 'humanizer'])
    for (const phrase of BANNED) expect(body, `"${phrase}" did not survive packing`).toContain(phrase)
    expect(body).toContain('Short sentences')
    expect(body).toContain('If the cause is not known')
  })

  /**
   * A voice row on its own still produces a brief that says what to do.
   *
   * The failure this guards is small and total: pick only the Humanizer, and
   * `## What I need` used to be the voice rules, which is a brief whose entire
   * instruction is about wording. Now that voice is lifted out, the same brief
   * would have had an *empty* orders section — which is worse. `buildPack` says
   * the honest thing instead: no investigation was chosen, so ask.
   */
  test('the voice on its own still leaves an objective', () => {
    const body = brief(['humanizer'])
    const need = block(body, 'What I need')
    expect(need.length).toBeGreaterThan(40)
    expect(need).toContain('I picked no investigation')
    expect(block(body, 'How the reply should read')).toContain('ready to paste')
  })

  test('a typed instruction replaces the investigation and keeps the voice', () => {
    // They answer different questions. Writing the objective by hand is not a
    // reason to stop wanting the reply in his own register.
    const built = buildPack({
      template: 'humanizer',
      templates: ['customer-incident', 'humanizer'],
      instruction: 'Just tell Priya the sync is back.',
      items: ITEMS,
    })
    if ('error' in built) throw new Error(built.error)
    expect(block(built.firstMessage, 'What I need')).toBe('Just tell Priya the sync is back.')
    expect(block(built.firstMessage, 'How the reply should read')).toContain('ready to paste')
  })

  test('the skills of both are named, neither list replacing the other', () => {
    const body = brief(['customer-incident', 'humanizer'])
    for (const s of [...incident.skills, ...humanizer.skills]) expect(body).toContain(s)
  })
})

describe('with the Humanizer off, the brief is what it always was', () => {
  test('byte-for-byte the text from before this row existed', () => {
    // Fixed inputs, so the only things that can move this string are the packer
    // and the templates — which is the point. If you changed either on purpose,
    // regenerate test/fixtures/brief-before-humanizer.ts and read the diff.
    const body = renderPack({
      template: 'customer-incident',
      templates: ['customer-incident'],
      title: 'Acme sync stopped',
      cwd: '/w/truto',
      repo: 'truto',
      skills: incident.skills,
      instruction: incident.instruction,
      items: ITEMS,
      createdAt: 0,
    })
    expect(body).toBe(BRIEF_BEFORE_HUMANIZER)
  })

  test('a single-template brief carries that template and nothing appended', () => {
    const built = buildPack({ template: 'customer-incident', items: ITEMS })
    if ('error' in built) throw new Error(built.error)
    const need = built.firstMessage.split('## What I need\n\n')[1]!.split('\n\n## ')[0]!
    expect(need).toBe(incident.instruction.trim())
  })

  test('no trace of the voice reaches a brief that did not ask for it', () => {
    for (const id of TEMPLATES.filter(t => t.kind !== 'voice').map(t => t.id)) {
      const body = brief([id])
      expect(body, `${id} leaked the voice heading`).not.toContain('## How the reply should read')
      expect(body, `${id} leaked the voice skill`).not.toContain('humanizer-voice')
      for (const phrase of BANNED) {
        // "reach out" and "leverage" are ordinary English; the only way they can
        // appear in a brief is as the Humanizer's own banned list.
        expect(body, `${id} leaked the banned list ("${phrase}")`).not.toContain(`"${phrase}"`)
      }
    }
  })

  /*
   * AMENDED. The shared clause is in the brief now, not in each template.
   *
   * This used to assert that nine instructions all *opened* with the same 220
   * characters. They did, and it was 18% of a budget seven of them were within
   * six characters of spending — and a typed instruction replaced it, so the
   * hand-written brief was the one that never carried it. The claim worth
   * pinning is the one that was always meant: every brief says it, once.
   */
  test('the shared clause reaches every brief exactly once, from the brief', () => {
    for (const t of TEMPLATES) {
      expect(t.instruction, `${t.id} carries a copy of the shared clause`)
        .not.toContain('do not ask me to re-paste')
    }
    for (const id of TEMPLATES.map(t => t.id)) {
      const body = brief([id])
      expect(body.split('Do not ask me to re-paste').length - 1, `${id}`).toBe(1)
      expect(body, id).toContain('If you have a checkout of the repository named above, work in it.')
    }
  })
})
