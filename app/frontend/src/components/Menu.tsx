// Compact dropdown action menu (kebab). Fixed-position popover so table/card
// overflow never clips it; full keyboard support (arrows/Home/End/Escape).

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Icon, type IconName } from "./icons.tsx";

export type MenuItem =
  | {
    label: string;
    icon?: IconName;
    danger?: boolean;
    disabled?: boolean;
    /** Tooltip; shown on the item (used to explain disabled verbs). */
    title?: string;
    onSelect: () => void;
  }
  | "sep";

export function ActionMenu({ label, items, small = true }: {
  /** Accessible name for the trigger, e.g. `Actions for web`. */
  label: string;
  items: MenuItem[];
  small?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const close = (refocus: boolean) => {
    setOpen(false);
    setPos(null);
    if (refocus) triggerRef.current?.focus();
  };

  // Position after render: right-align to trigger, flip up when near the bottom.
  useLayoutEffect(() => {
    if (!open || !triggerRef.current || !menuRef.current) return;
    const t = triggerRef.current.getBoundingClientRect();
    const m = menuRef.current.getBoundingClientRect();
    const x = Math.max(8, Math.min(t.right - m.width, innerWidth - m.width - 8));
    let y = t.bottom + 4;
    if (y + m.height > innerHeight - 8) y = Math.max(8, t.top - m.height - 4);
    setPos({ x, y });
  }, [open]);

  // Focus the first item only once the menu is visible — focus() on a
  // visibility:hidden element (the measuring pass) is a silent no-op.
  useEffect(() => {
    if (open && pos) {
      (menuRef.current?.querySelector("button:not(:disabled)") as HTMLButtonElement | null)?.focus();
    }
  }, [open, pos !== null]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!menuRef.current?.contains(t) && !triggerRef.current?.contains(t)) close(false);
    };
    const onScroll = (e: Event) => {
      if (!menuRef.current?.contains(e.target as Node)) close(false);
    };
    const onResize = () => close(false);
    document.addEventListener("mousedown", onDown);
    addEventListener("scroll", onScroll, true);
    addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("mousedown", onDown);
      removeEventListener("scroll", onScroll, true);
      removeEventListener("resize", onResize);
    };
  }, [open]);

  const onMenuKey = (e: React.KeyboardEvent) => {
    const btns = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
    const idx = btns.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "Escape") {
      e.stopPropagation();
      close(true);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      btns[(idx + 1) % btns.length]?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      btns[(idx - 1 + btns.length) % btns.length]?.focus();
    } else if (e.key === "Home") {
      e.preventDefault();
      btns[0]?.focus();
    } else if (e.key === "End") {
      e.preventDefault();
      btns[btns.length - 1]?.focus();
    } else if (e.key === "Tab") {
      close(false);
    }
  };

  return (
    <>
      <button
        ref={triggerRef}
        className={`icon${small ? " small" : ""}`}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        title={label}
        onClick={() => (open ? close(false) : setOpen(true))}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && !open) {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        <Icon name="more" />
      </button>
      {open && (
        <div
          ref={menuRef}
          className="menu"
          role="menu"
          aria-label={label}
          style={pos ? { left: pos.x, top: pos.y } : { left: -9999, top: 0, visibility: "hidden" }}
          onKeyDown={onMenuKey}
        >
          {items.map((it, i) =>
            it === "sep" ? <div key={i} className="msep" role="separator" /> : (
              <button
                key={i}
                className={`mi${it.danger ? " danger" : ""}`}
                role="menuitem"
                disabled={it.disabled}
                title={it.title}
                onClick={() => {
                  close(true);
                  it.onSelect();
                }}
              >
                {it.icon && <Icon name={it.icon} size={14} />}
                {it.label}
              </button>
            )
          )}
        </div>
      )}
    </>
  );
}
