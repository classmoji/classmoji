# Callout System Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace bottom-floating `react-toastify` toasts and ad-hoc progress modals with a unified inline `Callout` primitive in `@classmoji/ui-components`, anchored via slots and animated with framer-motion.

**Architecture:** Single-slot replace-on-new model. Provider holds a slot registry and per-slot queue; slots render the active payload via framer-motion crossfade. Per-variant dismiss defaults (success auto, error/info/progress persistent). Migration is incremental: ship the primitive, swap `useNotifiedFetcher` internals (covers most callers invisibly), then migrate direct `toast.*` callers and bespoke progress modals one feature at a time, then drop `react-toastify`.

**Tech Stack:** TypeScript, React 19, framer-motion 12, Vitest + React Testing Library, Tailwind, react-router 7.

**Design doc:** `docs/plans/2026-05-05-callout-system-design.md`

**Commit policy:** Conventional commits, no Claude/AI co-author footer, no "Generated with" footer.

---

## Phase 1 — Build the primitive

### Task 1: Scaffold package structure and types

**Files:**
- Create: `packages/ui-components/src/Callout/types.ts`
- Create: `packages/ui-components/src/Callout/variants.ts`
- Create: `packages/ui-components/src/Callout/index.ts` (placeholder, exports filled in later)

**Step 1:** Create `types.ts` with:
```ts
import type { ReactNode } from 'react';

export type CalloutVariant = 'success' | 'error' | 'info' | 'progress';

export interface CalloutAction {
  label: string;
  onClick: () => void;
}

export interface CalloutPayload {
  variant: CalloutVariant;
  title: string;
  message?: string;
  slot?: string;
  progress?: number;
  icon?: ReactNode;
  action?: CalloutAction;
  persistent?: boolean;
  autoDismissMs?: number | null;
}

export interface CalloutHandle {
  show: (payload: CalloutPayload) => string;
  update: (id: string, payload: Partial<CalloutPayload>) => void;
  dismiss: (id: string) => void;
}

export interface ActiveCallout extends CalloutPayload {
  id: string;
  slot: string;
}
```

**Step 2:** Create `variants.ts` with per-variant defaults (default lifetime, accent color, default icon name). Use existing `Icon*` from `../icons` — `IconCheck` (success), `IconX` (error), `IconBell` (info), `IconArrowRotate` (progress).

```ts
import type { CalloutVariant } from './types.ts';

export interface VariantConfig {
  defaultAutoDismissMs: number | null;
  accentClassName: string; // tailwind classes for left accent bar
  iconColorClassName: string;
}

export const VARIANT_CONFIG: Record<CalloutVariant, VariantConfig> = {
  success: {
    defaultAutoDismissMs: 4000,
    accentClassName: 'bg-emerald-500',
    iconColorClassName: 'text-emerald-600 dark:text-emerald-400',
  },
  error: {
    defaultAutoDismissMs: null,
    accentClassName: 'bg-rose-500',
    iconColorClassName: 'text-rose-600 dark:text-rose-400',
  },
  info: {
    defaultAutoDismissMs: null,
    accentClassName: 'bg-sky-500',
    iconColorClassName: 'text-sky-600 dark:text-sky-400',
  },
  progress: {
    defaultAutoDismissMs: null,
    accentClassName: 'bg-violet-500',
    iconColorClassName: 'text-violet-600 dark:text-violet-400',
  },
};
```

