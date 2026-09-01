/**
 * Cutting a Wake brief out of quoted text.
 *
 * Wake packs a Claude Code session's last prompt as context. When that session
 * was itself started from a Wake brief, the prompt IS a Wake brief — so packing
 * it again nests one inside the other, and doing it twice nests it twice. The
 * result was a brief whose entire Context section was a stale copy of an older
 * brief, restating the same title three times and carrying no facts at all. The
 * same text is what the detail pane printed as a card's body: 1,776 characters
 * of Wake's own paperwork, `## Instruction` and `Packed by Wake at` included, in
 * a 400px glance pane.
 *
 * It lives in its own file for two reasons. It is used on both sides now — the
 * outbound pack path in `launch.ts` and the inbound read path in
 * `sources/claudeSessions.ts` — and putting it in either would make the other
 * import a module it has no other business with.
 *
 * **The marker has to track the producer.** The original was
 * `/(^|\n)#\s.*\n+Packed by Wake at \d{4}-/`: a title line immediately followed
 * by the footer, which was the brief format of several releases ago. `renderPack`
 * now writes `# <title>`, then `## What this is`, then a sentence, and puts the
 * footer below a `---`. Run against today's producer, the old regex matched
 * nothing — the defence had been dead, and green, for releases, because the test
 * that guarded it was written against a hand-typed copy of a format nothing
 * emits. `test/launch.test.ts` now builds its fixture by calling `renderPack`,
 * so a producer change fails the test instead of silently disarming the consumer.
 */

/**
 * Any one of the brief's own headers is enough, because a quoted copy often
 * begins part-way through: a transcript's last prompt is frequently the brief
 * from `## What I need` downwards.
 */
const WAKE_BRIEF = new RegExp(
  [
    // The current shape: a title, then the opening section.
    String.raw`(^|\n)#\s[^\n]*\n+##\s+What this is`,
    // The sentence that section always opens with, on its own.
    String.raw`(^|\n)A brief from Wake, my personal command centre`,
    // The footer, current and historical.
    String.raw`(^|\n)Packed by Wake at \d{4}-`,
    // The old shape, kept so an archived transcript still gets cut.
    String.raw`(^|\n)#\s[^\n]*\n+Packed by Wake at \d{4}-`,
  ].join('|'),
)

export function stripNestedBrief(text: string): string {
  const m = WAKE_BRIEF.exec(text)
  if (!m) return text
  const head = text.slice(0, m.index).trim()
  return head
    ? `${head}\n\n[Wake removed a copy of an earlier brief from here — it was this tool's own output, not new information.]`
    : '[This was a copy of an earlier Wake brief, so there is nothing quotable here. Ask me for the underlying thread.]'
}

/** Whether this text contains a brief Wake wrote. */
export const isNestedBrief = (text: string) => WAKE_BRIEF.test(text)

/**
 * The part of a quote that is not Wake's own brief, or `null` when there is
 * nothing else in it.
 *
 * `stripNestedBrief` replaces the cut with a sentence, which is right for a
 * brief a session is about to read and wrong for a card: that sentence would
 * become the row's title. On the card path the honest answer to "what is this
 * session about" is the part the operator actually typed, and when there is no
 * such part it is the session's own project name — never Wake quoting itself.
 */
export function withoutBrief(text: string): string | null {
  const m = WAKE_BRIEF.exec(text)
  if (!m) return text
  const head = text.slice(0, m.index).trim()
  return head || null
}

/**
 * A one-line title with Wake's own markers scrubbed out of it.
 *
 * `withoutBrief` needs a line boundary to find a brief, and a session's recorded
 * title is one line: a transcript whose first prompt was a Wake brief produced
 * the card title `Acme sync stopped Packed by Wake`, which is the tool's own
 * footer arriving as the name of somebody's work.
 */
export function titleWithoutBrief(title: string): string {
  return title
    .replace(/\s*Packed by Wake\b.*$/i, '')
    .replace(/\s*##\s*(What this is|What I need|Instruction|Context)\b.*$/i, '')
    .replace(/\s*A brief from Wake\b.*$/i, '')
    .trim()
}

/**
 * A Wake brief, shortened to the part a person would want to re-read.
 *
 * `withoutBrief` answers "what else was in this text" and returns `null` when
 * the answer is nothing, which is right for a card title and catastrophic for a
 * transcript. A session started from Wake has that brief as its *first user
 * turn*, so the reader ran it through `cleanPrompt`, got `null`, and dropped
 * the turn — the conversation opened with Claude's answer and no visible
 * question. The one loop this product exists to serve, rendered as a reply to
 * nothing.
 *
 * So the brief renders as itself, cut down rather than deleted. What survives
 * is the title, the objective it actually carried, and a line saying what was
 * left out and how big it was — which is the difference between "you sent this"
 * and a wall of Wake's own paperwork on a 375px screen.
 */
export function briefDigest(text: string): string | null {
  if (!isNestedBrief(text)) return null

  const title = /(?:^|\n)#\s+(.+)/.exec(text)?.[1]?.trim() ?? null
  const need = /\n##\s+What I need\s*\n+([\s\S]*?)(?=\n##\s|\n---\s*\n|$)/.exec(text)?.[1]?.trim() ?? null
  const objects = /\n##\s+Context\s+—\s+(\d+)\s+object/.exec(text)?.[1] ?? null

  const head = `[A Wake brief${title ? ` — ${title}` : ''}${
    objects ? `, with ${objects} attached object${objects === '1' ? '' : 's'}` : ''
  } · ${text.length.toLocaleString()} characters. What it asked for:]`

  // No instruction section means a shape this function does not know. Saying so
  // beats printing a heading with nothing under it.
  if (!need) return `${head}\n\n[Wake could not find the instruction in it — open the pack to read the whole brief.]`
  const clipped = need.length > 1_400 ? `${need.slice(0, 1_400)}\n…[cut here; the whole brief is in the pack]` : need
  return `${head}\n\n${clipped}`
}
