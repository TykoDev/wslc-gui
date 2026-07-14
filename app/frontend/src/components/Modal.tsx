import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { Icon } from "./icons.tsx";

/** Generic dialog shell: header (title + close), scrollable body, action footer.
    Escape closes, Tab cycles inside, overlay click closes. */
export function Modal({ title, onClose, children, actions, wide, initialFocus, describedBy }: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  actions?: ReactNode;
  wide?: boolean;
  initialFocus?: RefObject<HTMLElement | null>;
  /** Id of the element that carries the dialog's consequence text. A dialog named only by
   * its title can leave "there is no undo" unannounced — which is the one sentence a
   * destructive confirm exists to deliver. */
  describedBy?: string;
}) {
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Restore focus on close. Without this the keyboard user lands on <body>: the dialog
    // steals focus from the trigger, and after a successful destroy (a removed volume's
    // kebab) the trigger no longer exists to hand it back to.
    const opener = document.activeElement as HTMLElement | null;
    const el = initialFocus?.current ??
      boxRef.current?.querySelector<HTMLElement>("input, select, textarea, button:not([aria-label='Close dialog'])");
    el?.focus();
    return () => {
      if (opener && opener !== document.body && document.contains(opener)) opener.focus();
      else document.querySelector<HTMLElement>("main.content button, main.content a")?.focus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
    } else if (e.key === "Tab" && boxRef.current) {
      const focusables = [...boxRef.current.querySelectorAll<HTMLElement>(
        "button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href]",
      )];
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={boxRef}
        className={`modal${wide ? " wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        aria-describedby={describedBy}
        onKeyDown={onKey}
      >
        <header>
          <h3>{title}</h3>
          <button className="icon small" aria-label="Close dialog" onClick={onClose}>
            <Icon name="x" size={14} />
          </button>
        </header>
        <div className="mbody">{children}</div>
        {actions && <div className="modalactions">{actions}</div>}
      </div>
    </div>
  );
}

export interface ConfirmProps {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  /** When set, the user must type this exact string to enable confirm (unregister contract). */
  requireText?: string;
  onConfirm: () => void | Promise<void>;
  onClose: () => void;
}

let confirmSeq = 0;

export function ConfirmModal(p: ConfirmProps) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  // Stable per-instance so two stacked confirms cannot describe each other.
  const bodyId = useRef(`confirm-body-${++confirmSeq}`).current;

  const blocked = p.requireText !== undefined && typed !== p.requireText;

  return (
    <Modal
      title={p.title}
      onClose={p.onClose}
      initialFocus={cancelRef}
      describedBy={bodyId}
      actions={
        <>
          {/* Cancel is default-focused (interface-design §4) */}
          <button ref={cancelRef} onClick={p.onClose}>Cancel</button>
          <button
            className={p.danger ? "danger" : "primary"}
            disabled={blocked || busy}
            onClick={async () => {
              setBusy(true);
              try {
                await p.onConfirm();
                p.onClose();
              } catch {
                // Failure already surfaced (toast); keep the dialog open with input intact.
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "Working…" : p.confirmLabel}
          </button>
        </>
      }
    >
      {/* Wrapper exists to give the description a single id. It re-declares .mbody's own
          column+gap so multi-paragraph bodies keep the spacing they had as direct children. */}
      <div id={bodyId} className="mbodygroup">{p.body}</div>
      {p.requireText !== undefined && (
        <label className="field">
          <span>Type <code>{p.requireText}</code> to confirm</span>
          <input
            type="text"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </label>
      )}
    </Modal>
  );
}

export function Drawer({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  // FE-5: restore opener focus on close, mirroring Modal. Mount-only (empty deps) so a
  // re-render — onClose gets a fresh identity each render — never fires the restore early;
  // the Escape listener lives in its own effect that may re-bind freely.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    return () => {
      if (opener && opener !== document.body && document.contains(opener)) opener.focus();
      else document.querySelector<HTMLElement>("main.content button, main.content a")?.focus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="drawer" role="dialog" aria-modal="false" aria-label={title}>
      <header>
        {title}
        <span style={{ flex: 1 }} />
        <button ref={closeRef} className="icon small" onClick={onClose} aria-label="Close panel">
          <Icon name="x" size={14} />
        </button>
      </header>
      <div className="body">{children}</div>
    </div>
  );
}
