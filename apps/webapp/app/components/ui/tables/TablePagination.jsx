import { IconChevronLeft, IconChevronRight } from '@tabler/icons-react';

const TablePagination = ({
  pageIndex,
  pageSize,
  totalItems,
  onPageChange,
  onPageSizeChange,
  pageSizeOptions = [25, 50, 100],
}) => {
  const pageCount = Math.ceil(totalItems / pageSize);
  const startItem = pageIndex * pageSize + 1;
  const endItem = Math.min((pageIndex + 1) * pageSize, totalItems);

  const canPreviousPage = pageIndex > 0;
  const canNextPage = pageIndex < pageCount - 1;

  // Generate page numbers to display
  const getPageNumbers = () => {
    const pages = [];
    const maxPagesToShow = 7;

    if (pageCount <= maxPagesToShow) {
      // Show all pages
      for (let i = 0; i < pageCount; i++) {
        pages.push(i);
      }
    } else {
      // Show first, last, and pages around current
      if (pageIndex <= 3) {
        // Near start
        for (let i = 0; i < 5; i++) pages.push(i);
        pages.push('...');
        pages.push(pageCount - 1);
      } else if (pageIndex >= pageCount - 4) {
        // Near end
        pages.push(0);
        pages.push('...');
        for (let i = pageCount - 5; i < pageCount; i++) pages.push(i);
      } else {
        // Middle
        pages.push(0);
        pages.push('...');
        for (let i = pageIndex - 1; i <= pageIndex + 1; i++) pages.push(i);
        pages.push('...');
        pages.push(pageCount - 1);
      }
    }

    return pages;
  };

  if (totalItems === 0) return null;

  return (
    <div className="flex items-center justify-between px-4 py-3 bg-gray-50 dark:bg-gray-800/50 border-t border-gray-200 dark:border-gray-700">
      <div className="flex items-center gap-3">
        <span className="text-sm text-gray-700 dark:text-gray-300">
          {startItem}-{endItem} of {totalItems}
        </span>
        <select
          value={pageSize}
          onChange={e => onPageSizeChange(Number(e.target.value))}
          className="text-sm border border-gray-300 dark:border-gray-600 rounded px-2 py-1 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 focus:outline-none focus:ring-1 focus:ring-blue-500"
        >
          {pageSizeOptions.map(size => (
            <option key={size} value={size}>
              {size} per page
            </option>
          ))}
        </select>
      </div>

      <div className="flex items-center gap-1">
        <button
          onClick={() => onPageChange(pageIndex - 1)}
          disabled={!canPreviousPage}
          className="p-1.5 border border-gray-300 dark:border-gray-600 rounded hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent"
          title="Previous page"
        >
          <IconChevronLeft size={16} className="text-gray-600 dark:text-gray-400" />
        </button>

        {getPageNumbers().map((page, idx) => {
          if (page === '...') {
            return (
              <span key={`ellipsis-${idx}`} className="px-2 text-gray-400 dark:text-gray-500 text-sm">
                ...
              </span>
            );
          }

          return (
            <button
              key={page}
              onClick={() => onPageChange(page)}
              className={`min-w-[32px] px-2 py-1 text-sm border border-gray-300 dark:border-gray-600 rounded ${
                page === pageIndex
                  ? 'bg-blue-600 text-white border-blue-600'
                  : 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800'
              }`}
            >
              {page + 1}
            </button>
          );
        })}

        <button
          onClick={() => onPageChange(pageIndex + 1)}
          disabled={!canNextPage}
          className="p-1.5 border border-gray-300 dark:border-gray-600 rounded hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent"
          title="Next page"
        >
          <IconChevronRight size={16} className="text-gray-600 dark:text-gray-400" />
        </button>
      </div>
    </div>
  );
};

export default TablePagination;
