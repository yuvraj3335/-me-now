/**
 * Settings.
 *
 * The old page printed shell commands as status text — `not connected — … run:
 * claude mcp login slack` — which is a README wearing a product's clothes. Each
 * row here says what is true in a sentence and offers the one action that fixes
 * it; the command that would also fix it lives behind a disclosure, because when
 * it is the answer it is the whole answer, and the rest of the time it is noise.
 */

import { useEffect, useState } from 'react'
import {
  Activity, Bell, BellRing, Check, ChevronRight, Link2, Loader2, Mic, Monitor, Moon,
  Smartphone, Sun, Terminal,
} from 'lucide-react'
import { actions } from '../lib/api'
import type { SourceStatus } from '../lib/types'
import {
  currentSubscription, disablePush, enablePush, needsHomeScreenInstall, pushSupported,
} from '../lib/push'
import { Button, Field, Sheet, inputClass } from '../components/primitives'
import { SOURCE_LABEL, SourceDot } from '../components/sources'
import { dictationSupported, fmtBytes, recordingSupported } from '../lib/voice'
import { ago } from '../lib/time'
import { useTheme, type Theme } from '../lib/theme'

type Overview = {
  handoff: { url: string; maxChars: number; templates: number; recentSessions: number }
  mail: { connected: boolean; reason: string | null; accounts: Array<{ address: string; connected: boolean; via: string; reason: string | null }>; canSend: boolean; canDraft: boolean; discovered: string[] }
  voice: { stt: { available: boolean; reason: string }; storage: { count: number; bytes: number }; missing: number }
  skills: { total: number; byCatalog: Record<string, number> }
  workspace: { root: string; repos: number }
  identity: { emails: string[]; github: string; gmailAccounts: string[] }
  publicUrl: string
}

/**
 * Which link in the credential chain answered, in words. Naming it matters: a
 * source that works "through Claude Code's token" goes dark the moment someone
 * removes that entry, and a source on Wake's own login does not.
 */
const VIA: Record<string, string> = {
  'wake-oauth': 'Wake’s own login',
  'claude-bridge': 'Claude Code’s token on this machine',
  env: 'an environment variable',
  'gh cli': 'the token the gh CLI already holds',
  filesystem: 'the transcripts on this machine',
}

/**
 * Where each source's shell fallback lives. Kept next to the row it belongs to
 * rather than in prose, and shown only when someone opens the disclosure.
 */
const CLI_FALLBACK: Record<string, string> = {
  slack: 'claude mcp add --transport http slack https://mcp.slack.com/mcp\nclaude mcp login slack',
  sentry: 'claude mcp add --transport http sentry https://mcp.sentry.dev/mcp\nclaude mcp login sentry',
  gmail: 'claude mcp add --transport http gmail https://gmailmcp.googleapis.com/mcp/v1\nclaude mcp login gmail',
}

