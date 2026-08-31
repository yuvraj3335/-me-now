/**
 * Voice notes.
 *
 * The promise the UI makes is that the recording survives whatever else fails —
 * transcription, a restart, a missing service — so these tests are mostly about
 * the audio still being there and the index still pointing at it.
 */

import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import {
  deleteNote, getNote, listNotes, notePath, saveNote, sttStatus, storageUsed, transcribe, updateNote, verifyStorage,
} from '../src/server/voice/store'
import { VOICE_MAX_BYTES } from '../src/server/env'
import { voice } from '../src/server/voice/router'

const bytes = (n: number) => new Uint8Array(n).fill(7).buffer

describe('storing a note', () => {
  test('the audio lands on disk and the row points at it', async () => {
    const r = await saveNote({ data: bytes(2048), mime: 'audio/webm', durationMs: 4200 })
    expect(r.ok).toBe(true)
    if (!r.ok) return

    expect(existsSync(notePath(r.note))).toBe(true)
    expect(readFileSync(notePath(r.note)).length).toBe(2048)
    expect(r.note.filename.endsWith('.webm')).toBe(true)
    expect(r.note.duration_ms).toBe(4200)
  })

  test('a note survives a restart, because nothing about it is in memory', async () => {
    const r = await saveNote({ data: bytes(512), mime: 'audio/mp4', title: 'walk' })
    if (!r.ok) return
    // Re-reading through a fresh query is what a restarted process does.
    const again = getNote(r.note.id)!
    expect(again.title).toBe('walk')
    expect(existsSync(notePath(again))).toBe(true)
  })

  test('an empty recording is refused rather than stored as a 0-byte file', async () => {
    const r = await saveNote({ data: bytes(0), mime: 'audio/webm' })
    expect(r.ok).toBe(false)
  })

  test('an oversized recording is refused with the limit named', async () => {
    const r = await saveNote({ data: bytes(VOICE_MAX_BYTES + 1), mime: 'audio/webm' })
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.error).toContain('MB limit')
  })

  test('a transcript becomes the title; without one the title says when', async () => {
    const withText = await saveNote({ data: bytes(64), mime: 'audio/webm', transcript: 'check the netsuite mapping tomorrow' })
    expect(withText.ok && withText.note.title).toBe('check the netsuite mapping tomorrow')
    expect(withText.ok && withText.note.transcript_state).toBe('client')

    const without = await saveNote({ data: bytes(64), mime: 'audio/webm' })
    expect(without.ok && without.note.title).toMatch(/^Note · /)
    expect(without.ok && without.note.transcript_state).toBe('none')
  })
})

describe('transcription', () => {
  test('with no service configured, it says so and keeps the audio', async () => {
    const status = sttStatus()
    expect(status.available).toBe(false)
    expect(status.reason).toContain('Recordings are kept')

    const saved = await saveNote({ data: bytes(256), mime: 'audio/webm' })
    if (!saved.ok) return
    const r = await transcribe(saved.note.id)
    expect(r.ok).toBe(false)
    // The whole point: a failed transcription is not a lost recording.
    expect(existsSync(notePath(saved.note))).toBe(true)
    expect(getNote(saved.note.id)).not.toBeNull()
  })

  test('a note never gains a transcript it was not given', async () => {
    const saved = await saveNote({ data: bytes(128), mime: 'audio/webm' })
    if (!saved.ok) return
    await transcribe(saved.note.id)
    expect(getNote(saved.note.id)!.transcript).toBeNull()
  })
})

describe('housekeeping', () => {
  test('deleting removes both the row and the file', async () => {
    const saved = await saveNote({ data: bytes(128), mime: 'audio/webm' })
    if (!saved.ok) return
    const path = notePath(saved.note)
    expect(deleteNote(saved.note.id)).toBe(true)
    expect(getNote(saved.note.id)).toBeNull()
    expect(existsSync(path)).toBe(false)
  })

  test('storage reports what is actually stored', async () => {
    const before = storageUsed()
    await saveNote({ data: bytes(1000), mime: 'audio/webm' })
    const after = storageUsed()
    expect(after.count).toBe(before.count + 1)
    expect(after.bytes).toBe(before.bytes + 1000)
    expect(verifyStorage().missing).toBe(0)
  })

  test('a note can be attached to a task after the fact', async () => {
    const saved = await saveNote({ data: bytes(64), mime: 'audio/webm' })
    if (!saved.ok) return
    updateNote(saved.note.id, { task_id: 'task-1' })
    expect(listNotes({ taskId: 'task-1' }).map(n => n.id)).toContain(saved.note.id)
  })

  /*
   * And detached again, which is the half that did not work through the API.
   *
   * `PATCH /api/voice/:id` read every field as `b.field ?? undefined`, and
   * `updateNote` drops keys that are `undefined` — so an explicit `null`, which
   * the route's own body type declares as legal and which is the only way to
   * say "take this off the task", arrived as an empty patch. The route answered
   * 200 having changed nothing. The store was always able to do it, and this is
   * the store half; the router now tells absent from null with `in`.
   */
  test('a note can be detached again by clearing the field', async () => {
    const saved = await saveNote({ data: bytes(64), mime: 'audio/webm' })
    if (!saved.ok) return
    updateNote(saved.note.id, { task_id: 'task-2' })
    expect(getNote(saved.note.id)!.task_id).toBe('task-2')

    updateNote(saved.note.id, { task_id: null })
    expect(getNote(saved.note.id)!.task_id, 'the note could not be detached').toBeNull()
    expect(listNotes({ taskId: 'task-2' }).map(n => n.id)).not.toContain(saved.note.id)
  })
})

/**
 * The router's half: absent means "leave it", `null` means "clear it".
 *
 * These are two different requests and `?? undefined` collapsed them into one.
 */
describe('patching a note over the API', () => {
  test('an explicit null clears the field, and an absent key does not', async () => {
    const saved = await saveNote({ data: bytes(64), mime: 'audio/webm' })
    if (!saved.ok) return
    updateNote(saved.note.id, { task_id: 'task-3', title: 'a title' })

    const patch = (body: unknown) => voice.request(`/${saved.note.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

    // Absent: the title is untouched.
    await patch({ transcript: 'words' })
    expect(getNote(saved.note.id)!.title).toBe('a title')

    // Explicit null: the field is cleared.
    const r = await patch({ task_id: null })
    expect(r.status).toBe(200)
    expect(getNote(saved.note.id)!.task_id, 'null was read as "leave it alone"').toBeNull()
    // And nothing else went with it.
    expect(getNote(saved.note.id)!.title).toBe('a title')
  })
})
