/**
 * HTML mail, made safe to render.
 *
 * Email HTML is written by strangers and is the single most hostile input this
 * app handles. Wake takes an allowlist approach: parse nothing, trust nothing,
 * and emit only the tags and attributes on a short list. Everything else is
 * dropped, including the element's *content* for the tags whose content is
 * executable (`script`, `style`, `iframe`, `object`).
 *
 * Two decisions worth stating rather than burying:
 *
 *   - Remote images are neutralised by default. A tracking pixel tells a sender
 *     you opened their mail and where from, and "load images" is a choice the
 *     reader should make per message.
 *   - `text/plain` is preferred wherever a message has it. Sanitized HTML is a
 *     fallback for mail that only exists as HTML, not the default path.
 */

const ALLOWED_TAGS = new Set([
  'a', 'b', 'blockquote', 'br', 'code', 'div', 'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'hr', 'i', 'img', 'li', 'ol', 'p', 'pre', 'span', 'strong', 'sub', 'sup',
  'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'u', 'ul',
])

/** Tags whose *contents* must go with them, not just their markup. */
const DROP_WITH_CONTENT = /<(script|style|iframe|object|embed|noscript|template|svg|math)\b[\s\S]*?<\/\1\s*>/gi

const ALLOWED_ATTRS: Record<string, Set<string>> = {
  a: new Set(['href', 'title']),
  img: new Set(['alt', 'title', 'width', 'height', 'data-wake-src']),
  td: new Set(['colspan', 'rowspan']),
  th: new Set(['colspan', 'rowspan']),
}

const SAFE_URL = /^(https?:|mailto:|tel:)/i

export type Sanitized = { html: string; blockedImages: number }

export function sanitizeEmailHtml(input: string): Sanitized {
  if (!input) return { html: '', blockedImages: 0 }

  let blockedImages = 0
  let html = input
    // Comments can hide markup from a naive tag scanner; conditional comments
    // are how Outlook mail smuggles a second document past one.
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(DROP_WITH_CONTENT, '')
    // An unclosed <script> would survive the pair-matching pass above.
    .replace(/<\/?(script|style|iframe|object|embed|noscript|template|svg|math)\b[^>]*>/gi, '')

  html = html.replace(/<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^"'>])*)>/g, (_m, slash: string, rawName: string, rawAttrs: string) => {
    const name = rawName.toLowerCase()
    if (!ALLOWED_TAGS.has(name)) return ''
    if (slash) return `</${name}>`

    const attrs: string[] = []
    const allowed = ALLOWED_ATTRS[name]
    if (allowed) {
      for (const m of rawAttrs.matchAll(/([a-zA-Z][a-zA-Z0-9:_-]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
        const attr = m[1]!.toLowerCase()
        const value = (m[3] ?? m[4] ?? m[5] ?? '').trim()
        if (!allowed.has(attr)) continue
        if ((attr === 'href' || attr === 'src') && !SAFE_URL.test(value)) continue
        attrs.push(`${attr}="${escapeAttr(value)}"`)
      }
    }

    if (name === 'img') {
      // The original source is kept in a data attribute rather than thrown
      // away, so "load images" can be offered per message without refetching
      // the whole thread.
      const src = /\ssrc\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(rawAttrs)
      const url = (src?.[2] ?? src?.[3] ?? src?.[4] ?? '').trim()
      if (url && SAFE_URL.test(url)) {
        blockedImages++
        attrs.push(`data-wake-src="${escapeAttr(url)}"`)
      }
      return `<img ${attrs.join(' ')}>`
    }

    if (name === 'a') {
      attrs.push('target="_blank"', 'rel="noreferrer noopener nofollow"')
    }

    return attrs.length ? `<${name} ${attrs.join(' ')}>` : `<${name}>`
  })

  return { html: html.trim(), blockedImages }
}

const escapeAttr = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/* ------------------------------- plain text -------------------------------- */

/**
 * Mail text is escaped HTML even when it is sold as plain text.
 *
 * Gmail's own snippets come back escaped — `let&#39;s`, `Burns &amp; McDonnell`
 * — and Wake printed them verbatim into a row title, a card excerpt, a Now row
 * and a detail pane, because every one of those renders text rather than markup.
 * The decode belongs here, where the text is made, and not in four view
 * components that would each have to remember.
 */
const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  hellip: '…', mdash: '—', ndash: '–', laquo: '«', raquo: '»',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', sbquo: '‚', bdquo: '„',
  middot: '·', bull: '•', dagger: '†', prime: '′', minus: '−',
  trade: '™', copy: '©', reg: '®', deg: '°', plusmn: '±', times: '×', divide: '÷',
  euro: '€', pound: '£', yen: '¥', cent: '¢', sect: '§', para: '¶',
  frac12: '½', frac14: '¼', frac34: '¾', shy: '', zwj: '', zwnj: '',
}