export function Settings() {
  const [sources, setSources] = useState<SourceStatus[]>([])
  const [redirectUri, setRedirectUri] = useState('')
  const [over, setOver] = useState<Overview | null>(null)
  const [truto, setTruto] = useState<{ profiles: string[]; active: any; error?: string } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [clientFor, setClientFor] = useState<SourceStatus | null>(null)
  const [pushOn, setPushOn] = useState(false)
  const [devices, setDevices] = useState(0)
  const [msg, setMsg] = useState<string | null>(null)
  /**
   * A failure to start authorization belongs beside the source that failed.
   * It used to be written into `msg`, which renders inside Notifications —
   * three sections down the page, in a machine slug, so clicking Connect looked
   * like clicking nothing at all.
   */
  const [connectError, setConnectError] = useState<{ name: string; text: string } | null>(null)
  const [audit, setAudit] = useState(false)

  const load = async () => {
    await Promise.all([
      actions.connections().then(d => { setSources(d.sources); setRedirectUri(d.redirectUri) }).catch(() => {}),
      fetch('/api/settings').then(r => r.json()).then(setOver).catch(() => {}),
      fetch('/api/settings/truto').then(r => r.json()).then(setTruto).catch(() => {}),
      actions.pushStatus().then(d => setDevices(d.devices.length)).catch(() => {}),
    ])
  }

  useEffect(() => {
    void load()
    void currentSubscription().then(s => setPushOn(!!s))
  }, [])

  async function connect(s: SourceStatus) {
    setBusy(s.name)
    setConnectError(null)
    try {
      const r = await actions.connectStart(s.name)
      if (r.url) {
        // A popup keeps Wake's state alive behind the consent screen.
        window.open(r.url, '_blank', 'width=620,height=760')
        setTimeout(load, 4000)
      } else if (r.error === 'needs_client_id') {
        // 428, and the whole answer: this source has no dynamic registration,
        // so it needs an app of your own. The sheet asks for exactly that.
        if (r.redirectUri) setRedirectUri(r.redirectUri)
        setClientFor(s)
      } else {
        setConnectError({
          name: s.name,
          // `detail` is the sentence the server wrote; the slug is the fallback,
          // and the status code is the fallback's fallback.
          text: r.detail ?? r.error ?? `Could not start authorization (${r.status ?? 'no response'}).`,
        })
      }
    } catch (e) {
      setConnectError({ name: s.name, text: (e as Error).message })
    } finally {
      setBusy(null)
    }
  }

  async function togglePush() {
    setMsg(null)
    if (pushOn) {
      await disablePush()
      setPushOn(false)
      await load()
      return
    }
    const r = await enablePush()
    setPushOn(r.ok)
    if (!r.ok) setMsg(r.reason ?? 'Could not enable notifications')
    else {
      // Confirming the round trip immediately is the difference between "the
      // toggle is on" and "this device will actually be woken".
      const t = await actions.pushTest()
      setDevices(t.devices)
      setMsg(t.devices ? `On, and a test reached ${t.devices} device${t.devices > 1 ? 's' : ''}.` : 'On, but no device is registered yet.')
    }
  }

  return (
    <div className="pb-24">
      <header className="pt-8 pb-6">
        <h1 className="text-[26px] sm:text-[30px] font-medium tracking-[-0.025em] leading-none">Settings</h1>
        <p className="mt-2 text-[13px] text-fg-mute">What is connected, and what runs where</p>
      </header>

      {/* Panes, not a column of prose: each section is a scannable card, and on
          a screen wide enough for two, they flow into two so "is notifications
          on" doesn't mean scrolling past six unrelated sections to check. */}
      <div className="lg:columns-2 lg:gap-x-6">

      {/* --------------------------- appearance ------------------------------ */}
      <Section title="Appearance" hint="Follows the system unless you say otherwise.">
        <ThemeChoice />
      </Section>

      {/* ------------------------------ sources ------------------------------ */}
      <Section title="Sources" hint="Wake reads these on a timer and never writes to them.">
        {sources.map(s => (
          <div key={s.name} className="flex items-start gap-3 py-4 hairline last:border-0">
            <div className="pt-1.5"><SourceDot source={s.name} size={7} /></div>
            <div className="grow min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-[14.5px]">{SOURCE_LABEL[s.name]}</span>
                <span className={`text-[12.5px] ${s.ok ? 'text-ok' : 'text-fg-mute'}`}>
                  {s.ok ? 'connected' : 'not connected'}
                </span>
              </div>
              {s.ok && s.via && <p className="text-[11.5px] text-fg-mute mt-1">through {VIA[s.via] ?? s.via}</p>}
              {/* Connected is not the same claim as working. A source whose own
                  last poll failed used to render in exactly the green a healthy
                  one does, with nothing anywhere on the page saying otherwise. */}
              {s.ok && s.lastSync && !s.lastSync.ok && (
                <div className="mt-1.5">
                  <p className="text-[12px] text-warn leading-snug">
                    Connected, but the last sync failed {ago(s.lastSync.at)}.
                  </p>
                  {s.lastSync.error && (
                    <details className="mt-1">
                      <summary className="cursor-pointer list-none text-[11.5px] text-fg-mute hover:text-fg-dim transition-colors">
                        What went wrong
                      </summary>
                      <p className="mt-1 text-[11.5px] font-mono text-fg-mute break-words leading-relaxed">
                        {s.lastSync.error}
                      </p>
                    </details>
                  )}
                </div>
              )}
              {!s.ok && <Reason name={s.name} detail={s.detail} />}
              {connectError?.name === s.name && (
                <p className="text-[12.5px] text-warn mt-1.5 leading-snug">{connectError.text}</p>
              )}
            </div>
            {s.oauthable && (
              <Button
                variant={s.ok ? 'ghost' : 'solid'}
                onClick={() => (s.ok ? actions.disconnect(s.name).then(load) : connect(s))}
                disabled={busy === s.name}
              >
                {busy === s.name ? <Loader2 size={13} className="animate-spin" /> : null}
                {s.ok ? 'Disconnect' : 'Connect'}
              </Button>
            )}
          </div>
        ))}
      </Section>

      {/* ------------------------------- mail -------------------------------- */}
      {over && (
        <Section
          title="Mail accounts"
          hint={
            over.mail.accounts.length > 1
              ? 'Separate connections, not one inbox with a filter.'
              : 'The one address mail is actually addressed to.'
          }
        >
          {over.mail.accounts.map(a => (
            <div key={a.address} className="flex items-start gap-3 py-3 hairline last:border-0">
              <div className="grow min-w-0">
                <div className="text-[14px]">{a.address}</div>
                <p className={`text-[12px] mt-0.5 ${a.connected ? 'text-ok' : 'text-fg-mute'}`}>
                  {a.connected ? `connected through ${a.via}` : 'not connected'}
                </p>
              </div>
            </div>
          ))}
          {over.mail.connected && (
            <p className="text-[12px] text-fg-mute pt-2 leading-relaxed">
              This connection can {over.mail.canSend ? 'send' : 'read but not send'}
              {over.mail.canDraft ? ' and save drafts' : ''}.
              {!over.mail.canSend && ' Composing still works; Send is disabled rather than failing at the last step.'}
            </p>
          )}
          {!over.mail.connected && over.mail.reason && (
            // `reason` is now one sentence by construction, so it no longer has
            // to be cut at the first full stop — which used to lop the second
            // half off a genuinely useful explanation.
            <p className="text-[12.5px] text-fg-mute pt-2 leading-relaxed">
              {over.mail.reason} Open Mail for the fix.
            </p>
          )}
        </Section>
      )}

      {/* ---------------------------- open in claude ------------------------- */}
      {over && (
        <Section
          title="Open in Claude"
          hint="Wake packs the context and hands it over as a link. It runs no model and holds no key of its own."
        >
          <Row
            icon={<Terminal size={14} />}
            label="Opens"
            value={over.handoff.url}
            mono
            tone="ok"
          />
          <Row
            label="Brief size"
            value={`up to ${over.handoff.maxChars.toLocaleString()} characters travel in the link; anything longer is trimmed and says so`}
          />
          <Row label="Templates" value={`${over.handoff.templates}, each with its own context slots and named skills`} />
          <Row label="Recent sessions" value={`${over.handoff.recentSessions} on this machine in the last 30 days`} />
          <p className="text-[12px] text-fg-mute pt-2 leading-relaxed">
            On a phone this opens the Claude app; on a laptop, a new tab. Either way it is your own
            Claude login — Wake never sees it, and nothing starts on the DevBox.
          </p>
        </Section>
      )}

      {/* ------------------------------ truto -------------------------------- */}
      {truto && (
        <Section title="Truto" hint="The CLI's own profiles. Wake never reads or shows the token.">
          {truto.active ? (
            <>
              <Row label="Profile" value={truto.active.profile} />
              <Row label="Team" value={truto.active.team ?? '(not reported)'} />
              <Row label="User" value={truto.active.user ?? '(not reported)'} />
              <Row label="API" value={truto.active.apiUrl ?? '(default)'} mono />
            </>
          ) : (
            <p className="text-[12.5px] text-fg-mute py-2 leading-relaxed">
              {truto.error ?? 'No Truto CLI profile resolved on this machine.'}
            </p>
          )}
          {truto.profiles.length > 1 && (
            // Thirty-seven profile names is a dump, not information. The count
            // is the fact; the list is available to whoever wants it.
            <details className="pt-2">
              <summary className="cursor-pointer list-none text-[11.5px] text-fg-mute hover:text-fg-dim transition-colors">
                {truto.profiles.length} profiles on this machine
              </summary>
              <p className="mt-1.5 text-[11.5px] text-fg-mute leading-relaxed">{truto.profiles.join(' · ')}</p>
            </details>
          )}
        </Section>
      )}

      {/* --------------------------- skills & MCP ---------------------------- */}
      {over && (
        <Section title="Skills and workspace" hint="Skills are named in a brief, never inlined into one.">
          <Row
            label="Skills indexed"
            value={`${over.skills.total} across ${Object.keys(over.skills.byCatalog).length} catalogs (${Object.entries(over.skills.byCatalog).map(([k, v]) => `${k}:${v}`).join(', ')})`}
          />
          <Row
            label="Workspace"
            value={`${over.workspace.repos} ${over.workspace.repos === 1 ? 'repository' : 'repositories'} under ${over.workspace.root}`}
          />
        </Section>
      )}

      {/* ------------------------------ voice -------------------------------- */}
      {over && (
        <Section title="Voice" hint="Recordings stay on this machine. Nothing is uploaded unless you attach it to a send you confirm.">
          <Row
            icon={<Mic size={14} />}
            label="Microphone"
            value={recordingSupported() ? 'available in this browser' : 'this browser cannot record audio'}
            tone={recordingSupported() ? 'ok' : 'bad'}
          />
          <Row
            label="Live dictation"
            value={dictationSupported() ? 'available in this browser' : 'not available here — recordings still work'}
            tone={dictationSupported() ? 'ok' : undefined}
          />
          <Row
            label="Transcribing stored notes"
            value={over.voice.stt.available ? 'configured' : 'not configured'}
            tone={over.voice.stt.available ? 'ok' : undefined}
          />
          {!over.voice.stt.available && (
            <p className="text-[12px] text-fg-mute pt-1 leading-relaxed">{over.voice.stt.reason}</p>
          )}
          <Row label="Stored" value={`${over.voice.storage.count} note${over.voice.storage.count === 1 ? '' : 's'} · ${fmtBytes(over.voice.storage.bytes)}`} />
          {over.voice.missing > 0 && (
            <p className="text-[12px] text-warn pt-1">
              {over.voice.missing} note{over.voice.missing === 1 ? '' : 's'} reference audio that is no longer on disk.
            </p>
          )}
        </Section>
      )}

      {/* -------------------------- notifications ---------------------------- */}
      <Section title="Notifications">
        {needsHomeScreenInstall() && (
          <div className="flex gap-3 mb-4 text-[13px] text-fg-dim leading-relaxed">
            <Smartphone size={15} className="shrink-0 mt-0.5 text-accent-ink" />
            <p>
              On iPhone, open the share sheet and choose <strong className="font-medium">Add to Home Screen</strong> first.
              Apple only delivers push to an installed app, never to a Safari tab.
            </p>
          </div>
        )}

        <div className="flex items-center gap-3 py-2">
          <Button variant={pushOn ? 'solid' : 'accent'} onClick={togglePush} disabled={!pushSupported()}>
            {pushOn ? <BellRing size={14} /> : <Bell size={14} />}
            {pushOn ? 'Notifications on' : 'Turn on notifications'}
          </Button>
          {pushOn && (
            <Button variant="ghost" onClick={async () => {
              const r = await actions.pushTest()
              setDevices(r.devices)
              setMsg(r.devices ? `Sent to ${r.devices} device${r.devices > 1 ? 's' : ''}.` : 'No devices registered.')
            }}>
              Send a test
            </Button>
          )}
          {devices > 0 && <span className="text-[12px] text-fg-mute tnum">{devices} device{devices > 1 ? 's' : ''}</span>}
        </div>

        {msg && <p className="text-[12.5px] text-fg-dim mt-2 leading-snug">{msg}</p>}
        {!pushSupported() && <p className="text-[12.5px] text-fg-mute mt-2">This browser doesn’t support Web Push.</p>}
      </Section>

      {/* ------------------------------ audit -------------------------------- */}
      <Section title="Audit" hint="Every message sent, every brief handed over, every command run.">
        <button
          onClick={() => setAudit(true)}
          className="w-full flex items-center gap-2 py-3 text-left text-[13.5px] text-fg-dim hover:text-fg transition-colors"
        >
          <Activity size={14} className="text-fg-mute" />
          Open the audit trail
          <ChevronRight size={14} className="ml-auto text-fg-mute" />
        </button>
      </Section>

      </div>

      <AuditSheet open={audit} onClose={() => setAudit(false)} />
      <ClientSheet
        source={clientFor}
        redirectUri={redirectUri}
        onClose={() => setClientFor(null)}
        onSaved={async () => { setClientFor(null); await load() }}
      />
    </div>
  )
}

