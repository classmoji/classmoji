/**
 * A response's gallery status chip plus Approve / Hide. Used by the staff
 * responses table (Task 6) and the assistant queue (galleryQueue.tsx), which
 * both post to `/{class}/forms/{slug}/responses/gallery`.
 */

const GALLERY_CHIP: Record<string, string> = {
  PENDING: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
  APPROVED: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200',
  HIDDEN: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300',
};

export default function GalleryCell({
  status,
  onChange,
}: {
  status: string;
  onChange: (next: 'APPROVED' | 'HIDDEN') => void;
}) {
  return (
    <div className="flex items-center gap-2 whitespace-nowrap">
      <span
        className={`rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${
          GALLERY_CHIP[status] ?? GALLERY_CHIP.PENDING
        }`}
      >
        {status.toLowerCase()}
      </span>
      {status !== 'APPROVED' ? (
        <button
          type="button"
          onClick={() => onChange('APPROVED')}
          className="text-xs font-medium text-emerald-700 hover:underline dark:text-emerald-400"
        >
          Approve
        </button>
      ) : null}
      {status !== 'HIDDEN' ? (
        <button
          type="button"
          onClick={() => onChange('HIDDEN')}
          className="text-xs font-medium text-gray-500 hover:underline dark:text-gray-400"
        >
          Hide
        </button>
      ) : null}
    </div>
  );
}
