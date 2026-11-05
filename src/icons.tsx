import React from 'react'

export type ReaderIconName = 'previous' | 'next' | 'zoomIn' | 'zoomOut' | 'document' | 'check' | 'close' | 'image' | 'retry' | 'notes'
export type ReaderIconProps = Omit<React.SVGProps<SVGSVGElement>, 'name'> & { name: ReaderIconName; size?: number }

const paths: Record<ReaderIconName, React.ReactNode> = {
  previous: <path d="m14 6-6 6 6 6" />,
  next: <path d="m10 6 6 6-6 6" />,
  zoomIn: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4 4M7.5 10.5h6m-3-3v6" /></>,
  zoomOut: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4 4M7.5 10.5h6" /></>,
  document: <><path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8l-5-5Z" /><path d="M14 3v5h5M8 12h8m-8 4h6" /></>,
  check: <path d="m5 12 4 4L19 6" />,
  close: <path d="m6 6 12 12M6 18 18 6" />,
  image: <><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8" cy="8" r="1.5" /><path d="m3 17 5-5 4 4 4-6 5 7" /></>,
  retry: <><path d="M20 10a8 8 0 1 0-2 8M20 4v6h-6" /></>,
  notes: <><path d="M15 3H7a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V7l-3-4Z" /><path d="M15 3v4h3M9 11h6m-6 4h6m-6-8h2" /></>,
}

/** Decorative by default; the owning control supplies its accessible label. */
export function ReaderIcon({ name, size = 16, className, ...props }: ReaderIconProps) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" className={className ? `pr-icon ${className}` : 'pr-icon'} {...props}>{paths[name]}</svg>
}
