# Browser control: from ref-clicks to vision, in tiers

Written 2026-08-21 after reviewing three computer-use agent codebases against our
extension architecture. Answers one question — *when do screenshots and pixel
coordinates earn their place?* — and lays out the implementation order.

## The finding that shapes everything

**Our ref-based clicks are already "pixel perfect" — in fact they cannot miss.**
The extension resolves a `ref` from the accessibility snapshot to the live element
and calls `el.click()` (extension/execute.js:122). There is no coordinate to get
wrong: no scroll offset, no zoom, no DPI scaling, no layout shift between look and
click. Pixel coordinates are the *less* reliable grounding, not the more.

What the survey repos actually show:

| Repo | Perception | Grounding | Takeaway for us |
|---|---|---|---|
| bytebot | screenshots of a full Ubuntu-in-Docker desktop | pixel coordinates via a `computer-use` REST API | the full-desktop tier; heavy (entire containerized OS), only needed to reach outside the browser |
| agent-zero | DOM annotation + screenshots, XFCE desktop in Docker | mixed DOM/coordinates | hybrid validates our direction; safety model is "sandbox everything in Docker", i.e. isolation over permissioning |
| suitedaces/computer-agent | two modes: Claude computer-use (screenshot + pixel coords, takes the cursor) and background CDP (no cursor) | coords in mode 1, CDP in mode 2 | its *background* mode is architecturally our extension: structured control, user keeps the mouse |

Fourth source, the GitHub `desktop-agent` topic survey (Eigent 15.1k stars, Workany,
Ouroboros, Microsoft's WindowsAgentArena, terminaI, and others): the dominant pattern
across general desktop agents is screenshots + vision + coordinates — because outside
a browser there is no DOM to reference. That confirms the tier split rather than
changing it: vision+coordinates is the *desktop* tier's native grounding (our deferred
T5), not a better grounding for the browser, where structure exists. Two smaller
signals worth keeping: terminaI ships explicit per-action approval workflows —
independent validation of our grant gate over agent-zero's isolation-only stance —
and WindowsAgentArena exists as a benchmark should T5 ever need evaluating.

So the industry pattern is not "vision replaces DOM control" — it is DOM-structured
control where possible, vision + coordinates only where structure is invisible.

## Where the accessibility tree is genuinely blind

Screenshots/vision earn their place exactly here, nowhere else:

1. **Canvas-rendered UIs** — Figma, maps, charts, games. One `<canvas>` node, zero
   children; the tree sees nothing clickable.
2. **Cross-origin iframes** — content scripts cannot reach inside; the tree stops
   at the frame boundary.
3. **Image-only controls** — image maps, icon buttons with no role/label; our
   role-based collector (extension/snapshot.js) skips them.
4. **Outside the browser entirely** — native apps, file dialogs. Extension cannot
   reach these at all (bytebot tier; out of scope here).

## The design: set-of-marks, refs stay the executor

The best-practice middle path (used by browser-use, WebVoyager, and effectively by
computer-agent's CDP mode) is **set-of-marks**: annotate a screenshot with numbered
boxes derived from the accessibility snapshot, let a vision model pick a *mark*, and
map the mark back to a **ref**. The model gets pixels for perception; execution
stays deterministic and grant-gated. Raw coordinate clicks exist only as the last
resort for the truly structureless cases (canvas), never as the default.

Critical detail the naive version gets wrong: `captureVisibleTab` returns
**physical pixels**, DOM geometry is in **CSS pixels**. Every rect must carry the
`devicePixelRatio` and scroll offsets captured *at snapshot time*, or every overlay
and every coordinate click is off by the zoom factor. This is the actual
"pixel-perfect" trap — not click dispatch, but coordinate-space mapping.

## Tiers

### T1 — bounding rects in the snapshot [small, do first]
`extension/snapshot.js` nodes gain `rect: {x, y, w, h}` (CSS px,
`getBoundingClientRect` + scroll), and the snapshot gains viewport metadata:
`{ dpr, scrollX, scrollY, viewportW, viewportH }`. Pure data addition; no verb
changes; existing consumers unaffected. This is the prerequisite for everything
below and is useful on its own (server-side sanity checks that a ref is visible).

### T2 — `screenshot` verb [read-tier, manifest change]
New verb returning the visible tab as PNG (base64) plus the same viewport metadata.
`chrome.tabs.captureVisibleTab` — note `activeTab` alone only covers
user-gesture invocations; programmatic capture from the worker likely needs the
`"tabs"` permission or `<all_urls>` host permission. **Manifest change; call it out
in the ticket, smallest permission that works.** Screenshots carry whatever is on
screen — treat as sensitive read: same read gating as snapshot, never persisted
into the knowledge index, size-capped.

### T3 — set-of-marks composition [server-side, no new deps]
Server endpoint/step that takes screenshot + snapshot, draws numbered boxes at
`rect * dpr`, returns the annotated image and the mark→ref table. `sharp` is
already in the payload and composites SVG overlays onto PNG — no new dependency.
Vision-capable models receive the annotated image; their answer is a mark number;
the server resolves mark→ref and executes a normal ref click. A model cannot
invent a target: an out-of-table mark is a refusal, and the executed thing is
still a grant-gated ref click.

**Any-model requirement (owner, binding — not just the Claude SDK lane):** the
capability registers on the MCP server as well as the SDK tools, one
implementation behind both; the annotated PNG is also written to a temp file and
the path returned, because file-capable CLIs read files natively where inline
base64 fails; and the mark table is always returned as text — `{mark, ref, role,
name}` — so a non-vision model can choose a mark from the table alone.
Set-of-marks degrades to a better-organized snapshot for text-only models;
vision is an enhancement, never a requirement.

### T4 — `clickAt` coordinate verb [act-tier, last resort]
For canvas and the structureless remainder. Content script maps CSS-px point via
`document.elementFromPoint(x/dpr adjustments applied)` and dispatches the click.
Hard rules: act-gated like every mutating verb (a coordinate click is `act` on the
page origin — same `hasActGrant`, same refusal text); rejected when the point
falls outside the captured viewport metadata bounds; never chosen when a ref
match exists. CDP (`chrome.debugger`) for trusted OS-level input is explicitly
deferred — the `debugger` permission triggers a scary browser banner and its
power (arbitrary CDP) is out of proportion to the canvas use case.

### T5 — full desktop control [REJECTED — owner decision, 2026-08-21]
The bytebot tier: OS-level screenshot + input outside the browser. Rejected, not
deferred: the owner ruled it out. The reasoning stands on its own — a different
risk class (no origin model exists on a desktop, so the grant gate has nothing to
anchor to) and a different runtime (native agent, not extension). Browser-scoped
control via T1–T4 is the ceiling of this system. Do not re-propose without the
owner reopening it.

## Security invariants (hold across every tier)

- Every mutating verb — ref click, `clickAt`, type, navigate — passes the same
  server-side `hasActGrant(origin)`; a coordinate is not a side door.
- Screenshot bytes and page text are DATA, never instructions. Annotated images go
  to the model as perception; nothing in them relaxes a grant.
- Mark→ref resolution happens server-side from the server's own table; a model
  cannot name a ref or coordinate that was not offered.
- Grants stay per-exact-origin, one array, one gate (`browserGrants`), as today.

## Order and why

T1 → T2 ship independently and unblock experimentation with any vision-capable
model already in the roster. T3 is where "which model can use this" stops
mattering — every vision model can read an annotated PNG and answer with a number,
which also serves the all-lanes goal (ticket f060b85a) for lanes whose CLI can
take image input. T4 only after T3 shows its residual need. T5 is rejected outright.
