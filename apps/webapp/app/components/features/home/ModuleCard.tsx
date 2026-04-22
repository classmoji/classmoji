import { Link } from 'react-router';

export interface ModuleCardItem {
  kind: 'QUIZ' | 'ASGN';
  title: string;
  date: string;
  done?: boolean;
}

export interface ModuleCardData {
  // TODO: Module schema has no integer index; show when one lands
  number: string | number | null;
  name: string;
  assignmentCount: number;
  weeks: string;
  pct: number;
  items: ModuleCardItem[];
}

interface ModuleCardProps {
  module: ModuleCardData | null;
  viewModuleHref: string;
  assignmentsHref?: string;
  lecturesHref?: string;
}

export function ModuleCard({
  module,
  viewModuleHref,
  assignmentsHref,
  lecturesHref,
}: ModuleCardProps) {
  if (!module) {
    return (
      <div className="panel flex flex-col">
        <div className="px-[18px] pt-4 pb-3">
          <div className="caps text-[10px]">Current module</div>
          <div className="mt-1 text-[16px] font-semibold">No active module</div>
          <div className="mt-0.5 text-[12.5px] text-ink-2">
            You don&apos;t have any open modules right now.
          </div>
        </div>
      </div>
    );
  }
  const m = module;
  const pct = Math.max(0, Math.min(100, Math.round(m.pct)));
  const subtitle = `${m.assignmentCount} assignment${m.assignmentCount === 1 ? '' : 's'} · ${pct}%`;

  return (
    <div className="panel flex flex-col">
      <div className="px-[18px] pt-4 pb-3">
        <div className="caps text-[10px]">
          {m.number != null ? `Module #${m.number}` : 'Current module'}
        </div>
        <div className="mt-1 text-[16px] font-semibold">{m.name}</div>
        <div className="mt-0.5 text-[12.5px] text-ink-2">{subtitle}</div>
      </div>

      {m.items.length > 0 && (
        <>
          <div className="sep" />
          <div className="px-[18px] pt-2.5 pb-1.5">
            <div className="caps text-[10px] mb-1.5">This week</div>
            {m.items.map((it, i) => {
              const dueLike = it.date.toLowerCase().startsWith('due');
              return (
                <div
                  key={i}
                  className={`grid items-center gap-2.5 py-[9px] px-0.5 ${
                    i === 0 ? '' : 'border-t border-line-cool'
                  }`}
                  style={{ gridTemplateColumns: '60px 1fr auto' }}
                >
                  <span
                    className={`chip ${it.kind === 'QUIZ' ? 'chip-quiz' : 'chip-asgn'}`}
                  >
                    {it.kind}
                  </span>
                  <span className="text-[13px] truncate">
                    {it.title}
                    {it.done ? ' ✓' : ''}
                  </span>
                  <span
                    className={`text-xs ${dueLike ? 'text-ink-1' : 'text-ink-3'}`}
                  >
                    {it.date}
                  </span>
                </div>
              );
            })}
          </div>
        </>
      )}

      <div className="sep" />
      <div className="flex items-center gap-2 px-3.5 py-2.5">
        {assignmentsHref && (
          <Link to={assignmentsHref} className="btn btn-sm no-underline">
            Assignments
          </Link>
        )}
        {lecturesHref && (
          <Link to={lecturesHref} className="btn btn-sm no-underline">
            Lectures
          </Link>
        )}
        <div className="flex-1" />
        <Link to={viewModuleHref} className="btn btn-sm no-underline">
          View module →
        </Link>
      </div>
    </div>
  );
}

export default ModuleCard;
