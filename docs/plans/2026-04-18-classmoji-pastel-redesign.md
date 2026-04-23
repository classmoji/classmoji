# Classmoji Pastel Redesign Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Apply the "Classmoji Student App" design (pastel light-blue paper, CLASSMOJI wordmark, sectioned sidebar, pastel chips, Tweaks FAB, dark theme) across the entire `apps/webapp`, preserving all functionality and responsiveness.

**Architecture:**
- Port the prototype's CSS variables (light + dark) into `global.css` and re-expose them through Tailwind v4 `@theme` in `tailwind.css`. Re-skin existing components — do NOT introduce a new component library.
- Replace the current sidebar (`CommonLayout`) with a shell that mirrors the design (Brand → user-card → class-switch → sectioned nav → footer nav). Add a global Tweaks FAB.
- Rebuild the five explicitly-mocked Student screens (Dashboard, Calendar, Modules, Module Detail, Assignments) in Tailwind. Other Student/Admin/Assistant routes are restyled by token migration + replacing layout chrome (cards, chips, buttons, breadcrumbs).

**Tech Stack:** React Router 7 (framework mode), Tailwind CSS v4 (@theme), Inter + JetBrains Mono + Instrument Serif via Google Fonts, AntD `ConfigProvider` (existing), `useDarkMode` hook (existing).

**Reference files (extracted design bundle):**
- `/tmp/design-pkg/extracted/classmoji/project/styles.css`
- `/tmp/design-pkg/extracted/classmoji/project/Classmoji Student App.html`
- `/tmp/design-pkg/extracted/classmoji/project/components/{shell,home,screens,tweaks,wordmark}.jsx`
- `/tmp/design-pkg/extracted/classmoji/project/screenshots/*.jpg`

**Working principles:**
- DRY: shared chips/cards/buttons live as Tailwind utility classes (`.chip`, `.chip-quiz`, `.card`, `.btn`, `.btn-primary`) defined once in `global.css`. Routes use Tailwind utilities + these utility classes; no per-route CSS files.
- YAGNI: don't introduce features not in the design. Tweaks FAB exposes only accent + theme.
- Responsive: prototype is 1280px-fixed; we keep the existing responsive layout (mobile sidebar collapse already in `CommonLayout`).
- Dark mode: tokens drive both themes; `html.dark` swaps the variables. AntD theme already wired via `useDarkMode`.
- Accessibility: keep `:focus-visible`, semantic landmarks, AA contrast. Don't remove existing aria attrs.
- TDD-light: this is a visual redesign — "tests" are typecheck + build + manual playwright snapshot of dashboard/calendar/modules/login. After each task: `npm run web:typecheck && npm run web:build`. After Phase 2/3, capture playwright screenshots of the five student screens at desktop + tablet width.
- Commits: one focused commit per task, conventional `feat(webapp):` / `style(webapp):` prefix.

---

## Phase 1 — Foundations

### Task 1: Pastel design tokens + Instrument Serif

**Files:**
- Modify: `apps/webapp/app/styles/global.css`
- Modify: `apps/webapp/app/styles/tailwind.css`
- Modify: `apps/webapp/app/root.tsx` (font preconnect)

**Step 1: Update CSS variables in `global.css` `:root`**

Replace the existing tokens with the bundle's final palette (light-blue paper, real violet, pastel chips). Use these literal values (from `/tmp/design-pkg/extracted/classmoji/project/styles.css`):

