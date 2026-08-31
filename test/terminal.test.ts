/**
 * "Open in Claude" starts a session, and only the ones it is allowed to.
 *
 * A live terminal cannot be tested here — the suite points `WAKE_CLAUDE_BIN` at
 * a path that does not exist precisely so a stray test can never start a real
 * Claude Code session, and it has no tmux server of its own to talk to. What
 * *can* be pinned down is everything that decides what would be started, and
 * that is the half worth pinning: this is the one place in the product where a
 * request body turns into a process on the box.
 *
 * Four boundaries, one per section below:
 *
 *   1. **Naming.** A session id and a tmux target are the same fact in two
 *      spellings, and the round trip has to be total in both directions.
 *   2. **Arguments.** The command is fixed, the flags are fixed, and the only
 *      caller-supplied string in argv is the brief — as a positional prompt,
 *      never as an option.
 *   3. **Refusal.** A repository the registry never scanned, a session that is
 *      not on this machine, and a directory outside the workspace are each
 *      refused by name.
 *   4. **The brief.** What the session receives is the approved text, and the
 *      brief no longer prints a command line for a human to go and paste.
 */

import { beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  claudeArgv, isSessionId, openTerminal, resolveSessionCwd, sessionIdFromTmuxName,
  terminalRoute, terminalSocketPath, tmuxNameFor,
} from '../src/server/claudecode/terminal'
import { buildPack, renderPack } from '../src/server/claudecode/launch'
import { CLAUDE_BIN, CLAUDE_HOME, CLAUDE_PROJECTS_DIR, WORKSPACE_ROOT } from '../src/server/env'
import { terminalIdOf } from '../src/web/lib/route'
import { rescan } from '../src/server/registry/scan'

const root = process.env.WAKE_WORKSPACE_ROOT!
const SESSION = 'aaaaaaaa-1111-4111-8111-111111111111'
const NOT_HERE = 'ffffffff-9999-4999-8999-999999999999'
/** A real transcript in a real repository, with no process behind it. */
const FINISHED = 'cccccccc-3333-4333-8333-333333333333'

beforeAll(() => {
  // The same fixture launch.test.ts builds. Building it twice is harmless and
  // keeps this file runnable on its own.
  const repo = join(root, 'truto')
  mkdirSync(repo, { recursive: true })
  writeFileSync(join(repo, 'README.md'), '# truto\n')
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'wake', GIT_AUTHOR_EMAIL: 'wake@example.com',
    GIT_COMMITTER_NAME: 'wake', GIT_COMMITTER_EMAIL: 'wake@example.com',
  } as Record<string, string>
  for (const args of [['init', '-b', 'main'], ['add', '.'], ['commit', '-m', 'init']]) {
    Bun.spawnSync(['git', ...args], { cwd: repo, stdout: 'ignore', stderr: 'ignore', env })
  }
  rescan(root)

  // One real transcript, recorded as having run inside the fixture repository,
  // so "resume this session" is answered by the same reader the Sessions page
  // uses rather than by an id this test handed back to itself.
  const dir = `${CLAUDE_PROJECTS_DIR}/${repo.replace(/[^a-zA-Z0-9]/g, '-')}`
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    `${dir}/${SESSION}.jsonl`,
    [
      { type: 'user', cwd: repo, gitBranch: 'fix/sync', message: { role: 'user', content: 'look at the sync' } },
      { type: 'user', cwd: repo, gitBranch: 'fix/sync', message: { role: 'user', content: 'carry on' } },
    ].map(l => JSON.stringify(l)).join('\n'),
  )

  /*
   * And a process holding it open, because a transcript on its own is no longer
   * enough to resume.
   *
   * `openTerminal` gates a resume on `isSessionActive`, which reads the
   * per-process files Claude Code writes — the same source `claude agents
   * --json` reports from. Without this the fixture describes a session that
   * *finished*, and the tests below would be measuring the refusal rather than
   * the allowlist they are named for.
   */
  mkdirSync(`${CLAUDE_HOME}/sessions`, { recursive: true })
  writeFileSync(
    `${CLAUDE_HOME}/sessions/4242.json`,
    JSON.stringify({ pid: 4242, sessionId: SESSION, cwd: repo, startedAt: Date.now(), name: 'the fixture' }),
  )
})

/* -------------------------------- naming ---------------------------------- */

