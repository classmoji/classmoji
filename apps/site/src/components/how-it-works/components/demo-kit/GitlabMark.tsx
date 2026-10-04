import React from 'react';

type GitlabMarkProps = {
  className?: string;
};

/** Official Gitlab tanuki silhouette. Color is inherited for brand and monochrome uses. */
export function GitlabMark({ className }: GitlabMarkProps) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={`fill-current ${className ?? ''}`}>
      <path d="m23.955 13.587-1.342-4.135-2.664-8.189a.455.455 0 0 0-.867 0l-2.664 8.189H7.582L4.918 1.263a.455.455 0 0 0-.867 0L1.387 9.452.045 13.587a.924.924 0 0 0 .331 1.023L12 23.054l11.624-8.443a.92.92 0 0 0 .331-1.024Z" />
    </svg>
  );
}
