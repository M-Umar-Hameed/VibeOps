// GET /tickets folds `sandbox` into review rows, so the list needs no
// per-ticket /sandbox request (QW4 removed that N+1).
export type Ticket = { id: string; title: string; status: string; version: number; body: string | null; sandbox?: { exists: boolean; lastVerdict?: string | null } };
export type Agent = { name: string; roles: string[]; models?: { name: string }[] };
export type Skill = { name: string };
export type SandboxStatus = { exists: boolean; branch?: string; lastVerdict?: string; protectedViolation?: string[] };
export type Diff = { diff: string };
export type DoctorStatus = { name: string; binary: string; probe: { ok: boolean; error?: string }; auth: { known: boolean; connected: boolean | null }; lastChecked: string };
export type SandboxActivityFile = { path: string; status: "A" | "M" | "D"; additions: number; deletions: number };
export type SandboxActivityData = { stage: string; files: SandboxActivityFile[]; totalAdditions: number; totalDeletions: number; lastChangeAt: string };
export type ModelOption = { agent: string; model: string; label: string };

export const parseSel = (s: string) => { const [agent, model] = s.split("::"); return { agent, model }; };
export const SELECTED_TICKET_KEY = "vibeops.forgeSelectedTicketId";