describe('a session id and its tmux session are one fact', () => {
  test('the name round-trips', () => {
    const name = tmuxNameFor(SESSION)!
    expect(name).toBe(`wake-${SESSION}`)
    expect(sessionIdFromTmuxName(name)).toBe(SESSION)
  })

  test('the prefix is what makes a name ours', () => {
    // Something else on the socket, or a name a caller invented. Neither
    // describes a terminal this API knows about, so neither is listed.
    expect(sessionIdFromTmuxName(SESSION)).toBeNull()
    expect(sessionIdFromTmuxName(`other-${SESSION}`)).toBeNull()
    expect(sessionIdFromTmuxName('wake-not-a-uuid')).toBeNull()
  })

  test('only a uuid may become a tmux target', () => {
    // Every one of these would otherwise reach a `-t` argument or a filename.
    for (const bad of [
      '', 'main', '../../etc/passwd', 'a; rm -rf /', '$(whoami)',
      `${SESSION} extra`, `${SESSION}\n`, 'zzzzzzzz-1111-4111-8111-111111111111',
    ]) {
      expect(isSessionId(bad)).toBe(false)
      expect(tmuxNameFor(bad)).toBeNull()
    }
    expect(isSessionId(SESSION)).toBe(true)
  })

  test('case is folded, because a uuid is not two ids', () => {
    expect(tmuxNameFor(SESSION.toUpperCase())).toBe(`wake-${SESSION}`)
  })

  test('the route and the socket are built from the id', () => {
    expect(terminalRoute(SESSION)).toBe(`/terminal/${SESSION}`)
    expect(terminalSocketPath(SESSION)).toBe(`/api/claude/terminals/${SESSION}/socket`)
    // The browser's parser and the server's builder have to agree, or a link
    // Wake produced lands on a page that cannot read it.
    expect(terminalIdOf(terminalRoute(SESSION))).toBe(SESSION)
    expect(terminalIdOf(`${terminalRoute(SESSION)}/`)).toBe(SESSION)
    expect(terminalIdOf('/sessions')).toBeNull()
    expect(terminalIdOf('/terminal/')).toBeNull()
  })
})

/* ------------------------------- arguments -------------------------------- */

describe('what actually reaches a command line', () => {
  test('a new conversation names its own session id', () => {
    expect(claudeArgv({ sessionId: SESSION, resume: false, permissionMode: 'bypassPermissions' }))
      .toEqual([CLAUDE_BIN, '--permission-mode', 'bypassPermissions', '--session-id', SESSION])
  })

  test('a resume names that session, and does not fork it', () => {
    const argv = claudeArgv({ sessionId: SESSION, resume: true, permissionMode: 'bypassPermissions' })
    expect(argv).toEqual([CLAUDE_BIN, '--permission-mode', 'bypassPermissions', '--resume', SESSION])
    // `--fork-session` would resume the transcript under a *new* id, which is
    // the one outcome "resume THAT session" must not produce.
    expect(argv).not.toContain('--fork-session')
  })

  test('bypassPermissions is the mode unless the other one was chosen', () => {
    expect(claudeArgv({ sessionId: SESSION, resume: false, permissionMode: 'acceptEdits' })[2])
      .toBe('acceptEdits')
  })

  test('the brief is the last argument, verbatim, and it is a prompt', () => {
    const brief = '# Wake brief\n\nLook at `sync`, and say "no" if it is fine.\n- a bullet\n'
    const argv = claudeArgv({ sessionId: SESSION, resume: false, permissionMode: 'bypassPermissions', brief })
    // Verbatim: newlines, quotes and backticks all survive, because the argv is
    // exec'd rather than handed to a shell.
    expect(argv[argv.length - 1]).toBe(brief)
    expect(argv.length).toBe(6)
  })

  test('an empty brief is no brief, not a blank first turn', () => {
    for (const empty of ['', '   ', '\n\n', null, undefined]) {
      expect(claudeArgv({ sessionId: SESSION, resume: false, permissionMode: 'bypassPermissions', brief: empty }))
        .toHaveLength(5)
    }
  })

  test('a brief cannot smuggle in a flag', () => {
    // It is positional and last, so `claude` reads it as the prompt. Nothing
    // here parses it, and there is no request field that appends to argv.
    const argv = claudeArgv({
      sessionId: SESSION, resume: false, permissionMode: 'bypassPermissions',
      brief: '--dangerously-skip-permissions --add-dir /etc',
    })
    expect(argv).toHaveLength(6)
    expect(argv.indexOf('--dangerously-skip-permissions')).toBe(-1)
    expect(argv[5]).toBe('--dangerously-skip-permissions --add-dir /etc')
  })

  test('the command is never a caller\'s', () => {
    // The binary is `CLAUDE_BIN` and the flags are these four. If a fifth flag
    // ever appears here it was added deliberately, not passed in.
    const argv = claudeArgv({ sessionId: SESSION, resume: true, permissionMode: 'bypassPermissions', brief: 'hi' })
    expect(argv[0]).toBe(CLAUDE_BIN)
    expect(argv.filter(a => a.startsWith('--'))).toEqual(['--permission-mode', '--resume'])
  })
})

