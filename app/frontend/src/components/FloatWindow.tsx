// Non-blocking floating window (r7-dd1): draggable by its title bar, resizable
// via the native CSS resize handle, never overlays the page with a scrim —
// the page behind stays fully interactive.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "./icons.tsx";

export function FloatWindow({ title, onClose, children }: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const [pos, setPos] = useState(() => ({
    x: Math.max(12, innerWidth - 720),
    y: Math.max(12, innerHeight - 520),
  }));
  const drag = useRef<{ dx: number; dy: number } | null>(null);
  const winRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      if (!drag.current) return;
      setPos({
        x: Math.min(Math.max(-200, e.clientX - drag.current.dx), innerWidth - 80),
        y: Math.min(Math.max(0, e.clientY - drag.current.dy), innerHeight - 40),
      });
    };
    const onUp = () => {
      drag.current = null;
    };
    addEventListener("pointermove", onMove);
    addEventListener("pointerup", onUp);
    return () => {
      removeEventListener("pointermove", onMove);
      removeEventListener("pointerup", onUp);
    };
  }, []);

  return (
    <div
      ref={winRef}
      className="floatwin"
      role="dialog"
      aria-modal="false"
      aria-label={title}
      style={{ left: pos.x, top: pos.y }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <header
        onPointerDown={(e) => {
          // Buttons in the title bar must stay clickable, not start a drag.
          if ((e.target as HTMLElement).closest("button")) return;
          drag.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
        }}
      >
        <span className="fwtitle">{title}</span>
        <span style={{ flex: 1 }} />
        <button className="icon small" onClick={onClose} aria-label="Close window">
          <Icon name="x" size={14} />
        </button>
      </header>
      <div className="fwbody">{children}</div>
    </div>
  );
}
