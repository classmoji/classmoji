/**
 * The page chrome every public forms surface sits in: the classroom's own
 * canvas tint, a centred card, and the course's name above it.
 *
 * ── Why the colours arrive as props ────────────────────────────────────────
 * `getThemeByKey` lives in `@classmoji/utils/themes` and the LOADER calls it,
 * handing this component two hex strings. Importing it here would work, but the
 * loader already has the classroom row in hand and the component then has no
 * reason to know that themes exist as a concept — which keeps this file a
 * layout and the theme a piece of data.
 *
 * ── Why a <style> tag and not an inline background ─────────────────────────
 * An inline `style={{background}}` is one value, and this needs two: the light
 * one and the dark one, chosen before paint, with no JavaScript in this
 * component and no flash. So both ship as a custom property and CSS picks.
 *
 * ── Why THREE selectors and not just `html.dark` ───────────────────────────
 * The card inside this canvas is styled with Tailwind's `dark:` utilities, and
 * this app's `tailwind.css` declares no `@custom-variant dark` — so in Tailwind
 * v4 those utilities compile to `@media (prefers-color-scheme: dark)`. The
 * canvas used to key on the `dark` CLASS that root.tsx's boot script adds: two
 * different sources of truth for one page. When they disagreed — a hydration
 * mismatch stripping the class was one real way (see `FormRenderer`), no JS is
 * another — the card went dark and the canvas stayed white. Making that
 * disagreement impossible is the whole point of the shape below.
 *
 * The canvas now follows the SAME signal the card does, with the class as an
 * override on top:
 *
 *   1. `:root`                    — light, the floor.
 *   2. `@media (prefers-color-scheme: dark) :root:not(.light)`
 *                                 — dark whenever the card is dark: class or no
 *                                   class, JavaScript or none.
 *   3. `html.dark` / `html.light` — an EXPLICIT choice beats the OS.
 *
 * `.light` is the positive marker for forced light. `?theme=light` — the
 * appearance the webapp passes when it frames one of these pages — only ever
 * REMOVED the `dark` class, which is indistinguishable from "nobody expressed a
 * preference"; under rule 2 alone, a forced-light embed on a dark-mode machine
 * would have gone dark. So `APP_DARK_MODE_SCRIPT` in root.tsx now adds `light`
 * on that path and rule 2 steps aside for it. That branch of the script returns
 * before attaching the OS listener, so `.light` and `.dark` can never both be
 * present and rules 3 cannot fight each other.
 *
 * `color-scheme` rides the same three selectors, so the native controls this
 * page is made of — inputs, selects, checkboxes, the scrollbar — match the
 * surface they sit on.
 *
 * `body` is painted too, so the overscroll area past the end of a long form
 * matches the canvas instead of showing the app's default background. The dark
 * case is stated a second time on purpose: `tailwind.css` points `html.dark
 * body` at the editor's own #191919, which outranks a bare `body` selector, so
 * beating it needs a rule of equal specificity — this stylesheet renders after
 * that one, so the later of the two wins. Drop that line and every classroom
 * theme gets a grey overscroll that does not match its canvas.
 */

export interface CanvasTheme {
  background: string;
  darkBackground: string;
}

export function FormCanvas({
  theme,
  classroomName,
  children,
}: {
  theme: CanvasTheme;
  classroomName?: string | null;
  children: React.ReactNode;
}) {
  return (
    <>
      <style>{`
        :root { --forms-canvas: ${theme.background}; color-scheme: light; }
        @media (prefers-color-scheme: dark) {
          :root:not(.light) { --forms-canvas: ${theme.darkBackground}; color-scheme: dark; }
        }
        html.dark { --forms-canvas: ${theme.darkBackground}; color-scheme: dark; }
        html.light { --forms-canvas: ${theme.background}; color-scheme: light; }
        body { background-color: var(--forms-canvas); }
        html.dark body { background-color: var(--forms-canvas); }
      `}</style>
      <div
        className="min-h-screen px-4 py-10 sm:py-16"
        style={{ backgroundColor: 'var(--forms-canvas)' }}
      >
        <div className="mx-auto w-full max-w-2xl">
          {classroomName ? (
            <div className="mb-3 px-1 text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
              {classroomName}
            </div>
          ) : null}
          <div className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-black/5 sm:p-9 dark:bg-neutral-900 dark:ring-white/10">
            {children}
          </div>
          <div className="mt-6 text-center text-xs text-gray-400 dark:text-gray-500">
            Powered by Classmoji
          </div>
        </div>
      </div>
    </>
  );
}

/** The form's own title and description, above the fields. */
export function FormHeader({ title, description }: { title: string; description?: string | null }) {
  return (
    <header className="mb-7">
      <h1 className="text-2xl font-bold tracking-tight text-gray-900 dark:text-white">{title}</h1>
      {description ? (
        <p className="mt-2 text-sm text-gray-600 dark:text-gray-300">{description}</p>
      ) : null}
    </header>
  );
}

/**
 * A terminal state: an icon, a headline, and a line of prose. Every non-form
 * outcome of these two routes — check your email, this form is closed, you're
 * in, that link expired — is one of these, so they all read as the same page in
 * a different mood rather than as four different error screens.
 */
export function FormNotice({
  icon,
  title,
  children,
}: {
  icon: string;
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="py-4 text-center">
      <div className="mb-3 text-3xl" aria-hidden="true">
        {icon}
      </div>
      <h1 className="text-xl font-semibold text-gray-900 dark:text-white">{title}</h1>
      <div className="mx-auto mt-3 max-w-md text-sm leading-relaxed text-gray-600 dark:text-gray-300">
        {children}
      </div>
    </div>
  );
}
