/**
 * Secret redaction.
 *
 * Applied to everything that leaves a subprocess and everything written to the
 * audit log. The threat is mundane rather than exotic: a verbose HTTP dump
 * includes the Authorization header, and once it is in a turn's event log it is
 * in the model's context, the SQLite file, and the UI.
 *
 * Redaction is lossy on purpose — a masked value keeps its shape (prefix and
 * length) so a human can tell two different tokens apart without either being
 * recoverable.
 */

const PATTERNS: Array<{ re: RegExp; label: string }> = [
  // Authorization: Bearer <token>  /  "Authorization": "Bearer <token>"
  { re: /(\b(?:authorization|proxy-authorization)"?\s*[:=]\s*"?)(bearer\s+)?([A-Za-z0-9._~+/=-]{12,})/gi, label: 'auth' },
  // Any JSON field whose *name* says secret, regardless of the value's shape.
  {
    re: /("?(?:[a-z_]*(?:secret|password|passwd|api[_-]?key|access[_-]?token|refresh[_-]?token|private[_-]?key|client[_-]?secret|token)[a-z_]*)"?\s*[:=]\s*"?)([^"'\s,}\]]{6,})/gi,
    label: 'field',
  },
  // Bare credentials that are recognisable on their own.
  { re: /\bsk-[A-Za-z0-9_-]{16,}/g, label: 'anthropic' },
  { re: /\bxox[abposr]-[A-Za-z0-9-]{8,}/g, label: 'slack' },
  { re: /\bgh[pousr]_[A-Za-z0-9]{16,}/g, label: 'github' },
  { re: /\bAKIA[0-9A-Z]{16}\b/g, label: 'aws' },
  // JWTs: three base64url segments. Distinctive enough not to false-positive.
  { re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, label: 'jwt' },
]

/** `abcdef…` → `abcd…[24 chars]`, so two tokens stay distinguishable. */
function mask(v: string): string {
  const clean = v.trim()
  if (clean.length <= 8) return '[redacted]'
  return `${clean.slice(0, 4)}…[redacted ${clean.length} chars]`
}

export function redact(input: string): string {
  if (!input) return input
  let out = input
  for (const { re } of PATTERNS) {
    out = out.replace(re, (full, ...rest) => {
      const groups = rest.slice(0, -2) as Array<string | undefined>
      // Multi-group patterns keep their prefix ("Authorization: Bearer ") so the
      // reader can still see WHICH header was present.
      const secret = groups[groups.length - 1]
      if (groups.length >= 2 && secret) {
        const prefix = groups.slice(0, -1).filter(Boolean).join('')
        return `${prefix}${mask(secret)}`
      }
      return mask(full)
    })
  }
  return out
}

/** Recursively redact a parsed structure, keys included. */
export function redactJson<T>(value: T, depth = 0): T {
  if (depth > 12 || value === null || value === undefined) return value
  if (typeof value === 'string') return redact(value) as unknown as T
  if (Array.isArray(value)) return value.map(v => redactJson(v, depth + 1)) as unknown as T
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY.test(k) && typeof v === 'string' ? mask(v) : redactJson(v, depth + 1)
    }
    return out as unknown as T
  }
  return value
}

const SECRET_KEY = /secret|password|passwd|token|api[_-]?key|private[_-]?key|credential/i

/**
 * Environment variables a subprocess should never inherit. Wake's own OAuth
 * tokens and push keys have nothing to do with the Truto CLI or Claude Code,
 * and passing them down is how a credential ends up somewhere it was never
 * meant to go.
 *
 * ANTHROPIC_API_KEY is on the list for a second reason: Claude Code prefers an
 * API key over its own login when one is present, so leaving it in the child's
 * environment would silently move every launched session off the machine's
 * account and onto Wake's key.
 */
const STRIP_ENV =
  /^(WAKE_(SLACK|SENTRY|GMAIL)_TOKEN|WAKE_VAPID|WAKE_PLATFORM_MCP_TOKEN|VAPID_|WAKE_STT_KEY|WAKE_ANTHROPIC_API_KEY|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN)/i

export function childEnv(extra: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || STRIP_ENV.test(k)) continue
    out[k] = v
  }
  return { ...out, ...extra }
}
