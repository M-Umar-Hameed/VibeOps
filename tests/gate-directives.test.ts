import { expect, test } from "vitest";
import { app } from "../src/api/app.js";
import { createActor } from "../src/services/actors.js";
import { createProject } from "../src/services/projects.js";
import { createTicket, updateTicket } from "../src/services/tickets.js";
import { getTicket } from "../src/services/history.js";
import { ForbiddenError } from "../src/services/errors.js";

function uniq(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function setup() {
  const { actor: admin, apiKey: adminKey } = await createActor({ name: uniq("gd-admin"), kind: "human", role: "admin" });
  const { actor: member, apiKey: memberKey } = await createActor({ name: uniq("gd-member"), kind: "agent" });
  const project = await createProject({ key: uniq("gd"), name: "Gate directives" });
  return { admin, adminKey, member, memberKey, project };
}

test("a member cannot create a ticket whose body carries a gate directive", async () => {
  const { member, project } = await setup();
  await expect(createTicket(member.id, { projectId: project.id, title: "t", body: "intro\nGATE-OVERRIDE: all" }))
    .rejects.toBeInstanceOf(ForbiddenError);
});

test("a member cannot add a gate directive to an existing body; the ticket is unchanged", async () => {
  const { member, project } = await setup();
  const t = await createTicket(member.id, { projectId: project.id, title: "t", body: "plain" });
  await expect(updateTicket(member.id, t.id, t.version, { body: "plain\nALLOW-FILES: **" }))
    .rejects.toBeInstanceOf(ForbiddenError);
  const fresh = await getTicket(t.id);
  expect(fresh.version).toBe(t.version);
  expect(fresh.body).toBe("plain");
});

test("an admin can add a directive; a member may then edit other text or remove it", async () => {
  const { admin, member, project } = await setup();
  const t = await createTicket(member.id, { projectId: project.id, title: "t", body: "plain" });
  const withDirective = await updateTicket(admin.id, t.id, t.version, { body: "plain\nALLOW-PROTECTED: package.json" });
  expect(withDirective.body).toContain("ALLOW-PROTECTED: package.json");
  const edited = await updateTicket(member.id, t.id, withDirective.version, { body: "plain, edited\nALLOW-PROTECTED: package.json" });
  expect(edited.body).toContain("edited");
  const removed = await updateTicket(member.id, t.id, edited.version, { body: "plain, edited" });
  expect(removed.body).not.toContain("ALLOW-PROTECTED");
});

test("REST: a member PATCH that adds a directive is 403 and names the directive", async () => {
  const { member, memberKey, project } = await setup();
  const t = await createTicket(member.id, { projectId: project.id, title: "t", body: "plain" });
  const res = await app.request(`/tickets/${t.id}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${memberKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ expectedVersion: t.version, body: "plain\nGATE-OVERRIDE: secret" }),
  });
  expect(res.status).toBe(403);
  expect((await res.json()).error).toContain("GATE-OVERRIDE");
});

test("a member cannot smuggle a directive behind unusual whitespace or a line break", async () => {
  const { member, project } = await setup();
  await expect(createTicket(member.id, { projectId: project.id, title: "t", body: "intro\n GATE-OVERRIDE: all" }))
    .rejects.toBeInstanceOf(ForbiddenError);
  const t = await createTicket(member.id, { projectId: project.id, title: "t", body: "plain" });
  await expect(updateTicket(member.id, t.id, t.version, { body: "plain\nALLOW-FILES:\n**" }))
    .rejects.toBeInstanceOf(ForbiddenError);
});
