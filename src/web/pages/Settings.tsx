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
import {
  Button, Field, PageTitle, Pager, Segmented, Sheet, inputClass, pageCount, pageSlice,
} from '../components/primitives'
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
  /**
   * Why the Sources list is empty, when it is.
   *
   * `.catch(() => {})` left `sources` at `[]`, and an empty Sources section
   * reads as "nothing is configured" — a healthy-looking answer produced by a
   * request that failed. This page's whole job is telling him which connections
   * are alive, so it is the last place that may answer a failure with silence.
   */
  const [sourcesError, setSourcesError] = useState<string | null>(null)
  const [audit, setAudit] = useState(false)

  const load = async () => {
    await Promise.all([
      actions.connections()
        .then(d => { setSources(d.sources); setRedirectUri(d.redirectUri); setSourcesError(null) })
        .catch(e => setSourcesError((e as Error).message || 'could not read the connection status')),
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
    // A test that woke nothing has to say so. This read `t.devices` and nothing
    // else, so a round trip that reached zero devices set the count to 0 and
    // left the row looking enabled — which is how "notifications do not fire"
    // stayed unexplained while every part of the machinery was healthy.
    if (!t.sent) setPushWord(t.reason ?? 'nothing was woken')
  }

  return (
    <div className="pb-24">
      <header className="pt-4 pb-2 flex items-center gap-3">
        <PageTitle>Settings</PageTitle>
      </header>

      <Section title="You">
        <Row label="Email" value={over?.identity.emails[0] ?? '—'} mono />
        <Row label="GitHub" value={over?.identity.github ?? '—'} mono />
      </Section>

      {/*
        The number in this section is `sync_runs.count` — the rows the source's
        last poll returned, before dedup and before anything reached the desk.
        Three pages print a number per source and none of them said which
        number: Settings `Slack 56 · GitHub 4 · Gmail 30 · Sentry 17 · Claude
        Code 21`, Pulse `37 · 4 · 29 · 12 · 17`, the desk's tabs `14 · 5 · 29 ·
        35 · 18`. They are three different true measures and they read as one
        measure disagreeing three ways.

        The noun is said here rather than on each row because the row has no
        room for it: `synced 1m · 30 fetched · auth 22m` needs 205px of a
        159px column at 375, and the fact it would push out is the auth age,
        which is the one thing `synced` cannot tell you.
      */}
      <Section title="Sources" note="the number is what the last sync fetched">
        {sourcesError && !sources.length && (
          <Row label="Sources" value={sourcesError} tone="warn" />
        )}
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
        {/* `0 notes · 0 B` is the same nothing said twice — Work's recorder
            already drops the size under an empty list, and this row is the same
            fact about the same store. */}
        <Row
          label="Voice"
          value={over
            ? [
              recordingSupported() ? 'microphone available' : 'no microphone',
              `${over.voice.storage.count} note${over.voice.storage.count === 1 ? '' : 's'}`,
              ...(over.voice.storage.count ? [fmtBytes(over.voice.storage.bytes)] : []),
            ].join(' · ')
            : '—'}
        />
      </Section>

      {/* An `AUDIT` eyebrow over a single row reading `Audit trail` is one word
          printed twice, eleven pixels apart. A section heading earns its line by
          grouping rows; this is one row, and it says what it opens. */}
      <section className="mt-6">
        <button
          onClick={() => setAudit(true)}
          className="w-full flex items-center h-11 border-b border-rule text-left text-base text-fg-dim
                     hover:text-fg transition-colors duration-100"
        >
          <span className="grow">Audit trail</span>
          <ChevronRight size={14} className="text-fg-mute" />
        </button>
      </section>

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
 * An eyebrow and rows. There is no wrapper, because there is no card.
 *
 * `note` is a caption on the heading's own line, not a paragraph under it: it
 * names the unit the rows below are counted in, which is a fact about the whole
 * section and would be a lie repeated N times if it rode each row. It drops the
 * eyebrow's uppercase and letter-spacing, because it is a sentence and those
 * are for a label.
 */
function Section({
  title, note, children,
}: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section className="mt-6 first:mt-0">
      <h2 className="text-eyebrow uppercase text-fg-mute mb-2">
        {title}
        {note && <span className="normal-case tracking-normal"> — {note}</span>}
      </h2>
      {children}
    </section>
  )
}

/**
 * One 44px row: label at the page's x, value at x + 92, action right-aligned.
 *
 * `Row` used a 112px label column while the Sources rows used 96 and the Mail
 * row had none at all, which is how one page came to have three label x and
 * three value x — two of them two pixels apart.
 *
 * 92 rather than 96, and the action's left pad 8 rather than 12 — four pixels
 * each, and the eight together are the difference between Gmail's status being
 * readable on a phone and not. Measured at 375: `synced 1m · 30 ·
 * auth 22m` wants 156px, the value column was 151, and the row shipped reading
 * `…auth 2…` — the auth age is last on the line and it is the one fact
 * `synced` cannot carry, so it was the fact being lost. The column is 159 now.
 *
 * Nothing else in the row had eight pixels to give. 343px of phone holds an
 * 84px `Disconnect` that cannot shrink, and `Claude Code` — the widest label on
 * the page at 76px — needs the column it is in. The air between the end of that
 * label and the start of the value is bought back from the source dot beside
 * it, 5px rather than 6, and the gap after it, 6 rather than 8: measured, it is
 * 5px where it was 6. A straight `w-24 → w-23` would have left 1px, and two
 * words in two columns separated by less than a space read as one word.
 *
 * 159 is the ceiling and it is not enough for everything: `synced 59m · 128 ·
 * auth 59m` is 172px and still truncates on a phone. Past this, the row has to
 * say less rather than be given more.
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
      <span className="text-sm text-fg-mute w-23 shrink-0">{label}</span>
      <span className={`text-sm truncate min-w-0 grow ${colour} ${mono ? 'font-mono' : ''}`}
        title={title ?? value}>
        {value}
      </span>
      {action && <span className="shrink-0 pl-2">{action}</span>}
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
  const detail = word.detail ?? (s.detail && !s.ok
    ? s.detail
        .replace(/https?:\/\/\S+/g, '')
        .replace(/\s*[:.]\s*(?=[.:]|$)/g, '')
        .replace(/\s{2,}/g, ' ')
        .replace(/^[\s:.]+|[\s:.]+$/g, '')
        .trim()
    : null)

  return (
    <>
      <div className="flex items-center h-11 border-b border-rule min-w-0">
        {/* 5px and `gap-1.5`, against the page's usual 6 and 8: this is the
            only label column with a mark in front of it, and those three pixels
            are what keep `Claude Code` from touching the value beside it in a
            column that has been narrowed to fit the value. */}
        <span className="w-23 shrink-0 flex items-center gap-1.5 min-w-0">
          <SourceDot source={s.name} size={5} />
          <span className="text-sm truncate">{SOURCE_LABEL[s.name]}</span>
        </span>
        <span className={`text-sm truncate min-w-0 grow ${word.tone}`} title={s.detail || word.text}>
          {word.text}
          {detail && <span className="text-fg-mute"> · {detail}</span>}
        </span>
        {link && (
          <a href={link} target="_blank" rel="noreferrer"
            className="shrink-0 pl-2 inline-flex items-center gap-1 text-sm text-fg-mute
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
        {s.oauthable && s.connectable ? (
          <span className="shrink-0 pl-2">
            <Button size="sm" variant="ghost" disabled={busy}
              onClick={() => (s.hasWakeToken && s.ok ? onDisconnect() : onConnect())}>
              {busy ? <Loader2 size={13} className="animate-spin" /> : null}
              {/* A refused grant has already had its tokens cleared, so there is
                  nothing left to disconnect — the honest offer is Connect.

                  `lastAuthError` is deliberately *not* consulted here any more.
                  A terminal refusal nulls the tokens, so it arrives at the
                  `Connect` branch above on `hasWakeToken` alone; the only way to
                  reach this line holding a token is a **transient** failure —
                  a 5xx, a DNS blip, a rate limit — which `creds.ts` records
                  without touching the grant. Reading that as terminal put a
                  working source on `Reconnect` permanently, because nothing
                  clears the field until some later refresh succeeds and no
                  refresh runs at all while the access token is still valid.
                  What the source can do right now is `ok`, and that is what
                  this asks. */}
              {!s.hasWakeToken ? 'Connect' : s.ok ? 'Disconnect' : 'Reconnect'}
            </Button>
          </span>
        ) : (
          /*
            The two sources that are not grants say so, rather than ending in
            whitespace.

            Slack, Gmail and Sentry end in `Disconnect`; GitHub and Claude Code
            ended in nothing at all, three rows apart in the same column, and the
            reason — that there is no token of Wake's to revoke, because GitHub
            comes from the `gh` login on this box and Claude Code from
            transcripts on its disk — was true, sound, and nowhere on the page.
            A reader with an empty cell has to guess between "not applicable"
            and "broken", and one of those guesses sends them looking for a
            button that should not exist.

            Muted text at the weight of the ghost buttons above it, so the
            column reads as one column, and deliberately not a control: there is
            nothing here to press.
          */
          <span className="shrink-0 pl-2 text-sm text-fg-mute"
            title="Not an OAuth grant — Wake reads this from your own machine, so there is nothing to disconnect">
            this machine
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
 * Five states, and each one has an owner.
 *
 * `reconnect — <reason>` comes first because it is the only one that names
 * something he can do. A grant the provider has refused is not a failed sync:
 * the poll failed *because* of it, and "sync failed · 401 from
 * https://mcp.slack.com/mcp" blames the sync for a problem in the credential and
 * offers nothing. The reason is the provider's own word — `invalid_grant`,
 * `token_revoked` — and it is worth printing verbatim, because it is the thing
 * you would search for.
 *
 * `not connected` means no credential from any link in the chain. `sync failed`
 * means a credential that was accepted and a poll that was not. `synced`
 * needs `ok`, `connected` and a count. The row used to answer `not connected`
 * for a Slack holding a real, accepted token — flatly wrong, and the opposite
 * of what the footer on the desk said about the same source in the same
 * second.
 *
 * `detail` is the slot beside the word. A working source spends it on when the
 * credential last actually authenticated, which is the fact `ok` cannot carry:
 * a source can poll perfectly at the same moment its refresh token is dead, and
 * will keep doing so until the access token expires.
 */
export function stateWord(s: SourceStatus): { text: string; tone: string; detail?: string } {
  /*
   * A recorded refusal only outranks everything else while the source is
   * actually refusing.
   *
   * `last_auth_error` holds two different kinds of thing. A terminal one — the
   * provider's own `invalid_grant` or `token_revoked` — comes with the tokens
   * cleared, so `ok` is false and this branch is the whole story. A transient
   * one — a 5xx, an HTML error page, a rate limit — is recorded with the grant
   * left intact, on purpose, and `refresh.test.ts` pins that. Nothing clears
   * the field except a later successful refresh, and no refresh runs while the
   * access token is still valid, so one bad minute at the provider used to
   * leave a perfectly healthy source reading `reconnect — 500 …` for the rest
   * of the token's life. `ok` is the live answer; a stale reason does not get
   * to overrule it.
   */
  if (s.lastAuthError && !s.ok) {
    return { text: `reconnect — ${s.lastAuthError}`, tone: 'text-warn' }
  }
  // A token Wake holds is connected. Live MCP failure is sync failed, never
  // "not connected" — that word is reserved for no credential at all.
  if (!s.hasWakeToken && !s.lastSync?.connected && !s.ok) {
    return { text: 'not connected', tone: 'text-fg-mute' }
  }
  // `auth 3m`, not `auth ok 3m`. The word `ok` costs 20px in the one column on
  // this page that has none — `synced now · 30 · auth ok 3m` needed 174px of a
  // 151px slot at 375, and the truncation ate the auth fact, which is the one
  // thing here `synced` cannot already tell you.
  //
  // The same 20px argument reaches the end of `synced` itself, and stops there.
  // `sync 1m · 30 · auth 22m` is 141px against this string's 156, which is the
  // difference between fitting a 59-minute-old poll of 128 rows on a phone and
  // not — but the word is asserted literally by `test/settings-state.test.ts`,
  // which is not a file this pass owns. The eight pixels came out of the row's
  // geometry instead; see `Row`.
  const authOk = s.lastAuthOkAt ? `auth ${ago(s.lastAuthOkAt)}` : undefined
  if ((s.lastSync && !s.lastSync.ok) || (s.hasWakeToken && !s.ok)) {
    return { text: 'sync failed', tone: 'text-warn' }
  }
  if (s.lastSync?.ok) {
    return {
      text: `synced ${ago(s.lastSync.at)}${s.lastSync.count === null ? '' : ` · ${s.lastSync.count}`}`,
      tone: 'text-ok',
      detail: authOk,
    }
  }
  return {
    text: s.ok ? 'connected' : 'not connected',
    tone: s.ok ? 'text-ok' : 'text-fg-mute',
    detail: s.ok ? authOk : undefined,
  }
}

function AuditSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [data, setData] = useState<any>(null)
  useEffect(() => {
    if (!open) return
    // Enough to page through. 80 was one and a half pages, so the pager it now
    // has would have had almost nothing to do.
    fetch('/api/settings/audit?limit=200').then(r => r.json()).then(setData).catch(() => {})
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

/**
 * One audit list, paged.
 *
 * It used to be `rows.slice(0, 40)`: the rest of the trail was fetched, held in
 * memory and silently dropped, which is the worst of the three options — the
 * reader cannot see it and cannot tell it is missing.
 *
 * `pageSlice` and `pageCount` rather than a local page size, so the range the
 * pager prints describes the rows underneath it.
 *
 * The page is local state rather than a URL parameter, unlike every table on a
 * real page. Two independent lists share this sheet and the sheet itself is not
 * in the URL, so one `?page=` would have to mean two things and would outlive
 * the overlay that gave it meaning.
 */
function AuditGroup({ title, rows, render }: { title: string; rows: any[]; render: (r: any) => React.ReactNode }) {
  const [page, setPage] = useState(1)
  if (!rows?.length) return null
  const pages = pageCount(rows.length)
  const at = Math.min(page, pages)
  return (
    <div>
      <div className="text-eyebrow uppercase text-fg-mute mb-2">{title}</div>
      {pageSlice(rows, at).map((r, i) => (
        <div key={r.id ?? i} className="flex items-center gap-2 h-11 border-b border-rule last:border-0">{render(r)}</div>
      ))}
      <Pager page={at} pages={pages} total={rows.length} onPage={setPage} />
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

      {/* No `autoFocus`, for the reason `TaskSheet`, `Home` and `Work` all give
          in their own words: below `sm` this is a bottom sheet, and focusing a
          field as it opens raises the keyboard into a panel that is still
          animating, so iOS scrolls the sheet to keep the caret visible and the
          first thing he sees is the middle of a form. The field is one tap
          away, and the tap is his. */}
      <Field label="Client ID">
        <input className={inputClass} value={id} onChange={e => setId(e.target.value)}
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
 *
 * *Only* what it resolved to. The value column used to read `System · light`
 * beside a segmented control whose pressed segment already said System, so the
 * one word in the row that the control cannot say was the one being pushed out:
 * 80px of text in 76px of column, ellipsised to `System · li…`. The resolution
 * is the whole reason this row has a value, and Light and Dark resolve to
 * themselves — they get no value at all rather than an echo of the button.
 *
 * That left `Theme  light  [System | Light | Dark]` with System pressed, which
 * is a row that contradicts itself read cold: the value says one word and the
 * control says another, and nothing on the line says the first is a
 * *consequence* of the second. `now` is the whole fix — one word that turns a
 * setting into an observation — and the sentence that spells it out appears
 * where there is room for it and not where there is not. Measured: the value
 * column is 67px at 375 and `light now` is 54 of it; the whole sentence is
 * 192px and the column that has to hold it is 316 at `sm`.
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
      <span className="text-sm text-fg-mute w-23 shrink-0">Theme</span>
      <span className="text-sm text-fg-dim grow truncate">
        {theme === 'system' && (
          <>
            <span className="hidden sm:inline">following your system · </span>
            {resolved} now
          </>
        )}
      </span>
      <Segmented options={options} value={theme} onChange={set} ariaLabel="Theme" />
    </div>
  )
}
