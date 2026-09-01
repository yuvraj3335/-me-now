/**
 * Launch templates.
 *
 * A template is a row in the UI, not a hidden string. Each one says which kinds
 * of object it expects to be handed, which skills the session should be told
 * about by *name* (never inlined — the session can read them itself), and the
 * opening instruction.
 *
 * Every instruction takes one skeleton — OBJECTIVE, ESTABLISH, SUBAGENTS,
 * EVIDENCE, DELIVER, DO NOT — so that selecting three concatenates into
 * something still readable rather than three essays in three shapes. They say
 * *what* to establish and what each part must return; they never spell out the
 * commands, because the flags drift and the objects do not. "Read the
 * environment-integration override" stays true across CLI releases; a command
 * line with `-p` and `-o json` in it does not.
 *
 * **Where the steps come from.** These are not a generic support desk written
 * down. Every ESTABLISH order was read back out of his own Claude Code history —
 * 99 sessions, ~570 turns, ~6,800 commands — and the ones that survived are the
 * ones the transcripts actually show. That is why they say things a generic
 * template would not: profiles read `yuvraj-<customer>-<env>` and the name in a
 * thread is usually approximate, so it is matched rather than trusted; `whoami`
 * runs on *every* environment named, because he names two or three and the bug
 * is usually in one of them; and the environment's mapping row is read before
 * the base row, because reading the base while the override is what runs is the
 * single most repeated way these investigations went wrong.
 *
 * ── What this file's last pass changed, and why ────────────────────────────
 *
 * **The shared clause left.** Nine of these instructions used to open with the
 * same 220 characters — "Every identifier you need is in the context below…" —
 * and the cap they are written against is 1,200. Seven of them sat within six
 * characters of that cap, so eighteen per cent of every template's budget was
 * one duplicated sentence, and the same sentence was *lost* entirely the moment
 * the operator typed an instruction of his own, because a typed instruction
 * replaces the template's. It lives in the brief now, in `renderPack`'s "How to
 * work from this", where it is said once, applies to a hand-typed brief too, and
 * costs no template anything.
 *
 * **The budget is 1,100 and it means something different.** The old number was
 * derived from `HANDOFF_MAX_CHARS`: a brief had to fit in a URL, so three long
 * instructions would push the evidence out of the link. That reason has expired.
 * A brief is now the argv of a real process — the kernel's limit on one argument
 * is 128KB, not 12,000 characters — and the URL is the fallback for when the box
 * is unreachable. So the cap is kept for the reason that was always the better
 * one: three of these can be selected together, and a session that meets three
 * thousand words of orders before it meets a single fact reads none of them
 * carefully.
 *
 * The new number moves both things in the right direction at once. Room for the
 * *job* goes up — a template used to get 1,200 minus a 220-character clause it
 * did not write, which is 980, and it now gets 1,100. The *worst case* goes
 * down: three long instructions were 3,594 characters and are now 3,196, because
 * the clause that was in all three is in the brief once instead.
 *
 * **SUBAGENTS names questions, not job titles.** It used to cast an architect, a
 * senior engineer and a QA lead. The casting was doing one useful thing and one
 * decorative one: it split the work into independent questions, and it dressed
 * them up as people. The split is what matters — and the clause that makes it
 * work was never written down, so it is written down now: *in parallel, none
 * reading another's answer*. A subagent that reads the first one's conclusion is
 * not a second opinion, it is an echo, and one of the three is always there to
 * argue the other two are wrong.
 *
 * **Voice is structurally separate.** `humanizer` is `kind: 'voice'`. It used to
 * be concatenated into `## What I need` alongside the investigations in click
 * order, which meant its own text had to open by announcing what it governed —
 * otherwise a session that met it above `Customer incident` read it as step one.
 * `buildPack` now lifts every voice template into its own `## How the reply
 * should read` section, always last, whatever order it was clicked in. The
 * announcement is no longer needed, and the ~200 characters it cost went back
 * into the voice rules.
 *
 * **Three templates were missing and are now here.** Twelve rows for a product
 * whose main verb is "send this to Claude", and not one of them was for *making
 * a change*: every row was an investigation, a review, a QA run or a reply,
 * while half the sessions on this machine are builds. `implement` is the biggest
 * of the three gaps. `scope-request` is the second — "can we support this" is a
 * different job from answering a thread and from reviewing code, and it is what
 * a partner or customer ask actually is. `green` is the third: `qa-branch`
 * reports and `review-pr` reads, and neither of them fixes a red command.
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
   * `investigation` is every row that says what to establish, who to put on it,
   * and what to hand back. `voice` says none of that — it governs the wording of
   * the message that leaves at the end, and is worn over an investigation rather
   * than instead of one.
   *
   * The distinction is load-bearing in two places rather than one. The picker
   * renders a modifier as a modifier instead of as another thing to investigate;
   * and `buildPack` lifts voice out of `## What I need` into its own section, so
   * a voice template can no longer land above an investigation and read as its
   * first step. That second one is why the type is on the template rather than
   * in the blurb's prose.
   *
   * Optional, and absent means `investigation`, because that is what almost
   * every row is and restating it once per row would be noise.
   */
  kind?: 'investigation' | 'voice'
  /** Item kinds this template is built to receive, in the order it wants them. */
  slots: SlotKind[]
  /** Repository name to default the working directory to, if it is present. */
  defaultRepo: string | null
  /**
   * Named, not inlined. The session resolves them from its own catalogs.
   *
   * "Its own" is the load-bearing part, and it has been wrong twice.
   *
   * The first time it was wrong by name: these read `truto-cli-toolbelt`,
   * `truto-mapping-tester`, `truto-safe-admin-operator` — names that exist only
   * under an old `Cursor-skills` tree — so every one arrived as an instruction to
   * load something unloadable, and a session handed three of them loaded an
   * unrelated skill instead.
   *
   * The second time it was wrong by *reach*, which is subtler and survived the
   * first fix. A Claude Code session resolves a name from `~/.claude/skills` and
   * from `<cwd>/.claude/skills`. Wake indexes three trees, and of the 32 skills
   * it indexes on this machine, 14 are in neither of those places: they are
   * loadable by nothing, and Wake was offering all 14 as chips in the composer.
   * A further 9 are project skills of `truto` alone, while `review-pr` — whose
   * `defaultRepo` is null — names one of them. `skillReaches` in
   * `src/server/skills/catalog.ts` answers that question against the directory
   * the session will actually run in, and `buildPack` drops what cannot be
   * reached and says so in the brief rather than issuing an order that cannot be
   * carried out.
   *
   * So the rule is: a name here has to be one the *receiving* session can load
   * where it will be running, and it should be one the history shows him
   * actually opening. `truto-cli` is on nearly every investigation row for both
   * reasons.
   */
  skills: string[]
  instruction: string
}

