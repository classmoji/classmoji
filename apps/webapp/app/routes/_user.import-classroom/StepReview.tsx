import { useEffect, useState } from 'react';
import { Input, Tag } from 'antd';
import type { ListedClassroom } from './utils';

interface Props {
  classrooms: ListedClassroom[]; // only the selected ones
  slugByClassroom: Map<number, string>;
  onSlugChange: (githubId: number, slug: string) => void;
}

interface SlugStatus {
  checking: boolean;
  available: boolean;
  suggestion?: string;
}

/**
 * Step 3 — review each selected classroom, edit its slug, and confirm. Slug
 * availability is checked per classroom against the (possibly not-yet-created)
 * GitHub org via the availability endpoint's `org_provider_id` path.
 */
export default function StepReview({ classrooms, slugByClassroom, onSlugChange }: Props) {
  const [status, setStatus] = useState<Map<number, SlugStatus>>(new Map());

  // Debounced availability check whenever a slug changes.
  useEffect(() => {
    const handle = setTimeout(async () => {
      const next = new Map<number, SlugStatus>();
      await Promise.all(
        classrooms.map(async c => {
          const slug = slugByClassroom.get(c.githubId) ?? '';
          if (!slug || !c.organization) {
            next.set(c.githubId, { checking: false, available: !!c.organization });
            return;
          }
          try {
            const params = new URLSearchParams({
              org_provider_id: String(c.organization.id),
              slug,
            });
            const res = await fetch(`/api/classrooms/availability?${params.toString()}`);
            const data = (await res.json()) as {
              slug_available: boolean;
              slug_suggestion?: string;
            };
            next.set(c.githubId, {
              checking: false,
              available: data.slug_available,
              suggestion: data.slug_suggestion,
            });
          } catch {
            // Network hiccup — don't block import; treat as available.
            next.set(c.githubId, { checking: false, available: true });
          }
        })
      );
      setStatus(next);
    }, 350);
    return () => clearTimeout(handle);
    // Re-run when the set of classrooms or any slug changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [classrooms, Array.from(slugByClassroom.values()).join('|')]);

  return (
    <div>
      <p className="text-sm text-gray-600 dark:text-gray-300 mb-4">
        Review and confirm. Imported classrooms start GitHub-free; install the Classmoji app later
        to enable live syncing and grading.
      </p>

      <div className="space-y-3">
        {classrooms.map(c => {
          const slug = slugByClassroom.get(c.githubId) ?? '';
          const st = status.get(c.githubId);
          const taken = st && !st.checking && !st.available;
          return (
            <div
              key={c.githubId}
              className="rounded-xl ring-1 ring-stone-200 dark:ring-neutral-800 p-4"
            >
              <div className="font-medium dark:text-gray-100">{c.name}</div>
              <div className="text-xs text-gray-500 dark:text-gray-400 mb-2">
                {c.organization?.login ?? 'No organization'}
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-gray-500 dark:text-gray-400">/admin/</span>
                <Input
                  size="small"
                  value={slug}
                  status={taken ? 'error' : undefined}
                  style={{ maxWidth: 320 }}
                  onChange={e => onSlugChange(c.githubId, e.target.value)}
                />
                {taken && st?.suggestion && (
                  <Tag
                    color="blue"
                    className="cursor-pointer"
                    onClick={() => onSlugChange(c.githubId, st.suggestion!)}
                  >
                    Use {st.suggestion}
                  </Tag>
                )}
              </div>
              {taken && (
                <div className="text-xs text-red-500 mt-1">
                  A classroom with this slug already exists in {c.organization?.login}.
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