```css
:root {
  /* Accent — set by Tweaks panel */
  --accent: #6d5efc;
  --accent-hover: #5a4cf0;
  --accent-soft: #ece9ff;
  --accent-soft-2: #dedaff;
  --accent-ink: #4a3fbb;

  /* Legacy aliases — keep working */
  --violet: var(--accent);
  --violet-hover: var(--accent-hover);
  --violet-soft: var(--accent-soft);
  --violet-soft-2: var(--accent-soft-2);
  --violet-ink: var(--accent-ink);

  /* Light-blue sky neutrals */
  --paper: #eaf0fb;
  --paper-2: #dfe7f6;
  --panel: #ffffff;
  --panel-tint: #f4f6ff;
  --panel-hover: #f7f9fd;
  --sidebar: #ffffff;

  --line: #dfe4ee;
  --line-2: #c9d0de;
  --line-strong: #a7afbf;
  --line-cool: #e5e7ef;

  --ink-0: #14151a;
  --ink-1: #2b2d35;
  --ink-2: #5b5f69;
  --ink-3: #868994;
  --ink-4: #b4b7be;

  --nav-hover: #eef1f8;
  --bar-track: #e4e8f1;
  --chip-neutral-bg: #eef1f7;
  --chip-neutral-border: #d8dde8;
  --chip-neutral-ink: #5b6272;

  --bg-stop-1: #f3f6ff;
  --bg-stop-2: #dce6fa;
  --bg-stop-3a: #e6ecf8;
  --bg-stop-3b: #eef2fb;
  --bg-stop-3c: #e3ebfa;

  --mint-bg:  #e3f3e8; --mint-bord:#c1dfcb; --mint-ink:#1a6b3e;
  --peach-bg: #fdecea; --peach-bord:#f7cfca; --peach-ink:#8a2a16;
  --sky-bg:   #e6effb; --sky-bord:#c9d9ee; --sky-ink:#1d4f8f;
  --lilac-bg: #ece9ff; --lilac-bord:#d6d0fa; --lilac-ink:#4a3fbb;
  --amber-bg: #fbf1dc; --amber-bord:#ead8b1; --amber-ink:#8a5a12;
  --rose-bg:  #fde5ea; --rose-bord:#f5c5d0; --rose-ink:#9a1f3a;

  /* Legacy aliases for chips that referenced *-soft/*-ink */
  --mint:  var(--mint-ink);  --mint-soft:  var(--mint-bg);
  --peach: var(--peach-ink); --peach-soft: var(--peach-bg);
  --sky:   var(--sky-ink);   --sky-soft:   var(--sky-bg);
  --rose:  var(--rose-ink);  --rose-soft:  var(--rose-bg);
  --amber: var(--amber-ink); --amber-soft: var(--amber-bg);

  /* Background surface aliases — keep utilities like bg-bg-0 working */
  --bg-0: var(--paper);
  --bg-1: var(--panel);
  --bg-2: var(--sidebar);
  --bg-3: var(--paper-2);
  --bg-ink: var(--ink-0);

  --shadow-card:  0 1px 2px rgba(20,10,40,0.04);
  --shadow-float: 0 10px 30px rgba(20,25,50,0.12), 0 2px 6px rgba(20,25,50,0.06);
  --shadow-sm: var(--shadow-card);
  --shadow-md: var(--shadow-card);
  --shadow-lg: var(--shadow-float);

  --r-sm: 4px; --r-md: 8px; --r-lg: 12px; --r-xl: 14px; --r-2xl: 16px;

  --font-sans:    'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
  --font-mono:    'JetBrains Mono', ui-monospace, Menlo, Consolas, monospace;
  --font-display: 'Instrument Serif', 'Cormorant Garamond', Georgia, serif;
}
```

**Step 2: Add the dark theme block right after `:root`**

