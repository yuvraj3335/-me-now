/**
 * A task means the same five things by "status" that a card does.
 *
 * It did not, and the seam was invisible from either side: a task stored
 * `todo | doing | done` and the Work page kept its own circles to draw them, so
 * two surfaces of one product had two vocabularies for one idea and neither
 * could say so. `In review` had nowhere to live on his own list, and `Won't do`
 * was only reachable by deleting the row it was written on.
 *
 * Three things are pinned here, and the middle one is the one that bites.
 *
 * The **round trip** is obvious: every one of the five has to survive a write
 * and come back the same word.
 *
 * The **legacy read** is not. Migration 14 rewrote every row that existed the
 * morning it ran, and a migration runs once — so it is not what keeps the old
 * words out of the browser. `tools/seed-demo.ts` writes `todo` and `doing`
 * straight into SQLite, past every route, on every reseed. Without the mapping
 * on the way out, those rows reach the UI carrying a status nothing can paint
 * and render as a chip with no glyph and no word in it. The rewrite and the map
 * are therefore tested separately, because they protect different rows.
 *
 * And **no field opens the keyboard by itself**. On iOS a focused field raises
 * it as the sheet mounts, which eats half the surface, hides the commit in the
 * footer and stutters the animation — measured on the phone this product is
 * built for.
 */

import { beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { db, migrateTaskStatuses, now, taskStatus } from '../src/server/db'
import { api } from '../src/server/api'
import { STATUS_ORDER } from '../src/web/lib/types'

type Any = Record<string, any>

const post = (path: string, body?: unknown) =>
  api.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })

