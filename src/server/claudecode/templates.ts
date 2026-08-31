/**
 * Launch templates.
 *
 * A template is a row in the UI, not a hidden string. Each one says which kinds
 * of object it expects to be handed, which skills the session should be told
 * about by *name* (never inlined — the session can read them itself, and it has
 * the same catalogs Wake indexes), and the opening instruction.
 *
 * The instructions all share one clause: do not ask the person to re-paste
 * identifiers that are already in the pack. That is the entire point of packing
 * context instead of typing a prompt.
 *
 * Every instruction takes one skeleton — OBJECTIVE, ESTABLISH, SUBAGENTS,
 * EVIDENCE, DELIVER, DO NOT — so that selecting three templates concatenates
 * into something still readable rather than three essays in three shapes. They
 * say *what* to establish and what each role must return; they never spell out
 * the commands, because the flags drift and the objects do not. "Read the
 * environment-integration override" stays true across CLI releases; a command
 * line with `-p` and `-o json` in it does not.
 *
 * They name subagents by role — architect, senior engineer, UI, UX, designer,
 * QA lead — because the failure these replace was one voice doing a shallow
 * pass on six different questions.
 *
 * One row in this list is not an investigation at all. `humanizer` is a *voice*
 * template: it says nothing about what to find out and everything about how the
 * last message reads. It is meant to be worn over one of the others, which is
 * why its own text opens by saying so — `buildPack` concatenates the selected
 * instructions in the order they were clicked, and nothing in this file gets to
 * reorder that list. A section that governs only the reply therefore has to
 * announce what it governs, or a session that meets it above `Customer
 * incident` reads it as the first step of the investigation. See `kind` below.
 *
 * **1,200 characters each, hard.** The instruction is inlined into the brief and
 * the brief is trimmed at `HANDOFF_MAX_CHARS`; three long ones selected together
 * push the packed Slack and Sentry evidence out of the link, which is exactly
 * what `PER_ITEM_QUOTE_CHARS` exists to prevent. `test/launch.test.ts` holds the
 * bound.
 *
 * **Where the steps come from.** These are not a generic support desk written
 * down. Every ESTABLISH order in this file was read back out of his own Claude
 * Code history — 99 sessions, ~570 turns, ~6,800 commands — and the ones that
 * survived are the ones the transcripts actually show. That is why they say
 * things a generic template would not: profiles read `yuvraj-<customer>-<env>`
 * and the name in a thread is usually approximate, so it is matched rather than
 * trusted; `whoami` runs on *every* environment named because he names two or
 * three and the bug is usually in one of them; and the environment's mapping row
 * is read before the base row, because reading the base while the override is
 * what runs is the single most repeated way these investigations went wrong.
 *
 * The corresponding rule about *pasted* evidence lives one file over, in
 * `launch.ts`, and deliberately so — Wake pastes other people's conclusions for
 * a living, so the brief says once that they are leads rather than findings
 * instead of eleven templates each spending characters to say it.
 */

// `task` is Wake's own object rather than someone else's — the operator's
// title, his stickies, and the frozen provenance of the row it came from. It was
// the one missing link in the chain the product exists to serve: row → task →
// stickies → Open in Claude. `note` was in this union from the first release and
// nothing ever produced one; the stickies are what fills it.
export type SlotKind = 'card' | 'mail' | 'slack' | 'sentry' | 'notion' | 'github' | 'session' | 'note' | 'task'

export type Template = {
  id: string
  label: string
  blurb: string
  /**
   * What selecting this row actually does.
   *
   * `investigation` is every original row: it says what to establish, who to
   * put on it, and what to hand back. `voice` says none of that — it governs
   * the wording of the message that leaves at the end, and is meant to be worn
   * over an investigation rather than instead of one.
   *
   * Optional, and absent means `investigation`, because that is what every
   * other row is and restating it once per row would be noise.
   * The distinction lives on the type rather than in the blurb's prose so the
   * picker can render a modifier as a modifier, instead of as an eleventh thing
   * to investigate that happens to be about words.
   */
  kind?: 'investigation' | 'voice'
  /** Item kinds this template is built to receive, in the order it wants them. */
  slots: SlotKind[]
  /** Repository name to default the working directory to, if it is present. */
  defaultRepo: string | null
  /**
   * Named, not inlined. The session resolves them from its own catalogs.
   *
   * "Its own" is the load-bearing part, and it is what these names got wrong
   * for a while. They read `truto-cli-toolbelt`, `truto-mapping-tester`,
   * `truto-safe-admin-operator` — names that exist only under an old
   * `Cursor-skills` tree. Wake's own index does not read that tree and neither
   * does a Claude Code session, so every one of them arrived as an instruction
   * to load something unloadable; a session handed three of them went and
   * loaded an unrelated skill instead. `resolveSkillId` passes an unknown name
   * through untouched rather than dropping it, which is why this stayed quiet.
   *
   * So the rule is: a name here has to exist in the catalog the *receiving*
   * session reads, and it should be one the history shows him actually opening.
   * `truto-cli` is on nearly every investigation row for both reasons.
   */
  skills: string[]
  instruction: string
}

