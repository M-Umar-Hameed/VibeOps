# Finding: Security-Testing Capability for VibeOps

**Date:** 2026-08-11
**Status:** Investigation complete
**Recommendation:** Wrap Strix, gated on building a new container isolation tier and an authorization/scope record first. If the isolation tier is not funded, drop the capability entirely.

---

## Executive Summary

VibeOps already has roughly 60% of a pentest platform under different names (ticketing, run pipeline, knowledge index, audit trail). The critical missing pieces are an HTTP intercepting proxy, a target-scope authorization record, and a container-level exploitation sandbox isolated from the operator machine. **The current sandbox model runs agents on the host OS with a known Bash escape; running adversarial exploit code under it would be reckless.** Wrap Strix as an external tool rather than reimplementing it, but only after the isolation and authorization gaps are closed. If those are not funded, do not ship the capability.

---

## Q1: What VibeOps Already Has

A pentest platform needs: findings storage, reproduction runs, multi-tool dispatch, isolated execution, gated verdicts, evidence retrieval, and injection defense. VibeOps has all of these under different names.

| Pentest Primitive | Existing Subsystem | Evidence |
|---|---|---|
| **Finding = Ticket** | Tickets table + events audit trail | `src/services/tickets.ts:8-88` (createTicket/updateTicket insert events); `src/db/schema.ts:52-63` (events table: "Append-only. No UPDATE, no DELETE, ever.") |
| **Reproduction = Run** | Forge run pipeline | `src/forge/runs.ts:243-345` (startPipeline), `src/forge/runs.ts:376-538` (pipeline stages) |
| **Multi-tool dispatch** | Relay lanes with role-based routing | `src/relay/dispatch.ts:10-19` (unified dispatch point); `src/forge/router.ts:13-61` (plan/work/review roles, cheapest/quality routing, escalate) |
| **Isolated execution attempt** | Git worktree sandbox | `src/forge/sandbox.ts:160-169` (ensureSandbox creates worktree); `src/forge/sandbox.ts:311-330` (promoteSandbox); `src/forge/sandbox.ts:336-356` (cleanup) |
| **Gated verdict** | Review stage + protected-paths policy | `src/forge/runs.ts:556-616` (reviewStage, verdict determines pass/reject); `src/forge/verify.ts:36-68` (computeVerificationStatus); `src/forge/policy.ts:5-67` (protected paths + ALLOW-PROTECTED waiver) |
| **Evidence retrieval / prior-finding memory** | pgvector knowledge index | `src/services/knowledge.ts:193-228` (searchKnowledge cosine similarity); `src/db/schema.ts:81-95` (embeddings table, 1024-dim vector) |
| **Injection defense** | Untrusted fencing in prompts | `src/relay/prompts.ts:11-17` (fenceUntrusted + UNTRUSTED_CLAUSE) |

**Conclusion:** A significant portion of a pentest platform's infrastructure already exists. Findings are tickets; reproductions are runs; the review gate is the verdict; the knowledge index is the evidence store.

---

## Q2: What Is Genuinely Missing

Three capabilities have no equivalent in the codebase:

### 1. HTTP Intercepting Proxy

**Searched:** `proxy`, `intercept`, `mitmproxy`, `burp` (case-insensitive) across `src/`.
**Result:** Zero matches.
**Nearest existing thing:** `src/mcp/server.ts` is an MCP *server*, not an HTTP intercepting proxy. It exposes tools over MCP; it does not sit in-line on target traffic.
**Why it does not substitute:** A pentest proxy records, replays, and mutates HTTP traffic to/from a target application. The MCP server does none of this.

### 2. Target Scope Definition (Authorization Record)

**Searched:** `target.*scope`, `scope.*target`, `allowlist`, `CIDR` across `src/`.
**Result:** One hit — `src/api/app.ts:53-55` — which is the CORS origin allowlist, unrelated to attack-target scoping.
**Nearest existing thing:** `src/api/auth.ts:30-72` has actor roles (member/admin) and `src/forge/policy.ts` has protected-path globs. Neither defines "what hosts/URLs may this run attack."
**Why it does not substitute:** Actor authorization answers "who may use VibeOps." Protected-path policy answers "which files may this run edit." Neither answers "which network targets is the operator authorized to test." Without a scope record, there is no enforceable boundary between a security tool and an attack tool.

### 3. Container/VM Exploitation Sandbox

