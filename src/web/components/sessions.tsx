/**
 * Every Claude Code session on this box, by repository.
 *
 * The launch sheet has always had a picker over these, but only as a dropdown
 * inside a hand-off — there was no way to see what is on the machine, which of
 * them is still running, or to get rid of one. This is that list.
 *
 * Two facts shape it. Sessions are filed by the directory they *started* in,
 * flattened to dashes, and that encoding is lossy — so the grouping key is the
 * `cwd` the transcript recorded, never the filename. And `turns` is counted from
 * the tail the server read, not from the whole transcript, so it renders as
 * `turns in view` everywhere rather than as a total nobody measured.
 *
 * Delete is the one irreversible action in the product that touches files Wake
 * did not write. It names all four paths, takes a typed confirmation, and is
 * refused outright while the session is running — unlinking a live transcript
 * does not stop the process, it just leaves it appending to a file with no name.
 */

import { useEffect, useMemo, useState } from 'react'
import { Loader2, SquareTerminal, Trash2 } from 'lucide-react'
import { Button, Empty, Pager, Sheet, inputClass, pageCount, pageSlice } from './primitives'
import { ago } from '../lib/time'
import { toast } from '../lib/toast'
import { setParam, useParam } from '../lib/route'
import { launchApi, openLaunch, type Session } from '../lib/launch'

/** Typed exactly, or the button stays disabled. */
const CONFIRM_WORD = 'delete'