```css
html.dark, html[data-theme="dark"] {
  --paper:   #0e1016;
  --paper-2: #151824;
  --panel:   #171a25;
  --panel-tint: #1c2030;
  --panel-hover: #1e2232;
  --sidebar: #121521;
  --line:        #262a38;
  --line-2:      #323648;
  --line-strong: #474c62;
  --line-cool:   #262a38;
  --ink-0: #f1f2f6;
  --ink-1: #d9dbe3;
  --ink-2: #a4a9b8;
  --ink-3: #7a7f8e;
  --ink-4: #545a6a;
  --nav-hover: #1f2333;
  --bar-track: #252a3b;
  --chip-neutral-bg: #242839;
  --chip-neutral-border: #323648;
  --chip-neutral-ink: #a4a9b8;
  --bg-stop-1: #1a1f32;
  --bg-stop-2: #0a0d17;
  --bg-stop-3a: #0c0f1a;
  --bg-stop-3b: #11152a;
  --bg-stop-3c: #090b14;
  --accent-soft:   #23204a;
  --accent-soft-2: #2e2a5e;
  --accent-ink:    #b7b0ff;
  --mint-bg:  #132a1f; --mint-bord: #1f4431; --mint-ink:  #6be39b;
  --peach-bg: #3a1612; --peach-bord:#552520; --peach-ink: #ffab9b;
  --sky-bg:   #112036; --sky-bord:  #1e3556; --sky-ink:   #8fc0ff;
  --lilac-bg: #201c3f; --lilac-bord:#342c66; --lilac-ink: #c1b7ff;
  --amber-bg: #362710; --amber-bord:#523c1b; --amber-ink: #f3c76a;
  --rose-bg:  #3a1222; --rose-bord: #571c36; --rose-ink:  #ff9bb8;
  --shadow-card:  0 1px 2px rgba(0,0,0,0.3);
  --shadow-float: 0 12px 40px rgba(0,0,0,0.5), 0 2px 6px rgba(0,0,0,0.3);
}
```

**Step 3: Body gradient + Instrument Serif**

Replace the existing `body` rule and add display class:

```css
body {
  font-family: var(--font-sans);
  color: var(--ink-0);
  background:
    radial-gradient(1200px 800px at 85% -10%, var(--bg-stop-1) 0%, transparent 60%),
    radial-gradient(900px 700px at -10% 110%, var(--bg-stop-2) 0%, transparent 55%),
    linear-gradient(175deg, var(--bg-stop-3a) 0%, var(--bg-stop-3b) 55%, var(--bg-stop-3c) 100%);
  background-attachment: fixed;
  -webkit-font-smoothing: antialiased;
  font-size: 13px;
  line-height: 1.45;
}
.display { font-family: var(--font-display); letter-spacing: -0.005em; }
```

(Drop the old GitLab body rule and the `* { font-family: 'Inter' }` global — let `body` cascade.)

**Step 4: Add Instrument Serif to root font link**

In `apps/webapp/app/root.tsx` and `global.css`'s `@import url('https://fonts.googleapis.com/css2?...')`, append `Instrument+Serif:ital@0;1`. The `<link href="…">` becomes:
`https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&family=Instrument+Serif:ital@0;1&display=swap`

**Step 5: Update `tailwind.css` `@theme`**

Add token aliases so utilities like `bg-paper`, `bg-panel`, `bg-sidebar`, `bg-mint-bg`, `text-mint-ink`, `border-line-cool`, `text-accent-ink`, `bg-accent-soft` exist:

```css
--color-paper: var(--paper);
--color-panel: var(--panel);
--color-panel-hover: var(--panel-hover);
--color-sidebar: var(--sidebar);
--color-nav-hover: var(--nav-hover);
--color-line-cool: var(--line-cool);
--color-accent: var(--accent);
--color-accent-hover: var(--accent-hover);
--color-accent-soft: var(--accent-soft);
--color-accent-soft-2: var(--accent-soft-2);
--color-accent-ink: var(--accent-ink);
--color-mint-bg: var(--mint-bg);
--color-mint-bord: var(--mint-bord);
--color-mint-ink: var(--mint-ink);
/* …same pattern for peach/sky/lilac/amber/rose */
--font-display: var(--font-display);
```

Remove the GitLab-orange `--color-primary*` block — replace with:

```css
--color-primary: var(--accent);
--color-primary-50: var(--accent-soft);
--color-primary-100: var(--accent-soft-2);
--color-primary-500: var(--accent);
--color-primary-600: var(--accent-hover);
--color-primary-700: var(--accent-ink);
```

(Keep the same scale name so existing `bg-primary-500` utilities resolve to the new accent.)

**Step 6: Verify**