/* -------------------------------- pieces ---------------------------------- */

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="mb-5 break-inside-avoid rounded-2xl bg-ink-900/60 border border-white/[0.05] p-5">
      <h2 className="text-[11.5px] uppercase tracking-[0.08em] text-fg-mute">{title}</h2>
      {hint && <p className="text-[12.5px] text-fg-mute mt-1 mb-3 leading-relaxed max-w-[58ch]">{hint}</p>}
      <div className={hint ? '' : 'mt-3'}>{children}</div>
    </section>
  )
}

function Row({
  label, value, tone, mono, icon, action,
}: {
  label: string
  value: string
  tone?: 'ok' | 'bad' | 'warn'
  mono?: boolean
  icon?: React.ReactNode
  action?: React.ReactNode
}) {
  const colour = tone === 'ok' ? 'text-ok' : tone === 'bad' ? 'text-bad' : tone === 'warn' ? 'text-warn' : 'text-fg-dim'
  return (
    <div className="flex items-start gap-3 py-2.5 hairline last:border-0">
      {icon && <span className="text-fg-mute mt-0.5 shrink-0">{icon}</span>}
      <div className="grow min-w-0">
        <div className="text-[13px] text-fg-mute">{label}</div>
        <div className={`text-[13.5px] mt-0.5 break-words ${colour} ${mono ? 'font-mono text-[12px]' : ''}`}>{value}</div>
      </div>
      {action}
    </div>
  )
}

