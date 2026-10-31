import { Link } from 'react-router';

/**
 * Shown to a plan owner who has more active classes than the Free plan
 * includes (a lapsed Pro, or a class handed to them). Nothing is locked for
 * it: the classes keep working, and only starting or reactivating another one
 * is refused. Built from the viewer's OWN allowance, so it never names anyone
 * else's classes.
 */
export interface ActiveClassAllowanceSummary {
  /** `null` = unlimited (Pro). */
  limit: number | null;
  active: { id: string; name: string; slug: string }[];
}

export const isOverActiveClassLimit = (allowance: ActiveClassAllowanceSummary | null | undefined) =>
  !!allowance && allowance.limit !== null && allowance.active.length > allowance.limit;

const ActiveClassLimitNotice = ({ allowance }: { allowance: ActiveClassAllowanceSummary }) => {
  if (!isOverActiveClassLimit(allowance)) return null;
  const count = allowance.active.length;

  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg bg-amber-50 dark:bg-amber-950/40 ring-1 ring-amber-200 dark:ring-amber-900 px-4 py-3"
    >
      <div className="flex-1 min-w-[14rem]">
        <div className="text-sm font-medium text-amber-900 dark:text-amber-100">
          You have {count} active classes. The Free plan includes {allowance.limit}.
        </div>
        <div className="mt-0.5 text-sm text-amber-800 dark:text-amber-200">
          They keep working. To start or reactivate another class, archive{' '}
          {count - (allowance.limit ?? 0)} of them in Class Settings, or upgrade to Pro.
        </div>
      </div>
      <Link to="/settings/billing" className="btn btn-sm">
        Upgrade to Pro
      </Link>
    </div>
  );
};

export default ActiveClassLimitNotice;