Run: `cd apps/webapp && npm run typecheck && npm run build`
Expected: build succeeds, no Tailwind warnings about missing tokens.

**Step 7: Commit**

```bash
git add apps/webapp/app/styles/global.css apps/webapp/app/styles/tailwind.css apps/webapp/app/root.tsx
git commit -m "feat(webapp): pastel design tokens + Instrument Serif font"
```

---

### Task 2: Re-skin chip / card / button / progress utility classes

**Files:**
- Modify: `apps/webapp/app/styles/global.css`

**Step 1: Replace `.chip*` rules**

```css
.chip {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 2px 8px; border-radius: 6px;
  font-size: 10.5px; font-weight: 600; letter-spacing: 0.04em;
  text-transform: uppercase; border: 1px solid transparent;
  line-height: 1.6; font-family: var(--font-sans);
}
.chip-quiz { background: var(--mint-bg);   color: var(--mint-ink);   border-color: var(--mint-bord); }
.chip-asgn { background: var(--peach-bg);  color: var(--peach-ink);  border-color: var(--peach-bord); }
.chip-lect { background: var(--sky-bg);    color: var(--sky-ink);    border-color: var(--sky-bord); }
.chip-proj { background: var(--rose-bg);   color: var(--rose-ink);   border-color: var(--rose-bord); }
.chip-mod  { background: var(--accent-soft); color: var(--accent-ink); border-color: var(--accent-soft-2); }
.chip-lab  { background: var(--sky-bg);    color: var(--sky-ink);    border-color: var(--sky-bord); }
.chip-late { background: var(--rose-bg);   color: var(--rose-ink);   border-color: var(--rose-bord); }
.chip-done { background: var(--mint-bg);   color: var(--mint-ink);   border-color: var(--mint-bord); }
.chip-locked,
.chip-upcoming { background: var(--chip-neutral-bg); color: var(--chip-neutral-ink); border-color: var(--chip-neutral-border); text-transform: none; font-weight: 500; letter-spacing: 0; }
.chip-inprog   { background: var(--accent-soft); color: var(--accent-ink); border-color: var(--accent-soft-2); text-transform: none; font-weight: 500; letter-spacing: 0; }
.chip-submitted{ background: var(--amber-bg); color: var(--amber-ink); border-color: var(--amber-bord); text-transform: none; font-weight: 500; letter-spacing: 0; }
.chip-ghost    { background: var(--chip-neutral-bg); color: var(--chip-neutral-ink); border-color: var(--chip-neutral-border); }
```

**Step 2: Replace `.card`, add `.panel`, `.panel-head`, `.panel-body`, `.evt*`, `.bar`, `.btn*`, `.avatar`**

Use the bundle's rules verbatim (see `/tmp/design-pkg/extracted/classmoji/project/styles.css` lines 245-355) but keep the existing `.row-hover` and animation rules intact.

`.card` becomes `background: var(--panel); border: 1px solid var(--line-cool); border-radius: var(--r-xl); box-shadow: var(--shadow-card);`

`.btn-primary` uses the bundle's `box-shadow: 0 1px 0 rgba(255,255,255,0.2) inset, 0 1px 2px rgba(80,60,200,0.25);`

**Step 3: Verify**

`npm run web:typecheck && npm run web:build`. Open the running dashboard in a browser; chips and buttons should reflect new palette.

**Step 4: Commit**

```
style(webapp): pastel chips/cards/buttons utility classes
```

---

## Phase 2 — Shell + Tweaks

### Task 3: New sidebar shell (`CommonLayout`)

**Files:**
- Modify: `apps/webapp/app/components/layout/navigation/CommonLayout.tsx`

**Step 1: Read the bundle reference**

Open `/tmp/design-pkg/extracted/classmoji/project/components/shell.jsx` for the exact structure (Brand → user-card with role → class-switch with sub-line → sectioned nav with caps headings → sidebar-foot with Settings/Docs/Support).

**Step 2: Implement**

