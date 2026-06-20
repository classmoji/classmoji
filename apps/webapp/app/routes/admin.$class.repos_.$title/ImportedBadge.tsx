import { Tooltip, Tag } from 'antd';
import { IconBrandGithub } from '@tabler/icons-react';

interface ImportedMeta {
  source?: string;
  points_awarded?: string;
  points_available?: string;
  submission_timestamp?: string | null;
  grade?: string | null;
  commit_count?: number;
  submitted?: boolean;
  passing?: boolean;
  original_url?: string;
}

/**
 * Read-only badge for data imported from GitHub Classroom (stored on
 * `GitRepo.metadata`). Shown whenever metadata exists — it is reference info, NOT
 * a live Classmoji grade. Primary text shows real points (when an autograding
 * scale existed) otherwise the commit count.
 */
export default function ImportedBadge({ metadata }: { metadata: unknown }) {
  if (!metadata || typeof metadata !== 'object') return null;
  const m = metadata as ImportedMeta;
  const hasGrade = m.grade != null && m.grade !== '';
  // Show points whenever both are present — including 0/0 (that IS the value the
  // export recorded; don't hide it).
  const hasPoints = m.points_awarded != null && m.points_available != null;
  const primary = hasGrade
    ? String(m.grade)
    : hasPoints
      ? `${m.points_awarded}/${m.points_available}`
      : m.commit_count != null
        ? `${m.commit_count} commit${m.commit_count === 1 ? '' : 's'}`
        : 'imported';

  return (
    <Tooltip
      title={
        <div className="text-xs leading-5">
          <div className="font-medium mb-0.5">Imported from GitHub Classroom</div>
          {hasGrade && <div>Grade: {m.grade}</div>}
          {hasPoints && (
            <div>
              Points: {m.points_awarded}/{m.points_available}
            </div>
          )}
          {m.commit_count != null && <div>Commits: {m.commit_count}</div>}
          {m.submitted != null && <div>Submitted: {m.submitted ? 'yes' : 'no'}</div>}
          {m.passing != null && <div>Passing: {m.passing ? 'yes' : 'no'}</div>}
        </div>
      }
    >
      <Tag
        icon={<IconBrandGithub size={12} className="inline -mt-0.5 mr-0.5" />}
        className="cursor-default text-gray-600 dark:text-gray-300"
      >
        {primary}
      </Tag>
    </Tooltip>
  );
}
