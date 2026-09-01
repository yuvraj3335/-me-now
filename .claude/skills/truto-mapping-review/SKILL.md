---
name: truto-mapping-review
description: Strict audit of a Truto integration's proxy config and unified API mappings — account/auth setup, proxy resource-method correctness against provider docs, unified schema conformance, JSONata response/query/body mappings, dynamic dispatch safety, and live read-only validation. Use when asked to review, audit, verify, QA or sanity-check unified mappings or an integration config, to check a mapping PR or a newly added method, or to find why a unified endpoint returns wrong or missing fields. Produces severity-ranked findings with evidence, never a vague approval.
---

> **Copy — do not edit here.** Canonical source is `truto/.claude/skills/`; resync with `truto/scripts/sync-mapping-skills.sh`. Paths and `yarn` commands below refer to the `truto` backend repo.

# Reviewing Truto proxy + unified mappings

**Load `truto-mapping-reference` first** — it is what you check the config *against*.
Review only: do not mutate catalog or config unless the user explicitly asks for fixes.

## Inputs to establish before starting

Integration slug, unified model, resource(s) and method(s) in scope, a test integrated
account id, and the provider's official docs. If the account or docs are missing, review
what you can from config and say plainly which sections you could not evidence.

## Safety

- Read-only by default: `list` and `get`.
- **No live `create` / `update` / `delete` without explicit approval in this conversation.**
  Per-call, not blanket. For mutating methods, review config and docs, plus a fake-id test
  *only* when the failure provably happens before the upstream mutation.
- `get` needs a real id — take it from a `list` response, never invent one.

---

## What to check

### 1. Account and integration config
Account exists, is active, belongs to the expected integration and environment.
Auth method and credential shape. Integration-level `base_url` and placeholder
substitution, `headers`, `authorization`, `query`, `query_array_format`, `pagination`,
`rate_limit`, `error_expression`. Every proxy resource referenced by a mapping exists in
`config.resources`.

### 2. Proxy resource-methods
For each one a mapping targets, against the provider's docs: HTTP method, path and
placeholder sources, static query and headers, `body_format`, `response_path` versus the
real response shape, `pagination` config on list endpoints, `query_array_format` versus
what the provider parses, `scopes`, `base_url` override.

### 3. Unified schema conformance
Exposed methods match the intended support matrix. `response_mapping` emits **only** fields
in the unified schema. Required schema fields are populated whenever the provider response
can supply them. Enums match the schema's values. `date-time` fields are real ISO strings.
Arrays and nested objects match the declared shape. `is_partial_response` set where the
method structurally cannot fill core fields.

**Semantic correctness is the part that gets skipped and matters most.** Check meaning, not
just shape:
- the provider's own record id maps to unified `id`
- foreign ids appear only inside their correct nested reference object
- no unrelated id reused to satisfy a required field
- names, statuses, owners, orgs, users, dates carry their generic unified meaning
- compare against a sibling integration's mapping for the same resource — a field that means
  something different here than everywhere else is a finding

### 4. JSONata
Parses. Every referenced provider field exists in the docs or an observed response.
Every conditional branch returns the same unified shape. Type coercion is explicit
(string mappings coerce nothing). `$firstNonEmpty` order is sensible. `$mapValues` cannot
leak an unmapped provider value into a closed enum — reference §13; this is a common real
defect. Booleans survive. Arrays are not accidentally nested or flattened. Null/empty values
do not fabricate a required field.

Run each branch through `truto unified test-mapping` (response_mapping) or
`truto jsonata eval` (everything else) with a representative sample.

### 5. Query and body schemas
Field names follow unified naming, not provider naming, unless unavoidable — and where
unavoidable the `description` explains it. Non-response-schema fields are justified by
routing, path construction or a provider requirement. `required: true` present wherever
its absence would let an unsafe default through. `query_mapping` sends only documented
provider params. Body: only writable fields on update; no destructive defaults; PUT-replace
semantics considered.

### 6. Dispatch and steps
Every dynamic branch selects the right proxy resource/method. Unsupported branches fail
**before** the upstream call. An unconditional selector is last and is not on a destructive
method. `before` steps run only when needed and their response paths are right. Fallback
ids or placeholder defaults cannot produce a destructive or misleading call. `path_mapping`
cannot construct an invalid or provider-leaking path except as an intentional safe failure.

### 7. Live read-only validation
Safe `list` per resource; verify empty-list behaviour on empty resources; `get` on an id
from a list. Compare live unified output against the schema, and live proxy output against
what `response_mapping` assumes.

If live output contradicts the config, check the mapping cache before concluding the config
is wrong — up to ~23 minutes of staleness, reference §11.

---

## Output

Findings first, ordered by severity.

**High** — can call the wrong endpoint, mutate the wrong resource, lose data, fall back
unsafely, break auth or base URL, or return wrong ids.
**Medium** — schema mismatch, misleading field mapping, missing required query/body schema,
bad enum or date shape, incomplete pagination, wrong `response_path`.
**Low** — unclear descriptions, naming, missing optional fields, docs polish.

Per finding:

- resource / method, and mapping or config id where available
- what is wrong, in plain words
- why it matters — the concrete failure, not a restatement
- recommended fix

Then:

- **Verified OK** — what you actively checked and found correct
- **Commands run** — so the user can reproduce
- **Not tested** — every gap, and why

## Standard of proof

Be strict, and be honest about evidence. Do not give a vague approval, and do not pad the
list with speculation to look thorough — a finding you cannot evidence is noise that costs
the user a real investigation.

State each finding's basis: read in config, confirmed against docs, or observed live. Where
you are uncertain, say exactly which piece of evidence is missing and what would settle it.
"Verified OK" means you checked it — not that you did not look.
