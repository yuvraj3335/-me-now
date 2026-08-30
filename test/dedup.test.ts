import { expect, test, describe } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  cardId, elidedPrefix, elisionPairs, extractRefs, groupCards, normalizeSubject, pile, subjectRef,
} from '../src/server/dedup'
import type { RawCard } from '../src/server/sources/types'

const card = (p: Partial<RawCard> & Pick<RawCard, 'source' | 'source_id'>): RawCard => ({
  kind: 'x', title: 't', why: 'w', url: 'https://example.com', ts: 1, pile: 'now', refs: [], ...p,
})

describe('reference extraction', () => {
  test('finds a PR from a full URL, a short ref, and a bare number in context', () => {
    expect(extractRefs('see https://github.com/trutohq/truto/pull/2034 please'))
      .toContainEqual({ t: 'gh', v: 'trutohq/truto#2034' })
    expect(extractRefs('trutohq/truto-app#1131 is ready'))
      .toContainEqual({ t: 'gh', v: 'trutohq/truto-app#1131' })
    expect(extractRefs('fixed in #2034', 'trutohq/truto'))
      .toContainEqual({ t: 'gh', v: 'trutohq/truto#2034' })
  })

  test('a bare number without a repo in context is not a reference', () => {
    // Guessing a repo here would merge unrelated work across repositories.
    expect(extractRefs('there were #2034 errors')).toHaveLength(0)
  })

  test('strips reply and list noise from subjects', () => {
    expect(normalizeSubject('Re: Fwd: [truto] Deploy failed')).toBe('deploy failed')
    expect(normalizeSubject('RE: RE: Budget')).toBe('budget')
  })
})

describe('subject refs are fenced in', () => {
  test('a distinctive title qualifies', () => {
    expect(subjectRef('fix(mfa): make the login MFA token purpose-strict'))
      .toEqual({ t: 'subject', v: 'fix(mfa): make the login mfa token purpose-strict' })
  })

  test('short, generic and single-token titles do not', () => {
    expect(subjectRef('Fix the bug')).toBeNull()             // too short to be distinctive
    expect(subjectRef('Session in truto-app-connections')).toBeNull()  // generic fallback
    expect(subjectRef('averyveryverylongsingletokenstring')).toBeNull() // an id, not a subject
  })
})

describe('grouping', () => {
  test('one thing seen in four places collapses to one group', () => {
    const cards = [
      card({ source: 'github', source_id: '1', refs: [{ t: 'gh', v: 'trutohq/truto#2034' }] }),
      card({ source: 'slack', source_id: 'C1:1.1', refs: [
        { t: 'slackthread', v: 'C1:1.1' }, { t: 'gh', v: 'trutohq/truto#2034' },
      ] }),
      card({ source: 'gmail', source_id: 'me:t1', refs: [
        { t: 'gmailthread', v: 'me:t1' }, { t: 'gh', v: 'trutohq/truto#2034' },
      ] }),
      card({ source: 'claude', source_id: 'sess1', refs: [{ t: 'gh', v: 'trutohq/truto#2034' }] }),
    ]
    const groups = groupCards(cards)
    const keys = new Set(cards.map(c => groups.get(cardId(c))))
    expect(keys.size).toBe(1)
    // The durable identifier wins the label, not the thread or message id.
    expect([...keys][0]).toBe('gh:trutohq/truto#2034')
  })

  test('two sessions on one PR merge through the title when only one has a pr-link', () => {
    const title = 'fix(mfa): make the login MFA token purpose-strict so 2FA cannot be bypassed'
    const cards = [
      card({ source: 'github', source_id: 'pr', refs: [
        { t: 'gh', v: 'trutohq/truto#2034' }, subjectRef(title)!,
      ] }),
      card({ source: 'claude', source_id: 'withLink', refs: [
        { t: 'gh', v: 'trutohq/truto#2034' }, subjectRef(title)!,
      ] }),
      card({ source: 'claude', source_id: 'noLink', refs: [subjectRef(title)!] }),
    ]
    const groups = groupCards(cards)
    expect(new Set(cards.map(c => groups.get(cardId(c)))).size).toBe(1)
  })

  test('transitive merging: A—B and B—C puts A and C together', () => {
    const cards = [
      card({ source: 'github', source_id: 'a', refs: [{ t: 'gh', v: 'o/r#1' }] }),
      card({ source: 'slack', source_id: 'b', refs: [
        { t: 'gh', v: 'o/r#1' }, { t: 'subject', v: 'the deploy is broken again' },
      ] }),
      card({ source: 'gmail', source_id: 'c', refs: [{ t: 'subject', v: 'the deploy is broken again' }] }),
    ]
    const groups = groupCards(cards)
    expect(groups.get('github:a')).toBe(groups.get('gmail:c'))
  })

  test('cards sharing nothing stay separate', () => {
    const cards = [
      card({ source: 'slack', source_id: 'x', refs: [{ t: 'slackthread', v: 'C1:1' }] }),
      card({ source: 'slack', source_id: 'y', refs: [{ t: 'slackthread', v: 'C2:2' }] }),
      card({ source: 'claude', source_id: 'z', refs: [] }),
    ]
    const groups = groupCards(cards)
    expect(new Set(cards.map(c => groups.get(cardId(c)))).size).toBe(3)
  })

  test('a card with no references is its own group, keyed by its own id', () => {
    const c = card({ source: 'claude', source_id: 'lonely', refs: [] })
    expect(groupCards([c]).get('claude:lonely')).toBe('claude:lonely')
  })
})

