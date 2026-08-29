import { expect, test } from 'bun:test'
import { parseSlackResults, readsLikeAsk } from '../src/server/sources/slack'

/** Verbatim from a live mcp.slack.com search — the format this parser exists for. */
const REAL = `# Search Results for: to:me after:2026-08-15

## Messages (5 results)
### Result 1 of 5
Channel: DM (ID: D0BT1ED811Q)
Participants: Ramesh Sutaliya (ID: U09038ZHE3H), Yuvraj Muley (ID: U09617LRRDF)
From: Ramesh Sutaliya <ramesh.sutaliya@spendflo.com> (ID: U09038ZHE3H) 
Time: 2026-08-27 11:03:21 IST
Message_ts: 1787808801.580799
Permalink: [link](https://truto.slack.com/archives/D0BT1ED811Q/p1787808801580799)
Text: 
Hi Yuvraj,
we are going to give a internal demo with product today, can you check with <@U08HCR8KXQB|Varad> and provide the details.

---

### Result 2 of 5
Channel: #eng-platform (ID: C0123ABCD)
Participants: Uday Bhaskar Gajavalli (ID: U061JB3L41W), Yuvraj Muley (ID: U09617LRRDF)
From: Uday Bhaskar Gajavalli <uday@truto.one> (ID: U061JB3L41W) 
Time: 2026-08-26 11:34:19 IST
Message_ts: 1787724259.189389
Permalink: [link](https://truto.slack.com/archives/C0123ABCD/p1787724259189389)
Text: 
see https://github.com/trutohq/truto/pull/2034 when you get a sec

---

`

test('parses the real Slack markdown response', () => {
  const hits = parseSlackResults(REAL)
  expect(hits).toHaveLength(2)

  const [dm, ch] = hits
  expect(dm!.channelId).toBe('D0BT1ED811Q')
  expect(dm!.isDm).toBe(true)
  expect(dm!.fromName).toBe('Ramesh Sutaliya')
  expect(dm!.fromId).toBe('U09038ZHE3H')
  expect(dm!.ts).toBe('1787808801.580799')
  expect(dm!.epochMs).toBe(1787808801580)
  expect(dm!.permalink).toBe('https://truto.slack.com/archives/D0BT1ED811Q/p1787808801580799')
  expect(dm!.text).toContain('internal demo')

  expect(ch!.isDm).toBe(false)
  expect(ch!.channelName).toBe('#eng-platform')
  expect(ch!.text).toContain('github.com/trutohq/truto/pull/2034')
})

test('flags a real ask without a model', () => {
  expect(readsLikeAsk('can you check with Varad and provide the details.')).toBe('a direct request')
  expect(readsLikeAsk('any update on the zoom oauth app?')).toBe('someone is chasing an update')
  expect(readsLikeAsk('I don’t have plan ready yet')).toBeNull()
})
