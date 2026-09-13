"use client";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";

export function DetailDialog({
  label,
  title,
  children,
  kind = "report",
}: {
  label: string;
  title: string;
  children: ReactNode;
  kind?: "report" | "video";
}) {
  const [open, setOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    dialog.current?.showModal();
    const previous = document.documentElement.style.overflow;
    document.documentElement.style.overflow = "hidden";
    return () => {
      document.documentElement.style.overflow = previous;
    };
  }, [open]);
  function keepFocus(event: KeyboardEvent<HTMLDialogElement>) {
    if (event.key !== "Tab") return;
    const items = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>(
        'button, a[href], summary, video[controls], [tabindex="0"]',
      ),
    ).filter(
      (node) =>
        node.getClientRects().length > 0 && !node.hasAttribute("disabled"),
    );
    const first = items[0],
      last = items[items.length - 1];
    if (!first) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="detail-trigger"
        aria-haspopup="dialog"
        aria-controls={id}
        onClick={() => setOpen(true)}
      >
        {label}
        <span aria-hidden="true">↗</span>
      </button>
      <dialog
        ref={dialog}
        id={id}
        className={"detail-dialog detail-dialog--" + kind}
        aria-labelledby={id + "-title"}
        onKeyDown={keepFocus}
        onClose={() => {
          setOpen(false);
          trigger.current?.focus();
        }}
        onClick={(event) => {
          if (event.target === event.currentTarget) dialog.current?.close();
        }}
      >
        {open ? (
          <div className="detail-dialog__body">
            <div className="detail-dialog__heading">
              <h2 id={id + "-title"}>{title}</h2>
              <button
                type="button"
                className="dialog-close"
                aria-label="סגירת החלונית"
                onClick={() => dialog.current?.close()}
              >
                ×
              </button>
            </div>
            {children}
          </div>
        ) : null}
      </dialog>
    </>
  );
}
