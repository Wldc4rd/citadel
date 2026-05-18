import { useEffect, type ReactNode } from 'react';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  /** Optional caption next to the title. */
  caption?: ReactNode;
  children: ReactNode;
  /** Optional footer slot (e.g. action buttons). */
  footer?: ReactNode;
  /** When set, render the modal at the given max-width class instead of the default. */
  widthClass?: string;
}

export function Modal({
  open,
  onClose,
  title,
  caption,
  children,
  footer,
  widthClass = 'max-w-3xl',
}: ModalProps) {
  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-start sm:items-center justify-center bg-black/60 p-3 sm:p-6"
      onClick={onClose}
    >
      <div
        className={`w-full ${widthClass} bg-ink-800 border border-ink-600 rounded-lg shadow-2xl flex flex-col max-h-[90vh]`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 px-4 py-3 border-b border-ink-600">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-ink-100 truncate">{title}</h2>
            {caption && (
              <p className="text-xs text-ink-300 mt-0.5 truncate">{caption}</p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="p-1 rounded-md text-ink-300 hover:bg-ink-700/60 hover:text-ink-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
          >
            ×
          </button>
        </div>
        <div className="flex-1 overflow-auto p-4 text-sm text-ink-100">{children}</div>
        {footer && (
          <div className="border-t border-ink-600 px-4 py-3 flex items-center justify-end gap-2">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