describe('piles', () => {
  const c = { pile: 'now' as const }

  test('an unseen card sits where its source put it', () => {
    expect(pile(c, undefined)).toBe('now')
  })

  test('a manual move beats the rule', () => {
    expect(pile(c, { pile_override: 'parked' })).toBe('parked')
  })

  test('an active snooze parks it; an expired one gives it back', () => {
    const t = 1_000_000
    expect(pile(c, { snoozed_until: t + 1000 }, t)).toBe('parked')
    expect(pile(c, { snoozed_until: t - 1000 }, t)).toBe('now')
  })

  test('done and not-mine disappear entirely', () => {
    expect(pile(c, { done_at: 1 })).toBe('hidden')
    expect(pile(c, { not_mine: 1 })).toBe('hidden')
  })

  test('not-mine outranks a manual move, so dismissal is permanent', () => {
    expect(pile(c, { not_mine: 1, pile_override: 'now' })).toBe('hidden')
  })
})

describe('titles built from raw prompts', () => {
  // Regression: real session titles were cut mid-word and began with list
  // markers, e.g. "- PR This is the PR" and "…+ \"retryable\" — permanent invalid_".
  test('a prompt pasting a PR URL yields that PR as a hard reference', () => {
    const prompt = 'Riya can you please approve - * Backend: github.com/trutohq/truto/pull/2008 * Frontend next'
    expect(extractRefs(prompt)).toContainEqual({ t: 'gh', v: 'trutohq/truto#2008' })
  })
})

/**
 * Every producer must go through `subjectRef`.
 *
 * A subject is the weakest thing Wake will merge on, and `subjectRef` is the
 * only place its guards live — a minimum length, a generic-title denylist, and
 * "one token is an id, not a subject". A source that builds `{ t: 'subject' }`
 * from `normalizeSubject` directly bypasses all three, which is how every
 * "(no subject)" email in two inboxes collapsed into one card.
 */
describe('no source hand-rolls a subject ref', () => {
  test('subject refs are only ever produced by subjectRef', () => {
    const dir = 'src/server/sources'
    // types.ts declares the Ref union itself; every other file constructs one.
    for (const f of readdirSync(dir).filter(n => n.endsWith('.ts') && n !== 'types.ts')) {
      const src = readFileSync(join(dir, f), 'utf8')
      for (const m of src.matchAll(/\{\s*t:\s*'subject'/g)) {
        throw new Error(
          `${dir}/${f}: ${m[0]}… builds a subject ref by hand — use subjectRef(), which fences weak ones out`,
        )
      }
    }
    expect(true).toBe(true)
  })
})

describe('a title cut short still names the same thing', () => {
  // The real case: a Claude session titled from its own first prompt is cut to
  // 72 characters and keeps the ellipsis; PR #2034's title is 75 and is not.
  const long = 'fix(mfa): make the login MFA token purpose-strict so 2FA cannot be bypassed'
  const cut = 'fix(mfa): make the login MFA token purpose-strict so 2FA cannot be…'

  test('the ellipsis is recognised and stripped', () => {
    expect(elidedPrefix('a whole title')).toBeNull()
    expect(elidedPrefix('half a title…')).toBe('half a title')
    expect(elidedPrefix('half a title...')).toBe('half a title')
    // Trailing punctuation left behind by the cut goes with it.
    expect(elidedPrefix('cut on a comma, …')).toBe('cut on a comma')
  })

  test('a PR and the session cut from its title become one card', () => {
    const groups = groupCards([
      card({
        source: 'github', source_id: '1', title: long,
        refs: [{ t: 'gh', v: 'trutohq/truto#2034' }, subjectRef(long)!],
      }),
      card({ source: 'claude', source_id: 's1', title: cut, refs: [subjectRef(cut)!] }),
    ])
    const gh = groups.get(cardId({ source: 'github', source_id: '1' }))
    const session = groups.get(cardId({ source: 'claude', source_id: 's1' }))
    expect(session).toBe(gh!)
    // And the durable identifier wins the label, as it does for any merge.
    expect(gh).toBe('gh:trutohq/truto#2034')
  })

  test('two sessions cut at different points merge too', () => {
    const shorter = 'fix(mfa): make the login MFA token purpose-strict so…'
    const groups = groupCards([
      card({ source: 'claude', source_id: 'a', title: cut, refs: [subjectRef(cut)!] }),
      card({ source: 'claude', source_id: 'b', title: shorter, refs: [subjectRef(shorter)!] }),
    ])
    expect(groups.get('claude:a')).toBe(groups.get('claude:b')!)
    // The group key is the least-truncated title in the component: half a
    // sentence is a poor name for a thing.
    expect(groups.get('claude:a')).not.toMatch(/purpose-strict so…$/)
  })

  test('an ambiguous prefix merges nothing', () => {
    // Two real titles share this opening. Picking one would hide the other,
    // which is the exact failure this whole file is built to avoid.
    const a = 'feat(api-tokens): pick permissions when minting a token'
    const b = 'feat(api-tokens): pick permissions when revoking a token'
    const c = 'feat(api-tokens): pick permissions when…'
    expect(elisionPairs([a, b, c])).toEqual([])

    const groups = groupCards([
      card({ source: 'github', source_id: '1', title: a, refs: [subjectRef(a)!] }),
      card({ source: 'github', source_id: '2', title: b, refs: [subjectRef(b)!] }),
      card({ source: 'claude', source_id: 's', title: c, refs: [subjectRef(c)!] }),
    ])
    expect(new Set([groups.get('github:1'), groups.get('github:2'), groups.get('claude:s')]).size).toBe(3)
  })

  test('a prefix too short to be distinctive is not a link', () => {
    // Below the floor, an opening is a phrase rather than a subject.
    expect(elisionPairs(['short opening line…', 'short opening line and the rest of it'])).toEqual([])
  })
})
