import { Link } from 'react-router';

/**
 * The Edit · Responses · Teams switcher on a form's admin screens.
 *
 * One component for the builder, the responses page and the team-set pages, so
 * the three screens name each other the same way and a form's staff can move
 * between them without going back to the list.
 *
 * Presentational only: every prop is something the route's loader already has.
 * Teams is left out for a PUBLIC form, because team sets are built from a
 * classroom roster and a public form's respondents are not on one. An
 * unpublished CLASSROOM form still gets the tab; the team-set pages say what is
 * missing there.
 *
 * Paths are built the way the rest of the forms admin builds them (template
 * literals, no encoding): slugs are already URL-safe.
 */

export type FormAdminTab = 'edit' | 'responses' | 'teams';

export type FormAdminAccess = 'PUBLIC' | 'CLASSROOM';

export interface FormAdminTabsProps {
  classroomSlug: string;
  formSlug: string;
  /** The form's access mode. Teams is shown only for CLASSROOM. */
  access: FormAdminAccess;
  /** The screen being shown; its link carries `aria-current="page"`. */
  active: FormAdminTab;
  /** Submitted responses, shown next to "Responses". Omitted: no count. */
  responses?: number | null;
}

export interface FormAdminTabItem {
  tab: FormAdminTab;
  label: string;
  href: string;
  current: boolean;
  /** Only ever set on the Responses tab. */
  count: number | null;
}

const TAB_LABELS: Record<FormAdminTab, string> = {
  edit: 'Edit',
  responses: 'Responses',
  teams: 'Teams',
};

/**
 * The tabs to render, in order. Pure, so `tests/unit/forms-admin-tabs.spec.ts`
 * can check the links and the PUBLIC rule without rendering: the Playwright
 * runner compiles JSX to its own component-testing objects, which React cannot
 * render.
 */
export function formAdminTabItems({
  classroomSlug,
  formSlug,
  access,
  active,
  responses,
}: FormAdminTabsProps): FormAdminTabItem[] {
  const base = `/${classroomSlug}/forms/${formSlug}`;
  const tabs: FormAdminTab[] =
    access === 'CLASSROOM' ? ['edit', 'responses', 'teams'] : ['edit', 'responses'];

  return tabs.map(tab => ({
    tab,
    label: TAB_LABELS[tab],
    href: `${base}/${tab}`,
    current: tab === active,
    count: tab === 'responses' && typeof responses === 'number' ? responses : null,
  }));
}

export function FormAdminTabs(props: FormAdminTabsProps) {
  return (
    <nav
      aria-label="Form"
      className="inline-flex items-center gap-0.5 rounded-lg border border-gray-200 bg-gray-50 p-0.5 dark:border-gray-700 dark:bg-gray-900"
    >
      {formAdminTabItems(props).map(item => (
        <Link
          key={item.tab}
          to={item.href}
          aria-current={item.current ? 'page' : undefined}
          className={`whitespace-nowrap rounded-md px-3 py-1.5 text-sm ${
            item.current
              ? 'bg-white font-semibold text-gray-900 shadow-sm dark:bg-gray-800 dark:text-white'
              : 'text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white'
          }`}
        >
          {item.label}
          {item.count !== null ? (
            <>
              {' '}
              <span className="font-normal tabular-nums text-gray-400 dark:text-gray-500">
                {item.count}
              </span>
            </>
          ) : null}
        </Link>
      ))}
    </nav>
  );
}

export default FormAdminTabs;
