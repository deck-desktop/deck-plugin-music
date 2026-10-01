// Ask for a single line of text — a name, a branch, a path.
//
// Replaces window.prompt, which in a webview is an OS modal: it steals focus, hides the cursor,
// cannot be styled, and blocks the whole window while it is up. Three near-identical copies of
// this had grown (the git graph, the terminal rename, the editor's new-branch box), so this is
// the one implementation they now share.
//
// Driven by a state object rather than a hook, matching ConfirmDialog, so a caller can keep what
// it is asking about alongside the question:
//   const [ask, setAsk] = useState<NamePromptState | null>(null);
//   setAsk({ title: "Rename to", initial: file.name, onSave: (v) => rename(file, v) });
import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useRef, useState } from "react";

export interface NamePromptState {
  title: string;
  /** A second line under the title — the path being renamed, the ref being tagged. */
  subtitle?: string;
  /** Pre-filled value. A rename starts from the current name; a create starts empty. */
  initial?: string;
  placeholder?: string;
  /** Defaults to "Save". */
  confirmLabel?: string;
  onSave: (value: string) => void;
}

export function NamePrompt({ state, onClose }: { state: NamePromptState | null; onClose: () => void }) {
  const [val, setVal] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset to the new question's initial value each time one opens. Keyed on the state object, so
  // reopening the same prompt starts fresh rather than showing the last answer.
  useEffect(() => {
    if (!state) return;
    setVal(state.initial ?? "");
    // Select the initial text so a rename can be typed straight over.
    requestAnimationFrame(() => inputRef.current?.select());
  }, [state]);

  const submit = () => {
    const v = val.trim();
    if (!v) return;
    state?.onSave(v);
    onClose();
  };

  return (
    <AnimatePresence>
      {state && (
        <motion.div
          className="fixed inset-0 z-[150] flex items-center justify-center bg-black/50"
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          onMouseDown={onClose}
        >
          <motion.div
            className="w-80 rounded-xl border border-subtle p-4 shadow-2xl"
            style={{ background: "var(--bg-card)" }}
            initial={{ scale: 0.92, opacity: 0, y: 10 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.96, opacity: 0, y: 6 }}
            transition={{ type: "spring", stiffness: 420, damping: 30 }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="text-[15px] font-semibold text-text-primary">{state.title}</div>
            {state.subtitle && (
              <div className="mt-1 truncate text-[12px] text-text-muted" title={state.subtitle}>{state.subtitle}</div>
            )}
            <input
              ref={inputRef} autoFocus value={val} placeholder={state.placeholder}
              onChange={(e) => setVal(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") submit(); if (e.key === "Escape") onClose(); }}
              className="mt-3 w-full rounded-lg border border-subtle bg-transparent px-3 py-2 text-sm text-text-primary outline-none placeholder:text-text-muted focus:border-[var(--accent)]"
            />
            <div className="mt-4 flex justify-end gap-2">
              <button onClick={onClose}
                className="rounded-md border border-subtle bg-elev px-3.5 py-2 text-[13px] text-text-secondary transition hover:text-text-primary">
                Cancel
              </button>
              <button onClick={submit} disabled={!val.trim()}
                className="rounded-md px-3.5 py-2 text-[13px] font-semibold text-white disabled:opacity-40"
                style={{ background: "var(--accent)" }}>
                {state.confirmLabel ?? "Save"}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
