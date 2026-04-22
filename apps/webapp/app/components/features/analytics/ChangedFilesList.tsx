export interface ChangedFile {
  name: string;
  add: number;
  del: number;
}

export interface ChangedFilesListProps {
  files?: ChangedFile[];
}

/**
 * Per-file change summary. Gracefully renders an empty state when the
 * snapshot does not include per-file detail yet.
 */
const ChangedFilesList = ({ files }: ChangedFilesListProps) => {
  if (!files || files.length === 0) {
    return (
      <div
        className="mb-6 rounded-lg border border-dashed border-gray-200 dark:border-gray-700 px-3 py-4 text-sm text-gray-500 dark:text-gray-400 text-center"
        data-testid="changed-files-empty"
      >
        No file detail in snapshot.
      </div>
    );
  }

  const maxMag = files.reduce(
    (m, f) => Math.max(m, f.add + f.del),
    0,
  );

  return (
    <div className="mb-6" data-testid="changed-files">
      <div className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400 font-semibold mb-2">
        Changed files
      </div>
      <div className="rounded-lg border border-gray-100 dark:border-gray-700 divide-y divide-gray-100 dark:divide-gray-700">
        {files.map((f) => {
          const total = f.add + f.del;
          const totalPct = maxMag > 0 ? (total / maxMag) * 100 : 0;
          const addPct = total > 0 ? (f.add / total) * 100 : 0;
          const delPct = 100 - addPct;
          return (
            <div
              key={f.name}
              className="flex items-center gap-3 px-3 py-2 text-sm"
              data-testid={`file-row-${f.name}`}
            >
              <span className="flex-1 min-w-0 truncate font-mono text-xs text-gray-800 dark:text-gray-100">
                {f.name}
              </span>
              <span className="tabular-nums text-xs text-green-600 dark:text-green-400">
                +{f.add}
              </span>
              <span className="tabular-nums text-xs text-red-600 dark:text-red-400">
                -{f.del}
              </span>
              <div
                className="h-1.5 w-28 overflow-hidden rounded-full bg-gray-100 dark:bg-gray-800"
                style={{ height: 6 }}
              >
                <div className="flex h-full" style={{ width: `${totalPct}%` }}>
                  <div
                    className="h-full bg-green-500 dark:bg-green-400"
                    style={{ width: `${addPct}%` }}
                  />
                  <div
                    className="h-full bg-red-500 dark:bg-red-400"
                    style={{ width: `${delPct}%` }}
                  />
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default ChangedFilesList;