Replace the sidebar markup so it renders, in order:
1. `Brand` row containing the existing `<Logo />` from `@classmoji/ui-components` (per memory: keep CLASSMOJI Logo component, not IconLogo).
2. `.user-card` showing `<Avatar />` + name + role label (read role from `useStore`).
3. `.class-switch` showing the active classroom name + subtitle, with chevron — wraps existing classroom-picker dropdown trigger so functionality stays.
4. Sectioned nav: top group (Dashboard, Calendar). Section header "Coursework" → Modules / Assignments / Resubmits. Section header "Reference" → People / Tokens / Syllabus / Grading Policy. Filter items by role using existing `roleSettings` so admin/assistant routes still appear under their own labels.
5. `.sidebar-foot` with Settings / Docs / Support.

Use Tailwind classes for layout (`flex flex-col gap-1 px-3 py-4 …`) and the new utility classes (`.caps`, `.chip`, etc.) for chrome. Sidebar width remains `220px` desktop; existing mobile collapse behaviour preserved.

The active item gets `bg-accent-soft text-accent-ink font-semibold`, matching the prototype.

**Step 3: Verify**

`npm run web:typecheck && npm run web:build`. Visit `/student/<class>/dashboard` — sidebar should match design (white card on pastel background, sectioned, with Tweaks-FAB-ready empty state).

**Step 4: Commit**

```
feat(webapp): redesign sidebar shell with sectioned nav and class switch
```

---

### Task 4: Breadcrumbs + main content frame

**Files:**
- Modify: `apps/webapp/app/components/layout/navigation/CommonLayout.tsx` (or extract `Crumbs.tsx` if not already)

**Step 1: Implement breadcrumbs**

Add `<Crumbs trail={[...]} />` rendered above each route. Trail is derived from `useLocation()` + classroom slug. Style: small dot in accent + breadcrumb segments with `/` separator, last segment `ink-0` bold (per `shell.jsx` lines 90-102).

**Step 2: Wrap children in `.main` (`flex flex-col p-5 overflow-y-auto`)**

**Step 3: Verify**

Typecheck + build. Visit a deep route (`/student/<class>/modules/<module>`) — breadcrumbs render correctly.

**Step 4: Commit**

```
feat(webapp): add accent-dot breadcrumbs above main content
```

---

### Task 5: Tweaks FAB (accent picker + theme toggle)

**Files:**
- Create: `apps/webapp/app/components/features/tweaks/TweaksPanel.tsx`
- Modify: `apps/webapp/app/root.tsx` (mount `<TweaksPanel />` once, after `<Outlet />`)
- Modify: `apps/webapp/app/styles/global.css` (already has `.tweaks-fab`/`.tweaks-panel` rules — confirm or port from bundle lines 357-496)

**Step 1: Implement**

Reference `/tmp/design-pkg/extracted/classmoji/project/components/tweaks.jsx`. The component:
- Floating round button bottom-right (`.tweaks-fab`) — sliders/cog icon.
- On click, reveals a 300px panel with: Accent swatches (6 presets), custom color input, theme segmented control (Light / Dark).
- Persists choice in `localStorage`: `cm-accent` (hex) and `cm-theme` (`light|dark|system`).
- Accent: sets CSS var on `:root` via `document.documentElement.style.setProperty('--accent', value)` plus computes `--accent-hover`, `--accent-soft`, `--accent-soft-2`, `--accent-ink` (use `color-mix()` or precomputed swatch metadata table).
- Theme: toggles `html.dark`. Bridge to existing `useDarkMode` store so AntD `ConfigProvider` picks it up — call the same setter the existing dark-mode hook uses.

**Step 2: Verify**

Build. Open app; FAB visible on every authenticated page. Pick a swatch — accent changes app-wide. Toggle dark — sidebar/content/AntD components all flip.

**Step 3: Commit**

```
feat(webapp): add Tweaks FAB for accent and theme controls
```

---

## Phase 3 — Student Screens (1:1 with design)

### Task 6: Dashboard

