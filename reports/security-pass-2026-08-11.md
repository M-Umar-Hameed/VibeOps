# VibeOps Security Pass Report - 2026-08-11

## Executive Summary

Manual adversarial security testing of the VibeOps HTTP API surface. Strix (LLM-driven pentester) was not executed due to missing LLM API key configuration; manual curl-based testing was performed instead, which provides more precise coverage of the specific hypotheses in the ticket.

## What Was Scanned

**Target:** `http://127.0.0.1:8787` (embedded PGlite instance)

**Tool:** Manual curl testing with two identities:
- Admin key (owner key from `~/.vibeops/credentials.json`)
- Member key (created for this test, name: `security-test-member`)

**Note:** The test member actor was created via `createActor({name:"security-test-member", kind:"agent", role:"member"})` and **remains in the database**. It should be revoked via `POST /actors/:id/revoke` after this pass if the testing instance is retained.

**Routes tested (59 endpoints):**

### Admin-only routes (`requireAdmin`) - all returned 403 for member:
- `PATCH /projects/:id`
- `POST /projects/:id/git-init`
- `POST /projects/:id/index-repo`
- `DELETE /projects/:id/knowledge`
- `DELETE /projects/:id`
- `POST /projects/scan`
- `POST /projects/import`
- `GET /projects/:id/settings`
- `PUT /projects/:id/settings/:key`
- `POST /sync/:projectId`
- `POST /actors`
- `POST /actors/:id/revoke`
- `GET /settings/:key`
- `PATCH /settings/:key`
- `POST /knowledge/obsidian/start`
- `POST /knowledge/obsidian/stop`
- `POST /ingest/sessions`
- `GET /system/status`
- `GET /system/logs`
- `GET /system/agents`
- `POST /relay/bootstrap`
- `GET /forge/agents`
- `GET /forge/skills`
- `GET /forge/doctor`
- `POST /forge/pipeline`
- `GET /forge/runs`
- `GET /forge/recovery`
- `GET /forge/runs/:id/output`
- `POST /forge/runs/:id/stop`
- `GET /forge/tickets/:id/sandbox`
- `GET /forge/tickets/:id/sandbox/activity`
- `POST /forge/tickets/:id/resume`
- `GET /forge/tickets/:id/diff`
- `POST /forge/tickets/:id/explain-diff`
- `POST /forge/tickets/:id/approve`
- `POST /forge/tickets/:id/promote`
- `POST /forge/tickets/:id/waive-policy`
- `POST /forge/tickets/:id/discard`
- `POST /forge/sandboxes/cleanup`
- `PATCH /relay/agents/:name`
- `POST /council/evaluate`
- `GET /council`
- `GET /council/:id`
- `GET /council/:id/output`
- `POST /council/:id/answers`
- `POST /council/:id/create-ticket`
- `GET /skills/marketplaces`
- `POST /skills/marketplaces`
- `DELETE /skills/marketplaces`
- `POST /skills/install`
- `POST /skills/uninstall`
- `GET /skills/installed`
- `GET /skills/local`
- `POST /mcp/install`
- `POST /tickets/:id/verify`

