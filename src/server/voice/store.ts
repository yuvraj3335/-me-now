/**
 * Voice notes.
 *
 * Audio lives on disk under the data directory; SQLite holds the index. That
 * split matters for one reason: a 4MB recording in a row makes every query that
 * touches the table slow, and the WAL that the poll loop shares would carry it.
 *
 * Nothing here uploads audio anywhere. A note reaches Slack, Gmail or a model
 * only if a person attaches it to something and confirms that send — which is
 * the same rule every other outbound path in Wake follows.
 */

import { mkdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { db, now, uid } from '../db'
import { STT_KEY, STT_MODEL, STT_URL, VOICE_DIR, VOICE_MAX_BYTES, VOICE_MAX_SECONDS } from '../env'

/** Container → extension. Browsers hand back whatever their encoder produced. */
const EXT: Record<string, string> = {
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
}

export type VoiceNote = {
  id: string
  filename: string
  mime: string
  bytes: number
  duration_ms: number | null
  title: string | null
  transcript: string | null
  transcript_state: 'none' | 'client' | 'server' | 'failed'
  transcript_error: string | null
  task_id: string | null
  card_group: string | null
  pack_id: string | null
  created_at: number
}

export type SaveInput = {
  data: ArrayBuffer
  mime: string
  durationMs?: number | null
  title?: string | null
  transcript?: string | null
  /** 'client' when the browser's own recogniser produced it. */
  transcriptFrom?: 'client' | null
  taskId?: string | null
  cardGroup?: string | null
  packId?: string | null
}

export async function saveNote(input: SaveInput): Promise<{ ok: true; note: VoiceNote } | { ok: false; error: string }> {
  const bytes = input.data.byteLength
  if (!bytes) return { ok: false, error: 'the recording was empty' }
  if (bytes > VOICE_MAX_BYTES) {
    return { ok: false, error: `that recording is ${Math.round(bytes / 1e6)}MB, over the ${Math.round(VOICE_MAX_BYTES / 1e6)}MB limit` }
  }
  if (input.durationMs && input.durationMs > VOICE_MAX_SECONDS * 1000) {
    return { ok: false, error: `that recording is longer than the ${VOICE_MAX_SECONDS}s limit` }
  }

  const base = (input.mime || 'audio/webm').split(';')[0]!.trim()
  const id = uid()
  const filename = `${id}.${EXT[base] ?? 'bin'}`

  mkdirSync(VOICE_DIR, { recursive: true })
  await Bun.write(join(VOICE_DIR, filename), input.data)

  const transcript = input.transcript?.trim() || null
  db.query(
    `INSERT INTO voice_notes (id, filename, mime, bytes, duration_ms, title, transcript,
                              transcript_state, task_id, card_group, pack_id, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id, filename, base, bytes, input.durationMs ?? null,
    input.title?.trim() || titleFrom(transcript),
    transcript,
    transcript ? (input.transcriptFrom ?? 'client') : 'none',
    input.taskId ?? null, input.cardGroup ?? null, input.packId ?? null, now(),
  )

  return { ok: true, note: getNote(id)! }
}

/** "Note · 21:40" is a fallback, not a label anyone wants to read twice. */
function titleFrom(transcript: string | null): string {
  if (transcript) {
    const t = transcript.replace(/\s+/g, ' ').trim()
    return t.length > 64 ? `${t.slice(0, 63).replace(/[\s,;:–—-]+$/, '')}…` : t
  }
  return `Note · ${new Date().toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`
}

export const getNote = (id: string): VoiceNote | null =>
  (db.query<VoiceNote, [string]>(`SELECT * FROM voice_notes WHERE id = ?`).get(id) ?? null)

export function listNotes(opts: { taskId?: string | null; limit?: number } = {}): VoiceNote[] {
  return opts.taskId
    ? db.query<VoiceNote, [string, number]>(
        `SELECT * FROM voice_notes WHERE task_id = ? ORDER BY created_at DESC LIMIT ?`,
      ).all(opts.taskId, opts.limit ?? 100)
    : db.query<VoiceNote, [number]>(
        `SELECT * FROM voice_notes ORDER BY created_at DESC LIMIT ?`,
      ).all(opts.limit ?? 100)
}

export function updateNote(id: string, patch: Partial<Pick<VoiceNote, 'title' | 'transcript' | 'task_id' | 'card_group' | 'pack_id'>>) {
  const keys = Object.keys(patch).filter(k => patch[k as keyof typeof patch] !== undefined)
  if (!keys.length) return getNote(id)
  db.query(`UPDATE voice_notes SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`)
    .run(...keys.map(k => (patch as any)[k] ?? null), id)
  return getNote(id)
}

export function deleteNote(id: string): boolean {
  const note = getNote(id)
  if (!note) return false
  try {
    unlinkSync(join(VOICE_DIR, note.filename))
  } catch {
    // A missing file is not a reason to keep an index row pointing at nothing.
  }
  db.query(`DELETE FROM voice_notes WHERE id = ?`).run(id)
  return true
}

export function notePath(note: VoiceNote): string {
  return join(VOICE_DIR, note.filename)
}

export function storageUsed(): { count: number; bytes: number } {
  const r = db.query<{ n: number; b: number | null }, []>(
    `SELECT COUNT(*) AS n, SUM(bytes) AS b FROM voice_notes`,
  ).get()
  return { count: r?.n ?? 0, bytes: r?.b ?? 0 }
}

/* ------------------------------ transcription ----------------------------- */

export type SttStatus = { available: boolean; reason: string; url: string | null; model: string | null }

/**
 * Whether server-side transcription is possible at all.
 *
 * Anthropic has no transcription endpoint, so there is no default here and
 * nothing bundled. Unset, Wake keeps the audio and says so — a note with no
 * transcript is a note; a note with an invented transcript is a lie you will act
 * on later.
 */
export function sttStatus(): SttStatus {
  if (!STT_URL) {
    return {
      available: false,
      url: null,
      model: null,
      reason:
        'No transcription service is configured. Recordings are kept and playable; the browser transcribes ' +
        'live dictation on its own where it supports it. Set WAKE_STT_URL (an OpenAI-compatible ' +
        '/audio/transcriptions endpoint) and WAKE_STT_KEY to transcribe stored notes too.',
    }
  }
  return { available: true, url: STT_URL, model: STT_MODEL, reason: 'ready' }
}

export async function transcribe(id: string): Promise<{ ok: boolean; transcript?: string; error?: string }> {
  const note = getNote(id)
  if (!note) return { ok: false, error: 'no such note' }

  const status = sttStatus()
  if (!status.available) return { ok: false, error: status.reason }

  try {
    const file = Bun.file(notePath(note))
    if (!(await file.exists())) return { ok: false, error: 'the audio file is missing from disk' }

    const form = new FormData()
    form.append('file', new File([await file.arrayBuffer()], note.filename, { type: note.mime }))
    form.append('model', STT_MODEL)

    const res = await fetch(STT_URL, {
      method: 'POST',
      headers: STT_KEY ? { Authorization: `Bearer ${STT_KEY}` } : {},
      body: form,
      signal: AbortSignal.timeout(120_000),
    })
    if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).slice(0, 200)}`)

    const body: any = await res.json().catch(() => null)
    const transcript = String(body?.text ?? body?.transcript ?? '').trim()
    if (!transcript) throw new Error('the transcription service returned no text')

    db.query(
      `UPDATE voice_notes SET transcript = ?, transcript_state = 'server', transcript_error = NULL,
                              title = COALESCE(NULLIF(title, ''), ?) WHERE id = ?`,
    ).run(transcript, titleFrom(transcript), id)
    return { ok: true, transcript }
  } catch (e) {
    const error = (e as Error).message
    // The audio survives a failed transcription. That is the whole point of
    // storing the file first and transcribing second.
    db.query(`UPDATE voice_notes SET transcript_state = 'failed', transcript_error = ? WHERE id = ?`)
      .run(error.slice(0, 500), id)
    return { ok: false, error }
  }
}

/** Disk and index can drift if a file is removed by hand; report, do not guess. */
export function verifyStorage(): { missing: number } {
  let missing = 0
  for (const n of listNotes({ limit: 1000 })) {
    try {
      statSync(notePath(n))
    } catch {
      missing++
    }
  }
  return { missing }
}
