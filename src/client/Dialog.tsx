import { useEffect, useRef } from "react";
import type { ReactNode } from "react";

export function Dialog({
  label,
  className = "",
  onClose,
  children,
}: {
  label: string;
  className?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (!opener.current && document.activeElement instanceof HTMLElement) opener.current = document.activeElement;
    dialog.showModal();
    return () => {
      dialog.close();
      const target = opener.current;
      // React may remove the dialog after the native close algorithm runs.
      // Defer restoration and never steal focus from a newly opened modal.
      queueMicrotask(() => {
        if (target?.isConnected && !document.querySelector("dialog[open]")) target.focus();
      });
    };
  }, []);

  return (
    <dialog
      ref={ref}
      className={`overlay-dialog ${className}`}
      aria-label={label}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      {children}
    </dialog>
  );
}
