/**
 * Settings, as a list you scan.
 *
 * One column. No cards, no masonry, no `items-start` grid. Section titles are
 * eyebrows at the page title's own x; every row is 44px with a hairline under
 * it; there is one label x and one value x; and every action is ghost text of
 * the same weight, because Connect and Disconnect are the same decision.
 *
 * What this replaces, measured: nine `rounded-panel bg-ink-850 border border-edge
 * p-4` sections in a three-column grid whose columns ended at y598 / y573 / y733,
 * leaving 160px and 192px of ragged bottom and a 789×302 hole beside a full
 * column. In light mode those were nine pure-white cards on a grey page. The
 * card's own padding put every section title at x=241 against a page title at
 * x=224, and inside it there were five more left edges — 241, 245, 259, 365, 367
 * — of which two were two pixels apart, which is one column drawn twice.
 *
 * Deleted outright: the MAIL section, which repeated the Gmail row three rows
 * above it; the OPEN IN CLAUDE section, which exposed four constants nobody can
 * change; the terminal disclosure and its `CLI_FALLBACK` map, which offered a
 * shell command as the fix for a state it cannot fix and which the credential
 * chain would shadow anyway; the two push sentences; the `Which ones`
 * disclosure; the floating push-test sentence; and all nine `Section` wrappers.
 *
 * Three honesty rules the rows keep:
 *
 *   1. **`s.detail` renders regardless of `ok`.** It was gated on `s.ok &&`, so
 *      the diagnosis appeared only when there was nothing to diagnose. Slack's
 *      `detail` is the provider's own sentence naming the app and the URL that
 *      fixes it — fetched, held in state, and never painted.
 *   2. **Disconnect is only offered for a token that is actually working.**
 *      A held token whose poll failed is Reconnect (same client id, new
 *      grant). Disconnect deletes the `oauth_tokens` row, client id included.
 *   3. **A source that cannot be connected offers no Connect button.**
 *      Gmail now can — Google OIDC plus offline access.
 */

import { useEffect, useState } from 'react'
import { Check, ChevronRight, ExternalLink, Link2, Loader2 } from 'lucide-react'
import { actions } from '../lib/api'
import type { SourceStatus } from '../lib/types'
import {
  currentSubscription, disablePush, enablePush, needsHomeScreenInstall, pushSupported,
} from '../lib/push'
import { Button, Field, Segmented, Sheet, inputClass } from '../components/primitives'
import { SOURCE_LABEL, SourceDot } from '../components/sources'
import { fmtBytes, recordingSupported } from '../lib/voice'
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