/* -------------------------------- refusal --------------------------------- */

describe('only what Wake already knows can be started', () => {
  test('a repository the registry never scanned is refused by name', () => {
    for (const cwd of ['/etc', '/', '~', '/home/someone-else/work/thing', 'not-a-repo']) {
      const r = openTerminal({ cwd })
      expect(r).toHaveProperty('error')
      if ('error' in r) {
        expect(r.status).toBe(400)
        expect(r.error).toContain('registry')
      }
    }
  })

  test('a session that is not on this machine is refused', () => {
    const r = openTerminal({ sessionId: NOT_HERE })
    expect(r).toHaveProperty('error')
    if ('error' in r) {
      expect(r.status).toBe(400)
      expect(r.error).toContain('no session')
    }
  })

  test('an id that is not an id is refused before anything looks it up', () => {
    for (const bad of ['../../etc', 'main; id', '$(whoami)', 'wake-truto']) {
      const r = openTerminal({ sessionId: bad })
      expect(r).toHaveProperty('error')
      if ('error' in r) expect(r.status).toBe(400)
    }
  })

  test('a session in the registry resolves; one outside the workspace does not', () => {
    const repo = join(root, 'truto')
    expect(resolveSessionCwd(repo)).toEqual({ ok: true, path: repo, repo: 'truto' })

    // A subdirectory of a repository is real work in a real checkout, and the
    // registry has never heard of it. Bounded by the workspace root instead.
    const sub = join(repo, 'packages', 'web')
    const inSub = resolveSessionCwd(sub)
    expect(inSub.ok).toBe(true)
    if (inSub.ok) expect(inSub.path).toBe(sub)

    for (const outside of ['/etc', '/tmp', join(root, '..', 'elsewhere')]) {
      const r = resolveSessionCwd(outside)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error).toContain('outside the workspace')
    }
  })

  test('the workspace root is not a repository, and no session starts there', () => {
    /*
     * Found on the deployed site, and it is what "Open in Claude is broken"
     * turned out to be: a live session at `cwd: /home/yuvraj/work`, `repo:
     * null`. Pressing Open from a session row whose own `cwd` the registry did
     * not know fell back to "not about one repository", and the fallback was
     * taken literally — Claude Code started in the drawer that contains all
     * eleven checkouts and is itself none of them.
     *
     * `resolveCwd` still answers the root for a *brief*, because "not about one
     * repository" is a true thing to say about a mail thread and a Slack
     * question. Only the thing that spawns a process insists on somewhere real.
     */
    const atRoot = resolveSessionCwd(WORKSPACE_ROOT)
    expect(atRoot.ok, 'a session recorded at the workspace root still resolves').toBe(false)
    if (!atRoot.ok) expect(atRoot.error).toContain('not a repository')

    // And the same refusal on the way in, for a new conversation that named no
    // repository at all — which is the path the reported session actually took.
    for (const cwd of [undefined, null, '', WORKSPACE_ROOT]) {
      const r = openTerminal({ cwd } as Parameters<typeof openTerminal>[0])
      expect('error' in r, `a session started with cwd ${JSON.stringify(cwd)}`).toBe(true)
      if ('error' in r) {
        expect(r.status).toBe(400)
        expect(r.error, 'the refusal does not say what to do about it')
          .toContain('Pick a repository')
      }
    }
  })

  test('a recorded path cannot climb out of the workspace with ..', () => {
    const r = resolveSessionCwd(`${WORKSPACE_ROOT}/../../../etc`)
    expect(r.ok).toBe(false)
  })

  test('a session with no recorded directory has nowhere to resume', () => {
    const r = resolveSessionCwd(null)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('does not record')
  })

  test('naming a real repository gets past the allowlist and stops at the machine', () => {
    // The suite points WAKE_CLAUDE_BIN at nothing, on purpose, so this is where
    // a valid request stops. A 503 here is the proof that the 400s above are
    // the allowlist talking and not an unavailable binary.
    const r = openTerminal({ cwd: 'truto' })
    expect(r).toHaveProperty('error')
    if ('error' in r) {
      expect(r.status).toBe(503)
      expect(r.error).toContain('claude binary')
    }
  })

  test('a session that IS on this machine gets past the allowlist too', () => {
    const r = openTerminal({ sessionId: SESSION })
    expect(r).toHaveProperty('error')
    if ('error' in r) expect(r.status).toBe(503)
  })

  test('a session nothing is running is refused before the machine is asked', () => {
    /*
     * The transcript exists and the directory is a real repository, so every
     * allowlist in this file says yes — and it still may not be resumed,
     * because `--resume` on a session no process is holding open is how Claude
     * Code came to tell him, on his phone, that the session had been archived.
     *
     * 409 rather than 503 is the whole point: this refusal comes *before*
     * availability, so it is the same answer on a box with tmux and without
     * one, and it is the same sentence `POST /sessions/:id/send` gives.
     */
    const dir = `${CLAUDE_PROJECTS_DIR}/${join(root, 'truto').replace(/[^a-zA-Z0-9]/g, '-')}`
    writeFileSync(
      `${dir}/${FINISHED}.jsonl`,
      [
        { type: 'user', cwd: join(root, 'truto'), message: { role: 'user', content: 'this one ended' } },
        { type: 'user', cwd: join(root, 'truto'), message: { role: 'user', content: 'last week' } },
      ].map(l => JSON.stringify(l)).join('\n'),
    )

    const r = openTerminal({ sessionId: FINISHED })
    expect(r).toHaveProperty('error')
    if ('error' in r) {
      expect(r.status, 'a finished session was handed to --resume').toBe(409)
      expect(r.error).toContain('not running any more')
    }
  })
})