**Step 3:** Verify TypeScript compiles. Run `npx tsc -p packages/ui-components/tsconfig.json --noEmit` (or whatever the package's typecheck script is — check `package.json`).

**Step 4:** Commit.
```
git add packages/ui-components/src/Callout
git commit -m "feat(ui-components): scaffold Callout types and variants"
```

---

### Task 2: Build CalloutProvider with queue + slot registry

**Files:**
- Create: `packages/ui-components/src/Callout/CalloutProvider.tsx`

**Behavior:**
- React context exposing `CalloutHandle`.
- Maintains `Map<slotId, ActiveCallout | null>` for the active payload per slot.
- Maintains `Set<slotId>` of mounted slots (registered via `__registerSlot` / `__unregisterSlot` exposed through internal context).
- `show(payload)`:
  - Generates id via `crypto.randomUUID()`.
  - Resolves target slot (`payload.slot ?? 'default'`).
  - If slot is mounted: assigns the payload as the slot's active callout (replaces any prior).
  - If slot is unmounted: stores in a buffer keyed by slot id with a 500ms timer. On timer expiry, fall back to `'default'` slot if mounted; otherwise drop and `console.warn` in dev (`process.env.NODE_ENV !== 'production'`).
  - Schedules auto-dismiss timer per resolved `autoDismissMs` (payload override → variant default).
  - Returns id.
- `update(id, partial)`: locates active callout by id across slots; merges; resets auto-dismiss timer if `autoDismissMs` or `variant` changed. If the merged variant is a terminal `success` from a `progress` morph, default auto-dismiss to 2000ms unless explicitly overridden.
- `dismiss(id)`: clears the slot if it currently holds id; clears its timer.
- All state is held in refs + a single tick counter `useState` to trigger re-render on changes — keeps `useCallout()` returning a stable handle (no re-subscriptions).

Export an internal `useCalloutInternal()` hook for `CalloutSlot` to subscribe to its slot's active payload.

**Step 1:** Implement.
**Step 2:** TypeScript check.
**Step 3:** Commit.
```
git commit -m "feat(ui-components): add CalloutProvider with slot registry and queue"
```

---

### Task 3: Build CalloutCard visual

**Files:**
- Create: `packages/ui-components/src/Callout/CalloutCard.tsx`

**Behavior:**
- Pure presentational component. Props: `payload: ActiveCallout`, `onDismiss: () => void`.
- Layout matches the screenshot in `docs/plans/2026-05-05-callout-system-design.md`:
  - Outer: `relative flex items-center gap-3 rounded-2xl bg-white dark:bg-neutral-900 ring-1 ring-stone-200 dark:ring-neutral-800 px-4 py-3 shadow-sm overflow-hidden`
  - Left accent: absolutely positioned `w-1 inset-y-0 left-0` div using `VARIANT_CONFIG[variant].accentClassName`.
  - Icon: payload.icon if provided, else default per variant. For `progress` with no icon override, render the default icon with a slow Tailwind `animate-spin`.
  - Text: `<span className="font-semibold text-gray-900 dark:text-gray-100">{title}</span>` followed by `<span className="text-gray-600 dark:text-gray-400">{message}</span>` on the same line on `sm+`, stacked on mobile.
  - Optional action button (uses `Button` from `../Button`).
  - Dismiss button (`IconButton` with `IconX`).
  - For `progress` variant with `progress != null`: render a `h-0.5 bg-violet-500` bar at the bottom edge with width `${progress * 100}%`, transitioning width over 240ms.

**Step 1:** Implement.
**Step 2:** TypeScript check.
**Step 3:** Commit.
```
git commit -m "feat(ui-components): add CalloutCard visual component"
```

---

### Task 4: Build CalloutSlot with framer-motion animation

**Files:**
- Create: `packages/ui-components/src/Callout/CalloutSlot.tsx`

**Behavior:**
- Props: `id?: string` (default `"default"`), `className?: string`.
- Registers/unregisters with provider on mount/unmount via internal context.
- Subscribes to its slot's active callout.
- Renders an `<AnimatePresence mode="wait">` containing the active `CalloutCard` keyed by callout id.
- Motion: `initial={{ opacity: 0, y: -8 }}`, `animate={{ opacity: 1, y: 0 }}`, `exit={{ opacity: 0, y: -4 }}`, `transition={{ duration: 0.18, ease: 'easeOut' }}`.
- If `useReducedMotion()` is true, drop the `y` translate and use opacity-only.
- Container is `className={cn('w-full', className)}` — no fixed positioning. Caller controls placement.

**Step 1:** Implement.
**Step 2:** TypeScript check.
**Step 3:** Commit.
```
git commit -m "feat(ui-components): add CalloutSlot with framer-motion animation"
```

---

### Task 5: Add useCallout hook + finalize public exports

**Files:**
- Create: `packages/ui-components/src/Callout/useCallout.ts`
- Modify: `packages/ui-components/src/Callout/index.ts`
- Modify: `packages/ui-components/src/index.ts`

**Behavior:**
- `useCallout()` returns the `CalloutHandle` from context. Throws a descriptive error in dev if used outside a `CalloutProvider`.
- `index.ts` re-exports `CalloutProvider`, `CalloutSlot`, `useCallout`, and the public types.
- Top-level `packages/ui-components/src/index.ts` re-exports those alongside the existing primitives, in the same style as `Card`, `Chip`, etc.

**Step 1:** Implement.
**Step 2:** TypeScript check across consuming apps: `npm run typecheck` (or apps/webapp's typecheck script).
**Step 3:** Commit.
```
git commit -m "feat(ui-components): export Callout public API"
```

---

### Task 6: Tests

**Files:**
- Create: `packages/ui-components/src/Callout/Callout.test.tsx`

**Test cases (one `it()` each):**
1. `show()` renders into the default slot.
2. `show({ slot: 'x' })` renders into slot `x` and not into default.
3. A second `show()` to the same slot replaces the first.
4. `update(id, ...)` morphs the active card without unmounting (assert by checking the dismiss button DOM node identity — replace would unmount it).
5. `dismiss(id)` removes the active callout from its slot.
6. `success` auto-dismisses after 4000ms (use `vi.useFakeTimers()`).
7. `error` does not auto-dismiss.
8. `progress` morphed to `success` via `update` auto-dismisses 2000ms later.
9. `show({ slot: 'unmounted' })` falls back to `default` after 500ms when `default` is mounted.
10. `show({ slot: 'unmounted' })` is dropped (no throw, console.warn called) after 500ms when `default` is also unmounted.

Use `@testing-library/react`. Reference an existing `packages/ui-components` test for setup conventions (look in `Card/`, `Button/`, etc.).

**Step 1:** Write tests.
**Step 2:** Run: `npm run test --workspace=packages/ui-components` (or whatever script applies — check `packages/ui-components/package.json`).
**Step 3:** All green. Fix any implementation bugs surfaced.
**Step 4:** Commit.
```
git commit -m "test(ui-components): cover Callout slot routing, replace, lifetimes"
```

---

## Phase 2 — Wire into webapp

### Task 7: Mount provider and default slot in webapp

**Files:**
- Modify: `apps/webapp/app/root.tsx` — wrap the app tree with `<CalloutProvider>`. Keep existing `<ToastContainer />` mounted in parallel.
- Modify: `apps/webapp/app/components/layout/navigation/CommonLayout.tsx` — render `<CalloutSlot />` directly above the route content area, inside the floating-card container's outer wrapper. Read the file first; place the slot where the page title row begins so the slot sits above page content but inside the routed area, with `className="mb-3"` for spacing.

**Step 1:** Inspect `apps/webapp/app/root.tsx` for the right wrap point (look for the existing `<ToastContainer />` import — wrap inside that level).
**Step 2:** Inspect `CommonLayout.tsx` for where the page title row is rendered. Place the slot just before it.
**Step 3:** Manual smoke: `npm run web:dev` is already running per AGENTS.md (do not start it). Open any admin page and confirm no regressions. Use Playwright/Chrome tools if available.
**Step 4:** Commit.
```
git commit -m "feat(webapp): mount CalloutProvider and default slot in CommonLayout"
```

---

### Task 8: Rewrite useNotifiedFetcher to use Callout

**Files:**
- Modify: `apps/webapp/app/hooks/useNotifiedFetcher.ts`

**Behavior:** Public API of the hook stays identical (`{ fetcher, notify }`). Internals route through `useCallout()` instead of `toast()`:
- `notify(action, message)` → `callout.show({ variant: 'progress', title: message ?? '…', persistent: true })`. Track returned id by `action` in a ref Map.
- On `fetcher.data.success`: `callout.update(id, { variant: 'success', title: fetcher.data.success, autoDismissMs: 2000 })`.
- On `fetcher.data.error`: if id exists `callout.update(id, { variant: 'error', title: fetcher.data.error })`; else `callout.show({ variant: 'error', title: fetcher.data.error })`.
- On `fetcher.data.info`: dedupe by `info` slot id like before — `callout.show({ variant: 'info', title: fetcher.data.info })`.
- Drop the `position` arg from `notify()` signature (no positional concept anymore) but keep it as an ignored optional third arg for backward compatibility — type as `unknown` and ignore.

**Step 1:** Implement.
**Step 2:** Manual smoke: trigger a form submission on any admin page that uses `useGlobalFetcher().notify(...)`. Verify the callout appears in the default slot above the route content and morphs to success/error.
**Step 3:** Commit.
```
git commit -m "refactor(webapp): drive useNotifiedFetcher through Callout system"
```

---

## Phase 3 — Migrate direct toast.* callers

There are ~20 files importing `toast` from `react-toastify`. Group migrations by feature area to keep diffs reviewable. Each task below = one commit.

For each file: replace `import { toast } from 'react-toastify'` with `import { useCallout } from '@classmoji/ui-components'`, replace `toast.success(msg)` with `callout.show({ variant: 'success', title: msg })`, etc. Where the call is inside an event handler in a component, instantiate `const callout = useCallout()` at the top of the component. Where it's outside a component (rare — verify), refactor to call from the nearest component.

### Task 9: Migrate admin classroom routes

**Files (modify each, one commit covering all):**
- `apps/webapp/app/routes/admin.$class.modules_.$title.assign-graders/route.tsx`
- `apps/webapp/app/routes/admin.$class.assistants.$login/route.tsx`
- `apps/webapp/app/routes/admin.$class.calendar/route.tsx`
- `apps/webapp/app/routes/admin.$class.pages.new/route.tsx`
- `apps/webapp/app/routes/admin.$class.pages/route.tsx`
- `apps/webapp/app/routes/admin.$class.modules.form/FormModule.tsx`
- `apps/webapp/app/routes/admin.$class.modules_.$title/Menu.tsx`
- `apps/webapp/app/routes/admin.$class.assistants/route.tsx`
- `apps/webapp/app/routes/admin.$class.assistants/FormAssistant.tsx`
- `apps/webapp/app/routes/admin.$class.students/StudentsTable.tsx`

Smoke each route's primary action in the browser.

```
git commit -m "refactor(webapp): migrate admin classroom routes to Callout"
```

### Task 10: Migrate admin settings + assistant + student routes

**Files:**
- `apps/webapp/app/routes/admin.$class.settings.team/TagSection.tsx`
- `apps/webapp/app/routes/admin.$class.settings.grades/LetterGradeMapping.tsx`
- `apps/webapp/app/routes/admin.$class.settings.grades/EmojiMapping.tsx`
- `apps/webapp/app/routes/_user.settings.billing/route.tsx`
- `apps/webapp/app/routes/assistant.$class_.calendar/route.tsx`
- `apps/webapp/app/routes/student.$class.modules_.$module.team/route.tsx`
- `apps/webapp/app/routes/student.$class.dashboard/TokenPopupForm.tsx`

```
git commit -m "refactor(webapp): migrate settings, assistant, student routes to Callout"
```

---

## Phase 4 — Replace bespoke progress UI

### Task 11: Replace TriggerProgress

**Files:**
- Read: `apps/webapp/app/components/ui/display/TriggerProgress.tsx` and find all callers (`grep -rn TriggerProgress apps/webapp`).
- For each caller: replace the modal usage with a `<CalloutSlot id="<feature-slot>" />` placed inline in the feature UI, and convert the polling logic to call `callout.show({ variant: 'progress', slot: '<feature-slot>', progress, ... })` and `callout.update(...)` as the run progresses, then `callout.update(id, { variant: 'success', ... })` on completion or `{ variant: 'error', ... }` on failure.
- Delete `TriggerProgress.tsx` once no callers remain.

```
git commit -m "refactor(webapp): replace TriggerProgress modal with inline Callout"
```

### Task 12: Replace ImportProgressModal in slides app

**Files:**
- Mount `<CalloutProvider>` in `apps/slides/app/root.tsx`.
- Add a `<CalloutSlot />` in the slides editor shell.
- Replace `apps/slides/app/components/ImportProgressModal.tsx` callers with progress callouts. Delete the modal file once unused.

```
git commit -m "refactor(slides): replace ImportProgressModal with inline Callout"
```

---

## Phase 5 — Remove react-toastify

### Task 13: Drop react-toastify

**Only run after every direct caller is migrated.** Verify with `grep -rn "react-toastify" apps packages` — should return zero matches.

**Files:**
- Modify: `apps/webapp/app/root.tsx` — remove `<ToastContainer />` and the `react-toastify` import.
- Modify: `apps/slides/app/root.tsx` — same.
- Remove `react-toastify` from `apps/webapp/package.json` and `apps/slides/package.json`. Run `npm install` to update lockfile **only if** the ai-agent submodule is populated (per AGENTS.md, contributors without the submodule must not commit lockfile changes). If the submodule is empty, leave the lockfile and flag in PR description.

```
git commit -m "chore: remove react-toastify after full migration to Callout"
```

---

## Verification checklist (run before final PR)

- [ ] `npm run typecheck` (or per-workspace) clean.
- [ ] `npm run test --workspace=packages/ui-components` green.
- [ ] `npm run web:test` (Playwright) green for routes touched in phases 3–4.
- [ ] Manual: success, error, info callouts visible above route content.
- [ ] Manual: progress callout morphs to success and auto-dismisses.
- [ ] `grep -rn "react-toastify" apps packages` → no matches.
- [ ] `grep -rn "TriggerProgress" apps` → no matches.