/** The CLI is the fallback, not the status copy. It lives behind a disclosure. */
function Reason({ name, detail }: { name: string; detail: string }) {
  const cmd = CLI_FALLBACK[name]
  // Adapter status strings historically appended "run: …" — strip that so the
  // sentence reads as a sentence and the command appears once, below.
  // Older adapter strings appended "— connect here, or run: …". Strip the
  // command and any dangling conjunction so the sentence reads as a sentence
  // and the command appears once, below, where someone asked for it.
  const clean = detail
    .replace(/\s*—?\s*run:.*$/is, '')
    .replace(/^not connected\s*—?\s*/i, '')
    .replace(/[,\s]*\bor\b\s*$/i, '')
    .trim()
  return (
    <div className="mt-1">
      {clean && <p className="text-[12.5px] text-fg-mute leading-snug">{clean}</p>}
      {cmd && (
        <details className="mt-1.5">
          <summary className="cursor-pointer list-none text-[11.5px] text-fg-mute hover:text-fg-dim transition-colors">
            Or connect it from a terminal
          </summary>
          <pre className="mt-1.5 p-2.5 rounded-[10px] bg-ink-850 text-[11.5px] font-mono text-fg-dim overflow-x-auto leading-relaxed">
            {cmd}
          </pre>
        </details>
      )}
    </div>
  )
}

function AuditSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [data, setData] = useState<any>(null)
  useEffect(() => {
    if (!open) return
    fetch('/api/settings/audit?limit=80').then(r => r.json()).then(setData).catch(() => {})
  }, [open])

  return (
    <Sheet open={open} onClose={onClose} title="Audit">
      {!data ? (
        <p className="text-[13px] text-fg-mute py-6">Reading…</p>
      ) : (
        <div className="space-y-5">
          <AuditGroup title="Outbound and hand-offs" rows={data.events} render={(e: any) => (
            <>
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${e.ok ? 'bg-ok' : 'bg-bad'}`} />
              <span className="font-mono text-[11.5px] text-fg-dim shrink-0">{e.kind}</span>
              <span className="text-[12px] text-fg-mute truncate">{e.target ?? e.error ?? ''}</span>
              <span className="ml-auto tnum text-[11px] text-fg-mute shrink-0">{ago(e.at)}</span>
            </>
          )} />
          <AuditGroup title="Truto CLI" rows={data.commands} render={(r: any) => (
            <>
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${r.ok ? 'bg-ok' : 'bg-bad'}`} />
              <span className="font-mono text-[11.5px] text-fg-dim truncate">truto {r.argv.slice(0, 4).join(' ')}</span>
              <span className="ml-auto tnum text-[11px] text-fg-mute shrink-0">{ago(r.at)}</span>
            </>
          )} />
        </div>
      )}
    </Sheet>
  )
}