/**
 * The clause every template shares.
 *
 * It no longer claims the CLI and the checkouts are "on this machine" — the
 * brief now opens wherever you are signed in to Claude, which may be a phone.
 * Saying otherwise sent sessions looking for a working directory they did not
 * have. What is still true, and is the whole point of packing, is that every
 * identifier the work needs is already below.
 */
const NO_REPASTE =
  'Every identifier you need is in the context below — do not ask me to re-paste any of it. ' +
  'If you have a checkout of the repository named above, work in it; if not, reason from what is here and tell me what you would need.'

export const TEMPLATES: Template[] = [
  {
    id: 'customer-incident',
    label: 'Customer incident',
    blurb: 'A customer report, taken to a root cause and a safe reply.',
    slots: ['slack', 'mail', 'sentry', 'card', 'task', 'session', 'note'],
    defaultRepo: 'truto',
    skills: ['truto-cli', 'truto-operator', 'truto-api-conventions'],
    instruction: `${NO_REPASTE}

OBJECTIVE. Take this report to a root cause and a safe reply.

ESTABLISH, through the Truto CLI, in order. Match the customer to a profile — they read yuvraj-<customer>-<env>; the name given is usually approximate. None for them? Stop and ask; do not guess an environment. Run whoami on every environment named, not just one. Then the thread, the integration, the account (status, scope, context, capabilities), the environment-integration override, and the mapping — environment row before base.

SUBAGENTS. A senior engineer to reproduce with the smallest safe READ. An architect to name the layer: provider, config, environment override, mapping, sync runtime, or the customer's call. A QA lead for what falsifies it.

EVIDENCE. Logs walked day by day to the day it changed. Raw response beside the unified one. Evaluate the mapping as deployed.

DELIVER. Impact, evidence, layer, confidence, workaround, fix, draft reply.

DO NOT. Mutate anything. Do not send the reply.`,
  },
  {
    id: 'sentry-issue',
    label: 'Sentry issue',
    blurb: 'One stack trace to the line that produced it.',
    slots: ['sentry', 'card', 'task', 'session', 'note'],
    defaultRepo: 'truto',
    skills: ['truto-cli', 'truto-api-conventions'],
    instruction: `${NO_REPASTE}

OBJECTIVE. Get from this stack trace to the line that produced it, and to a verdict on whether it is worth fixing.

ESTABLISH. The frame in our code rather than in a dependency, the release it started in, and how often it fires and for how many tenants. A loud error affecting one account and a quiet one affecting all of them rank the other way round.

SUBAGENTS. A senior engineer to trace the wrong value back to where it entered. An architect on whether this class of error is possible elsewhere in the same shape. A QA lead on the case that reproduces it.

EVIDENCE. The failing input, the code path, and a test that fails now for the stated reason. If it is a provider returning something undocumented, say so and quote it — that is a different fix from a defect of ours.

DELIVER. Root cause, blast radius, whether it is ours, the fix, and the test that proves it.

DO NOT. Open a pull request. Push anything.`,
  },
  {
    /**
     * A GitHub card had no template of its own, so `templateFor` mapped it to
     * `sentry-issue` — opening a pull request preselected the Sentry template
     * and its instruction told the session to read a stack trace. A pull request
     * is a different job from an exception, and it is one of the two things
     * GitHub ever puts on this list.
     */
    id: 'review-pr',
    label: 'Pull request',
    blurb: 'A pull request or issue that needs a read before it moves.',
    slots: ['github', 'card', 'task', 'session', 'note'],
    defaultRepo: null,
    skills: ['truto-api-conventions', 'platform-change-checklist'],
    instruction: `${NO_REPASTE}

OBJECTIVE. Say whether this is safe to merge, and back every claim with something you ran.

ESTABLISH. The PR's real head, both repositories if the feature is two PRs, and local reconciled with remote before reading a line. Then a three-dot diff against main, opening files in risk order: auth and enforcement first, then migrations and whether their numbering collides with main, then routers and services, then the other repo.

SUBAGENTS. A senior engineer to find the alternate entry point — the door guarded on one route and not another. An architect on whether the approach is right, independent of what any reviewer said. A QA lead to name what falsifies each finding.

EVIDENCE. Commands, not readings: typecheck, targeted tests, lint on changed files, a build. Assume you know nothing here; open the file.

DELIVER. Merge or do not, blocking findings in severity order, and every judgment call that needs my intent, not yours.

DO NOT. Push, merge or comment on the PR.`,
  },
  /**
   * Exercising a branch, which is not the same job as reading one.
   *
   * `review-pr` answers "is this right"; this answers "does it hold up when you
   * run it". They were one row until the history said otherwise: the QA runs in
   * the corpus open by booting the thing locally, minting a real identity out of
   * the auth code rather than a fixture, and taking a customer's path through it
   * — none of which a diff review does, and all of which needs saying before the
   * first agent is spawned.
   *
   * The two rules that come straight off his own briefs are the cleanup and the
   * hedge. Every run he wrote left artefacts on a shared environment and every
   * one of them ended with an order to delete them by name. And "if something
   * looks suspicious but you are not fully certain, label it clearly as a likely
   * issue rather than stating it as fact" appears in his QA prompts almost
   * verbatim, because a confident wrong finding costs more than a hedged right
   * one.
   */
  {
    id: 'qa-branch',
    label: 'QA a branch',
    blurb: 'A branch that is deployed somewhere and needs exercising, not reading.',
    slots: ['github', 'card', 'task', 'session', 'note'],
    defaultRepo: null,
    skills: ['truto-cli', 'truto-api-conventions'],
    instruction: `${NO_REPASTE}

OBJECTIVE. Exercise this branch as a senior QA engineer would, and report what broke.

ESTABLISH. What is deployed where, and get it running locally before UAT. Snapshot what you can restore, so the run is reversible. Then take the path a customer takes, not the unit test's.

SUBAGENTS. A senior engineer on the happy path and the boundaries. A QA lead on the states nobody builds for: empty, one, many, expired, revoked, half-migrated. A UX subagent on what the screen says on failure.

EVIDENCE. Every finding is a request and a response, or a screenshot, with the environment it came from. Read the result back from the store, not from the UI that wrote it. Not certain? Label it a likely issue, not a fact.

DELIVER. Findings in severity order, each with how to reproduce it and how to tell it is fixed. Then clean up: delete every job, record and file the run created, and put the checkout back as you found it.

DO NOT. Touch production. Fix anything unless asked.`,
  },
  {
    id: 'slack-thread',
    label: 'Slack thread',
    blurb: 'A thread with a question in it that needs a real answer.',
    slots: ['slack', 'card', 'task', 'note'],
    defaultRepo: null,
    skills: ['truto-cli', 'truto-api-conventions'],
    instruction: `${NO_REPASTE}

OBJECTIVE. Answer the question in this thread properly. Not an acknowledgement — the answer.

ESTABLISH. What is actually being asked, which is often narrower than the thread's volume suggests. Read all of it before answering any part; the follow-up two messages down is usually the real question. Then check the live config and the code rather than what the product ought to do.

SUBAGENTS. A senior engineer to verify the claim against what is deployed. An architect when the question is really whether we should support this, because that answer outlives the thread.

EVIDENCE. Whatever you assert, you checked. If the answer depends on their environment, go and look at their environment. If we cannot do it, say what would have to change.

DELIVER. The answer in his voice: short, specific, technically direct, with a concrete example where an example beats a sentence. No restating their question back at them.

DO NOT. Post anything. Guess to fill a gap — name the gap.`,
  },
  {
    id: 'mail-thread',
    label: 'Mail thread',
    blurb: 'An email thread that needs work before it can be answered.',
    slots: ['mail', 'card', 'task', 'note'],
    defaultRepo: null,
    skills: ['truto-cli'],
    instruction: `${NO_REPASTE}

OBJECTIVE. Work out what this thread needs before it can be answered, then draft the answer.

ESTABLISH. What is being asked and by when, what has already been promised in the thread, and whether any of it is now out of date. If it names a customer, an account or an integration, check the live state before writing a sentence about it.

SUBAGENTS. A senior engineer for the parts that are claims about the system rather than about the plan. An architect when the thread is really asking for a commitment about what we will support.

EVIDENCE. Separate what the thread asserts from what you confirmed. Anything unverified goes into the reply as a question, not as a statement.

DELIVER. A draft reply, short and plain, plus the open items that are not mine to answer and who they belong to.

DO NOT. Send it. Commit to a date on my behalf.`,
  },
  {
    id: 'mapping',
    label: 'Mapping — unified vs proxy',
    blurb: 'A field is wrong, missing, or shaped differently than expected.',
    slots: ['card', 'task', 'session', 'note'],
    defaultRepo: 'truto',
    skills: ['truto-unified-mappings', 'truto-jsonata', 'truto-cli'],
    instruction: `${NO_REPASTE}

OBJECTIVE. Why this field is wrong, missing, or a different shape than expected.

ESTABLISH. Which environment's mapping is live — the environment's row overrides the base, and reading the base while the override runs is how this goes wrong. Pull the deployed expression, not the catalog's. Then the proxy response for the same record, so you see both ends of the transform.

SUBAGENTS. A senior engineer to evaluate the live expression against the real payload and a crafted edge case. An architect on whether the unified model can hold what is asked for, or this is a schema question in a mapping costume.

EVIDENCE. Raw response, the deployed expression, and the unified output side by side. Run it; do not read it and conclude. Check the provider returns the field at all for this account first.

DELIVER. Which layer is wrong, the corrected expression, what it does to records already synced, and which environments need it.

DO NOT. Apply a mapping. Propose it as a diff.`,
  },
  {
    id: 'sync-job',
    label: 'Sync job failure',
    blurb: 'A run failed, stalled, or produced the wrong rows.',
    slots: ['card', 'task', 'sentry', 'session', 'note'],
    defaultRepo: 'truto',
    skills: ['truto-cli', 'truto-operator'],
    instruction: `${NO_REPASTE}

OBJECTIVE. Why this run failed, stalled, or wrote the wrong rows.

ESTABLISH. The runtime version first — V1 through V4 differ enough that a V4 answer is wrong for a V2 job, and it decides which code you are reading. Then the job's definition, the last runs and where they stopped, and the account behind it. Pagination, cursors and forks are where the stalls live.

SUBAGENTS. A senior engineer to walk one run from trigger to the row it stopped on. An architect on whether the job's shape suits the volume and the provider's paging. A QA lead on what a correct rerun looks like.

EVIDENCE. The run's log over the window it failed in, the cursor where it stopped, and the provider's paging contract. A run that looks stuck and a run polling a provider that stopped answering are different findings.

DELIVER. Why it stopped, whether data is missing or duplicated, whether a rerun is safe, and the fix.

DO NOT. Trigger a run against a customer environment. Mutate the job.`,
  },
  {
    id: 'account-health',
    label: 'Account health',
    blurb: 'Credentials, scopes, capabilities, reauthorization.',
    slots: ['card', 'task', 'session', 'note'],
    defaultRepo: null,
    skills: ['truto-cli', 'truto-operator'],
    instruction: `${NO_REPASTE}

OBJECTIVE. Say whether this account can do what is being asked of it, and what it needs if it cannot.

ESTABLISH. Its status, its last error, the scope actually granted against the scope the integration asks for, and its capabilities — what it exposes now, not what the catalog says. Then the context the account carries: flags set at connect time are usually the answer, and they go stale when a provider's plan changes.

SUBAGENTS. A senior engineer to prove the failure with the smallest read the account can do. An architect on whether this is a token, a scope, a plan, or a provider-side permission the customer has to change themselves.

EVIDENCE. The provider's own error text, not our paraphrase. Granted scope beside required scope. Say plainly whether reauthorizing fixes it or just repeats it.

DELIVER. What is wrong, whose side it is on, whether reconnecting helps, and what to tell the customer.

DO NOT. Refresh, reconnect or revoke anything.`,
  },
  {
    id: 'continue-session',
    label: 'Continue earlier work',
    blurb: 'Carry on a conversation that is still open, in the repository it is running in.',
    slots: ['session', 'task', 'note'],
    defaultRepo: null,
    skills: [],
    /*
     * This instruction used to open by telling the session it was not itself.
     *
     * "You are not resuming that session and you cannot: a link opens a new
     * conversation, so the transcript is not loaded" was true of the hand-off
     * that shipped this template — a link to a chat surface, which really did
     * start a stranger every time. It became false the moment Wake started the
     * session itself, and it was false in the worst possible place: this text is
     * the first message *inside* that session, so a session with its whole
     * transcript above it was being told, in its own words, that it had none.
     *
     * The word that replaced it — "resumed" — is now wrong in the other
     * direction, and that is what this edit is. The composer offers only
     * conversations that are **running right now**, and Send delivers one more
     * turn into the live one; nothing is being resumed off a transcript, because
     * an id that could only be resumed is an id the composer refuses to carry.
     * A session that stopped is not a row in that menu, so the brief cannot
     * arrive claiming to continue it.
     *
     * It still does not assert which case it is in, because both are real: pick
     * a session and this lands in that session with its history above it; pick
     * `A new conversation` and the same session's tail arrives quoted, in the
     * same repository. One sentence cannot know which, so this asks rather than
     * claims — and "check what you can actually see" is the right first move
     * under either, which is why it reads as one instruction instead of two
     * branches.
     */
    instruction: `Pick up the work below. It comes from a Claude Code session on this machine, in the repository named above.

You may be that session itself, still running, with everything above this message already yours — or a new one in the same working directory, holding only what is quoted here. Look before you answer: if the earlier turns are above you, use them; if all you have is the quote, treat it as a handover note from someone who has stopped talking and say so. Do not reconstruct from memory what you cannot see, and do not re-ask me for anything that is in front of you.

ESTABLISH. Where it got to, in your own words, before you carry on. If your reading differs from what the last prompt implies, say so — that gap is usually the reason the session stopped.

SUBAGENTS. A senior engineer to re-derive the current state from the repository rather than from the quote. An architect if the session was mid-decision, to finish the decision rather than inherit it.

DELIVER. A one-paragraph statement of where things stand, then the next concrete step, then do it.

DO NOT. Redo work the quote shows is already done, and do not commit or push.`,
  },
  {
    id: 'blank',
    label: 'Blank',
    blurb: 'Just the objects and your own instruction.',
    slots: ['card', 'task', 'mail', 'slack', 'sentry', 'notion', 'github', 'session', 'note'],
    defaultRepo: null,
    skills: [],
    instruction: NO_REPASTE,
  },
  {
    /**
     * The last row, because it is the last thing that happens.
     *
     * Every template above ends in a draft — "draft reply", "the reply text, in
     * my voice", "a short brief for me, then the reply" — and every one of them
     * spends its 1,200 characters on the finding rather than on the sentence.
     * So the sentence came back in whatever register the model reaches for by
     * default, which is a blog post with a greeting on it. This row is the
     * register, kept in one place, selectable on top of any of them.
     *
     * It sits below `Blank` in the picker on purpose. The list above it is a
     * list of jobs and you pick one; this is not another job, and putting it in
     * the middle of them would read as though choosing it meant not choosing
     * `Customer incident`.
     */
    id: 'humanizer',
    label: 'Humanizer',
    kind: 'voice',
    blurb: 'How the reply reads, not what to look into. Wear it over any template above.',
    // Every kind, like `blank`, and for the inverse reason: `blank` accepts
    // anything because it assumes nothing, this accepts anything because what
    // is attached has no bearing on how a sentence should sound.
    slots: ['card', 'task', 'mail', 'slack', 'sentry', 'notion', 'github', 'session', 'note'],
    defaultRepo: null,
    // A skill, not a second copy of the rules. The instruction below stands on
    // its own — a box without this catalog still gets the whole voice — and the
    // skill is where the longer version lives: the worked before/after pairs
    // that will not fit in 1,200 characters.
    skills: ['humanizer-voice'],
    // Not NO_REPASTE. That clause promises the identifiers are below and offers
    // a repository to work in, and neither half has anything to say to a
    // template whose entire subject is a sentence. What it keeps is the promise
    // that matters here: I am not being asked to write it myself.
    instruction: `Do not ask me to re-paste anything. Do not ask me to write the reply myself — write it.

VOICE. This section governs the words I will send, and nothing else. It replaces nothing else in this brief: the rest still says what to investigate, and none of it is softened. Where the work ends in a reply or an explanation, this is how it reads.

OBJECTIVE. Write what I paste into Slack. A person typed it, to someone waiting. Not a blog post, not a status report.

HOW IT READS. Short sentences. One idea each. The plainest word that is exact. The fact, then the cause if it is known, then the next step. Nothing else. If the cause is not known, say so in one sentence and say what happens next — do not pad the gap.

SUBAGENTS. A QA lead to read it back and cut any sentence that is not a fact, a cause or a next step.

DELIVER. The message itself, ready to paste.

DO NOT. No headings, no bullet-point essay, no greeting, no sign-off, no apology padding, no jargon, no filler. Never: "happy to help", "great question", "as an AI", "I hope this helps", "let me know if you have any questions", "circle back", "reach out", "deep dive", "leverage", "utilize", "good catch", "you're right".`,
  },
]

export const getTemplate = (id: string) => TEMPLATES.find(t => t.id === id) ?? null
