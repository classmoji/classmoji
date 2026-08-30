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
 * Dark mode in this app is a `dark` class on `<html>`, set by an inline script
 * before paint. An inline `style={{background}}` cannot react to it, so the dark
 * variant would need JavaScript and would flash the light colour first. Emitting
 * both values as a custom property — one under `:root`, one under `html.dark` —
 * lets the class the boot script already sets pick the right one, with no JS in
 * this component and no flash.
 *
 * `body` is painted too, so the overscroll area past the end of a long form
 * matches the canvas instead of showing the app's default background.
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
        :root { --forms-canvas: ${theme.background}; }
        html.dark { --forms-canvas: ${theme.darkBackground}; }
        body { background-color: var(--forms-canvas); }
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
