/**
 * PropertySection - A collapsible section within the properties panel
 *
 * Groups related properties together with a title header.
 */
export default function PropertySection({ title, children, defaultOpen = true }) {
  return (
    <div className="border-b border-gray-200 dark:border-gray-700 pb-4 mb-4 last:border-b-0 last:pb-0 last:mb-0">
      <h3 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-3">
        {title}
      </h3>
      <div className="space-y-3">
        {children}
      </div>
    </div>
  );
}

/**
 * PropertyRow - A single property with label and control
 */
export function PropertyRow({ label, children }) {
  return (
    <div className="flex items-center justify-between">
      <label className="text-sm text-gray-700 dark:text-gray-300">
        {label}
      </label>
      <div className="shrink-0">
        {children}
      </div>
    </div>
  );
}

/**
 * PropertyLabel - Just a label for full-width controls
 */
export function PropertyLabel({ children }) {
  return (
    <label className="block text-sm text-gray-700 dark:text-gray-300 mb-1.5">
      {children}
    </label>
  );
}
