/**
 * Sessions — what Claude Code has open on this machine.
 *
 * A thin page. Everything that is actually a decision lives in
 * `components/sessions.tsx`; this is the header row and the shell's own pad, so
 * the title sits on the same vertical as Pulse's and Settings'.
 *
 * The count is the one fact this row holds, and it is held here because it
 * belongs to the header rather than to the list: Desk, Mail and Work all print
 * theirs beside the title in the same muted tabular figures, and Sessions was
 * the only page in the product that did not — while the repository control
 * directly beneath it printed `truto 38` and `All repositories 73`. The list
 * reports it up rather than the page reaching down for it, because only the
 * list knows which repository and which view the number is about.
 *
 * `null` while the first read is in flight, so the row prints nothing rather
 * than a zero it has not measured yet.
 */

import { useState } from 'react'
import { PageTitle } from '../components/primitives'
import { SessionsView } from '../components/sessions'

export function Sessions() {
  const [count, setCount] = useState<number | null>(null)

  return (
    <div className="pb-24">
      <header className="pt-4 pb-2 flex items-center gap-3">
        <PageTitle>Sessions</PageTitle>
        {count !== null && <span className="tnum text-sm text-fg-mute">{count}</span>}
      </header>
      {/* The setter's identity is stable across renders, which is what keeps
          the report from re-firing the effect that produces it. */}
      <SessionsView onCount={setCount} />
    </div>
  )
}

// The router registers this by default import (contract C12); the named export
// is what every other page in the product is reached by. Both, so whichever
// spelling App.tsx uses resolves.
export default Sessions