**Files:**
- Modify: `apps/webapp/app/routes/student.$class.dashboard/route.tsx`
- Create: `apps/webapp/app/routes/student.$class.dashboard/components/{CourseDueBanner,WeekStrip,ModuleThisWeek,GroupActivity}.tsx`

**Step 1: Port layout**

Reference `/tmp/design-pkg/extracted/classmoji/project/components/home.jsx`. Build:
1. `CourseDueBanner` — full-width panel with `chip-quiz`, title, due time, "+N more" ghost button.
2. `WeekStrip` — 7-column grid; today's date in accent-filled circle; pastel `evt evt-{kind}` chips.
3. `ModuleThisWeek` — left card; module heading + list of items with chip + name + due copy.
4. `GroupActivity` — right card; commit list with monospace SHA, +/- diff counts, avatar initials.

Wire to existing dashboard loader data (assignments, modules, group repo activity). If a data field is missing, fall back to a clearly-labelled empty state (don't fabricate data).

**Step 2: Verify**

Run dev server (already running per AGENTS.md). Visit `/student/<class>/dashboard` and screenshot via `mcp__plugin_playwright_playwright__browser_take_screenshot`. Compare against `/tmp/design-pkg/extracted/classmoji/project/screenshots/01-01-light.jpg`.

**Step 3: Commit**

```
feat(webapp): redesign student dashboard with pastel week strip + activity
```

---

### Task 7: Calendar

**Files:**
- Modify: `apps/webapp/app/routes/student.$class.calendar/route.tsx`

**Step 1: Implement**

Match the prototype's `CalendarScreen` (in `/tmp/design-pkg/extracted/classmoji/project/components/screens.jsx`): month/week toggle, weekday header row, 7×N grid of day cells with stacked `.evt` chips, today highlighted with accent ring. Keep the existing iCal-feed action and event loader.

**Step 2: Verify**

Build, screenshot calendar route, compare to mock.

**Step 3: Commit** `feat(webapp): redesign student calendar`

---

### Task 8: Modules list + Module Detail

**Files:**
- Modify: `apps/webapp/app/routes/student.$class.modules/route.tsx`
- Modify: `apps/webapp/app/routes/student.$class.modules_.$module/route.tsx`

**Step 1: Modules list**

Per `screens.jsx` `ModulesScreen`: full-width rows, each with module index chip, title, subtitle, progress bar (`.bar .fill`), status chip (`chip-done|chip-inprog|chip-locked`), chevron CTA. Click → existing module-detail route.

**Step 2: Module detail**

Per `screens.jsx` `ModuleDetailScreen`: hero panel with module name + "Continue" primary CTA. Below, sectioned list of items by chip kind (quizzes, lectures, assignments) with same row style as dashboard.

**Step 3: Verify** + screenshot.

**Step 4: Commit** `feat(webapp): redesign module list and module detail`

---

### Task 9: Assignments list

**Files:**
- Modify: `apps/webapp/app/routes/student.$class.tasks/route.tsx`

**Step 1: Implement**

Two-column layout: left = filter chips (status + type), right = list of assignment rows (chip + title + due + status chip). Detail-view drawer/page reuses existing assignment detail.

**Step 2: Verify** + screenshot.

**Step 3: Commit** `feat(webapp): redesign student assignments list`

---

### Task 10: Placeholder student routes (Resubmits, People, Tokens, Syllabus, Grading)

**Files:**
- Modify: `apps/webapp/app/routes/student.$class.regrade-requests/route.tsx`
- Modify: `apps/webapp/app/routes/student.$class.tokens/route.tsx`
- Modify: `apps/webapp/app/routes/student.$class.syllabus/route.tsx`
- Existing People route (search under `student.$class.*`) and Grading Policy: re-skin shell only.

**Step 1: Apply panel + chip kit**

Each route wraps content in `.card`/`.panel` with `.panel-head` (title + actions) and `.panel-body`. Replace any GitLab-orange CTAs with `btn btn-primary` (now violet). No structural rewrite.

**Step 2: Verify** + screenshot one of them.

**Step 3: Commit** `style(webapp): apply pastel kit to remaining student routes`

---

## Phase 4 — Admin / Assistant / Public

### Task 11: Admin shell + dashboard

**Files:**
- Modify: `apps/webapp/app/routes/admin.$class.dashboard/route.tsx`
- Other `admin.$class.*` routes inherit shell automatically.

**Step 1:** Shell already updated (Task 3) — verify admin nav items render under correct sections (Coursework: Modules, Quizzes, Assignments; People: Students, Assistants, Teams; Settings group).

**Step 2:** For dashboard route, restyle stats cards using `.card` + `.caps` headers + `display` numbers. Charts keep their existing libs but inherit colors via CSS vars (set chart colors to `var(--accent)`, `var(--mint-ink)`, etc.).

**Step 3:** Skim every other admin route in dev browser. Replace any explicit `bg-primary-*`, `border-iron`, `bg-gray-*` that conflict with the new palette. Most should already work via the token migration in Task 1.

**Step 4: Commit** `style(webapp): apply pastel kit to admin routes`

---

### Task 12: Assistant routes

**Files:**
- All `apps/webapp/app/routes/assistant.$class_.*/route.tsx`

**Step 1:** Most assistant routes re-export from student routes (per AGENTS.md). For routes that don't, apply the same kit pass as Task 11.

**Step 2: Commit** `style(webapp): apply pastel kit to assistant routes`

---

### Task 13: Public + auth + landing routes

**Files:**
- `apps/webapp/app/routes/_index/`
- `apps/webapp/app/routes/_user/route.tsx`
- `apps/webapp/app/routes/_user.select-organization/route.tsx`
- `apps/webapp/app/routes/_user.create-classroom/`
- `apps/webapp/app/routes/_user.settings*`

**Step 1:** Re-skin the landing app bar + hero using the new tokens. Drop GitLab-orange. Use `display` font for the hero heading.

**Step 2:** Settings pages (general/billing) — apply panel layout, keep forms but switch button styles.

**Step 3: Commit** `style(webapp): apply pastel kit to landing + settings routes`

---

### Task 14: AntD theme + ErrorBoundary

**Files:**
- Modify: `apps/webapp/app/config/antd.ts`
- Modify: `apps/webapp/app/config/antdDark.ts`
- Modify: `apps/webapp/app/root.tsx` (ErrorBoundary at bottom)

**Step 1:** Set AntD `colorPrimary: '#6d5efc'` (light) and accent-ink for dark. Update Button overrides to use `var(--accent)`.

**Step 2:** ErrorBoundary surface — switch the orange/dark palette to the new tokens; primary button = `bg-accent text-white`.

**Step 3: Commit** `style(webapp): align AntD config and ErrorBoundary with new tokens`

---

## Phase 5 — Final QA

### Task 15: Visual regression sweep + final review

**Step 1:** Capture playwright screenshots (light + dark) for: Dashboard, Calendar, Modules, ModuleDetail, Assignments, AdminDashboard, SelectOrganization, Login. Save to `.playwright-mcp/redesign-<date>/`.

**Step 2:** Run `npm run web:typecheck && npm run web:build && npm run web:test` (Playwright e2e). Fix any selectors broken by class-name changes.

**Step 3:** Dispatch a final code reviewer (`pr-review-toolkit:code-reviewer`) over the full diff `git diff main...redesign`.

**Step 4: Commit** `chore(webapp): final redesign QA pass`

---

## Done Criteria
- All five mocked Student screens visually match prototype at desktop (1280px) and tablet (768px) widths in light + dark modes.
- Tweaks FAB sets accent + theme; choices persist.
- Sidebar uses CLASSMOJI Logo, sectioned nav, class-switch.
- AntD components inherit accent from CSS var.
- Typecheck, build, and existing Playwright suite pass.
- No remaining references to GitLab orange (`#e24329`) anywhere in `apps/webapp/app/**`.
