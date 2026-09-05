# UI guidelines for the VibeOps desktop app

Read this before changing anything under `app/`. It is short on purpose: every rule here exists because an agent once did the opposite and the work came back. Agents that are asked to change the UI follow it without being told; a plan or review that touches `app/` cites it.

## Stack, fixed

React 19, TanStack Router, TanStack Query, Tailwind 4 with the theme in `app/src/index.css`, `material-symbols-outlined` icons, `lucide-react` only where it is already imported. Tests are Vitest plus Testing Library with `apiFetch` mocked (see any `*.test.tsx` under `app/src/routes/`). No new dependencies, no CSS files besides `index.css`, no inline `style=` except the icon `fontVariationSettings` trick the sidebar already uses.

## Data access

`api.get/post/patch/del` from `app/src/lib/api.ts` return the response body directly. Never `res.data`, never `fetch` in a component. Server state lives in `useQuery`/`useMutation`; component state is for input fields and open/closed toggles only. Query keys are arrays that start with the screen name (`["forge", "runs", id]`). After a mutation, invalidate the key you changed, do not refetch by hand.

## Colours and type

Use theme tokens, never hex, never Tailwind palette colours (`gray-500`, `blue-400`). The palette is Material dark: `bg-background`, `bg-surface`, `bg-surface-container`, `bg-surface-container-lowest/low/high/highest`, text `text-on-surface`, muted `text-on-surface-variant`, accent `text-primary` / `bg-primary-fixed-dim text-on-primary-fixed`, purple accent `text-secondary`, errors `text-error`. Borders are `border-white/5` at rest and `border-white/20` on hover; the selected row is `bg-primary-fixed-dim/10 border-primary-fixed-dim text-primary`.

Type scale: `font-headline-md` for a screen title, `font-code-label text-code-label uppercase tracking-widest` for group headings and labels, `font-code-sm` for ids, hashes and timestamps, `text-sm` body inside panes. Status pills are `text-[10px] font-code-label uppercase` and use the green/red pair already in `RunHistoryPane` (`bg-green-500/20 text-green-400`, `bg-red-500/20 text-red-400`); that pair is the one sanctioned non-token colour.

## Layout

Screens are full-height flex shells (`h-full flex`) with panes that scroll themselves (`overflow-y-auto`); the body never scrolls. A left list pane is `w-80 border-r border-white/10`. Content does not get a `max-w-*` cap unless it is prose. Every screen has a one-line purpose caption under its title in `text-xs text-on-surface-variant/70`. Groups inside a pane are `space-y-6`; rows inside a group `space-y-2`; row padding `p-3 rounded border`.

## Interaction

Anything clickable is a `<button type="button">` or a router `<Link>`, never a `div` with `onClick` unless the row pattern in `TicketListPane` is being reused verbatim. Buttons and icon-only controls carry `aria-label` or visible text. Disabled state is `disabled:opacity-50 disabled:cursor-not-allowed` plus a `title` that says why. Errors from the API are shown inline next to the control that caused them, in `text-error text-xs`, using `e.message` as returned; never `alert`, never `console.error` as the only surface. Long-running actions show their spinner on the control (`animate-spin` on the icon), not a global overlay. Right-click menus use `ContextMenu` from `app/src/components/ContextMenu.tsx`.

Collapsible sections default closed, toggle with a `material-symbols-outlined` `expand_more` icon that rotates 180 degrees when open, and show their count in the heading.

## Copy

Labels are plain English nouns: "Work orders", "Runs", "Closed". No emojis, no exclamation marks, no "Oops". Empty states say what is absent in one italic line: `None`, `No runs yet`. Status names shown to a user are the raw status (`in_progress` renders as `IN_PROGRESS` through the uppercase utility); do not invent display names.

## Tests

Every behaviour change ships with a test in the screen's existing `*.test.tsx`, using the file's own `apiFetch` mock style. Assert on what the user sees (`screen.getByText`, `getByRole`, `getByLabelText`), not on class names. When a change adds a request, assert the exact path the mock received. Run `cd app && npx vitest run` and `npm run typecheck` before reporting; report the counts you saw, not counts you expect.

## What not to do

No new screens or routes for a feature that fits an existing pane. No new shared component until a second consumer exists. No refactor of neighbouring code in the same change. No `setTimeout` to wait for the DOM (the repo has a test that forbids it). No `localStorage` keys besides the ones exported from a `types.ts`.
