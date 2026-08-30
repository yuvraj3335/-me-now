/**
 * Voice: a dictation button, a recorder, and a player.
 *
 * The rule the components enforce between them: voice never commits anything.
 * Dictation writes into a field the person still has to act on, and a recording
 * becomes a note on disk. Neither sends mail, posts to Slack, nor starts a
 * session.
 */

import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, Loader2, Mic as MicIcon, Pause, Play, Square, Trash2 } from 'lucide-react'
import { motion } from 'motion/react'
import { Button } from './primitives'
import {
  fmtDuration, useDictation, useRecorder, voiceApi, type VoiceNote,
} from '../lib/voice'
import { STATIC_MODE } from '../lib/motion'
import { ago } from '../lib/time'

/**
 * Hold-to-talk dictation into a text field.
 *
 * Uses the browser's own recogniser, which exists in Chrome and Safari and does
 * not exist in Firefox. Where it is missing the button says so rather than
 * sitting there inert — and the recorder below is the fallback that works
 * everywhere, since it keeps the audio regardless.
 */
export function Mic({
  onText, title = 'Dictate',
}: { onText: (text: string) => void; title?: string }) {
  const [note, setNote] = useState<string | null>(null)

  const { listening, error, start, stop, supported } = useDictation((text, final) => {
    if (final) onText(text.trim())
  })

  useEffect(() => { if (error) setNote(error) }, [error])

  return (
    <div className="relative">
      <button
        type="button"
        title={supported ? title : 'This browser has no built-in dictation'}
        onClick={() => {
          setNote(null)
          if (!supported) {
            return setNote('This browser has no built-in dictation. Record a voice note instead — the audio is kept either way.')
          }
          listening ? stop() : start()
        }}
        className={`p-1.5 rounded-lg transition-colors ${
          listening ? 'text-accent-ink bg-accent-soft' : supported ? 'text-fg-mute hover:text-fg-dim hover:bg-ink-800' : 'text-fg-mute/50'
        }`}
      >
        {listening ? (
          <motion.span
            className="block"
            animate={STATIC_MODE ? undefined : { opacity: [1, 0.4, 1] }}
            transition={{ repeat: Infinity, duration: 1.2 }}
          >
            <MicIcon size={14} />
          </motion.span>
        ) : (
          <MicIcon size={14} />
        )}
      </button>
      {note && (
        <p className="absolute right-0 top-8 z-20 w-60 text-sm text-fg-mute
                      bg-ink-800 rounded-lg p-2 leading-snug shadow-xl">
          {note}
        </p>
      )}
    </div>
  )
}

/**
 * Record a voice note.
 *
 * The recording is uploaded when it stops, with whatever the browser managed to
 * transcribe alongside it. If transcription produced nothing the note is still
 * saved — an untranscribed note is a note; an invented transcript is something
 * you would act on wrongly later.
 */
