/**
 * The Desk's first tab holds tasks, and holds nothing else.
 *
 * It was the absence of a source filter for two releases: every card from every
 * pipe, ~100 rows of other people's systems, under a heading that said `Tasks`.
 * Not one thing he had written down was on it, because a task is not a card —
 * they are two tables and only one of them is his. Measured on the live desk at
 * the moment this was reported: 73 cards, 1 task, and the tab showed 73.
 *
 * Three things have to stay true for the fix to keep working, and each is a
 * plausible one-line edit away from being undone:
 *
 *   1. The tab reads `state.tasks`, not `state.cards`.
 *   2. A task row routes its writes to `/tasks/:id`. The desk's other five tabs
 *      write through `/cards/:group/...`, and `group_key` is the only identifier
 *      that reaches a row action — so the prefix is the routing and nothing else
 *      can be.
 *   3. The tab offers no control that cannot mean anything there. Priority does
 *      not exist on the `tasks` table, and `Task` — make a task from this row —
 *      cannot be offered on a row that already is one.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { isTaskRow, taskIdOf, taskRow, taskRowKey } from '../src/web/lib/taskRow'
import { cardKind, TASK_KIND } from '../src/web/components/kinds'
import { bucketsOf, inBucket } from '../src/web/lib/bucket'
import type { Task } from '../src/web/lib/types'

const home = readFileSync('src/web/pages/Home.tsx', 'utf8')
const table = readFileSync('src/web/components/CardTable.tsx', 'utf8')

/** Source with its prose removed — a comment is evidence, not behaviour. */
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const aTask = (over: Partial<Task> = {}): Task => ({
  id: 'abc-123', title: 'Make sure the tax module is supported', detail: null,
  status: 'in_progress', goal_id: null, source_card_group: null,
  due_at: 1_800_000_000_000, color: null, sort: 0,
  created_at: 1_700_000_000_000, updated_at: 1_700_000_900_000,
  started_at: null, completed_at: null, notes: [],
  origin_source: null, origin_title: null, origin_why: null,
  origin_url: null, origin_excerpt: null, origin_meta: null,
  ...over,
})

describe('a task, shaped like a desk row', () => {
  test('the key carries which table the row came from', () => {
    const row = taskRow(aTask())
    expect(row.group_key, 'the prefix is gone, so a row action cannot route')
      .toBe('task:abc-123')
    expect(isTaskRow(row)).toBe(true)
    expect(taskIdOf(row), 'the id does not survive the round trip').toBe('abc-123')
    expect(taskRowKey('abc-123')).toBe(row.group_key)
  })

  test('a card from a pipe is never mistaken for one', () => {
    // The five source tabs mint `group_key` from the provider's own ids, none of
    // which is prefixed. If one ever were, this is where it would be caught.
    for (const key of ['slack:C123:1787814333.427979', 'gmail:thread-9', 'sentry:TRUTO-38']) {
      expect(isTaskRow({ group_key: key } as never), `${key} read as a task`).toBe(false)
    }
  })

  test('it belongs to no source, so no source tab can claim it', () => {
    const row = taskRow(aTask())
    expect(row.sources, 'a task grew a member, and a source tab will now show it')
      .toEqual([])
    expect(bucketsOf(row), 'a task appears on a source tab').toEqual([])
    for (const src of ['slack', 'gmail', 'github', 'alerts', 'claude'] as const) {
      expect(inBucket(row, src), `the ${src} tab claimed a task`).toBe(false)
    }
  })

  test('the facts a row draws come across, and none is invented', () => {
    const row = taskRow(aTask({ due_at: 42, detail: 'the detail' }))
    expect(row.status, 'the status stopped being the task\'s own').toBe('in_progress')
    expect(row.due_at).toBe(42)
    expect(row.excerpt).toBe('the detail')
    // One clock: the desk orders on `activity_at` and prints an age from `ts`,
    // and a row at the top of the list showing a three-day-old age is two facts
    // where there should be one.
    expect(row.activity_at, 'the two clocks drifted apart').toBe(row.ts)
    // Nothing lands on a task from outside, so there is no "since you last
    // looked" — a `+N` here would be a number counting nothing.
    expect(row.activity.count).toBe(0)
  })

  test('it is drawn as a Task rather than as GitHub\'s fallback', () => {
    // `cardKind` used to fall through to `kindOf('github', …)` for a row with no
    // members, which paints `Item` in GitHub's blue — on every row of the tab.
    expect(cardKind(taskRow(aTask()))).toBe(TASK_KIND)
    expect(TASK_KIND.word).toBe('Task')
    expect(TASK_KIND.tint, 'the Task mark took a source hue after all')
      .toBe('var(--color-fg-dim)')
  })
})

