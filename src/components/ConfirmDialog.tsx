// Generic confirm dialog. Deck used window.confirm in a couple of places (Music, Whiteboard),
// which looks like a browser alert and can't be styled; this matches the app and is reusable.
//
// Driven by a state object rather than a hook so a caller can stash what it's confirming:
//   const [confirm, setConfirm] = useState<ConfirmState | null>(null);
//   setConfirm({ title: "Close tab?", body: "…", confirmLabel: "Close", onConfirm: () => … });
import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useRef } from "react";

export interface ConfirmState {
  title: string;
  /** A sentence for a plain question; nodes when the answer needs structure — an import summary
   *  listing what is about to be added, for instance. */
  body?: React.ReactNode;
  /** Defaults to "Confirm". */
  confirmLabel?: string;
  /** Red confirm button — for anything that destroys work. Default true. */
  danger?: boolean;
  /** Wider dialog, for a body that is a summary rather than a sentence. */
  wide?: boolean;
  /** Report something that already happened: one button, nothing to cancel. Replaces alert(),
   *  which in a webview is an OS modal — it steals focus, hides the cursor, and cannot be
   *  styled or dismissed with Escape. */
  acknowledge?: boolean;
  onConfirm: () => void;
}

export function ConfirmDialog({ state, onClose }: { state: ConfirmState | null; onClose: () => void }) {
  const confirmRef = useRef<HTMLButtonElement>(null);

  // Focus the confirm button so Enter confirms and Escape cancels — a dialog you can answer
  // without reaching for the mouse, since these fire mid-keyboard-work.
  useEffect(() => {
    if (!state) return;
    confirmRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state, onClose]);

  const confirm = () => {
    state?.onConfirm();
    onClose();
  };

  return (
    <AnimatePresence>
      {state && (
        <motion.div
          className="fixed inset-0 z-[150] flex items-center justify-center bg-black/50"
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          onClick={onClose}
        >
          <motion.div
            className={`glass rounded-xl p-5 ${state.wide ? "w-[440px]" : "w-[360px]"}`}
            initial={{ scale: 0.92, opacity: 0, y: 10 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.96, opacity: 0, y: 6 }}
            transition={{ type: "spring", stiffness: 420, damping: 30 }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-[15px] font-semibold text-text-primary">{state.title}</h3>
            {state.body != null && (typeof state.body === "string"
              ? <p className="mt-2 text-[13px] leading-relaxed text-text-secondary">{state.body}</p>
              // Not wrapped in <p>: a rich body may contain lists or divs, which are invalid
              // inside a paragraph and get reparented by the browser.
              : <div className="mt-2 text-[13px] leading-relaxed text-text-secondary">{state.body}</div>)}
            <div className="mt-5 flex justify-end gap-2">
              {/* An acknowledgement has nothing to cancel: the thing already happened, and a
                  "Cancel" beside "OK" would suggest it could be undone. */}
              {!state.acknowledge && (
                <button
                  onClick={onClose}
                  className="rounded-md border border-subtle bg-elev px-3.5 py-2 text-[13px] text-text-secondary transition hover:text-text-primary"
                >
                  Cancel
                </button>
              )}
              <button
                ref={confirmRef}
                onClick={confirm}
                className="rounded-md px-3.5 py-2 text-[13px] font-semibold text-white outline-none ring-offset-2 focus:ring-2"
                style={{ background: state.danger === false ? "var(--accent)" : "var(--danger)" }}
              >
                {state.confirmLabel ?? "Confirm"}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
