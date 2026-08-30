import { useEffect, useState } from 'react'
import { RotateCcw, UserMinus } from 'lucide-react'
import type { Card as CardT } from '../lib/types'
import { actions, reload } from '../lib/api'
import { ago } from '../lib/time'
import { Button, Empty, Sheet } from './primitives'
import { SOURCE_LABEL, SourceDot } from './sources'
import { toast } from '../lib/toast'

/**
 * Everything Done and Not-mine took off the list, and the way back.
 *
 * Done is deliberately cheap — one key, no confirmation — which only works if
 * it is also reversible. The undo bar covers the next few seconds; this covers
 * the rest, including the card someone finished yesterday and now needs again.
 * A re-sync will not bring one back: the card is still there, the suppression
 * is mine, and only I can lift it.
 */
export function DoneSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [cards, setCards] = useState<CardT[] | null>(null)

  const load = () =>
    actions.doneCards().then(d => setCards(d.cards)).catch(() => setCards([]))

  useEffect(() => { if (open) { setCards(null); void load() } }, [open])

  async function restore(c: CardT) {
    setCards(cur => cur?.filter(x => x.group_key !== c.group_key) ?? cur)
    await actions.restore(c.group_key)
    await reload()
    toast('Back on your list.')
  }

  return (
    <Sheet open={open} onClose={onClose} title="Done and not mine">
      <p className="text-[12.5px] text-fg-mute leading-relaxed mb-3">
        Nothing here is deleted — it is on the list you kept it off. Bring one back and it
        returns to the pile Wake would have put it in.
      </p>

      {!cards && <p className="text-[13px] text-fg-mute py-6">Reading…</p>}
      {cards?.length === 0 && <Empty>Nothing has been taken off your list.</Empty>}

      {cards?.map(c => (
        <div key={c.group_key} className="flex items-start gap-3 py-3 hairline last:border-0">
          <div className="pt-1.5"><SourceDot source={c.sources[0]?.source ?? 'github'} size={7} /></div>
          <div className="grow min-w-0">
            <div className="text-[13.5px] leading-snug line-clamp-2">{c.title}</div>
            <div className="mt-1 flex items-center gap-x-2 text-[11.5px] text-fg-mute flex-wrap">
              {c.state?.not_mine
                ? <span className="inline-flex items-center gap-1"><UserMinus size={11} /> not mine</span>
                : <span>done {c.state?.done_at ? ago(c.state.done_at) : ''}</span>}
              <span className="text-ink-600">·</span>
              <span>{c.sources.map(s => SOURCE_LABEL[s.source]).filter((v, i, a) => a.indexOf(v) === i).join(' + ')}</span>
            </div>
          </div>
          <Button variant="solid" onClick={() => void restore(c)} title="Bring it back">
            <RotateCcw size={13} /> Restore
          </Button>
        </div>
      ))}
    </Sheet>
  )
}