**Searched:** `docker`, `container`, `VM`, `chroot`, `namespace`, `firejail`, `bubblewrap` across `src/`.
**Result:** One hit — `src/api/degraded.ts:20` — which is documentation text about running pg_resetwal in a Postgres container, not runtime isolation.
**Nearest existing thing:** The git worktree sandbox (`src/forge/sandbox.ts`). `docker-compose.yml` runs Postgres only, not agents.
**Why it does not substitute:** A git worktree is a filesystem boundary, not a process/network boundary. Agents run as host processes with full network access. See the isolation gap section below.

---

## Q3: The Isolation Gap

### Current Model

Work agents run **on the host OS, not in a container**. The SDK lane guards Write/Edit by realpath prefix check:

- `src/relay/invoke-sdk.ts:30-50` — `checkToolPermission` verifies the target path starts with the sandbox prefix.
- `src/relay/invoke-sdk.ts:35-37` — **Bash is allowed unguarded.** The comment states: "a `cd /elsewhere && ...` is out of scope for Phase 1 (documented limitation)."
- `src/relay/invoke.ts:79` — The CLI lane spawns the agent with `cwd = workdir` but applies **no write guard at all**.

The only backstop is post-hoc host-file restore:

- `src/forge/sentinel.ts:14-78` — After the work stage, `detectAndRestore` compares hashes of sensitive paths (relay.json, credentials.json) and reverts changes. This is detection-after-the-fact, not prevention.

### Why This Is Reckless for Exploit Code

Adversarial exploit code:

1. Spawns arbitrary processes.
2. Opens network sockets to arbitrary hosts.
3. May itself be hostile (a proof-of-concept that "escapes" by design).

Running such code on the host OS with no network namespace, no mount namespace, and a documented Bash-escape path means:

- The exploit can reach any host the operator machine can reach.
- The exploit can write anywhere the operator user can write.
- A hostile payload can persist on the operator machine.

**This is not a hardening gap; it is a category mismatch.** The current sandbox model is designed for *trusted* coding agents editing *your own* codebase. Exploit code is *untrusted* by definition.

### Required Isolation Boundary (New Tier)

To run adversarial exploit code safely, VibeOps would need a **new isolation tier**, not the current sandbox hardened. Minimum requirements:

| Requirement | Rationale |
|---|---|
| Network-namespaced container or VM per run | Egress is default-deny; the exploit cannot reach unscoped targets. |
| Egress allowlist populated from the scope record | Only declared-in-scope hosts/ports are reachable. |
| No host filesystem mount beyond a scratch volume | The exploit cannot read or write the operator's files. |
| No host credentials in the container environment | The exploit cannot exfiltrate API keys, SSH keys, or OAuth tokens. |
| Kill-on-timeout | A hung or malicious exploit is forcibly terminated. |

This is **net-new infrastructure** (weeks, security-critical). It is not achievable by patching the existing git-worktree sandbox.

---

## Q4: Buy, Wrap, or Build?

### Build — Rejected

Reimplementing Strix's scanning logic would duplicate a mature, Apache-2.0-licensed project. The value VibeOps could add is in orchestration (ticketing, evidence, audit), not in vulnerability-detection heuristics. Building the scanner is unjustified.

### Wrap — Recommended (Gated)

Invoke Strix (or another mature scanner) as an external tool inside a new isolated run lane. VibeOps owns:

- **Scope record and authorization gate:** No scope → no run.
- **Ticketing and evidence storage:** Findings become tickets; proofs become comments.
- **Audit trail:** The append-only events table records who authorized what.
- **Egress binding:** The isolation tier's network allowlist is populated from the scope record.

This is the product: supervised, auditable, scope-bound security testing.

### Drop — The Safe Default

If the isolation tier is not funded, or if legal/compliance review rejects hosting an attack tool, ship nothing. A partially-isolated attack tool is worse than no attack tool.

---

### Case Against the Recommendation

Even with the "wrap, gated" recommendation, there are strong reasons to proceed cautiously or not at all:

1. **Strix is Docker+Python; VibeOps is Node/host-process.** Wrapping Strix forces VibeOps to depend on a container runtime and define an IPC surface (stdio, temp files, or socket) that it has so far avoided. This is real integration complexity, not just a function call.

2. **The isolation tier is net-new, security-critical infrastructure.** It is not a wrapper. It is weeks of work, requires security review, and introduces operational surface area (container images, network policies, egress auditing).

3. **Legal and liability exposure.** An automated attack tool, even one with authorization gates, carries legal risk a self-hosted ops console may not want to own. Operators must attest authorization; if that attestation is false, VibeOps is the instrument of the attack.

4. **Distraction cost.** Building this capability diverts engineering from the core product (supervised coding agents). The overlap in infrastructure is real (ticketing, audit) but the new surface is large.

