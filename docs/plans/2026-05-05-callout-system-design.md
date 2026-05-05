# Callout System — Design

**Date:** 2026-05-05
**Status:** Awaiting approval
**Author:** Muhammad Moiz (with Claude)

## Problem

Today, transient feedback in the webapp (and slides) is delivered through `react-toastify` toasts that float in from `bottom-center`. There are also bespoke progress modals (`TriggerProgress`, `ImportProgressModal`) for long-running work. The current setup has three problems:

1. **Visual disconnect.** A toast at the bottom of the screen has no spatial relationship to the action that triggered it. Users miss confirmations and errors, especially on long pages.
2. **Inconsistent surfaces.** Toasts, progress modals, and inline alerts each have their own visual language and code path.
3. **Naming overload.** "Notification" already means push notifications and email digests in this product. The toast layer needs its own term.

## Goal

Replace bottom-floating toasts and ad-hoc progress UI with a single inline component — the **Callout** — that slides into a dedicated slot in the page near the relevant content. Build it as a reusable primitive in `@classmoji/ui-components` so any future feature (and the slides app) can use it without re-implementing.

## Non-goals

- Push notifications, email digests, in-app inbox.
- The `ImpersonationBanner` (top-fixed admin bar) — different concern, stays as is.
- Streaming chat status (`isStreaming` flags in syllabus bot / prompt assistant) — already inline, no change.
- A general-purpose modal/drawer/popover system.

## Naming

**Callout.** Used by GitHub Primer and Notion for the same pattern. Unambiguous in this codebase: no collision with push/email notifications, no collision with `useNotifiedFetcher`, no collision with `ImpersonationBanner`.

## Architecture

### Package & files

Lives in `packages/ui-components/src/Callout/`:

```
Callout/
  index.ts                  // public exports
  CalloutProvider.tsx       // context, queue, slot registry
  CalloutSlot.tsx           // anchor that renders the active callout
  CalloutCard.tsx           // visual: avatar/icon, title, message, dismiss
  useCallout.ts             // imperative API for callers
  variants.ts               // success | error | info | progress styling map
  types.ts
  Callout.test.tsx
```

Exported from `packages/ui-components/src/index.ts` alongside other primitives.

### Public API

```tsx
// 1. Wrap once at the app root (replaces <ToastContainer />)
<CalloutProvider>
  <App />
</CalloutProvider>

// 2. Default slot — rendered once, high in the route shell
//    (CommonLayout, just below the AppBar/breadcrumb area)
<CalloutSlot />                       // implicit id="default"

// 3. Optional contextual slot — feature places one near its UI
<CalloutSlot id="quiz-editor" />

// 4. Fire from anywhere
const callout = useCallout();
callout.show({
  variant: 'success',
  title: 'Saved',
  message: 'Settings updated.',
});

callout.show({
  variant: 'progress',
  title: 'Syncing repos',
  message: '3 of 12 complete',
  slot: 'quiz-editor',
  progress: 0.25,             // 0..1; renders thin bar in card
  persistent: true,           // overrides per-variant default
});

// 5. Update / dismiss in-flight
const id = callout.show({ variant: 'progress', title: 'Importing slides' });
callout.update(id, { progress: 0.6, message: 'Processing images' });
callout.update(id, { variant: 'success', title: 'Import complete' });
callout.dismiss(id);
```

`useCallout()` returns a stable object — calling it does not re-subscribe the component. The provider keeps the dispatcher in a ref so callers don't re-render when the queue changes.

### Slot behavior (single-slot, replace-on-new)

Each `CalloutSlot` subscribes to one queue keyed by its `id`. When `show()` fires:

1. Provider routes the payload by `slot` (defaults to `"default"`).
2. The target slot renders **at most one** callout. A new callout replaces the current one with a 180ms crossfade.
3. If the targeted slot is not currently mounted, the provider buffers the message for 500ms (covers route transitions where the slot mounts a tick later), then falls back to the default slot. After 500ms with no slot, the message is dropped and a `console.warn` is emitted in dev so the misrouting is visible.

### Dismiss behavior (per-variant defaults, override allowed)

| Variant    | Default lifetime              | Reasoning                                 |
| ---------- | ----------------------------- | ----------------------------------------- |
| `success`  | Auto-dismiss after 4s         | Matches existing toast feel; low signal.  |
| `info`     | Persistent until X'd          | User decides when they've read it.        |
| `error`    | Persistent until X'd          | Errors should not silently disappear.     |
| `progress` | Persistent; auto-dismisses 2s after morphing to `success` | Confirms completion without lingering. |

Any callout can override with `persistent: true`, `autoDismissMs: <number>`, or `autoDismissMs: null`.

### Animation

`framer-motion` (already in webapp deps). The card mounts with `initial={{ opacity: 0, y: -8 }}`, animates to `{ opacity: 1, y: 0 }` with a 220ms spring. On replace, the outgoing card crossfades over 180ms while the new card slides in. `prefers-reduced-motion` short-circuits to opacity-only transitions.