export function Settings() {
  const [sources, setSources] = useState<SourceStatus[]>([])
  const [redirectUri, setRedirectUri] = useState('')
  const [over, setOver] = useState<Overview | null>(null)
  const [truto, setTruto] = useState<Truto | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [clientFor, setClientFor] = useState<SourceStatus | null>(null)
  const [pushOn, setPushOn] = useState(false)
  const [devices, setDevices] = useState(0)
  const [pushWord, setPushWord] = useState<string | null>(null)
  /**
   * A failure to start authorization belongs beside the source that failed, and
   * a terminal fallback may only appear under a row that has just failed to
   * connect — never as standing chrome.
   */
  const [connectError, setConnectError] = useState<{ name: string; text: string } | null>(null)
  const [audit, setAudit] = useState(false)

  const load = async () => {
    await Promise.all([
      actions.connections().then(d => { setSources(d.sources); setRedirectUri(d.redirectUri) }).catch(() => {}),
      fetch('/api/settings').then(r => r.json()).then(setOver).catch(() => {}),
      fetch('/api/settings/truto').then(r => r.json()).then(setTruto).catch(() => setTruto({ profiles: [], active: null, error: 'the CLI did not answer' })),
      actions.pushStatus().then(d => setDevices(d.devices.length)).catch(() => {}),
    ])
  }

  useEffect(() => {
    void load()
    void currentSubscription().then(s => setPushOn(!!s))
    const onVis = () => {
      if (document.visibilityState === 'visible') void load()
    }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [])

  async function connect(s: SourceStatus) {
    setBusy(s.name)
    setConnectError(null)
    try {
      const r = await actions.connectStart(s.name)
      if (r.url) {
        // A popup keeps Wake's state alive behind the consent screen.
        window.open(r.url, '_blank', 'width=620,height=760')
        // One 4s reload used to fire before Slack's Allow tab finished, so
        // the row still said the previous failure after a successful grant.
        for (const ms of [2_000, 6_000, 12_000, 20_000, 30_000]) setTimeout(load, ms)
      } else if (r.error === 'needs_client_id') {
        if (r.redirectUri) setRedirectUri(r.redirectUri)
        setClientFor(s)
      } else {
        setConnectError({ name: s.name, text: r.detail ?? r.error ?? 'could not start authorization' })
      }
    } catch (e) {
      setConnectError({ name: s.name, text: (e as Error).message })
    } finally {
      setBusy(null)
    }
  }

  async function togglePush() {
    setPushWord(null)
    if (pushOn) {
      await disablePush()
      setPushOn(false)
      await load()
      return
    }
    const r = await enablePush()
    setPushOn(r.ok)
    if (!r.ok) return setPushWord(r.reason ?? 'could not enable')
    // Confirming the round trip immediately is the difference between "the
    // toggle is on" and "this device will actually be woken".
    const t = await actions.pushTest()
    setDevices(t.devices)
  }

  return (
    <div className="pb-24">
      <header className="pt-4 pb-2">
        <h1 className="text-lg font-medium">Settings</h1>
      </header>

      <Section title="You">
        <Row label="Email" value={over?.identity.emails[0] ?? '—'} mono />
        <Row label="GitHub" value={over?.identity.github ?? '—'} mono />
      </Section>

      <Section title="Sources">
        {sources.map(s => (
          <SourceRow
            key={s.name} s={s} busy={busy === s.name}
            failure={connectError?.name === s.name ? connectError.text : null}
            onConnect={() => connect(s)}
            onDisconnect={() => void actions.disconnect(s.name).then(load)}
          />
        ))}
      </Section>

      <Section title="Notifications">
        {/* The row simply does not render where Web Push does not exist. It used
            to render, off, beside a sentence saying this browser has none. */}
        {pushSupported() && (
          <Row
            label="Push"
            value={needsHomeScreenInstall()
              ? 'add Wake to the Home Screen'
              : pushWord ?? (pushOn ? `on · ${devices} device${devices === 1 ? '' : 's'}` : 'off')}
            action={needsHomeScreenInstall() ? undefined : (
              <Button size="sm" variant="ghost" onClick={togglePush}>
                {pushOn ? 'Turn off' : 'Turn on'}
              </Button>
            )}
          />
        )}
      </Section>

      <Section title="Appearance">
        <ThemeChoice />
      </Section>

      <Section title="This machine">
        <Row label="Workspace"
          value={over ? `${over.workspace.repos} repos · ${over.workspace.root}` : '—'} mono />
        <Row label="Skills" value={over ? String(over.skills.total) : '—'}
          title={over ? Object.entries(over.skills.byCatalog).map(([k, v]) => `${k} ${v}`).join(' · ') : undefined} />
        {/*
          `—` while the answer is still coming is indistinguishable from `—`
          meaning none, and this row spent a release saying "no profiles on this
          machine" about a machine with 35 of them. It also latched on the
          loading string for ever when the request failed, because the catch
          swallowed it and left the value null.
        */}
        <Row
          label="Truto CLI"
          value={truto
            ? truto.profiles.length
              ? `${truto.profiles.length} profile${truto.profiles.length === 1 ? '' : 's'}${truto.active?.team ? ` · ${truto.active.team}` : ''}`
              : (truto.error ?? 'none')
            : '…'}
          title={truto?.profiles.join(' · ')}
        />
        <Row
          label="Voice"
          value={over
            ? `${recordingSupported() ? 'microphone available' : 'no microphone'} · ${over.voice.storage.count} note${over.voice.storage.count === 1 ? '' : 's'} · ${fmtBytes(over.voice.storage.bytes)}`
            : '—'}
        />
      </Section>

      <Section title="Audit">
        <button
          onClick={() => setAudit(true)}
          className="w-full flex items-center h-11 border-b border-rule text-left text-base text-fg-dim
                     hover:text-fg transition-colors duration-100"
        >
          <span className="grow">Audit trail</span>
          <ChevronRight size={14} className="text-fg-mute" />
        </button>
      </Section>

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

/** An eyebrow and rows. There is no wrapper, because there is no card. */
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-6 first:mt-0">
      <h2 className="text-eyebrow uppercase text-fg-mute mb-2">{title}</h2>
      {children}
    </section>
  )
}

/**
 * One 44px row: label at the page's x, value at x + 96, action right-aligned.
 *
 * `Row` used a 112px label column while the Sources rows used 96 and the Mail
 * row had none at all, which is how one page came to have three label x and
 * three value x — two of them two pixels apart.
 */
function Row({
  label, value, tone, mono, action, title,
}: {
  label: string; value: string
  tone?: 'ok' | 'bad' | 'warn'; mono?: boolean
  action?: React.ReactNode
  title?: string
}) {
  const colour = tone === 'ok' ? 'text-ok' : tone === 'bad' ? 'text-bad' : tone === 'warn' ? 'text-warn' : 'text-fg-dim'
  return (
    <div className="flex items-center h-11 border-b border-rule min-w-0">
      <span className="text-sm text-fg-mute w-24 shrink-0">{label}</span>
      <span className={`text-sm truncate min-w-0 grow ${colour} ${mono ? 'font-mono' : ''}`}
        title={title ?? value}>
        {value}
      </span>
      {action && <span className="shrink-0 pl-3">{action}</span>}
    </div>
  )
}

/**
 * A source, in one 44px line, whatever state it is in.
 *
 * It used to be a head row plus an optional second `<p>`, so five rows measured
 * 45 / 65 / 45 / 65 / 65 — a 20px alternation down a five-row list. The fact
 * that lived on the second line lives in the value column now, truncated with
 * the whole of it on `title`, which is where a long provider sentence belongs.
 */
function SourceRow({
  s, busy, failure, onConnect, onDisconnect,
}: {
  s: SourceStatus
  busy: boolean
  failure: string | null
  onConnect: () => void
  onDisconnect: () => void
}) {
  const word = stateWord(s)
  /**
   * Slack's live state, and the one place `warn` is spent in this product.
   *
   * The token is real and was accepted; the Slack *app* is not entitled for MCP.
   * That is neither "not connected" nor "sync failed", it is a fifth state whose
   * fix is a toggle in somebody else's console — and the provider wrote the
   * sentence and the URL for us. Wake fetched it and threw it away.
   */
  const links = s.detail?.match(/https?:\/\/\S+/g) ?? []
  // The LAST url, not the first: the provider's sentence names the endpoint that
  // refused before it names the console page that fixes it, and only the second
  // one is somewhere to go.
  const link = links.at(-1)
  const detail = s.detail && !s.ok
    ? s.detail
        .replace(/https?:\/\/\S+/g, '')
        .replace(/\s*[:.]\s*(?=[.:]|$)/g, '')
        .replace(/\s{2,}/g, ' ')
        .replace(/^[\s:.]+|[\s:.]+$/g, '')
        .trim()
    : null

  return (
    <>
      <div className="flex items-center h-11 border-b border-rule min-w-0">
        <span className="w-24 shrink-0 flex items-center gap-2 min-w-0">
          <SourceDot source={s.name} size={6} />
          <span className="text-sm truncate">{SOURCE_LABEL[s.name]}</span>
        </span>
        <span className={`text-sm truncate min-w-0 grow ${word.tone}`} title={s.detail || word.text}>
          {word.text}
          {detail && <span className="text-fg-mute"> · {detail}</span>}
        </span>
        {link && (
          <a href={link} target="_blank" rel="noreferrer"
            className="shrink-0 pl-3 inline-flex items-center gap-1 text-sm text-fg-mute
                       hover:text-fg-dim transition-colors duration-100"
            title={link}>
            fix <ExternalLink size={13} />
          </a>
        )}
        {/* Connect / Reconnect / Disconnect.
            A held token that cannot poll is not "Disconnect" — that wipes the
            client id they just pasted — it is Reconnect, which starts OAuth
            again against the same app. A source Wake cannot obtain a
            credential for offers nothing at all. */}
        {s.oauthable && s.connectable && (
          <span className="shrink-0 pl-3">
            <Button size="sm" variant="ghost" disabled={busy}
              onClick={() => (s.hasWakeToken && s.ok ? onDisconnect() : onConnect())}>
              {busy ? <Loader2 size={13} className="animate-spin" /> : null}
              {!s.hasWakeToken ? 'Connect' : s.ok ? 'Disconnect' : 'Reconnect'}
            </Button>
          </span>
        )}
      </div>
      {/* Only after a Connect on this row actually failed. */}
      {failure && (
        <p className="text-sm text-warn h-11 flex items-center">{failure}</p>
      )}
    </>
  )
}

/**
 * Four states, and each one has an owner.
 *
 * `not connected` means no credential from any link in the chain. `sync failed`
 * means a credential that was accepted and a poll that was not. `synced` needs
 * `ok`, `connected` and a count. The row used to answer `not connected` for a
 * Slack holding a real, accepted token — flatly wrong, and the opposite of what
 * the footer on Now said about the same source in the same second.
 */
export function stateWord(s: SourceStatus): { text: string; tone: string } {
  // A token Wake holds is connected. Live MCP failure is sync failed, never
  // "not connected" — that word is reserved for no credential at all.
  if (!s.hasWakeToken && !s.lastSync?.connected && !s.ok) {
    return { text: 'not connected', tone: 'text-fg-mute' }
  }
  if ((s.lastSync && !s.lastSync.ok) || (s.hasWakeToken && !s.ok)) {
    return { text: 'sync failed', tone: 'text-warn' }
  }
  if (s.lastSync?.ok) {
    return {
      text: `synced ${ago(s.lastSync.at)}${s.lastSync.count === null ? '' : ` · ${s.lastSync.count}`}`,
      tone: 'text-ok',
    }
  }
  return { text: s.ok ? 'connected' : 'not connected', tone: s.ok ? 'text-ok' : 'text-fg-mute' }
}

function AuditSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [data, setData] = useState<any>(null)
  useEffect(() => {
    if (!open) return
    fetch('/api/settings/audit?limit=80').then(r => r.json()).then(setData).catch(() => {})
  }, [open])

  return (
    <Sheet open={open} onClose={onClose} title="Audit" wide>
      {data && (
        <div className="space-y-6">
          <AuditGroup title="Outbound and hand-offs" rows={data.events} render={(e: any) => (
            <>
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${e.ok ? 'bg-ok' : 'bg-bad'}`} />
              <span className="font-mono text-sm text-fg-dim shrink-0 w-40 truncate">{e.kind}</span>
              <span className="text-sm text-fg-mute truncate">{e.target ?? e.error ?? ''}</span>
              <span className="ml-auto tnum text-sm text-fg-mute shrink-0">{ago(e.at)}</span>
            </>
          )} />
          <AuditGroup title="Truto CLI" rows={data.commands} render={(r: any) => (
            <>
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${r.ok ? 'bg-ok' : 'bg-bad'}`} />
              <span className="font-mono text-sm text-fg-dim truncate">truto {r.argv.slice(0, 4).join(' ')}</span>
              <span className="ml-auto tnum text-sm text-fg-mute shrink-0">{ago(r.at)}</span>
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
      <div className="text-eyebrow uppercase text-fg-mute mb-2">{title}</div>
      {rows.slice(0, 40).map((r, i) => (
        <div key={r.id ?? i} className="flex items-center gap-2 h-11 border-b border-rule last:border-0">{render(r)}</div>
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
          className="w-full flex items-center gap-2 h-11 text-left border-b border-rule
                     text-fg-mute hover:text-fg-dim transition-colors duration-100"
        >
          <code className="text-sm font-mono truncate grow">{redirectUri}</code>
          {copied ? <Check size={14} className="text-ok shrink-0" /> : <Link2 size={14} className="shrink-0" />}
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
    { id: 'system', label: 'System' },
    { id: 'light', label: 'Light' },
    { id: 'dark', label: 'Dark' },
  ]
  return (
    <div className="flex items-center h-11 border-b border-rule">
      <span className="text-sm text-fg-mute w-24 shrink-0">Theme</span>
      <span className="text-sm text-fg-dim grow truncate">
        {theme === 'system' ? `System · ${resolved}` : theme === 'light' ? 'Light' : 'Dark'}
      </span>
      <Segmented options={options} value={theme} onChange={set} ariaLabel="Theme" />
    </div>
  )
}
