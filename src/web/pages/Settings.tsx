/**
 * Settings, as a status board.
 *
 * Nine sections of label/value rows, in the order he needs them at 7am when
 * something is broken: who he is, what is connected, mail, notifications, the
 * hand-off, the machine, voice, appearance, audit.
 *
 * What this replaces: nine cards each with a prose subtitle and a second
 * paragraph under nearly every field — the longest a 43-word `WAKE_STT_URL`
 * configuration note, a README printed inside the product — with the state
 * (`connected` / `not connected`) as a small word buried in it. Every mechanism
 * sentence that is worth keeping moved behind the `<details>` disclosure that
 * already existed; the rest is gone.
 */

import { useEffect, useState } from 'react'
import {
  Activity, Check, ChevronRight, Link2, Loader2, Monitor, Moon, Sun,
} from 'lucide-react'
import { actions } from '../lib/api'
import type { SourceStatus } from '../lib/types'
import {
  currentSubscription, disablePush, enablePush, needsHomeScreenInstall, pushSupported,
} from '../lib/push'
import { Button, Field, Segmented, Sheet, inputClass } from '../components/primitives'
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

type Truto = { profiles: string[]; active: any; error?: string }

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
  const [truto, setTruto] = useState<Truto | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [clientFor, setClientFor] = useState<SourceStatus | null>(null)
  const [pushOn, setPushOn] = useState(false)
  const [devices, setDevices] = useState(0)
  const [msg, setMsg] = useState<string | null>(null)
  /**
   * A failure to start authorization belongs beside the source that failed. It
   * used to be written into `msg`, which renders inside Notifications — three
   * sections down the page — so clicking Connect looked like clicking nothing.
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
        if (r.redirectUri) setRedirectUri(r.redirectUri)
        setClientFor(s)
      } else {
        setConnectError({
          name: s.name,
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
      setMsg(t.devices ? `A test reached ${t.devices} device${t.devices > 1 ? 's' : ''}` : 'No device registered yet')
    }
  }

  const mailAccount = over?.mail.accounts[0]
  const gmail = sources.find(s => s.name === 'gmail')

  return (
    <div className="pb-24">
      <header className="flex items-center gap-3 pt-6 pb-4">
        <h1 className="text-lg font-medium">Settings</h1>
      </header>

      {/*
        Three explicit columns, filled by meaning.

        Not `lg:columns-2`, which distributes by HEIGHT and can split a card
        across two columns; and not one grid either, because a CSS grid sizes
        every row by its tallest tile, so a five-row Sources card leaves a
        hand's width of dead space beside a two-row You card. Assigning the
        tiles to columns keeps the reading order — down each column, in the order
        he needs them at 7am — and leaves no holes.
      */}
      <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3 items-start">
      <div className="grid gap-4 content-start">

        <Section title="You">
          <Row label="Email" value={over?.identity.emails[0] ?? '—'} mono />
          <Row label="GitHub" value={over?.identity.github ?? '—'} mono />
        </Section>

        <Section title="Sources">
          {sources.map(s => (
            <div key={s.name} className="flex items-center gap-3 h-11 border-b border-rule last:border-0">
              <SourceDot source={s.name} size={6} />
              <span className="text-base w-28 shrink-0 truncate">{SOURCE_LABEL[s.name]}</span>
              <span className={`text-sm w-32 shrink-0 ${stateTone(s)}`}>{stateWord(s)}</span>
              {/* The API's real `detail` — `signed in as yuvraj3335`, `7 projects
                  on this machine` — not a generic `via`. Those are the facts
                  that confirm the connection is the right one. */}
              <span className="text-sm text-fg-mute truncate grow" title={s.detail}>
                {s.ok ? s.detail : ''}
              </span>
              {s.oauthable && (
                <Button size="sm" variant={s.ok ? 'ghost' : 'default'} disabled={busy === s.name}
                  onClick={() => (s.ok ? actions.disconnect(s.name).then(load) : connect(s))}>
                  {busy === s.name ? <Loader2 size={13} className="animate-spin" /> : null}
                  {s.ok ? 'Disconnect' : 'Connect'}
                </Button>
              )}
            </div>
          ))}
          {connectError && (
            <p className="text-sm text-warn pt-2">{connectError.text}</p>
          )}
          {sources.some(s => !s.ok && CLI_FALLBACK[s.name]) && (
            <details className="pt-2">
              <summary className="cursor-pointer list-none text-sm text-fg-mute hover:text-fg-dim transition-colors duration-100">
                Connect one from a terminal
              </summary>
              <pre className="mt-2 p-2 rounded-control bg-ink-850 border border-edge text-xs
                              font-mono text-fg-dim overflow-x-auto">
                {sources.filter(s => !s.ok && CLI_FALLBACK[s.name]).map(s => CLI_FALLBACK[s.name]).join('\n\n')}
              </pre>
            </details>
          )}
        </Section>

        </div>
        <div className="grid gap-4 content-start">

        <Section title="Mail">
          <div className="flex items-center gap-3 h-11">
            <span className="text-base font-mono truncate grow">{mailAccount?.address ?? '—'}</span>
            <span className={`text-sm shrink-0 ${over?.mail.connected ? 'text-ok' : 'text-fg-mute'}`}>
              {over
                ? over.mail.connected
                  ? `connected · ${over.mail.canSend ? 'can send' : 'read only'}`
                  : 'not connected'
                : '—'}
            </span>
            {over && !over.mail.connected && gmail?.oauthable && (
              <Button size="sm" variant="default" disabled={busy === 'gmail'} onClick={() => connect(gmail)}>
                Connect
              </Button>
            )}
          </div>
        </Section>

        <Section title="Notifications">
          <Row label="Push" value={pushOn ? `on · ${devices} device${devices === 1 ? '' : 's'}` : 'off'}
            tone={pushOn ? 'ok' : undefined} />
          <div className="flex items-center gap-2 h-11">
            <Button size="md" variant={pushOn ? 'default' : 'primary'} onClick={togglePush} disabled={!pushSupported()}>
              {pushOn ? 'Turn off' : 'Turn on'}
            </Button>
            {pushOn && (
              <Button size="md" variant="default" onClick={async () => {
                const r = await actions.pushTest()
                setDevices(r.devices)
                setMsg(r.devices ? `Sent to ${r.devices} device${r.devices > 1 ? 's' : ''}` : 'No devices registered')
              }}>
                Send a test
              </Button>
            )}
            {msg && <span className="text-sm text-fg-dim truncate">{msg}</span>}
          </div>
          {!pushSupported() && <p className="text-sm text-fg-mute">This browser has no Web Push</p>}
          {needsHomeScreenInstall() && (
            <p className="text-sm text-fg-mute">
              iPhone delivers push only to an installed app — add Wake to the Home Screen first
            </p>
          )}
        </Section>

        <Section title="Open in Claude">
          <Row label="Target" value={over?.handoff.url ?? '—'} mono />
          <Row label="Brief limit" value={over ? `${over.handoff.maxChars.toLocaleString()} characters` : '—'} />
          <Row label="Templates" value={over ? String(over.handoff.templates) : '—'} />
          <Row label="Sessions seen" value={over ? `${over.handoff.recentSessions} · last 30 days` : '—'} />
        </Section>

        </div>
        <div className="grid gap-4 content-start">

        <Section title="Skills and workspace">
          <Row
            label="Skills"
            value={over
              ? `${over.skills.total} (${Object.entries(over.skills.byCatalog).map(([k, v]) => `${k} ${v}`).join(' · ')})`
              : '—'}
          />
          <Row label="Workspace" value={over ? `${over.workspace.repos} repos · ${over.workspace.root}` : '—'} mono />
          {/*
            A row, not a section — and it must be true. This read "no Truto CLI
            profiles on this machine" about a machine with nine of them, because
            every CLI invocation threw on its audit write and `settings.ts`
            swallowed the throw with `.catch(() => [])`.
          */}
          <Row
            label="Truto CLI"
            value={truto
              ? truto.profiles.length
                ? `${truto.profiles.length} profile${truto.profiles.length === 1 ? '' : 's'}${truto.active?.team ? ` · ${truto.active.team}` : ''}`
                : (truto.error ?? 'none on this machine')
              : '—'}
            tone={truto && !truto.profiles.length ? 'warn' : undefined}
          />
          {!!truto?.profiles.length && (
            <details>
              <summary className="cursor-pointer list-none text-sm text-fg-mute hover:text-fg-dim transition-colors duration-100">
                Which ones
              </summary>
              <p className="mt-1.5 text-sm text-fg-mute font-mono break-words">{truto.profiles.join(' · ')}</p>
            </details>
          )}
        </Section>

        <Section title="Voice">
          <Row label="Microphone" value={recordingSupported() ? 'available' : 'unavailable'}
            tone={recordingSupported() ? 'ok' : 'warn'} />
          <Row label="Dictation" value={dictationSupported() ? 'available' : 'unavailable'}
            tone={dictationSupported() ? 'ok' : undefined} />
          <Row label="Transcription" value={over?.voice.stt.available ? 'configured' : 'not configured'}
            tone={over?.voice.stt.available ? 'ok' : undefined} />
          <Row label="Stored" value={over ? `${over.voice.storage.count} notes · ${fmtBytes(over.voice.storage.bytes)}` : '—'} />
          {!!over?.voice.missing && (
            <Row label="Missing audio" value={String(over.voice.missing)} tone="warn" />
          )}
        </Section>

        <Section title="Appearance">
          <ThemeChoice />
        </Section>

        <Section title="Audit">
          <button
            onClick={() => setAudit(true)}
            className="w-full flex items-center gap-2 h-11 text-left text-base text-fg-dim
                       hover:text-fg transition-colors duration-100"
          >
            <Activity size={14} className="text-fg-mute" />
            Open the audit trail
            <ChevronRight size={14} className="ml-auto text-fg-mute" />
          </button>
        </Section>
        </div>
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

