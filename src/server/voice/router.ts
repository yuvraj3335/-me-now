/**
 * Voice's HTTP surface.
 *
 * Audio arrives as a raw body rather than multipart: the browser already has
 * the Blob from MediaRecorder, the metadata is small enough for query
 * parameters, and skipping multipart avoids parsing an attacker-controlled
 * boundary for no benefit.
 */

import { Hono } from 'hono'
import { audit } from '../db'
import { VOICE_MAX_BYTES } from '../env'
import {
  deleteNote, getNote, listNotes, notePath, saveNote, storageUsed, sttStatus, transcribe, updateNote,
} from './store'

export const voice = new Hono()

const bad = (m: string) => ({ error: m })

voice.get('/', c =>
  c.json({
    notes: listNotes({ taskId: c.req.query('task') ?? null }),
    storage: storageUsed(),
    stt: sttStatus(),
  }),
)

voice.post('/', async c => {
  const mime = c.req.header('content-type')?.split(';')[0]?.trim() || 'audio/webm'
  if (!mime.startsWith('audio/')) return c.json(bad(`expected an audio body, got "${mime}"`), 415)

  const declared = Number(c.req.header('content-length') ?? 0)
  if (declared && declared > VOICE_MAX_BYTES) {
    return c.json(bad(`that recording is over the ${Math.round(VOICE_MAX_BYTES / 1e6)}MB limit`), 413)
  }

  const data = await c.req.arrayBuffer()
  const r = await saveNote({
    data,
    mime,
    durationMs: Number(c.req.query('duration')) || null,
    title: c.req.query('title'),
    transcript: c.req.query('transcript'),
    transcriptFrom: c.req.query('transcript') ? 'client' : null,
    taskId: c.req.query('task'),
    cardGroup: c.req.query('card'),
    packId: c.req.query('pack'),
  })
  if (!r.ok) return c.json(bad(r.error), 400)
  audit('voice.save', { target: r.note.id, detail: { bytes: r.note.bytes, mime: r.note.mime } })
  return c.json({ note: r.note })
})

/** Playback. Range is honoured so scrubbing works rather than restarting. */
voice.get('/:id/audio', async c => {
  const note = getNote(c.req.param('id'))
  if (!note) return c.json(bad('no such note'), 404)

  const file = Bun.file(notePath(note))
  if (!(await file.exists())) return c.json(bad('the audio file is missing from disk'), 410)

  const range = c.req.header('range')
  const match = range ? /bytes=(\d*)-(\d*)/.exec(range) : null
  if (match) {
    const start = match[1] ? Number(match[1]) : 0
    const end = match[2] ? Number(match[2]) : note.bytes - 1
    if (start >= note.bytes || start > end) {
      return c.newResponse(null, 416, { 'Content-Range': `bytes */${note.bytes}` })
    }
    return c.newResponse(file.slice(start, end + 1).stream(), 206, {
      'Content-Type': note.mime,
      'Content-Range': `bytes ${start}-${end}/${note.bytes}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': String(end - start + 1),
      'Cache-Control': 'private, max-age=3600',
    })
  }

  return c.newResponse(file.stream(), 200, {
    'Content-Type': note.mime,
    'Accept-Ranges': 'bytes',
    'Content-Length': String(note.bytes),
    'Cache-Control': 'private, max-age=3600',
  })
})

voice.patch('/:id', async c => {
  const b = await c.req.json<Record<string, string | null>>().catch(() => ({}) as Record<string, string | null>)
  const note = updateNote(c.req.param('id'), {
    title: b.title ?? undefined,
    transcript: b.transcript ?? undefined,
    task_id: b.task_id ?? undefined,
    card_group: b.card_group ?? undefined,
    pack_id: b.pack_id ?? undefined,
  })
  return note ? c.json({ note }) : c.json(bad('no such note'), 404)
})

voice.post('/:id/transcribe', async c => {
  const r = await transcribe(c.req.param('id'))
  return r.ok ? c.json(r) : c.json(bad(r.error ?? 'transcription failed'), 502)
})

voice.delete('/:id', c => {
  const ok = deleteNote(c.req.param('id'))
  if (ok) audit('voice.delete', { target: c.req.param('id') })
  return ok ? c.json({ ok: true }) : c.json(bad('no such note'), 404)
})