**If the isolation tier is not funded and completed first, the recommendation degrades to DROP.**

---

## Authorization & Scope (Design, Addressed Not Deferred)

### Requirement

Automated exploitation must only run against systems the operator is authorized to test. This is the legal and ethical boundary between a security tool and an attack tool. It must be enforced in the design, not deferred to documentation.

### Design

#### 1. Per-Target Authorization Record

A new ticket kind or required ticket field carrying:

| Field | Content |
|---|---|
| `scope` | Host/CIDR/URL allowlist (JSON array of strings). |
| `authorization` | Operator attestation of authorization (free-text or checkbox "I am authorized to test these targets"). |
| `authorizedAt` | Timestamp. |
| `authorizedBy` | Actor ID. |

This record is persisted like any ticket. The `events` table (`src/db/schema.ts:52-63`) is the audit trail — no new audit infrastructure required.

#### 2. Enforcement Point: Refuse-to-Run

The exploit run lane **refuses to start** unless a valid scope+authorization record exists for the ticket. This mirrors existing patterns:

- `src/services/tickets.ts:54-60` — `requiresVerification` blocks close without a verification comment.
- `src/forge/policy.ts:28-37` — `ALLOW-PROTECTED:` waiver pattern.

The gate is: **no scope record → lane refuses to run.** This is not a warning; it is a hard block.

#### 3. Egress Binding

The isolation tier's network egress allowlist is populated **from** the scope record. An out-of-scope packet is dropped at the network namespace, not just refused at the application layer.

Authorization is enforced twice:

1. **App gate:** Run lane refuses to start without a scope record.
2. **Network gate:** Container egress is restricted to scoped hosts only.

This defense-in-depth ensures a compromised or buggy scanner cannot reach unscoped targets.

### Explicit Statement

**No scope record → the exploit lane refuses to run.** This is the difference between a security tool and an attack tool. It is non-negotiable and must be implemented before any exploit-code capability ships.

---

## Summary

| Question | Answer |
|---|---|
| Q1: What exists? | Ticketing, run pipeline, knowledge index, audit trail, injection defense — roughly 60% of a pentest platform. |
| Q2: What's missing? | HTTP intercepting proxy, target scope/authorization record, container isolation sandbox. |
| Q3: Isolation gap? | **Critical.** Host-process execution with documented Bash escape. Running exploit code under it is reckless. Requires a new container/VM isolation tier. |
| Q4: Recommendation? | **Wrap Strix, gated on isolation tier + authorization record.** If isolation is not funded, **drop**. |

---

## Appendix: File References

| Claim | File | Lines |
|---|---|---|
| Ticket creation + events audit | `src/services/tickets.ts` | 8-88 |
| Events table append-only | `src/db/schema.ts` | 52-63 |
| Run pipeline start | `src/forge/runs.ts` | 243-345 |
| Pipeline stages | `src/forge/runs.ts` | 376-538 |
| Relay dispatch | `src/relay/dispatch.ts` | 10-19 |
| Role routing + escalate | `src/forge/router.ts` | 13-61 |
| Worktree sandbox creation | `src/forge/sandbox.ts` | 160-169 |
| Promote sandbox | `src/forge/sandbox.ts` | 311-330 |
| Cleanup sandbox | `src/forge/sandbox.ts` | 336-356 |
| Review stage + verdict | `src/forge/runs.ts` | 556-616 |
| Verification status | `src/forge/verify.ts` | 36-68 |
| Protected-paths policy | `src/forge/policy.ts` | 5-67 |
| Knowledge search | `src/services/knowledge.ts` | 193-228 |
| Embeddings table (pgvector) | `src/db/schema.ts` | 81-95 |
| Untrusted fencing | `src/relay/prompts.ts` | 11-17 |
| SDK write guard | `src/relay/invoke-sdk.ts` | 30-50 |
| Bash unguarded (documented) | `src/relay/invoke-sdk.ts` | 35-37 |
| CLI lane no guard | `src/relay/invoke.ts` | 79 |
| Sentinel restore | `src/forge/sentinel.ts` | 14-78 |
| Actor roles + requireAdmin | `src/api/auth.ts` | 30-72 |
| MCP server (not proxy) | `src/mcp/server.ts` | 59-62 |
| CORS allowlist (not scope) | `src/api/app.ts` | 53-55 |
| docker-compose Postgres only | `docker-compose.yml` | 1-14 |
| requiresVerification close-block | `src/services/tickets.ts` | 54-60 |
| ALLOW-PROTECTED waiver pattern | `src/forge/policy.ts` | 28-37 |
