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
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  claudeArgv, derivedSessionId, isSessionId, openTerminal, resolveSessionCwd,
  sessionIdFromTmuxName, terminalRoute, terminalSocketPath, tmuxNameFor,
} from '../src/server/claudecode/terminal'
import {
  buildPack, parseSessionModel, renderPack, SESSION_MODELS,
} from '../src/server/claudecode/launch'
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
    // `process.pid`: `liveSessions()` checks the pid is a process that still
    // exists, so an invented number would describe a *stale* file rather than a
    // running session, and these tests would measure the wrong refusal.
    JSON.stringify({ pid: process.pid, sessionId: SESSION, cwd: repo, startedAt: Date.now(), name: 'the fixture' }),
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

  test('a named model reaches --model, and Default passes no flag at all', () => {
    /*
     * There was no `--model` anywhere in the spawn path, so every session Wake
     * started ran on whatever Claude Code picked and nothing on a phone could
     * say otherwise.
     *
     * `default` is deliberately the *absence* of the flag rather than a literal
     * passed to it: Claude Code chooses for itself when `--model` is missing,
     * which respects whatever the operator configured, and passing the word
     * would be Wake asserting a preference it does not have.
     */
    const withModel = claudeArgv({
      sessionId: SESSION, resume: false, permissionMode: 'bypassPermissions', model: 'opus',
    })
    expect(withModel).toEqual(
      [CLAUDE_BIN, '--permission-mode', 'bypassPermissions', '--model', 'opus', '--session-id', SESSION],
    )

    for (const quiet of [undefined, 'default' as const]) {
      const argv = claudeArgv({
        sessionId: SESSION, resume: false, permissionMode: 'bypassPermissions', model: quiet,
      })
      expect(argv, `model=${String(quiet)} put a flag on the command line`)
        .not.toContain('--model')
    }

    // The flag goes before the session id, so the brief stays the last argument
    // — which is the property the positional-prompt test below depends on.
    const withBrief = claudeArgv({
      sessionId: SESSION, resume: false, permissionMode: 'bypassPermissions',
      model: 'sonnet', brief: 'hello',
    })
    expect(withBrief[withBrief.length - 1]).toBe('hello')
  })

  test('every route that starts a session takes a model to argv', () => {
    /*
     * This is the assertion that would have caught the picker being decorative.
     *
     * `POST /terminals` has two branches. The pack branch — which is the launch
     * sheet, and the way most sessions actually start — returns *before* the
     * model was parsed, so `b.model` was read off the wire and dropped on the
     * floor. `/sessions/new` honoured it and the non-pack branch honoured it, so
     * the feature looked wired end to end from either of those and did nothing
     * from the one that matters most.
     *
     * Pinned as a property of the route rather than of one call: every path that
     * reaches `openTerminal` has to carry a model, and `terminalForPack` needs a
     * parameter for it because a pack row has no model column to read.
     */
    const router = readFileSync('src/server/claudecode/router.ts', 'utf8')

    // The pack branch parses it before it returns.
    const packBranch = /if \(typeof b\.packId === 'string'[\s\S]*?\n  \}/.exec(router)?.[0] ?? ''
    expect(packBranch.length, 'the pack branch could not be found').toBeGreaterThan(200)
    expect(packBranch, 'the pack branch starts a session without reading the model')
      .toMatch(/parseSessionModel\(b\.model\)/)
    expect(packBranch, 'the pack branch does not pass the model on')
      .toMatch(/terminalForPack\([^)]*model/)

    // And the thing it passes it to accepts one and forwards it.
    const forPack = /function terminalForPack\([\s\S]*?\n\}/.exec(router)?.[0] ?? ''
    expect(forPack, 'terminalForPack stopped taking a model').toMatch(/model: SessionModel/)
    expect(forPack, 'terminalForPack drops the model before openTerminal')
      .toMatch(/openTerminal\(\{[\s\S]*?\bmodel,/)

    // Every `openTerminal(` call in the router carries one.
    for (const m of router.matchAll(/openTerminal\(\{[\s\S]*?\n  \}\)/g)) {
      expect(m[0], `an openTerminal call with no model:\n${m[0].slice(0, 160)}`)
        .toMatch(/\bmodel\b/)
    }
  })

  test('an unrecognised model is refused by name rather than defaulted', () => {
    /*
     * Silently falling back would make `claude` start on a model he did not
     * choose; passing it through would make `claude` exit immediately inside a
     * tmux nobody is watching, which reads as "the session did not start" with
     * no reason attached. Both are worse than a sentence.
     *
     * The list is aliases only. A full name like `claude-opus-4-5` works today
     * and pins a version that gets retired from under a picker kept for a year.
     */
    for (const ok of SESSION_MODELS) {
      expect(parseSessionModel(ok), `${ok} is not accepted`).toEqual({ model: ok })
    }
    // Absent means default, which is what an old client sends.
    for (const empty of [undefined, null, '']) {
      expect(parseSessionModel(empty)).toEqual({ model: 'default' })
    }
    for (const no of ['claude-opus-4-5', 'gpt-4', 'Opus', 'opus ', '__proto__', 'sonnet;rm -rf /']) {
      const r = parseSessionModel(no)
      expect('error' in r, `${no} was accepted as a model`).toBe(true)
    }
  })

  test('the brief is the last argument, verbatim, behind an end-of-options marker', () => {
    const brief = '# Wake brief\n\nLook at `sync`, and say "no" if it is fine.\n- a bullet\n'
    const argv = claudeArgv({ sessionId: SESSION, resume: false, permissionMode: 'bypassPermissions', brief })
    // Verbatim: newlines, quotes and backticks all survive, because the argv is
    // exec'd rather than handed to a shell.
    expect(argv[argv.length - 1]).toBe(brief)
    // And `--` immediately before it, which is the part that makes the sentence
    // above true rather than nearly true. See the next test.
    expect(argv[argv.length - 2]).toBe('--')
    expect(argv.length).toBe(7)
  })

  test('an empty brief is no brief, not a blank first turn', () => {
    for (const empty of ['', '   ', '\n\n', null, undefined]) {
      expect(claudeArgv({ sessionId: SESSION, resume: false, permissionMode: 'bypassPermissions', brief: empty }))
        .toHaveLength(5)
    }
  })

  /*
   * This test used to pass while the thing it is named for was false.
   *
   * Its only case was a brief containing *several* words beginning with a dash,
   * which is one argv element and was never going to be parsed as a flag — the
   * assertion held for a reason that had nothing to do with the claim. The case
   * that matters is a brief that is a single flag token, and against the
   * installed binary that case was real:
   *
   *     $ claude -p --wake-probe-flag
   *     error: unknown option '--wake-probe-flag'
   *     $ claude -p --model … -- --wake-probe-flag
   *     (parsed as the prompt)
   *
   * `POST /api/claude/sessions/new` takes free text straight to `claudeArgv`, so
   * a first message beginning with a dash reached Claude Code's option parser —
   * and `--allow-dangerously-skip-permissions` is a real single-token flag on
   * that binary. The fix is `--`, and the single-token case is what pins it.
   */
  test('a brief cannot smuggle in a flag, whatever it spells', () => {
    const smuggle = [
      '--allow-dangerously-skip-permissions',
      '--dangerously-skip-permissions',
      '-p',
      '--help',
      '--dangerously-skip-permissions --add-dir /etc',
      '-- --already-fenced',
    ]
    for (const brief of smuggle) {
      const argv = claudeArgv({
        sessionId: SESSION, resume: false, permissionMode: 'bypassPermissions', brief,
      })
      // One element, last, and behind the marker that ends option parsing.
      expect(argv[argv.length - 1], brief).toBe(brief)
      expect(argv[argv.length - 2], brief).toBe('--')
      // Wake's own flags are the only options on this command line.
      expect(argv.slice(0, argv.indexOf('--')).filter(a => a.startsWith('-')), brief)
        .toEqual(['--permission-mode', '--session-id'])
    }
  })

  test('the command is never a caller\'s', () => {
    // The binary is `CLAUDE_BIN` and the flags are these four. If a fifth flag
    // ever appears here it was added deliberately, not passed in.
    const argv = claudeArgv({ sessionId: SESSION, resume: true, permissionMode: 'bypassPermissions', brief: 'hi' })
    expect(argv[0]).toBe(CLAUDE_BIN)
    // `--` is the end-of-options marker rather than an option, so the named
    // flags are still exactly the two Wake chose.
    expect(argv.filter(a => /^--\w/.test(a))).toEqual(['--permission-mode', '--resume'])
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

/* ---------------------------------------------------------------------------
 * Pressing Open twice.
 * ------------------------------------------------------------------------- */

describe('one pack, one session, however many times Open is pressed', () => {
  /**
   * The id a pack opens into is derived from the pack, not minted per request.
   *
   * Every route that opened a pack called `openTerminal` with no id, and
   * `openTerminal` answered with a fresh `randomUUID()` each time. So a double
   * tap — which on a phone is the natural response to a control that shows
   * nothing until tmux has answered — started two Claude Code sessions in one
   * repository, both carrying the same brief, and the second one appeared on the
   * Sessions list as a stranger. Deriving the id gives the pack an identity in
   * tmux, which makes "is this already open" a question tmux can answer with no
   * table to reconcile and nothing to clean up after a Wake restart.
   */
  test('the id is a function of the pack and nothing else', () => {
    const a = derivedSessionId('pack:0198f0c0-1111-7000-8000-000000000000')
    expect(a, 'not a well-formed session id, so it cannot be a --session-id').toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
    expect(isSessionId(a)).toBe(true)
    expect(derivedSessionId('pack:0198f0c0-1111-7000-8000-000000000000')).toBe(a)
    expect(derivedSessionId('pack:0198f0c0-1111-7000-8000-000000000001')).not.toBe(a)
    // The two namespaces cannot collide: a pack and a composer send that
    // happened to share a uuid must not land in the same conversation.
    expect(derivedSessionId('new:x')).not.toBe(derivedSessionId('pack:x'))
  })

  /**
   * The reattach, against a real tmux session on the suite's own socket.
   *
   * `available()` refuses to spawn anything here — `WAKE_CLAUDE_BIN` points at a
   * file that does not exist — so this creates the tmux session itself and then
   * asks `openTerminal` for it. That is exactly the state a second press finds:
   * a tmux session already named for this work, and nothing to do but point the
   * browser at it. What must not happen is a spawn, and what must not happen
   * twice is the brief.
   */
  test('a second open reattaches instead of starting a second session', () => {
    const repo = join(root, 'truto')
    const id = derivedSessionId('pack:double-tap')
    const name = tmuxNameFor(id)!
    const tmux = (args: string[]) =>
      Bun.spawnSync(['tmux', '-L', process.env.WAKE_TMUX_SOCKET!, ...args], { stdout: 'pipe', stderr: 'pipe' })

    const made = tmux(['new-session', '-d', '-s', name, '-c', repo, 'sleep', '30'])
    if (made.exitCode !== 0) return // no usable tmux on this machine; the unit test above still holds
    try {
      const r = openTerminal({ cwd: repo, newSessionId: id, brief: '# a brief\n\nlook at the sync' })
      expect('error' in r, `openTerminal refused: ${'error' in r ? r.error : ''}`).toBe(false)
      if ('error' in r) return
      expect(r.sessionId).toBe(id)
      expect(r.started, 'a second open started a second session').toBe(false)
      expect(r.briefSent, 'the brief was delivered a second time').toBe(false)

      // And exactly one tmux session carries this id.
      const list = tmux(['list-sessions', '-F', '#{session_name}']).stdout.toString()
      expect(list.split('\n').filter(l => l.trim() === name)).toHaveLength(1)
    } finally {
      tmux(['kill-session', '-t', name])
    }
  })
})