/**
 * One pass, deliberately.
 *
 * A replacement is not rescanned, so `&amp;lt;` decodes to `&lt;` and stops
 * there. Decoding until it settles would turn text that merely *describes* an
 * entity into the character it names — which is how an escaped `&amp;#39;` in
 * quoted mail becomes an apostrophe that was never in the message.
 */
export function decodeEntities(input: string): string {
  if (!input.includes('&')) return input
  return input.replace(/&(#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (whole, body: string) => {
    if (body[0] !== '#') return NAMED[body] ?? NAMED[body.toLowerCase()] ?? whole
    const code = body[1] === 'x' || body[1] === 'X'
      ? parseInt(body.slice(2), 16)
      : parseInt(body.slice(1), 10)
    // Surrogates, out-of-range points and C0 controls are not text a mail client
    // meant to show; leaving the entity as written is the honest fallback.
    if (!Number.isFinite(code) || code > 0x10ffff) return whole
    if (code >= 0xd800 && code <= 0xdfff) return whole
    if (code < 0x20 && code !== 0x09 && code !== 0x0a) return whole
    return String.fromCodePoint(code)
  })
}

/**
 * The padding marketing mail uses to pull a preview line out to a fixed length.
 *
 * U+034F COMBINING GRAPHEME JOINER, repeated between spaces, is the common one —
 * it renders as nothing in a mail client and as a stack of boxes in anything
 * that does not special-case it. Zero-width spaces, joiners, soft hyphens and
 * byte-order marks do the same job. Bidi overrides are deliberately not in this
 * set: they are load-bearing in right-to-left mail.
 */
const INVISIBLE =
  /[\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180e\u200b-\u200f\u2060-\u2064\u206a-\u206f\u3164\ufeff\uffa0]/g

/** Strip the padding, then the horizontal whitespace it leaves at line ends. */
const stripInvisible = (s: string) =>
  s.replace(INVISIBLE, '').replace(/[^\S\n]+$/gm, '')

/**
 * A one-line value: a subject, a snippet, a display name, a card title.
 *
 * Every whitespace run collapses, because none of these is ever rendered with
 * its line breaks intact and a snippet that wraps in the data wraps twice on
 * screen.
 */
export const plainText = (input: unknown): string =>
  typeof input === 'string' ? stripInvisible(decodeEntities(input)).replace(/\s+/g, ' ').trim() : ''

/**
 * A message body, whose line breaks are the only formatting it has.
 *
 * Indentation is left alone — a plain-text mail that quotes code is the case a
 * whitespace collapse ruins — so this only removes the invisibles and the
 * trailing runs they leave behind.
 */
export const plainBody = (input: string): string =>
  stripInvisible(decodeEntities(input)).replace(/\n{3,}/g, '\n\n').trim()

/** A readable plain-text rendering, for mail that only shipped HTML. */
export function htmlToText(input: string): string {
  return plainBody(
    input
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(DROP_WITH_CONTENT, '')
      .replace(/<\/(p|div|tr|li|h[1-6]|blockquote)>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  )
}

/**
 * Strip the quoted history so a reply shows what was actually written. Deleting
 * it from the stored body would lose it, so this is a view, applied at render.
 */
export function splitQuoted(text: string): { body: string; quoted: string | null } {
  const markers = [
    /^On .{10,120}wrote:$/m,
    /^-{2,}\s*Original Message\s*-{2,}$/im,
    /^_{10,}$/m,
    /^From: .+$/m,
  ]
  let cut = -1
  for (const re of markers) {
    const m = re.exec(text)
    if (m && (cut === -1 || m.index < cut)) cut = m.index
  }
  if (cut <= 0) return { body: text, quoted: null }
  return { body: text.slice(0, cut).trimEnd(), quoted: text.slice(cut).trim() }
}