/* --------------------------------- briefs --------------------------------- */

describe('the brief the session receives', () => {
  test('the pack is the artifact, and it is what would be sent', () => {
    const built = buildPack({
      template: 'blank',
      title: 'Sync is failing',
      cwd: 'truto',
      instruction: 'Find out why the Acme sync stopped.',
      items: [],
    })
    expect(built).not.toHaveProperty('error')
    if ('error' in built) return

    // One text in three places: the row, the file on disk, and — via
    // `claudeArgv` — the process's first message.
    const onDisk = Bun.file(built.packPath)
    expect(built.firstMessage).toContain('Find out why the Acme sync stopped.')
    expect(claudeArgv({
      sessionId: SESSION, resume: false, permissionMode: built.permissionMode,
      brief: built.firstMessage,
    }).at(-1)).toBe(built.firstMessage)
    expect(onDisk.size).toBeGreaterThan(0)
  })

  test('a brief about a session says it is being resumed, and prints no command', () => {
    const body = renderPack({
      template: 'blank', templates: ['blank'], title: 'Carry on',
      cwd: '/home/me/work/truto', repo: 'truto', skills: [],
      instruction: 'Finish the migration.', items: [], createdAt: Date.now(),
      permissionMode: 'bypassPermissions',
      session: { id: SESSION, cwd: '/home/me/work/truto', branch: 'fix/sync' },
    })

    expect(body).toContain(SESSION)
    expect(body).toContain('fix/sync')
    expect(body).toContain('next turn')

    // The whole point of the terminal. A brief that ends in a line to copy into
    // a terminal he has to go and find is the failure this work removed, so it
    // is asserted absent rather than merely not written.
    expect(body).not.toContain('--resume')
    expect(body).not.toContain('claude --')
    expect(body).not.toContain('in a terminal')
  })

  test('a session Wake cannot see is still named, and still not pasteable', () => {
    const body = renderPack({
      template: 'blank', templates: ['blank'], title: 'Elsewhere',
      cwd: '/home/me/work', repo: null, skills: [],
      instruction: 'Have a look.', items: [], createdAt: Date.now(),
      session: { id: NOT_HERE },
    })
    expect(body).toContain(NOT_HERE)
    expect(body).toContain('not on this machine')
    expect(body).not.toContain('--resume')
  })

  test('a brief with no session says nothing about one', () => {
    const body = renderPack({
      template: 'blank', templates: ['blank'], title: 'Fresh',
      cwd: '/home/me/work/truto', repo: 'truto', skills: [],
      instruction: 'Start here.', items: [], createdAt: Date.now(),
    })
    expect(body).not.toContain('session:')
    expect(body).not.toContain('--resume')
  })
})
