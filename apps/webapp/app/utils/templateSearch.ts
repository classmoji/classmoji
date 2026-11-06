/**
 * Template repository search, shared by `/api/github-repos?q=` (which orders
 * the results) and the two template pickers (which show them in groups).
 *
 * Order: the classroom's own org first (private before public, marked
 * templates first within each), then public template repositories anywhere.
 */
import type { ReactNode } from 'react';

/** `class`: in the classroom's org or group. `public`: a public template elsewhere. */
export type TemplateGroup = 'class' | 'public';

export interface TemplateRepository {
  name: string;
  ref?: string;
  full_name: string;
  description: string | null;
  updated_at: string | null | undefined;
  private: boolean;
  is_template?: boolean;
  language: string | null;
  stargazers_count: number;
  group: TemplateGroup;
}

export const TEMPLATE_GROUP_LABELS: Record<TemplateGroup, string> = {
  class: 'Your templates',
  public: 'Public templates',
};

const GROUP_ORDER: TemplateGroup[] = ['class', 'public'];

/**
 * Merge the org search and the public search into one ordered list. A repo in
 * both (the org's public repos) keeps its org entry; repos in `excluded`
 * (Classmoji's generated student and team repos) are dropped. Within a group
 * the search's own order (most recently updated) is kept.
 */
export function orderTemplateResults({
  orgItems,
  publicItems,
  excluded,
  limit,
}: {
  orgItems: Omit<TemplateRepository, 'group'>[];
  publicItems: Omit<TemplateRepository, 'group'>[];
  excluded: Set<string>;
  limit: number;
}): TemplateRepository[] {
  const seen = new Set<string>();
  const take = (items: Omit<TemplateRepository, 'group'>[], group: TemplateGroup) =>
    items.flatMap(item => {
      const key = item.full_name.toLowerCase();
      if (seen.has(key) || excluded.has(key)) return [];
      seen.add(key);
      return [{ ...item, group }];
    });

  const rank = (r: TemplateRepository) => (r.private ? 0 : 2) + (r.is_template ? 0 : 1);
  // Array.prototype.sort is stable, so ties keep the search order.
  const own = take(orgItems, 'class').sort((a, b) => rank(a) - rank(b));
  const elsewhere = take(publicItems, 'public');
  return [...own, ...elsewhere].slice(0, limit);
}

/** antd Select options, one titled group per non-empty group, in order. */
export function groupTemplateOptions(
  items: TemplateRepository[],
  renderLabel: (item: TemplateRepository) => ReactNode
) {
  return GROUP_ORDER.flatMap(group => {
    const options = items
      .filter(item => (item.group ?? 'class') === group)
      .map(item => ({ value: item.full_name, label: renderLabel(item) }));
    if (options.length === 0) return [];
    const label = TEMPLATE_GROUP_LABELS[group];
    return [{ label, title: label, options }];
  });
}