describe('the tab reads the right table', () => {
  const src = code(home)

  test('rows on the Tasks tab come from state.tasks', () => {
    expect(src, 'the adapter is no longer applied to the task list')
      .toMatch(/const taskRows = useMemo\(\(\) => tasks\.map\(taskRow\), \[tasks\]\)/)
    expect(src, 'the Tasks tab went back to showing every card')
      .toMatch(/const cards = isTasks\s*\n?\s*\? taskRows/)
  })

  test('the settled list is never fetched for it', () => {
    // `GET /cards/done` answers with cards. `/state` already sends every task
    // whatever its status, so asking there fetches a hundred rows to render none.
    expect(src, 'the Tasks tab asks the server for finished *cards*')
      .toContain('const settled = !isTasks && isSettledFilter(status)')
  })

  test('an unrecognised ?src= lands on Tasks rather than on nothing', () => {
    // `?src=all` is in every bookmark made before the tab was renamed. Cast, it
    // matches no source and renders an empty desk with nothing to say why.
    expect(src, 'the tab is read by cast again')
      .toContain("const tab: DeskTab = FILTERS.find(s => s === src) ?? 'tasks'")
  })

  test('?src=sentry still lands on the tab it used to name', () => {
    // A bookmark or a push notification minted before the Sentry tab became
    // the Alerts tab still carries the old value, and it has to keep landing
    // on the same rows rather than falling through to "no source filter".
    expect(src, 'the sentry alias is gone')
      .toContain("const src = p.src === 'sentry' ? 'alerts' : p.src")
  })
})

describe('a task row writes to the tasks endpoint', () => {
  const src = code(home)

  test('status routes on the row type, not on the tab', () => {
    // On the tab is not enough: the pane, the palette and the `j`/`k` cursor can
    // all hand a row to these functions, and the row is what knows where it lives.
    expect(src, 'a status write on a task went back to the cards endpoint')
      .toContain('if (isTaskRow(c)) return setTaskStatus(c, next)')
    expect(src, 'the task branch stopped calling updateTask')
      .toMatch(/await actions\.updateTask\(id, \{ status: next \}\)/)
  })

  test('a due date does too', () => {
    expect(src, 'a due date on a task went back to the cards endpoint')
      .toMatch(/if \(isTaskRow\(c\)\) \{[\s\S]*?actions\.updateTask\(id, \{ due_at: at \}\)/)
  })

  test('deleting one puts it back with its notes', () => {
    // `recreateTask` is Work's, and shared rather than copied: a second
    // implementation is how one of the two comes to drop the notes or re-count
    // the undo as throughput. See the `restore` flag on `POST /tasks`.
    expect(src, 'the desk grew its own copy of the undo')
      .toContain("import { recreateTask } from './Work'")
    expect(src, 'deleting a task from the desk has no way back')
      .toContain('run: () => recreateTask(t)')
  })
})

describe('nothing on the tab is a control that cannot mean anything', () => {
  const src = code(home)

  test('Priority is not offered, and not merely hidden', () => {
    // The `tasks` table has no priority column. Hiding the control alone leaves
    // a hand-typed `?pri=0` emptying the list with nothing on screen to say why.
    expect(src, 'the priority predicate stopped ignoring the Tasks tab')
      .toContain("const priActive = !isTasks && pri !== 'any'")
    expect(src, 'the priority control came back on the Tasks tab')
      .toContain("return tab === 'tasks' ? [due_, state_] : [due_, priority, state_]")
    // And the phone's `Filters · N` badge must not count it either, or it points
    // at a control that is not there.
    expect(src, 'the filter count went back to counting priority everywhere')
      .toContain("tab !== 'tasks' && pri !== 'any'")
  })

  test('Task is withheld on a row that already is one', () => {
    expect(src, 'the drawer offers `Task` on a task')
      .toContain("...(isTasks ? {} : { onTask: (c: CardT) => void makeTask(c) })")
  })

  test('and the drawer narrows to match, rather than opening a gap', () => {
    // `swipeActionWidth` gives four actions a narrower box than three, so a row
    // offering three while the hook is told four opens a 264px window with
    // 198px of buttons in it and 66px of empty drawer where the finger let go.
    expect(table, 'the drawer width stopped following the actions it will draw')
      .toContain('const actionsOn = (actions: RowAction) => (actions.onTask ? 4 : 3)')
    expect(code(table), 'a row hard-codes the action count again')
      .not.toMatch(/useSwipe\([^)]*,\s*4\s*[,)]/)
  })
})
