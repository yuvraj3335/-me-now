/**
 * The Humanizer, which is the only template that is not about the work.
 *
 * Every other row says what to find out. This one says how the last message
 * reads, and it is meant to be worn over one of the others rather than picked
 * instead of one. That shape fails in two directions, and this file pins both.
 *
 *   1. **Smothering.** Selected alongside `Customer incident`, it must not
 *      replace, truncate or soften a word of that template's investigation.
 *      `buildPack` concatenates in click order, so the two orders are tested
 *      separately — a rule that only holds when you happen to click it second
 *      is not a rule.
 *   2. **Leaking.** Unselected, it must not exist. A voice rule that reached a
 *      brief nobody asked it to reach would change every reply this product
 *      drafts, silently, and nobody diffs a brief. That is what the frozen
 *      fixture is for: the byte-for-byte text from before this row existed.
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
  test('the investigation arrives whole, in either order', () => {
    for (const order of [['customer-incident', 'humanizer'], ['humanizer', 'customer-incident']]) {
      const body = brief(order)
      // Byte-for-byte the template's own text, lifted back out of the brief.
      // Not `toContain` on a fragment: the claim is that nothing was dropped,
      // reworded or interleaved, and only equality says that.
      expect(section(body, 'Customer incident'), `order ${order.join('+')}`)
        .toBe(incident.instruction.trim())
      expect(section(body, 'Humanizer'), `order ${order.join('+')}`)
        .toBe(humanizer.instruction.trim())
    }
  })

  test('the investigation still says what to investigate', () => {
    const body = brief(['customer-incident', 'humanizer'])
    expect(body).toContain('Take this report to a root cause and a safe reply')
    expect(body).toContain('Truto CLI')
    expect(body).toContain('do not guess an environment')
    expect(body).toContain('DO NOT. Mutate anything. Do not send the reply.')
  })

  test('and the voice rules are in the same brief', () => {
    const body = brief(['customer-incident', 'humanizer'])
    for (const phrase of BANNED) expect(body, `"${phrase}" did not survive packing`).toContain(phrase)
    expect(body).toContain('Short sentences')
    expect(body).toContain('If the cause is not known')
  })

  test('the voice section declares what it governs, so its position cannot mislead', () => {
    // `buildPack` concatenates in click order and nothing in templates.ts can
    // reorder that, so the section has to carry its own scope. Landing above
    // `Customer incident`, this is what stops it being read as step one of the
    // investigation.
    for (const order of [['customer-incident', 'humanizer'], ['humanizer', 'customer-incident']]) {
      const voice = section(brief(order), 'Humanizer')
      expect(voice).toContain('VOICE. This section governs the words I will send, and nothing else.')
      expect(voice).toContain('It replaces nothing else in this brief')
      expect(voice).toContain('the rest still says what to investigate')
      expect(voice).toContain('none of it is softened')
    }
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
      expect(body, `${id} leaked the voice heading`).not.toContain('### Humanizer')
      expect(body, `${id} leaked the voice section`).not.toContain('VOICE.')
      expect(body, `${id} leaked the voice skill`).not.toContain('humanizer-voice')
      for (const phrase of BANNED) {
        // "reach out" and "leverage" are ordinary English; the only way they can
        // appear in a brief is as the Humanizer's own banned list.
        expect(body, `${id} leaked the banned list ("${phrase}")`).not.toContain(`"${phrase}"`)
      }
    }
  })

  test('the clause every other template shares is untouched', () => {
    // The cheapest way to have broken every brief at once would have been to
    // edit NO_REPASTE while adding a row that does not use it.
    const clause =
      'Every identifier you need is in the context below — do not ask me to re-paste any of it. ' +
      'If you have a checkout of the repository named above, work in it; if not, reason from what is here and tell me what you would need.'
    for (const t of TEMPLATES.filter(t => t.kind !== 'voice' && t.id !== 'continue-session')) {
      expect(t.instruction.startsWith(clause), `${t.id} no longer opens with the shared clause`).toBe(true)
    }
  })
})