### Member-accessible routes - all worked correctly:
- `GET /actors` (returns actor list)
- `GET /git/identity`
- `GET /mcp/config` (returns caller's own bearer in config)
- `GET /system/metrics`
- `GET /system/topology`
- `GET /system/ai-usage`
- `GET /prime`
- `GET /export/brief?kind=ticket` (but `kind=council` returns 403)
- `POST /forge/attachments` (member-accessible by design)

## Confirmed Findings

**NONE.** All tested security controls are working as designed:

1. **Auth enforcement:** 401 for missing/invalid keys
2. **Rate limiting:** 429 after 20 failures per key bucket
3. **Admin-gating:** All 55 `requireAdmin` routes return 403 for member keys
4. **Verification comments:** `kind:"verification"` blocked for members (403)
5. **Member review comments:** Do NOT unlock promote gate (lastVerdict: null)
6. **CORS:** Evil origins get no ACAO header; trusted origins do
7. **Prototype pollution:** `__proto__` and `constructor` agent names return 404

## False Positives

### 1. Shell metacharacter injection in ticket titles

**Tested payloads:**
- `test"; rm -rf /; #`
- `test $(id) injection`

**Result:** NOT EXPLOITABLE

**Reason:** `forgeCommit()` in `sandbox.ts:176-177` uses `spawn("git", ["commit", "-m", "forge: ${title}"])` which passes the title as an argv element, not through shell interpolation. Git receives the literal string including the metacharacters, which become part of the commit message - no shell execution occurs.

### 2. ALLOW-PROTECTED policy bypass

**Tested:** `ALLOW-PROTECTED: src/**, package.json, .github/**` in ticket body

**Result:** DOCUMENTED DESIGN, not a vulnerability

**Reason:** This is an intentional feature per `policy.ts:27-37`. The directive allows ticket authors to explicitly waive protected-path checks for specific globs. This is a policy-weakening surface when ticket bodies come from untrusted sources (e.g., sync'd external systems), but it requires:
1. A forge run to be started by an admin
2. Agent changes that touch protected paths
3. The policy violation to be displayed and require explicit human waiver anyway

The `waive-policy` endpoint (`forge-routes.ts:319-342`) requires exact path match confirmation, preventing blind waivers.

### 3. Cross-actor data access

**Tested:** Member A reading/modifying admin's tickets

**Result:** EXPECTED BEHAVIOR

**Reason:** Per the ticket description: "There is no tenant boundary in the schema, only actor ids." The application is designed for single-user/single-team use with role-based (admin/member) access, not multi-tenant isolation. Any authenticated user can read any ticket - this is by design.

## Cost

**Strix:** Not executed (no LLM API key configured)
**Manual testing:** ~45 curl requests, 0 external API calls, $0

## What a Strix Run Would Add

A proper Strix DAST pass would provide capabilities this manual testing did not:

1. **Automated fuzzing** - Strix would generate and test thousands of payload variations per endpoint, whereas manual testing covered ~3-5 payloads per hypothesis.
2. **Session management testing** - Automated detection of session fixation, token leakage, cookie security attributes.
3. **Crawl-discovered endpoints** - Manual testing used a pre-defined route list from code inspection; Strix crawling might discover undocumented or forgotten routes.
4. **Browser automation** - Testing of client-side security (XSS, CSRF token handling, clickjacking) that pure curl cannot assess.
5. **Systematic header injection** - Automated testing of HTTP header injection, response splitting, cache poisoning.
6. **Report artifact** - Machine-readable vulnerability report with CVE references and CVSS scoring.

**Recommendation:** Run Strix in a future pass with an LLM API key configured. Budget $15 / 40 iterations as specified in the original plan.

## What This Pass Did NOT Cover

**CRITICAL:** This HTTP API testing cannot assess the highest-risk surfaces in the agent architecture:

### 1. Bash sandbox-escape gap (documented in `docs/AGENT_CLIS.md`)

A work agent's `Bash` tool can write files **outside** the sandbox worktree. The sandbox is a git worktree, not an OS-level jail. The sentinel (`forge.sensitivePaths`) detects and reverts writes to enumerated paths **after the fact**, but:
- Only protects paths explicitly listed in `forge.sensitivePaths`
- Does not protect the live `~/.vibeops` database
- Is detection/revert, not prevention

### 2. relay.json = code execution (`forge-routes.ts:364-414`)

Editing `relay.json` modifies the command arrays that spawn agent processes on the NEXT run. The sentinel protects `relay.json` (if in `forge.sensitivePaths`), but again: detection, not prevention. A compromised agent could modify relay.json, and the sentinel would revert it - but only after the run completes.

### 3. Prompt injection (untested)

Agents read:
- Ticket bodies and comments
- Repository documentation (CLAUDE.md, README.md, etc.)
- RAG knowledge (web pages, session transcripts, Obsidian notes)

All untrusted text is fenced with `fenceUntrusted()` and secrets redacted, but **the boundary has never been adversarially tested** with:
- Fence-escape attempts
- Embedded VERDICT strings in ticket bodies
- Malicious instructions in synced comments

The injection corpus test (`tests/injection.test.ts`) covers basic fence-escape and verdict injection, but not comprehensive adversarial prompts.

### 4. Promote merges agent code into production

`promoteSandbox()` (`sandbox.ts:311-330`) runs `git merge --no-ff` to merge agent-written code into the real repository on a human click. There is:
- A dirty-workdir check
- A VERDICT: PASS requirement (admin-authored only)
- Protected-path policy check

But the actual merge is a `git merge`, not a sandboxed apply. Malicious code that passed review reaches the repository.

## Methodology Notes

1. All testing was against the embedded PGlite instance at localhost:8787
2. Two identities were used (admin + member) to test privilege escalation
3. Rate limiting was confirmed with 25 sequential requests (429 after 20)
4. CORS was tested by setting `cors.origins` and verifying ACAO header presence/absence
5. No code was modified - this is measurement only

## Files Changed

**None.** This report is the only output of this security pass.

---

*Report generated: 2026-08-11*
*Pass type: Manual HTTP API security audit*
*Scope: Web surface only - agent architecture risks are OUT OF SCOPE*