/**
 * The cap on one instruction, in characters, and the reason it is not the old one.
 *
 * 1,200 was about URLs — `HANDOFF_MAX_CHARS` is 12,000 for a whole brief, so
 * three long instructions pushed the packed evidence out of the link. A brief
 * travels as the argv of a real process now, where the kernel's limit on a
 * single argument is 128KB, so that reason has expired.
 *
 * What has not expired is the reason worth keeping: three of these can be
 * selected together, and a session that meets three thousand words of orders
 * before it meets a single fact reads none of them carefully. 1,100 raises what
 * a template gets for the actual job — it used to be 1,200 minus a 220-character
 * clause it did not write — while lowering the three-selected worst case from
 * 3,594 characters to 3,196, because that clause is now in the brief once
 * instead of in each of them. `test/launch.test.ts` holds both bounds.
 */
export const MAX_INSTRUCTION_CHARS = 1_100

export const TEMPLATES: Template[] = [
  {
    id: 'customer-incident',
    label: 'Customer incident',
    blurb: 'A customer report, taken to a root cause and a safe reply.',
    slots: ['slack', 'mail', 'sentry', 'card', 'task', 'session', 'note'],
    defaultRepo: 'truto',
    skills: ['truto-cli', 'truto-operator', 'truto-api-conventions'],
    instruction: `OBJECTIVE. Take this report to a root cause and a safe reply.

ESTABLISH, through the Truto CLI. Match the customer to a profile — they read yuvraj-<customer>-<env>, and the name in a thread is approximate. No profile for them? Stop and ask; do not guess an environment. Run whoami on every environment named, not just one. Read the environment's mapping row before the base row: reading the base while the override is what runs is how this goes wrong.

SUBAGENTS, in parallel, none reading another's answer. One reproduces it with the smallest safe READ. One names the layer — provider, config, environment override, mapping, sync runtime, or the customer's own call. One argues the other two are wrong.

EVIDENCE. Logs walked day by day back to the day it changed. The raw response beside the unified one. The mapping evaluated as deployed, not as catalogued.

DELIVER. Impact, evidence, layer, confidence, workaround, fix, then the draft reply.

DO NOT. Mutate anything. Send the reply.`,
  },
  {
    id: 'sentry-issue',
    label: 'Sentry issue',
    blurb: 'One stack trace to the line that produced it.',
    slots: ['sentry', 'card', 'task', 'session', 'note'],
    defaultRepo: 'truto',
    skills: ['truto-cli', 'truto-api-conventions'],
    instruction: `OBJECTIVE. Get from this stack trace to the line that produced it, and to a verdict on whether it is worth fixing.

ESTABLISH. The frame in our code rather than in a dependency, the release it started in, and how many tenants it reaches. A loud error hitting one account and a quiet one hitting all of them rank the other way round.

SUBAGENTS, in parallel, none reading another's answer. One traces the wrong value back to where it entered. One asks whether this shape of error is possible elsewhere in the same codebase. One writes the case that reproduces it. One argues we should not fix it.

EVIDENCE. The failing input, the code path, and a test that fails now for the stated reason. A provider returning something undocumented is a different fix from a defect of ours — say which, and quote it.

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
    instruction: `OBJECTIVE. Say whether this is safe to merge, and back every claim with something you ran.

ESTABLISH. The PR's real head, both repositories if the feature is two PRs, and local reconciled with remote before you read a line. Then a three-dot diff against main, opened in risk order: auth and enforcement first, then migrations and whether their numbering collides with main, then routers and services.

SUBAGENTS, in parallel, none reading another's answer. One hunts the alternate entry point — the door guarded on one route and not on another. One judges the approach on its own merits, having read no reviewer's comment. One names what would falsify each finding.

EVIDENCE. Commands, not readings: typecheck, targeted tests, lint on the changed files, a build. Assume you know nothing about this code; open the file.

DELIVER. Merge or do not, blocking findings in severity order, and every judgment call that needs my intent rather than yours.

DO NOT. Push, merge, or comment on the PR.`,
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
   * The cleanup rule comes straight off his own briefs: every run he wrote left
   * artefacts on a shared environment and every one of them ended with an order
   * to delete them by name. The hedge that used to sit beside it — "if something
   * looks suspicious but you are not fully certain, label it clearly as a likely
   * issue rather than stating it as fact" — has been promoted out of this row
   * into `renderPack`, because a confident wrong finding costs more than a hedged
   * right one in every job on this list, not only in this one.
   */
  {
    id: 'qa-branch',
    label: 'QA a branch',
    blurb: 'A branch that is deployed somewhere and needs exercising, not reading.',
    slots: ['github', 'card', 'task', 'session', 'note'],
    defaultRepo: null,
    skills: ['truto-cli', 'truto-api-conventions'],
    instruction: `OBJECTIVE. Exercise this branch as a senior QA engineer would, and report what broke.

ESTABLISH. What is deployed where, and get it running locally before UAT. Snapshot whatever you are about to change, so the run is reversible. Then take the path a customer takes, not the unit test's.

SUBAGENTS, in parallel, none reading another's answer. One on the happy path and its boundaries. One on the states nobody builds for: empty, one, many, expired, revoked, half-migrated. One on what the screen actually says when it fails.

EVIDENCE. Every finding is a request and a response, or a screenshot, with the environment it came from. Read the result back from the store, not from the UI that wrote it. Before a finding goes in the list, try to make it not be a bug: a half-set-up local is the commonest source of one that is not.

DELIVER. Findings in severity order, each with how to reproduce it and how to tell it is fixed. Then clean up: delete every job, record and file the run created, and put the checkout back as you found it.

DO NOT. Touch production. Fix anything unless I asked for it.`,
  },
  {
    id: 'slack-thread',
    label: 'Slack thread',
    blurb: 'A thread with a question in it that needs a real answer.',
    slots: ['slack', 'card', 'task', 'note'],
    defaultRepo: null,
    skills: ['truto-cli', 'truto-api-conventions'],
    instruction: `OBJECTIVE. Answer the question in this thread properly. Not an acknowledgement — the answer.

ESTABLISH. What is actually being asked, which is usually narrower than the thread's volume suggests. Read all of it before answering any part; the follow-up two messages down is often the real question. Then check the live config and the code, rather than what the product ought to do.

SUBAGENTS, in parallel, none reading another's answer. One verifies the claim against what is deployed. One asks whether the real question is "should we support this", because that answer outlives the thread.

EVIDENCE. Whatever you assert, you checked. If the answer depends on their environment, go and look at their environment. If we cannot do it, say what would have to change.

DELIVER. The answer: short, specific, technically direct, with a concrete example where an example beats a sentence. No restating their question back at them.

DO NOT. Post anything. Guess to fill a gap — name the gap.`,
  },
  {
    id: 'mail-thread',
    label: 'Mail thread',
    blurb: 'An email thread that needs work before it can be answered.',
    slots: ['mail', 'card', 'task', 'note'],
    defaultRepo: null,
    skills: ['truto-cli'],
    instruction: `OBJECTIVE. Work out what this thread needs before it can be answered, then draft the answer.

ESTABLISH. What is being asked and by when, what has already been promised in the thread, and whether any of that is now out of date. If it names a customer, an account or an integration, check the live state before writing a sentence about it.

SUBAGENTS, in parallel, none reading another's answer. One on the parts that are claims about the system rather than about the plan. One on whether the thread is really asking for a commitment about what we will support.

EVIDENCE. Separate what the thread asserts from what you confirmed. Anything unverified goes into the reply as a question, not as a statement.

DELIVER. A draft reply, short and plain, then the open items that are not mine to answer and who they belong to.

DO NOT. Send it. Commit to a date on my behalf.`,
  },
  {
    id: 'mapping',
    label: 'Mapping — unified vs proxy',
    blurb: 'A field is wrong, missing, or shaped differently than expected.',
    slots: ['card', 'task', 'session', 'note'],
    defaultRepo: 'truto',
    skills: ['truto-unified-mappings', 'truto-jsonata', 'truto-cli'],
    instruction: `OBJECTIVE. Say why this field is wrong, missing, or the wrong shape.

ESTABLISH. Whether the provider returns the field at all for this account, before anything else. Then which environment's mapping is live — the environment's row overrides the base, and reading the base while the override runs is how this goes wrong. Pull the deployed expression, not the catalog's, and the proxy response for the same record: both ends of the transform.

SUBAGENTS, in parallel, none reading another's answer. One evaluates the live expression against the real payload and against an edge case it crafts. One asks whether the unified model can hold what is being asked for, or whether this is a schema question in a mapping costume. One argues the mapping is right and the expectation is wrong.

EVIDENCE. Raw response, deployed expression and unified output side by side. Run it; do not read it and conclude.

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
    instruction: `OBJECTIVE. Say why this run failed, stalled, or wrote the wrong rows.

ESTABLISH. The runtime version first — V1 through V4 differ enough that a V4 answer is wrong for a V2 job, and it decides which code you are reading. Then the job's definition, the last runs and where each stopped, and the account behind it. Pagination, cursors and forks are where the stalls live.

SUBAGENTS, in parallel, none reading another's answer. One walks a single run from its trigger to the row it stopped on. One asks whether the job's shape suits the volume and the provider's paging. One says what a correct rerun looks like. One argues the job is fine and the provider changed under it.

EVIDENCE. The run's log over the window it failed in, the cursor where it stopped, and the provider's paging contract. A run that is stuck and a run polling a provider that stopped answering are different findings.

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
    instruction: `OBJECTIVE. Say whether this account can do what is being asked of it, and what it needs if it cannot.

ESTABLISH. Its status, its last error, the scope actually granted against the scope the integration asks for, and its capabilities as they are now rather than as the catalog describes them. Then the context the account carries: flags set at connect time are usually the answer, and they go stale when a provider's plan changes.

SUBAGENTS, in parallel, none reading another's answer. One proves the failure with the smallest read the account can still do. One decides whether this is a token, a scope, a plan, or a provider-side permission the customer has to change themselves.

EVIDENCE. The provider's own error text, not our paraphrase. Granted scope beside required scope. Say plainly whether reauthorizing fixes it or merely repeats it.

DELIVER. What is wrong, whose side it is on, whether reconnecting helps, and what to tell the customer.

DO NOT. Refresh, reconnect or revoke anything.`,
  },
  /**
   * Making a change, which nothing on this list used to be for.
   *
   * Twelve rows and every one of them was an investigation, a review, a QA run
   * or a reply — while the sessions actually running on this machine are as
   * often builds as they are diagnoses. Without this row the only way to ask for
   * a change was `Blank`, which is to say: with none of the four things that
   * separate a good implementation session from a bad one.
   *
   * Those four are what the instruction spends its budget on. Say what done
   * means before writing anything, because "it works" is not observable. Follow
   * the two or three places that already do something similar, because matching
   * a codebase beats being right in the abstract and is the difference between a
   * diff he can read and one he has to re-derive. Name the contract surfaces
   * *before* concluding there are none — the platform checklist exists because
   * that conclusion is usually wrong. And put a subagent on arguing for the
   * smaller version, because scope creep is the failure mode of this job in the
   * way that a confident wrong answer is the failure mode of the others.
   */
  {
    id: 'implement',
    label: 'Build a change',
    blurb: 'Make the change, in the shape this codebase already has.',
    slots: ['card', 'task', 'github', 'session', 'note', 'slack', 'mail'],
    defaultRepo: null,
    skills: ['platform-change-checklist', 'truto-api-conventions'],
    instruction: `OBJECTIVE. Make this change, and leave the repository in a state I can read and ship.

ESTABLISH, before you write a line. What "done" means here, stated as something observable. Then the existing shape: find the two or three places that already do something like this and follow them, because matching this codebase beats being right in the abstract. Name the contract surfaces it touches — schema, migration, route, CLI, docs — before deciding it touches none.

SUBAGENTS, in parallel, none reading another's answer. One writes the failing test first. One argues for the smaller version of this change. One hunts everything else that reads what you are about to alter.

EVIDENCE. Commands, not readings: typecheck, the test that failed before and passes now, and the suite that was green before still green. Say what you did not run.

DELIVER. The diff, what it does, what you decided and why, what is left, and the one thing you are least sure of.

DO NOT. Commit, push or open a PR unless I said so. Widen the change because something was nearby.`,
  },
  /**
   * "Can we do this?" — which is neither a thread to answer nor code to review.
   *
   * It is what a partner ask and half of his customer threads actually are, and
   * routing it to `slack-thread` gets an answer written before the feasibility
   * is known. The two orders that make it a different job are here: read the
   * *provider's* documentation before ours, because roughly half of these turn
   * out to be already possible and the answer is a config rather than a project;
   * and put one subagent on arguing we should not do it, because the cost of
   * saying yes is the part nobody writes down.
   */
  {
    id: 'scope-request',
    label: 'Can we do this?',
    blurb: 'A request for something we may or may not support — feasibility, shape and cost.',
    slots: ['slack', 'mail', 'card', 'task', 'notion', 'github', 'note'],
    defaultRepo: 'truto',
    skills: ['truto-api-conventions', 'truto-cli'],
    instruction: `OBJECTIVE. Say whether we can do what is being asked, what it would take, and what saying yes commits us to.

ESTABLISH. What is being asked for as a capability rather than as a feature name. Then what already exists: the provider's own API for it, whether our unified model already has a place for it, and whether another integration has solved the same shape. Roughly half of these are already possible and the answer is a config, not a project.

SUBAGENTS, in parallel, none reading another's answer. One reads the provider's documentation and says what is genuinely available. One reads our side and says where it would land. One argues we should not do it.

EVIDENCE. Quote the provider's own docs and name the endpoint. "It probably supports that" is not an answer. If it is possible today, prove it with a read against a real account.

DELIVER. Yes, no, or yes-with — in the first line. Then the shape of the work, which pieces are new, what we would be committing to maintain, and the question that is mine to answer rather than yours.

DO NOT. Promise a date. Build it.`,
  },
  /**
   * A red command, which is a different job from a review and from a QA run.
   *
   * `review-pr` reads a diff and `qa-branch` exercises a deployment; neither of
   * them fixes anything, and "pull latest and make the tests pass" is one of the
   * most common things in his history. The two orders worth the characters are
   * the ones that are skipped under time pressure: find out whether main is red
   * too, because a failure the branch inherited is somebody else's and fixing it
   * here hides it; and refuse the fix that makes the number go down without
   * making the thing work, by name, because that is the failure mode of every
   * agent asked to get to green.
   */
  {
    id: 'green',
    label: 'Get this to green',
    blurb: 'A failing test, build or typecheck, taken to passing — and to what was actually broken.',
    slots: ['github', 'card', 'task', 'session', 'note'],
    defaultRepo: null,
    skills: [],
    instruction: `OBJECTIVE. Get this back to green, and say what was actually broken.

ESTABLISH. The exact command that fails and its exact output, before any theory. Then whether it fails on main too — a failure the branch inherited is a different job from one it caused, and fixing it here hides it. Reconcile local with remote first; a stale checkout produces failures nobody else can reproduce.

SUBAGENTS, in parallel, none reading another's answer. One takes the first failure to its cause. One checks whether the rest are that same cause wearing different hats. One asks whether the test is wrong rather than the code.

EVIDENCE. The command, run again, in full, at the end. A test that passes because you changed what it asserts is not a fix — if changing the assertion is the right call, say so in those words and say what decision it encodes.

DELIVER. Green, or an honest count of what is still red and why. Then what was broken, in one paragraph, and whether it could ever have worked.

DO NOT. Skip, delete or quarantine a test to make a number go down. Commit or push.`,
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
     * It still does not assert which case it is in, because both are real: pick
     * a session and this lands in that session with its history above it; pick
     * `A new conversation` and the same session's tail arrives quoted, in the
     * same repository. One sentence cannot know which, so this asks rather than
     * claims — and "check what you can actually see" is the right first move
     * under either.
     *
     * What this pass added is where to look *instead* of the quote. The working
     * tree, the branch and the last commit are facts about right now; the quote
     * is a memory of a moment that has since moved, and it is frequently the
     * thing a resumed session gets wrong.
     */
    instruction: `Pick up the work below. It comes from a Claude Code session on this machine, in the repository named above.

You may be that session, still running, with everything above this message already yours — or a new one in the same directory, holding only what is quoted here. Look before you answer. If the earlier turns are above you, use them. If all you have is the quote, treat it as a handover note from someone who has stopped talking, and say so.

ESTABLISH. Where it got to, in your own words, from the repository rather than from the quote — the working tree, the branch and the last commit are facts about now; the quote is a memory. If your reading differs from what the last prompt implies, say so: that gap is usually why the session stopped.

SUBAGENTS. One re-derives the current state from the repository. One finishes any decision the session was in the middle of, rather than inheriting it.

DELIVER. One paragraph on where things stand, then the next concrete step, then take it.

DO NOT. Redo work the quote shows is done. Commit or push.`,
  },
  {
    /**
     * `Blank` is not an empty instruction.
     *
     * It used to be exactly the shared clause and nothing else, and when that
     * clause moved into the brief this row was left holding an empty string —
     * which renders as a `## What I need` heading with nothing under it. That is
     * worse than no template at all.
     *
     * What belongs here instead is the one order that is right when Wake does
     * not know what the job is: do not pick one for me. A model handed five
     * objects and no instruction will invent a plausible task and start on it,
     * and the wrong plausible task is more expensive than a question.
     */
    id: 'blank',
    label: 'Blank',
    blurb: 'Just the objects and your own instruction.',
    slots: ['card', 'task', 'mail', 'slack', 'sentry', 'notion', 'github', 'session', 'note'],
    defaultRepo: null,
    skills: [],
    instruction: `OBJECTIVE. Whatever I typed. If I typed nothing, that is the situation this row is for: read the context below, tell me in two lines what you think it is asking for and what you would do about it, and ask me the one question that would settle it. Then stop and wait. Do not choose a job for me and start on it.`,
  },
  {
    /**
     * The last row, because it is the last thing that happens.
     *
     * Every template above ends in a draft — "draft reply", "the answer", "a
     * short brief for me, then the reply" — and every one of them spends its
     * budget on the finding rather than on the sentence. So the sentence came
     * back in whatever register the model reaches for by default, which is a
     * blog post with a greeting on it. This row is the register, kept in one
     * place, selectable on top of any of them.
     *
     * It sits below `Blank` in the picker on purpose, under its own heading. The
     * list above it is a list of jobs and you pick one; this is not another job.
     *
     * **It no longer has to announce its own scope.** The first three sentences
     * of this instruction used to be "VOICE. This section governs the words I
     * will send, and nothing else. It replaces nothing else in this brief…",
     * spent entirely on defending against its own position: `buildPack`
     * concatenated in click order, so clicking this first put it above `Customer
     * incident`, where a session read it as step one of the investigation. That
     * was a workaround for a structural problem, and the structure is fixed —
     * voice is lifted into `## How the reply should read`, always last. The
     * ~200 characters went back into the rules, and one of them is new:
     * `WHAT IT IS NOT`, which bans the two evasions a model reaches for when it
     * is asked to write in somebody's voice and is not sure it can — handing
     * back options to choose between, and explaining the message before giving
     * it.
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
    // that will not fit in the budget.
    skills: ['humanizer-voice'],
    instruction: `OBJECTIVE. Write the message I will paste into Slack. A person typed it, to someone who is waiting. Not a blog post, not a status report.

HOW IT READS. Short sentences. One idea each. The plainest word that is exact. The fact, then the cause if it is known, then the next step. Nothing else. If the cause is not known, say so in one sentence and say what happens next — do not pad the gap.

WHAT IT IS NOT. Do not ask me to write it. Do not hand me two versions to choose between. Do not explain the message before giving it, and do not summarise it afterwards.

SUBAGENTS. One reads it back and cuts every sentence that is not a fact, a cause or a next step.

DELIVER. The message itself, ready to paste.

DO NOT. No headings, no bullet-point essay, no greeting, no sign-off, no apology padding, no jargon, no filler. Never: "happy to help", "great question", "as an AI", "I hope this helps", "let me know if you have any questions", "circle back", "reach out", "deep dive", "leverage", "utilize", "good catch", "you're right".`,
  },
]

export const getTemplate = (id: string) => TEMPLATES.find(t => t.id === id) ?? null

/** The rows that say what to find out, in the order the picker prints them. */
export const investigations = () => TEMPLATES.filter(t => (t.kind ?? 'investigation') === 'investigation')

/** The rows that govern how the reply reads. Lifted out of `## What I need`. */
export const voices = () => TEMPLATES.filter(t => t.kind === 'voice')
