/**
 * Voice: recording, transcription, playback.
 *
 * Three rules the UI depends on and the code enforces:
 *
 *   1. Voice never sends, posts or launches anything. A transcript lands in a
 *      field; a human still presses the button.
 *   2. The audio is saved even when transcription fails or is unavailable. The
 *      recording is the artifact; the transcript is a convenience.
 *   3. Live dictation uses the browser's own recogniser where it exists, and
 *      says so plainly where it does not, rather than showing a mic that does
 *      nothing.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

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

export type SttStatus = { available: boolean; reason: string; url: string | null; model: string | null }

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`/api/voice${path}`, init)
  const body = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error((body as any).error ?? `${r.status}`)
  return body as T
}

export const voiceApi = {
  // No trailing slash: the router mounts this collection at /api/voice, and
  // /api/voice/ falls through to the SPA handler and 404s.
  list: (taskId?: string | null) =>
    req<{ notes: VoiceNote[]; storage: { count: number; bytes: number }; stt: SttStatus }>(
      taskId ? `?task=${encodeURIComponent(taskId)}` : '',
    ),
  save: async (blob: Blob, meta: { durationMs?: number; transcript?: string | null; title?: string | null; taskId?: string | null; cardGroup?: string | null; packId?: string | null }) => {
    const p = new URLSearchParams()
    if (meta.durationMs) p.set('duration', String(Math.round(meta.durationMs)))
    if (meta.transcript) p.set('transcript', meta.transcript)
    if (meta.title) p.set('title', meta.title)
    if (meta.taskId) p.set('task', meta.taskId)
    if (meta.cardGroup) p.set('card', meta.cardGroup)
    if (meta.packId) p.set('pack', meta.packId)
    const r = await fetch(`/api/voice?${p}`, {
      method: 'POST',
      headers: { 'Content-Type': blob.type || 'audio/webm' },
      body: blob,
    })
    const body = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error((body as any).error ?? `${r.status}`)
    return (body as { note: VoiceNote }).note
  },
  patch: (id: string, b: Record<string, string | null>) =>
    req<{ note: VoiceNote }>(`/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(b),
    }),
  transcribe: (id: string) => req<{ ok: boolean; transcript?: string }>(`/${id}/transcribe`, { method: 'POST' }),
  remove: (id: string) => req<{ ok: true }>(`/${id}`, { method: 'DELETE' }),
  audioUrl: (id: string) => `/api/voice/${id}/audio`,
}

/* ------------------------------- recording -------------------------------- */

export type RecorderState = 'idle' | 'requesting' | 'recording' | 'stopping' | 'error'

export const recordingSupported = () =>
  typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined'

/** The first container this browser will actually produce. Safari differs from Chrome. */
function pickMime(): string {
  const options = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']
  for (const m of options) {
    try {
      if (MediaRecorder.isTypeSupported(m)) return m
    } catch {
      /* isTypeSupported is missing on older Safari; fall through to the default */
    }
  }
  return ''
}

export function useRecorder() {
  const [state, setState] = useState<RecorderState>('idle')
  const [error, setError] = useState<string | null>(null)
  const [ms, setMs] = useState(0)

  const rec = useRef<MediaRecorder | null>(null)
  const chunks = useRef<Blob[]>([])
  const started = useRef(0)
  const tick = useRef<ReturnType<typeof setInterval> | null>(null)
  const settle = useRef<((b: { blob: Blob; durationMs: number } | null) => void) | null>(null)

  const cleanup = useCallback(() => {
    if (tick.current) clearInterval(tick.current)
    tick.current = null
    rec.current?.stream.getTracks().forEach(t => t.stop())
    rec.current = null
  }, [])

  useEffect(() => cleanup, [cleanup])

  const start = useCallback(async () => {
    if (!recordingSupported()) {
      setState('error')
      setError('This browser cannot record audio.')
      return false
    }
    setState('requesting')
    setError(null)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mime = pickMime()
      const r = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined)
      chunks.current = []
      r.ondataavailable = e => { if (e.data.size) chunks.current.push(e.data) }
      r.onstop = () => {
        const blob = new Blob(chunks.current, { type: r.mimeType || 'audio/webm' })
        const durationMs = Date.now() - started.current
        cleanup()
        setState('idle')
        setMs(0)
        settle.current?.(blob.size ? { blob, durationMs } : null)
        settle.current = null
      }
      rec.current = r
      started.current = Date.now()
      r.start(250)
      setState('recording')
      tick.current = setInterval(() => setMs(Date.now() - started.current), 200)
      return true
    } catch (e) {
      setState('error')
      // The two failures worth distinguishing: no permission, and no device.
      const name = (e as Error).name
      setError(
        name === 'NotAllowedError'
          ? 'Microphone access was declined. Allow it in the browser’s site settings.'
          : name === 'NotFoundError'
            ? 'No microphone was found on this device.'
            : (e as Error).message,
      )
      return false
    }
  }, [cleanup])

  const stop = useCallback(
    () =>
      new Promise<{ blob: Blob; durationMs: number } | null>(resolve => {
        if (!rec.current || rec.current.state === 'inactive') return resolve(null)
        settle.current = resolve
        setState('stopping')
        rec.current.stop()
      }),
    [],
  )

  const cancel = useCallback(() => {
    settle.current = null
    if (rec.current && rec.current.state !== 'inactive') rec.current.stop()
    cleanup()
    setState('idle')
    setMs(0)
  }, [cleanup])

  return { state, error, ms, start, stop, cancel, supported: recordingSupported() }
}

/* ------------------------- live dictation (browser) ----------------------- */

type SpeechCtor = new () => any

const Speech: SpeechCtor | null =
  typeof window === 'undefined'
    ? null
    : ((window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition ?? null)

export const dictationSupported = () => !!Speech

/**
 * Live dictation into a field. Deliberately separate from recording: this
 * produces text and no file, and it never submits anything — the caller writes
 * the transcript into an input the human still has to act on.
 */
export function useDictation(onText: (text: string, final: boolean) => void) {
  const [listening, setListening] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ref = useRef<any>(null)
  const cb = useRef(onText)
  cb.current = onText

  const stop = useCallback(() => {
    try {
      ref.current?.stop()
    } catch {
      /* stopping something already stopped is not an error */
    }
    setListening(false)
  }, [])

  useEffect(() => stop, [stop])

  const start = useCallback(() => {
    if (!Speech) {
      setError('This browser has no built-in speech recognition. Record a voice note instead — the audio is kept either way.')
      return
    }
    try {
      const r = new Speech()
      r.continuous = true
      r.interimResults = true
      r.lang = navigator.language || 'en-US'
      r.onresult = (e: any) => {
        let interim = ''
        let final = ''
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const t = e.results[i][0].transcript
          if (e.results[i].isFinal) final += t
          else interim += t
        }
        if (final) cb.current(final, true)
        else if (interim) cb.current(interim, false)
      }
      r.onerror = (e: any) => {
        setError(e.error === 'not-allowed' ? 'Microphone access was declined.' : `Dictation failed: ${e.error}`)
        setListening(false)
      }
      r.onend = () => setListening(false)
      ref.current = r
      setError(null)
      r.start()
      setListening(true)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [])

  return { listening, error, start, stop, supported: dictationSupported() }
}

export const fmtDuration = (ms: number) => {
  const s = Math.round(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export const fmtBytes = (b: number) =>
  b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : b > 1e3 ? `${Math.round(b / 1e3)} KB` : `${b} B`
