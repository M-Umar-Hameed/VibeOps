# Project Tenants UX (Phase 23) — Design

Owner ask 2026-07-17 (screenshot: Antigravity's Projects sidebar): manage each
repo/project separately — its own tickets, its own working directory, switch
between them like Cursor/Antigravity workspaces.

## Honest scope

Data isolation already exists where it matters: tickets belong to projects
(projectId), projects own repoPaths (P20), forge sandboxes/promotes resolve
through the ticket's project repo. What is missing is the UX: the app shows
ALL tickets everywhere. This phase makes the app project-centric. It is
view-scoping over one shared DB and one auth realm — NOT hard multi-tenancy
(no per-project keys/DBs). Knowledge stays global by design (the shared brain
across projects is the product's memory moat); project-scoped notes already
exist via the notes scope field for anyone who wants them.

## UX

1. **Projects in the sidebar** (Antigravity-style): a Projects section
   listing every project (name; repoPath basename as subtitle; ticket count
   badge). Clicking one makes it ACTIVE. A persistent "All projects" entry at
   top retains the current global view. Active project persists across
   restarts (plugin-store setting `activeProjectId`, same mechanism as
   credentials — check app/src/settings.ts).
2. **Add project** button in that section: inline mini-form — name, key
   (auto-suggested from name, editable), absolute folder path (optional).
   POST /projects then PATCH repoPath when given; offer "Initialize git"
   inline when the path is not a repo (reuses P20 endpoints). New project
   becomes active.
3. **Scoping when a project is active**: ticket List screen (GET
   /tickets?projectId=), Forge board columns, Council create (project select
   pre-locked to active), Quick create (same), Dashboard metrics if they
   accept a project filter (check /system/metrics — if global-only, leave
   global and note it). TopBar shows the active project name as context
   (subtle chip next to the title).
4. **No backend changes expected**: /tickets?projectId exists; /projects
   CRUD + repoPath + git-init exist (P20). If a gap appears (e.g. metrics),
   scope-cut rather than grow the API in this phase.

## Implementation

React context `ProjectContext` (app/src/context/project.tsx): {projects,
activeProjectId, setActiveProject, refresh}. Provider mounted in main.tsx
inside the router root. Sidebar consumes it; screens read activeProjectId
and thread it into their queries. Persistence via the existing settings/store
module.

## Tests

Context unit (persist + restore via mocked store); Sidebar renders projects,
switch updates context, add-project posts name/key then repoPath; List
screen passes projectId when active and omits it for All; Forge board
filters; Council create pre-selects and locks the active project.
