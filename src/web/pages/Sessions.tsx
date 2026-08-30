/**
 * Sessions — what Claude Code has open on this machine.
 *
 * A thin page. Everything that is actually a decision lives in
 * `components/sessions.tsx`; this is the header row and the shell's own pad, so
 * the title sits on the same vertical as Pulse's and Settings'.
 */

import { PageTitle } from '../components/primitives'
import { SessionsView } from '../components/sessions'

export function Sessions() {
  return (
    <div className="pb-24">
      <header className="pt-4 pb-2 flex items-center gap-3">
        <PageTitle>Sessions</PageTitle>
      </header>
      <SessionsView />
    </div>
  )
}

// The router registers this by default import (contract C12); the named export
// is what every other page in the product is reached by. Both, so whichever
// spelling App.tsx uses resolves.
export default Sessions
