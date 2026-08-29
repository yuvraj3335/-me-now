import { useEffect, useState } from 'react'
import { Bell, BellRing, Check, Link2, Loader2, Smartphone, X } from 'lucide-react'
import { actions } from '../lib/api'
import type { SourceStatus } from '../lib/types'
import {
  currentSubscription, disablePush, enablePush, needsHomeScreenInstall, pushSupported,
} from '../lib/push'
import { Button, Field, Sheet, inputClass } from '../components/primitives'
import { SOURCE_LABEL, SourceDot } from '../components/sources'

export function Settings() {
  const [sources, setSources] = useState<SourceStatus[]>([])
  const [redirectUri, setRedirectUri] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [clientFor, setClientFor] = useState<SourceStatus | null>(null)
  const [pushOn, setPushOn] = useState(false)
  const [pushMsg, setPushMsg] = useState<string | null>(null)

  const load = () =>
    actions.connections().then(d => { setSources(d.sources); setRedirectUri(d.redirectUri) }).catch(() => {})

  useEffect(() => {
    void load()
    void currentSubscription().then(s => setPushOn(!!s))
  }, [])

  async function connect(s: SourceStatus) {
    setBusy(s.name)
    try {
      const r = await actions.connectStart(s.name)
      if (r.url) {
        // A popup keeps Wake's state alive behind the consent screen.
        window.open(r.url, '_blank', 'width=620,height=760')
        setTimeout(load, 4000)
      } else if (r.error === 'needs_client_id') {
        setClientFor(s)
      } else {
        setPushMsg(r.detail ?? r.error ?? 'Could not start authorization')
      }
    } catch (e) {
      setPushMsg((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  async function togglePush() {
    setPushMsg(null)
    if (pushOn) {
      await disablePush()
      setPushOn(false)
      return
    }
    const r = await enablePush()
    setPushOn(r.ok)
    if (!r.ok) setPushMsg(r.reason ?? 'Could not enable notifications')
  }

  return (
    <div className="pb-24">
      <header className="pt-8 pb-6">
        <h1 className="text-[26px] sm:text-[30px] font-medium tracking-[-0.025em] leading-none">Settings</h1>
        <p className="mt-2 text-[13px] text-fg-mute">Connections and notifications</p>
      </header>

      <section className="mt-4">
        <h2 className="text-[11.5px] uppercase tracking-[0.08em] text-fg-mute mb-1">Sources</h2>
        <p className="text-[12.5px] text-fg-mute mb-4 leading-relaxed">
          Wake reads these and never writes to them.
        </p>

        <div>
          {sources.map(s => (
            <div key={s.name} className="flex items-start gap-3 py-4 hairline last:border-0">
              <div className="pt-1.5"><SourceDot source={s.name} size={7} /></div>
              <div className="grow min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-[14.5px]">{SOURCE_LABEL[s.name]}</span>
                  {s.ok
                    ? <Check size={13} className="text-ok shrink-0" />
                    : <X size={13} className="text-fg-mute shrink-0" />}
                </div>
                <p className="text-[12.5px] text-fg-mute mt-1 leading-snug">{s.detail}</p>
                {s.via && (
                  <p className="text-[11.5px] text-fg-mute/70 mt-1">
                    via {s.via === 'claude-bridge' ? 'Claude Code’s token' : s.via}
                  </p>
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
        </div>
      </section>

      <section className="mt-10">
        <h2 className="text-[11.5px] uppercase tracking-[0.08em] text-fg-mute mb-4">Notifications</h2>

        {needsHomeScreenInstall() && (
          <div className="flex gap-3 mb-4 text-[13px] text-fg-dim leading-relaxed">
            <Smartphone size={15} className="shrink-0 mt-0.5 text-accent" />
            <p>
              On iPhone, open the share sheet and choose <strong className="font-medium">Add to Home
              Screen</strong> first. Apple only delivers push to an installed app, never to a Safari tab.
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
              setPushMsg(r.devices ? `Sent to ${r.devices} device${r.devices > 1 ? 's' : ''}.` : 'No devices registered.')
            }}>
              Send a test
            </Button>
          )}
        </div>

        {pushMsg && <p className="text-[12.5px] text-fg-dim mt-2 leading-snug">{pushMsg}</p>}
        {!pushSupported() && (
          <p className="text-[12.5px] text-fg-mute mt-2">This browser doesn’t support Web Push.</p>
        )}
      </section>

      <ClientSheet
        source={clientFor}
        redirectUri={redirectUri}
        onClose={() => setClientFor(null)}
        onSaved={async () => { setClientFor(null); await load() }}
      />
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