const patch = (path: string, body: unknown) =>
  api.request(path, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

const create = async (body: Record<string, unknown>) =>
  (await (await post('/tasks', body)).json()) as Any

/** The row as the column holds it, which is not always what the wire says. */
const stored = (id: string) =>
  db.query<{ status: string }, [string]>(`SELECT status FROM tasks WHERE id = ?`).get(id)?.status

/** The same task as `/state` hands it to the browser. */
const fromState = async (id: string) => {
  const s = (await (await api.request('/state')).json()) as Any
  return (s.tasks as Any[]).find(t => t.id === id)
}

/** A row written the way `seed-demo` writes one: straight in, past the routes. */
const seed = (id: string, status: string) =>
  db.query(
    `INSERT INTO tasks (id, title, status, sort, created_at, updated_at)
     VALUES (?, ?, ?, 0, ?, ?)`,
  ).run(id, `task ${id}`, status, now(), now())

const events = (id: string) =>
  db.query<{ kind: string }, [string]>(`SELECT kind FROM events WHERE task_id = ? ORDER BY id`)
    .all(id).map(e => e.kind)

beforeEach(() => {
  db.query(`DELETE FROM tasks`).run()
  db.query(`DELETE FROM events`).run()
})

describe('a task stores all five, and gives all five back', () => {
  test('every status survives a create', async () => {
    for (const status of STATUS_ORDER) {
      const t = await create({ title: `made as ${status}`, status })
      expect(t.status, `${status} did not survive being written`).toBe(status)
      expect(stored(t.id), `${status} was stored as something else`).toBe(status)
      expect(await fromState(t.id), `${status} never reached /state`).toMatchObject({ status })
    }
  })

  test('and every status survives a move to it', async () => {
    const t = await create({ title: 'moved through all five' })
    expect(t.status, 'a task with no status asked for is not Not started').toBe('not_started')
    for (const status of STATUS_ORDER) {
      const moved = (await (await patch(`/tasks/${t.id}`, { status })).json()) as Any
      expect(moved.status, `${status} did not survive a PATCH`).toBe(status)
      expect(stored(t.id), `${status} was stored as something else`).toBe(status)
    }
  })

  test('a status nobody recognises is refused rather than defaulted', async () => {
    // Silently storing a typo as `not_started` is a row that quietly changed
    // section, which is worse than a request that failed out loud.
    expect((await post('/tasks', { title: 'x', status: 'in_prog' })).status).toBe(400)
    const t = await create({ title: 'real' })
    expect((await patch(`/tasks/${t.id}`, { status: 'finished' })).status).toBe(400)
    expect(stored(t.id), 'a refused status was written anyway').toBe('not_started')
  })

  test('the times a status implies are derived, not sent', async () => {
    const t = await create({ title: 'derives its own times' })

    await patch(`/tasks/${t.id}`, { status: 'in_progress' })
    const started = (await fromState(t.id))!.started_at
    expect(started, 'starting work recorded no start time').toBeGreaterThan(0)

    const done = (await (await patch(`/tasks/${t.id}`, { status: 'done' })).json()) as Any
    expect(done.completed_at, 'finishing recorded no finish time').toBeGreaterThan(0)

    // A task he decided against was not finished, and the Done list is ordered
    // by exactly this column — so the two must not sort together.
    const dropped = (await (await patch(`/tasks/${t.id}`, { status: 'wont_do' })).json()) as Any
    expect(dropped.completed_at, "a Won't do kept a completion time").toBeNull()
    expect(dropped.started_at, 'a status change rewrote when the work began').toBe(started)
  })

  test('only a finish counts as work finished', async () => {
    // Pulse's Throughput is `task_done` and nothing else. The other four are
    // written for the record and drawn by nothing, so a move to `wont_do` must
    // not arrive in the chart as a task completed.
    const t = await create({ title: 'counted once' })
    for (const status of ['in_progress', 'in_review', 'done', 'wont_do'] as const) {
      await patch(`/tasks/${t.id}`, { status })
    }
    expect(events(t.id).filter(k => k === 'task_done').length).toBe(1)
    expect(events(t.id)).toContain('task_wont_do')
  })
})

describe('the three words a task used to be', () => {
  test('the migration rewrites each of them, once', () => {
    seed('legacy-todo', 'todo')
    seed('legacy-doing', 'doing')
    seed('legacy-done', 'done')
    seed('already-five', 'in_review')

    expect(migrateTaskStatuses(), 'the rewrite moved a different number of rows').toBe(2)

    expect(stored('legacy-todo')).toBe('not_started')
    expect(stored('legacy-doing')).toBe('in_progress')
    // `done` is already the word it keeps; the migration must not touch it, and
    // must not report it as moved.
    expect(stored('legacy-done')).toBe('done')
    expect(stored('already-five'), 'the rewrite touched a row already in the five')
      .toBe('in_review')

    // Nothing invents `in_review` or `wont_do`. Both are claims only he can
    // make, and a migration that guessed at either would file a task into a
    // section he never sent it to.
    expect(migrateTaskStatuses(), 're-running the rewrite moved rows again').toBe(0)
  })

  test('a legacy row written after the migration still renders', async () => {
    // This is the case the migration cannot cover and the reason the map stays
    // live: `seed-demo` writes these words directly, so they can appear in the
    // table on any machine, at any time, long after the rewrite has run.
    seed('reseeded', 'doing')
    expect(await fromState('reseeded'), 'a legacy row reached the browser unmapped')
      .toMatchObject({ status: 'in_progress' })
  })

  test('and a client may still send one', async () => {
    const t = await create({ title: 'sent the old word', status: 'doing' })
    expect(t.status).toBe('in_progress')
    expect(stored(t.id), 'the old word was written to the column').toBe('in_progress')
  })

  test('a legacy word that means the status a row already has is not a move', async () => {
    // `prev.status` is whatever the column holds, which on a reseeded box is
    // still `doing`. Compared raw, `in_progress` landing on it read as a
    // transition: a fresh `started_at` over the one the task had, and a second
    // event for a move nobody made.
    seed('reseeded-again', 'doing')
    db.query(`UPDATE tasks SET started_at = ? WHERE id = ?`).run(1_000, 'reseeded-again')

    const same = (await (await patch('/tasks/reseeded-again', { status: 'in_progress' })).json()) as Any
    expect(same.started_at, 'a no-op status write restamped when the work began').toBe(1_000)
    expect(events('reseeded-again'), 'a no-op status write was recorded as a move').toEqual([])
  })

  test('the map itself refuses to hand back something unpaintable', () => {
    expect(taskStatus('todo')).toBe('not_started')
    expect(taskStatus('doing')).toBe('in_progress')
    expect(taskStatus('done')).toBe('done')
    for (const s of STATUS_ORDER) expect(taskStatus(s)).toBe(s)
    // A row with no status, or one carrying text from a future build, still has
    // to draw something — a blank chip reads as a broken page.
    for (const junk of [null, undefined, '', 'blocked', 42]) {
      expect(taskStatus(junk)).toBe('not_started')
    }
  })
})

describe('nothing opens the keyboard by itself', () => {
  /**
   * Source with every comment removed.
   *
   * Both files explain at length what `autoFocus` did to a phone and why it is
   * gone, and a note about history is not a prop — an assertion that cannot
   * tell them apart bans the explanation along with the thing.
   */
  const codeOf = (f: string) =>
    readFileSync(f, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter(l => !l.trim().startsWith('//'))
      .join('\n')

  test('no field on the work surfaces is autofocused', () => {
    // Two of them were: the task title on a new task, and the goal title on
    // both a new and an edited goal.
    for (const f of [
      'src/web/pages/Work.tsx',
      'src/web/components/TaskSheet.tsx',
    ]) {
      expect(codeOf(f), `${f}: a field opens the keyboard on arrival`)
        .not.toMatch(/\bautoFocus\b/)
    }
  })
})
