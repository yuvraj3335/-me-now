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