function AuditGroup({ title, rows, render }: { title: string; rows: any[]; render: (r: any) => React.ReactNode }) {
  if (!rows?.length) return null
  return (
    <div>
      <div className="text-[10.5px] uppercase tracking-[0.08em] text-fg-mute mb-1.5">{title}</div>
      {rows.slice(0, 40).map((r, i) => (
        <div key={r.id ?? i} className="flex items-center gap-2 py-1.5 hairline last:border-0">{render(r)}</div>
      ))}
    </div>
  )
}

/**
 * The no-DCR path. Slack publishes no registration endpoint, so its app's own
 * client id and secret go here once; everything after that is automatic.
 */
function ClientSheet({
  source, redirectUri, onClose, onSaved,
}: { source: SourceStatus | null; redirectUri: string; onClose: () => void; onSaved: () => void }) {
  const [id, setId] = useState('')
  const [secret, setSecret] = useState('')
  const [copied, setCopied] = useState(false)

  useEffect(() => { setId(''); setSecret(''); setCopied(false) }, [source?.name])
  if (!source) return null

  return (
    <Sheet open onClose={onClose} title={`Connect ${SOURCE_LABEL[source.name]}`}
      footer={
        <Button variant="accent" className="w-full" disabled={!id.trim()}
          onClick={async () => { await actions.setClient(source.name, { client_id: id.trim(), client_secret: secret.trim() || undefined }); onSaved() }}>
          Save and continue
        </Button>
      }>
      <p className="text-[13px] text-fg-dim leading-relaxed mb-4">
        {SOURCE_LABEL[source.name]} doesn’t support automatic client registration, so it needs
        an app of your own. Create one, add the redirect URL below, then paste its credentials here.
        You only do this once.
      </p>

      <Field label="Redirect URL — add this to the app">
        <button
          onClick={() => { void navigator.clipboard?.writeText(redirectUri); setCopied(true) }}
          className="w-full flex items-center gap-2 bg-ink-800 rounded-[10px] px-3 py-2.5 text-left
                     hover:bg-ink-700 transition-colors"
        >
          <code className="text-[12px] font-mono text-fg-dim truncate grow">{redirectUri}</code>
          {copied ? <Check size={13} className="text-ok shrink-0" /> : <Link2 size={13} className="text-fg-mute shrink-0" />}
        </button>
      </Field>

      <Field label="Client ID">
        <input className={inputClass} value={id} onChange={e => setId(e.target.value)} autoFocus
          placeholder="1234567890.1234567890" />
      </Field>
      <Field label="Client secret" hint="Stored on your DevBox only.">
        <input className={inputClass} type="password" value={secret}
          onChange={e => setSecret(e.target.value)} placeholder="••••••••" />
      </Field>
    </Sheet>
  )
}

/**
 * Three states, not a switch.
 *
 * "System" is a real choice — a phone that goes dark at sunset should take the
 * app with it — so the control says which one is in effect right now rather than
 * leaving you to guess what "system" resolved to.
 */
function ThemeChoice() {
  const { theme, resolved, set } = useTheme()
  const options: Array<{ id: Theme; label: string; Icon: typeof Sun }> = [
    { id: 'system', label: 'System', Icon: Monitor },
    { id: 'light', label: 'Light', Icon: Sun },
    { id: 'dark', label: 'Dark', Icon: Moon },
  ]

  return (
    <div className="py-2">
      <div className="flex gap-1.5">
        {options.map(o => (
          <button
            key={o.id}
            onClick={() => set(o.id)}
            aria-pressed={theme === o.id}
            className={`flex-1 inline-flex items-center justify-center gap-1.5 min-h-10 rounded-[10px]
              text-[13.5px] transition-colors
              ${theme === o.id ? 'bg-ink-700 text-fg' : 'bg-ink-800 text-fg-mute hover:text-fg-dim'}`}
          >
            <o.Icon size={14} />
            {o.label}
          </button>
        ))}
      </div>
      {theme === 'system' && (
        <p className="mt-2 text-[11.5px] text-fg-mute">
          Following this device — {resolved} right now.
        </p>
      )}
    </div>
  )
}
