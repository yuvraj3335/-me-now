/**
 * The half of the security story Cloudflare Access does not cover.
 *
 * Access proves *who* is asking. It says nothing about *which page* asked, and
 * its cookie rides along on a cross-site form post from any tab the same
 * browser has open — so a state-changing request needs an origin check of its
 * own. That is one of the two things in this file.
 *
 * The other is confirmation tokens. "The user clicked Allow" is only meaningful
 * if the thing they allowed is the thing that then happens, so a token is bound
 * to a fingerprint of the exact arguments. Change the body of an email after
 * approving it and the fingerprint no longer matches: the old Allow is dead and
 * a new one has to be granted against the new text.
 */

import type { Context, Next } from 'hono'
import { db, now, uid } from './db'
import { ALLOWED_ORIGINS, CONFIRM_TTL_MS } from './env'

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/**
 * Paths exempt from the origin check, and why each one has to be.
 *
 * `/api/connections/callback` is a GET the identity provider redirects to, so it
 * has no same-origin referrer by construction — and it is a GET, so it is not
 * covered here anyway. Nothing else is exempt: the MCP surface is gone, and
 * push subscription happens from the app itself.
 */
const EXEMPT = [/^\/api\/connections\/callback/]

export function originGuard() {
  return async (c: Context, next: Next) => {
    if (!MUTATING.has(c.req.method)) return next()
    if (EXEMPT.some(re => re.test(c.req.path))) return next()

    const origin = c.req.header('origin')
    const site = c.req.header('sec-fetch-site')

    // Browsers that send Sec-Fetch-Site give the cleanest answer available:
    // same-origin means the request came from Wake's own page.
    if (site && site !== 'same-origin' && site !== 'none') {
      return c.json({ error: `cross-site request refused (Sec-Fetch-Site: ${site})` }, 403)
    }

    if (origin) {
      if (!ALLOWED_ORIGINS.includes(origin)) {
        return c.json({ error: `origin ${origin} is not allowed to change state here` }, 403)
      }
      return next()
    }

    // No Origin and no Sec-Fetch-Site: not a browser fetch. curl on the box and
    // the test suite land here, and both are already behind Access or in-process.
    // A cross-site *form* post always carries an Origin, so this is not the hole
    // it looks like — but it is the one assumption worth writing down.
    return next()
  }
}

/* ------------------------------ confirmations ----------------------------- */

export type ConfirmKind = 'mail.send' | 'slack.post' | 'launch' | 'truto.apply'

/** Stable hash of the exact arguments an approval was granted for. */
export function fingerprint(value: unknown): string {
  return new Bun.CryptoHasher('sha256')
    .update(JSON.stringify(value ?? null))
    .digest('hex')
}

export function issueConfirmation(kind: ConfirmKind, payload: unknown, summary?: string): {
  token: string
  expiresAt: number
  fingerprint: string
} {
  const token = uid()
  const fp = fingerprint(payload)
  const at = now()
  const expiresAt = at + CONFIRM_TTL_MS
  db.query(
    `INSERT INTO confirmations (id, kind, fingerprint, summary, state, created_at, expires_at)
     VALUES (?,?,?,?, 'issued', ?, ?)`,
  ).run(token, kind, fp, summary ?? null, at, expiresAt)
  return { token, expiresAt, fingerprint: fp }
}

export type ConfirmCheck = { ok: true } | { ok: false; reason: string }

/**
 * Spend a token. Single-use and argument-bound, checked in one place so no
 * caller can accidentally implement four fifths of it.
 */
export function useConfirmation(token: string, kind: ConfirmKind, payload: unknown): ConfirmCheck {
  const row = db
    .query<Record<string, any>, [string]>(`SELECT * FROM confirmations WHERE id = ?`)
    .get(token ?? '')
  if (!row) return { ok: false, reason: 'that confirmation is not recognised — approve the action again' }
  if (row.kind !== kind) return { ok: false, reason: 'that confirmation was granted for a different action' }
  if (row.state === 'used') return { ok: false, reason: 'that confirmation was already used' }
  if (row.expires_at < now()) {
    db.query(`UPDATE confirmations SET state = 'expired' WHERE id = ?`).run(token)
    return { ok: false, reason: 'that confirmation expired — approve it again' }
  }
  if (row.fingerprint !== fingerprint(payload)) {
    return {
      ok: false,
      reason: 'the content changed after it was approved, so the approval no longer describes it — review and approve again',
    }
  }
  db.query(`UPDATE confirmations SET state = 'used', used_at = ? WHERE id = ?`).run(now(), token)
  return { ok: true }
}

/** Housekeeping: expired tokens are noise, and a stale row is a confusing read. */
export function sweepConfirmations(): number {
  const r = db
    .query(`DELETE FROM confirmations WHERE expires_at < ? AND state != 'used'`)
    .run(now() - 24 * 3.6e6)
  return Number((r as { changes?: number }).changes ?? 0)
}
