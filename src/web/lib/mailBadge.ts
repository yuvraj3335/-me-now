/**
 * The Mail tab's badge: unread mail addressed to me, not total unread.
 *
 * "Unread" on a shared inbox is a number nobody acts on. The badge is only
 * useful if it counts the things that are actually on you, which is the same
 * rule the Now pile uses — so a newsletter never turns the badge amber.
 *
 * Polled slowly and only while the tab is visible: this is a hint, not a feed.
 */

import { useEffect, useState } from 'react'
import { mailApi } from './mail'

const POLL_MS = 120_000
let cached = 0

export function useMailBadge(): number {
  const [n, setN] = useState(cached)

  useEffect(() => {
    let live = true
    const load = async () => {
      if (document.hidden) return
      try {
        const r = await mailApi.threads({ box: 'unread' })
        if (!live) return
        cached = r.threads.filter(t => t.toMe).length
        setN(cached)
      } catch {
        // A disconnected Gmail shows no badge, which is the honest answer.
        if (live) setN(0)
      }
    }
    void load()
    const t = setInterval(load, POLL_MS)
    document.addEventListener('visibilitychange', load)
    return () => {
      live = false
      clearInterval(t)
      document.removeEventListener('visibilitychange', load)
    }
  }, [])

  return n
}