export function Recorder({
  taskId, cardGroup, packId, onSaved,
}: {
  taskId?: string | null
  cardGroup?: string | null
  packId?: string | null
  onSaved?: (n: VoiceNote) => void
}) {
  const rec = useRecorder()
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const transcript = useRef('')

  const dict = useDictation((text, final) => {
    if (final) transcript.current = `${transcript.current} ${text}`.trim()
  })

  if (!rec.supported) {
    return (
      <p className="text-sm text-fg-mute leading-relaxed">
        This browser cannot record audio, so voice notes are unavailable here.
      </p>
    )
  }

  const start = async () => {
    setErr(null)
    transcript.current = ''
    const ok = await rec.start()
    // Dictation runs alongside the recorder rather than instead of it: it costs
    // nothing where it works, and its absence costs nothing either.
    if (ok && dict.supported) dict.start()
  }

  const stop = async () => {
    if (dict.listening) dict.stop()
    const out = await rec.stop()
    if (!out) return
    setSaving(true)
    try {
      const note = await voiceApi.save(out.blob, {
        durationMs: out.durationMs,
        transcript: transcript.current.trim() || null,
        taskId,
        cardGroup,
        packId,
      })
      onSaved?.(note)
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div>
      <div className="flex items-center gap-2">
        {rec.state === 'recording' ? (
          <>
            <Button variant="primary" onClick={stop} disabled={saving}>
              <Square size={13} className="fill-current" /> Stop
            </Button>
            <span className="tnum text-sm text-accent-ink">{fmtDuration(rec.ms)}</span>
            <Button variant="ghost" onClick={rec.cancel}>Discard</Button>
          </>
        ) : (
          // Ghost, not bordered. Starting a recording is a decision, not a
          // commit — the commit is Stop, which saves — and Work already spends
          // its one filled control on `+ Task`. A bordered box beside an amber
          // one put three control styles on a page that needs one.
          <Button variant="ghost" onClick={start} disabled={saving || rec.state === 'requesting'}>
            {saving ? <Loader2 size={13} className="animate-spin" /> : <MicIcon size={14} />}
            {saving ? 'Saving…' : rec.state === 'requesting' ? 'Asking for the mic…' : 'Record a note'}
          </Button>
        )}
      </div>

      {(rec.error || err) && (
        <p className="mt-2 flex items-start gap-2 text-sm text-bad leading-snug">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />
          {rec.error ?? err}
        </p>
      )}
      {rec.state === 'recording' && !dict.supported && (
        <p className="mt-2 text-sm text-fg-mute">
          This browser cannot transcribe live; the audio is still saved.
        </p>
      )}
    </div>
  )
}

/** Playback with a real scrub bar, because a note you cannot seek is a note you re-listen to. */
export function VoicePlayer({ note, onDelete }: { note: VoiceNote; onDelete?: () => void }) {
  const audio = useRef<HTMLAudioElement>(null)
  const [playing, setPlaying] = useState(false)
  const [pos, setPos] = useState(0)
  const [dur, setDur] = useState(note.duration_ms ? note.duration_ms / 1000 : 0)
  const [err, setErr] = useState<string | null>(null)

  return (
    <div className="py-3 hairline last:border-0">
      <div className="flex items-start gap-3">
        <button
          onClick={() => {
            const el = audio.current
            if (!el) return
            if (playing) {
              el.pause()
            } else {
              el.play().catch(e => setErr((e as Error).message))
            }
          }}
          className="mt-0.5 p-2 rounded-full bg-ink-800 text-fg-dim hover:text-fg hover:bg-ink-700 transition-colors shrink-0"
        >
          {playing ? <Pause size={13} /> : <Play size={13} className="translate-x-[1px]" />}
        </button>

        <div className="grow min-w-0">
          <div className="text-sm text-fg leading-snug">{note.title ?? 'Note'}</div>
          <div className="mt-1 flex items-center gap-2">
            <input
              type="range"
              min={0}
              max={Math.max(dur, 0.1)}
              step={0.1}
              value={pos}
              onChange={e => {
                const v = Number(e.target.value)
                setPos(v)
                if (audio.current) audio.current.currentTime = v
              }}
              className="flex-1 h-1 accent-[var(--color-accent)] bg-ink-700 rounded-full appearance-none cursor-pointer"
              aria-label="Seek"
            />
            <span className="tnum text-sm text-fg-mute shrink-0">
              {fmtDuration(pos * 1000)} / {dur ? fmtDuration(dur * 1000) : '—'}
            </span>
          </div>

          {note.transcript && (
            <p className="mt-2 text-sm text-fg-dim leading-relaxed whitespace-pre-wrap">{note.transcript}</p>
          )}
          {!note.transcript && note.transcript_state === 'failed' && (
            <p className="mt-2 text-sm text-fg-mute">
              Transcription failed; the recording is intact. {note.transcript_error}
            </p>
          )}
          {err && <p className="mt-2 text-sm text-bad">{err}</p>}
          <div className="mt-1 text-sm text-fg-mute tnum">{ago(note.created_at)} ago</div>
        </div>

        {onDelete && (
          <button onClick={onDelete} className="p-2 -mr-1 text-fg-mute hover:text-bad transition-colors shrink-0" title="Delete">
            <Trash2 size={13} />
          </button>
        )}
      </div>

      <audio
        ref={audio}
        src={voiceApi.audioUrl(note.id)}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => { setPlaying(false); setPos(0) }}
        onTimeUpdate={e => setPos((e.target as HTMLAudioElement).currentTime)}
        onLoadedMetadata={e => {
          const d = (e.target as HTMLAudioElement).duration
          // MediaRecorder's webm has no duration in its header, so the browser
          // reports Infinity until it has seeked. The recorded length we stored
          // is the reliable number.
          if (Number.isFinite(d) && d > 0) setDur(d)
        }}
        onError={() => setErr('The audio could not be loaded.')}
        className="hidden"
      />
    </div>
  )
}