export function SessionsView() {
  const [sessions, setSessions] = useState<Session[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [doomed, setDoomed] = useState<Session | null>(null)

  const page = Math.max(1, Number(useParam('page') ?? '1') || 1)

  const load = () => {
    launchApi.sessions({ all: true })
      .then(d => setSessions(d.sessions))
      .catch(e => setErr((e as Error).message))
  }
  useEffect(load, [])

  /**
   * Paged after grouping, not before.
   *
   * A page boundary that falls inside a repository would print the same header
   * twice with a page turn between the halves, so the flat, already-sorted list
   * is sliced first and the headers are drawn from whatever landed on the page.
   *
   * The size is `primitives`' one number rather than a local constant: `Pager`
   * renders the range it stands over, so a list that sliced by 25 under a pager
   * that counts by 50 would print a range describing rows that are not there.
   */
  const rows = sessions ?? []
  const pages = pageCount(rows.length)
  const clamped = Math.min(page, pages)
  const shown = pageSlice(rows, clamped)

  const groups = useMemo(() => {
    const by = new Map<string, Session[]>()
    for (const s of shown) {
      const key = s.project || s.cwd
      const list = by.get(key)
      list ? list.push(s) : by.set(key, [s])
    }
    return [...by.entries()]
  }, [shown])

  if (err) return <p className="text-sm text-bad pt-4">{err}</p>
  if (!sessions) return null
  if (!rows.length) return <Empty>Nothing on this machine in the last year.</Empty>

  return (
    <div>
      {groups.map(([repo, list]) => (
        <section key={repo} className="pt-4">
          <h2 className="text-eyebrow uppercase text-fg-mute pb-1">{repo}</h2>
          {list.map(s => (
            <Row key={s.id} session={s} onDelete={() => setDoomed(s)} />
          ))}
        </section>
      ))}

      <Pager
        page={clamped}
        pages={pages}
        total={rows.length}
        onPage={p => setParam('page', p === 1 ? null : String(p))}
      />

      <DeleteSheet
        session={doomed}
        onClose={() => setDoomed(null)}
        onDone={() => { setDoomed(null); load() }}
      />
    </div>
  )
}

function Row({ session: s, onDelete }: { session: Session; onDelete: () => void }) {
  return (
    <div className="flex items-start gap-3 py-2 border-b border-rule last:border-0">
      <SquareTerminal size={14} className="text-fg-mute shrink-0 mt-1" />

      <div className="grow min-w-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-base text-fg truncate min-w-0">{s.title}</span>
          {s.live && <span className="text-sm text-ok shrink-0">live</span>}
        </div>
        {/* One truncated line of his own last prompt. Two lines of somebody's
            half-finished thought is a paragraph, and this is a list. */}
        {s.lastPrompt && (
          <p className="text-sm text-fg-mute truncate">{s.lastPrompt}</p>
        )}
        <p className="text-sm text-fg-mute truncate">
          {[
            s.branch,
            `${s.turns} turns in view`,
            ago(s.lastTs),
          ].filter(Boolean).join(' — ')}
        </p>
      </div>

      <div className="flex items-center gap-1 shrink-0">
        <Button
          size="sm"
          onClick={() => openLaunch(
            [{
              kind: 'session',
              ref: `session:${s.id}`,
              title: s.title,
              excerpt: s.lastPrompt,
              why: 'work already underway on my machine',
              meta: {
                session_id: s.id,
                cwd: s.cwd,
                branch: s.branch ?? null,
                turns_in_view: s.turns,
              },
            }],
            { templates: ['continue-session'], repoHint: s.cwd, session: s.id, title: s.title },
          )}
        >
          Open in Claude
        </Button>
        {/* Ghost, not `danger`. This button opens a dialog; the dialog's button
            is what destroys, and that one is `danger`. Fifty filled red squares
            down a list is a page shouting at you about something none of them
            has actually done yet. */}
        <Button
          size="sm"
          variant="ghost"
          ariaLabel="Delete"
          // A live session's files are still being written to. This is not a
          // caution, it is the reason the delete cannot be correct.
          title={s.live ? 'It is running right now — close it first' : 'Delete'}
          disabled={!!s.live}
          onClick={onDelete}
        >
          <Trash2 size={14} />
        </Button>
      </div>
    </div>
  )
}

/**
 * The delete dialog, which names what goes.
 *
 * The token is minted by the server against this exact session id and spent by
 * the delete, so approving one session and deleting another is not reachable —
 * the same rule the mail composer works under. The paths come back from that
 * same call, so the list shown is the list the server will act on rather than
 * something the client reconstructed.
 */
function DeleteSheet({
  session, onClose, onDone,
}: { session: Session | null; onClose: () => void; onDone: () => void }) {
  const [confirm, setConfirm] = useState('')
  const [ready, setReady] = useState<{ token: string; paths: string[] } | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setConfirm('')
    setReady(null)
    setErr(null)
    if (!session) return
    let live = true
    launchApi.confirmDeleteSession(session.id)
      .then(d => { if (live) setReady({ token: d.token, paths: d.paths }) })
      .catch(e => { if (live) setErr((e as Error).message) })
    return () => { live = false }
  }, [session?.id])

  const run = async () => {
    if (!session || !ready) return
    setBusy(true)
    try {
      const r = await launchApi.deleteSession(session.id, ready.token)
      toast(`Deleted ${r.removed.length} file${r.removed.length === 1 ? '' : 's'}.`)
      onDone()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Sheet open={!!session} onClose={onClose} title="Delete this session">
      {session && (
        <div>
          <p className="text-base text-fg-dim">{session.title}</p>
          <p className="text-sm text-fg-mute mt-2 leading-snug">
            This removes files under your Claude Code home, not inside Wake. It cannot be undone,
            and one of them is the edit-undo history for real source files.
          </p>

          <h3 className="text-eyebrow uppercase text-fg-mute mt-4 mb-2">What goes</h3>
          {ready
            ? ready.paths.map(p => (
              <p key={p} className="text-sm text-fg-mute font-mono truncate py-1 border-b border-rule last:border-0">
                {p}
              </p>
            ))
            : <p className="text-sm text-fg-mute h-8 flex items-center">—</p>}

          <h3 className="text-eyebrow uppercase text-fg-mute mt-4 mb-2">
            Type {CONFIRM_WORD} to confirm
          </h3>
          <input
            value={confirm}
            onChange={e => setConfirm(e.target.value)}
            spellCheck={false}
            autoComplete="off"
            aria-label={`Type ${CONFIRM_WORD} to confirm`}
            className={inputClass}
          />

          {err && <p className="text-sm text-bad mt-3">{err}</p>}

          <div className="mt-4 flex items-center gap-2">
            <Button
              variant="danger"
              disabled={busy || !ready || confirm.trim().toLowerCase() !== CONFIRM_WORD}
              onClick={run}
            >
              {busy ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
              Delete
            </Button>
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
          </div>
        </div>
      )}
    </Sheet>
  )
}