/**
 * Three states, not two.
 *
 * `connected` and `the last poll failed` are different problems with different
 * fixes, and a source that has never been connected at all must never render an
 * age — `/api/connections` hands every source the same `lastSync.at`, including
 * the ones with nothing to poll, so the age without `connected` beside it says
 * "synced 1m ago" about a source nobody ever connected.
 */
function stateWord(s: SourceStatus): string {
  if (!s.ok) return 'not connected'
  if (s.lastSync && !s.lastSync.connected) return 'not connected'
  if (s.lastSync && !s.lastSync.ok) return `sync failed ${ago(s.lastSync.at)}`
  if (s.lastSync) return `synced ${ago(s.lastSync.at)}`
  return 'connected'
}

function stateTone(s: SourceStatus): string {
  if (!s.ok || (s.lastSync && !s.lastSync.connected)) return 'text-fg-mute'
  if (s.lastSync && !s.lastSync.ok) return 'text-warn'
  return 'text-ok'
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-panel bg-ink-850 border border-edge p-4">
      <h2 className="text-eyebrow uppercase text-fg-mute mb-2">{title}</h2>
      {children}
    </section>
  )
}

function Row({
  label, value, tone, mono,
}: { label: string; value: string; tone?: 'ok' | 'bad' | 'warn'; mono?: boolean }) {
  const colour = tone === 'ok' ? 'text-ok' : tone === 'bad' ? 'text-bad' : tone === 'warn' ? 'text-warn' : 'text-fg-dim'
  return (
    <div className="flex items-center gap-3 h-11 border-b border-rule last:border-0">
      <span className="text-sm text-fg-mute w-28 shrink-0">{label}</span>
      <span className={`text-base truncate ${colour} ${mono ? 'font-mono text-sm' : ''}`} title={value}>
        {value}
      </span>
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
    <Sheet open={open} onClose={onClose} title="Audit" wide>
      {!data ? (
        <p className="text-sm text-fg-mute py-6">Reading…</p>
      ) : (
        <div className="space-y-6">
          <AuditGroup title="Outbound and hand-offs" rows={data.events} render={(e: any) => (
            <>
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${e.ok ? 'bg-ok' : 'bg-bad'}`} />
              <span className="font-mono text-xs text-fg-dim shrink-0 w-40 truncate">{e.kind}</span>
              <span className="text-sm text-fg-mute truncate">{e.target ?? e.error ?? ''}</span>
              <span className="ml-auto tnum text-xs text-fg-mute shrink-0">{ago(e.at)}</span>
            </>
          )} />
          <AuditGroup title="Truto CLI" rows={data.commands} render={(r: any) => (
            <>
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${r.ok ? 'bg-ok' : 'bg-bad'}`} />
              <span className="font-mono text-xs text-fg-dim truncate">truto {r.argv.slice(0, 4).join(' ')}</span>
              <span className="ml-auto tnum text-xs text-fg-mute shrink-0">{ago(r.at)}</span>
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
      <div className="text-eyebrow uppercase text-fg-mute mb-1">{title}</div>
      {rows.slice(0, 40).map((r, i) => (
        <div key={r.id ?? i} className="flex items-center gap-2 h-8 border-b border-rule last:border-0">{render(r)}</div>
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
        <Button size="lg" variant="primary" className="w-full" disabled={!id.trim()}
          onClick={async () => { await actions.setClient(source.name, { client_id: id.trim(), client_secret: secret.trim() || undefined }); onSaved() }}>
          Save and continue
        </Button>
      }>
      <Field label="Redirect URL — add this to the app">
        <button
          onClick={() => { void navigator.clipboard?.writeText(redirectUri); setCopied(true) }}
          className="w-full flex items-center gap-2 bg-ink-850 border border-edge rounded-control
                     px-3 h-8 text-left hover:bg-ink-800 transition-colors duration-100"
        >
          <code className="text-xs font-mono text-fg-dim truncate grow">{redirectUri}</code>
          {copied ? <Check size={13} className="text-ok shrink-0" /> : <Link2 size={13} className="text-fg-mute shrink-0" />}
        </button>
      </Field>

      <Field label="Client ID">
        <input className={inputClass} value={id} onChange={e => setId(e.target.value)} autoFocus
          placeholder="1234567890.1234567890" />
      </Field>
      <Field label="Client secret">
        <input className={inputClass} type="password" value={secret}
          onChange={e => setSecret(e.target.value)} placeholder="••••••••" />
      </Field>
    </Sheet>
  )
}

/**
 * Three states, not a switch. "System" is a real choice — a phone that goes dark
 * at sunset should take the app with it — so it carries what it resolved to.
 */
function ThemeChoice() {
  const { theme, resolved, set } = useTheme()
  const options: Array<{ id: Theme; label: string }> = [
    { id: 'system', label: theme === 'system' ? `System · ${resolved}` : 'System' },
    { id: 'light', label: 'Light' },
    { id: 'dark', label: 'Dark' },
  ]
  return (
    <div className="h-11 flex items-center gap-2">
      <Segmented options={options} value={theme} onChange={set} ariaLabel="Theme" />
      {theme === 'light' ? <Sun size={14} className="text-fg-mute" />
        : theme === 'dark' ? <Moon size={14} className="text-fg-mute" />
        : <Monitor size={14} className="text-fg-mute" />}
    </div>
  )
}
