export function LockedBanner() {
  return (
    <div className="bg-amber-50 dark:bg-amber-950/40 text-amber-900 dark:text-amber-200 ring-1 ring-amber-200 dark:ring-amber-900 rounded-lg px-3 py-2 text-sm mb-3">
      Read-only mode: this class has been locked by the owner. You can view everything but cannot make changes.
    </div>
  );
}
