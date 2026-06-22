import { useState } from 'react';
import { Modal, Tag } from 'antd';
import AutogradingResultCard, { type AutogradingResultData } from './AutogradingResultCard';

interface AutogradingResultPillProps {
  result?: AutogradingResultData | null;
  org?: string | null;
  repoName?: string | null;
}

/**
 * Compact `X/Y` pill for a table cell. Clicking it opens a modal with the
 * per-test breakdown (the full result card) — so a row stays scannable while the
 * detail is one click away.
 */
const AutogradingResultPill = ({ result, org, repoName }: AutogradingResultPillProps) => {
  const [open, setOpen] = useState(false);

  if (!result) return <span className="text-xs text-ink-4">—</span>;

  const total = result.total_tests ?? 0;
  const passed = result.passed_tests ?? 0;
  const allPassed = total > 0 && passed === total;

  return (
    <>
      <Tag
        color={allPassed ? 'green' : 'red'}
        className="font-semibold cursor-pointer"
        onClick={() => setOpen(true)}
      >
        {total > 0 ? `${passed}/${total}` : result.conclusion}
      </Tag>
      <Modal
        open={open}
        onCancel={() => setOpen(false)}
        footer={null}
        title={null}
        width={420}
        centered
        styles={{ content: { borderRadius: 16, padding: 20 } }}
      >
        <AutogradingResultCard result={result} org={org} repoName={repoName} embedded />
      </Modal>
    </>
  );
};

export default AutogradingResultPill;