### Visual

Matches the screenshot: rounded-2xl card, white bg / `dark:bg-neutral-900`, ring-1 stone/neutral, optional leading icon or avatar, bold title + body in same line on desktop, stacked on mobile, dismiss `IconX` on the right. Per-variant left-edge accent (subtle bar) so variant is glanceable without overpowering the card.

The existing `Card`, `IconButton`, and icon primitives from `@classmoji/ui-components` are reused — `CalloutCard` is composed from them, not styled from scratch.

### Types

```ts
type CalloutVariant = 'success' | 'error' | 'info' | 'progress';

interface CalloutPayload {
  variant: CalloutVariant;
  title: string;
  message?: string;
  slot?: string;                     // default: 'default'
  progress?: number;                 // 0..1, only meaningful for 'progress'
  icon?: ReactNode;                  // override default variant icon
  action?: { label: string; onClick: () => void }; // optional CTA
  persistent?: boolean;
  autoDismissMs?: number | null;
}

interface CalloutHandle {
  show: (p: CalloutPayload) => string;       // returns id
  update: (id: string, p: Partial<CalloutPayload>) => void;
  dismiss: (id: string) => void;
}
```

## Migration

There are ~20 files importing from `react-toastify` (~78 call sites including `useNotifiedFetcher`-driven ones). A big-bang rewrite is risky. Plan:

1. **Land the primitive.** Build `Callout` in `@classmoji/ui-components` with tests. No app changes yet.
2. **Mount the provider + default slot.** In `apps/webapp/app/root.tsx` add `<CalloutProvider>` around the tree. In `CommonLayout.tsx`, render `<CalloutSlot />` just below the page header (above the floating card content area). Keep `<ToastContainer />` mounted in parallel during migration.
3. **Replace `useNotifiedFetcher`.** Rewrite the hook to drive `useCallout()` instead of `toast()`. This single change migrates the majority of call sites because most use the `notify(action, message)` pattern, not direct `toast.*` calls. Public API of the hook stays identical — no caller changes needed.
4. **Migrate direct `toast.*` callers.** ~20 files with explicit `toast.success(...)` / `toast.error(...)`. Replace with `useCallout().show(...)` one route group at a time. Each PR touches a single feature area to keep diffs reviewable.
5. **Replace `TriggerProgress` modal usage.** Convert callers to `callout.show({ variant: 'progress', slot: '<feature-slot>', ... })` and `callout.update(...)` driven by the existing Trigger.dev polling. Delete `TriggerProgress` once all callers migrate.
6. **Replace `ImportProgressModal` (slides).** Same pattern — slides app gets its own `<CalloutProvider>` + `<CalloutSlot />` in `apps/slides/app/root.tsx`.
7. **Remove `react-toastify`.** Drop `<ToastContainer />` from both root files, uninstall the package, delete `cssTransition` import.

Steps 1–3 can land in a single PR (the primitive plus the `useNotifiedFetcher` rewrite covers most of the surface invisibly). Steps 4–7 land incrementally.

### `useNotifiedFetcher` compatibility note

The hook today auto-dismisses success at 2s and error at 4s. The new variant defaults are 4s for success and persistent for error. The hook will pass `autoDismissMs: 2000` for success to preserve the existing snappy feel for fetcher-driven flows; errors will become persistent (a behavior improvement — errors currently disappear after 4s, which is too short).

## Testing

Unit tests in `Callout.test.tsx` (Vitest + React Testing Library, matching the existing `packages/ui-components` test setup):

- `show()` renders into the default slot.
- `show({ slot: 'x' })` renders into slot `x`, not default.
- A second `show()` to the same slot replaces the first.
- `update()` morphs the active card without remounting.
- Auto-dismiss timers fire per variant default and clean up on unmount.
- Buffered fallback to default slot after 500ms when target is unmounted.
- `prefers-reduced-motion` skips translate animation.

Manual smoke pass after each migration PR using existing Playwright smoke tests in `apps/webapp/tests/smoke/critical-paths.spec.ts` — the suite already covers form-submit flows that surface toasts today.

## Risks

- **Slot discoverability.** Devs need to know slots exist. Mitigation: default slot covers 95% of cases; doc comment in `CalloutSlot.tsx` and a short README in `packages/ui-components/src/Callout/`.
- **Long-running progress callouts blocking other messages.** Single-slot replace means a progress callout will be replaced by an unrelated success/error. Mitigation: features that need durable progress (Trigger.dev syncs) should declare a dedicated slot rather than firing into `default`.
- **Slides app divergence.** Slides currently uses `top-center` toasts; moving to inline may shift expectations. Mitigation: the slides cutover (step 6) is independent and can be deferred.

## Open questions

None remaining — defaults above can be tweaked during implementation review.
