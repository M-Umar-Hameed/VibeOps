import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export type MenuItemSpec = {
  key: string;
  label: string;
  danger?: boolean;
  disabled?: boolean;
  disabledReason?: string;
  onSelect?: () => void | string | Promise<void | string>;
  confirm?: { title: string; message: string; confirmLabel: string };
};

const MENU_W = 260;
const MENU_H = 220;

export function ContextMenu({ items, x, y, label, onClose }: {
  items: MenuItemSpec[]; x: number; y: number; label: string; onClose: () => void;
}) {
  const [confirmKey, setConfirmKey] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const left = Math.max(0, Math.min(x, window.innerWidth - MENU_W));
  const top = Math.max(0, Math.min(y, window.innerHeight - MENU_H));

  useEffect(() => {
    const first = items.findIndex((it) => !it.disabled);
    if (first >= 0) itemRefs.current[first]?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { onClose(); return; }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const enabled = (itemRefs.current.filter(Boolean) as HTMLButtonElement[]).filter((b) => !b.disabled);
        if (!enabled.length) return;
        const cur = enabled.indexOf(document.activeElement as HTMLButtonElement);
        const dir = e.key === "ArrowDown" ? 1 : -1;
        (enabled[(cur + dir + enabled.length) % enabled.length] ?? enabled[0]).focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const run = async (it: MenuItemSpec) => {
    setPending(true); setError(""); setNotice("");
    try {
      const out = await it.onSelect?.();
      // A string result is feedback worth reading - show it and keep the menu
      // open (e.g. "indexed 12, skipped 3") instead of closing.
      if (typeof out === "string") { setConfirmKey(null); setNotice(out); }
      else onClose();
    }
    catch (e: any) { setError(e instanceof Error ? e.message : "Action failed"); }
    finally { setPending(false); }
  };

  const onItem = (it: MenuItemSpec) => {
    if (it.disabled) return;
    if (it.confirm) { setConfirmKey(it.key); return; }
    void run(it);
  };

  const confirming = items.find((it) => it.key === confirmKey);

  // Portalled to body: .glass-card sets backdrop-filter, which makes it the
  // containing block for fixed-position descendants, so viewport coordinates
  // resolved against the card and pushed the menu off-page.
  return createPortal(
    <>
      <div className="fixed inset-0 z-[60]" onClick={onClose} data-testid="run-menu-backdrop" />
      <div
        role="menu"
        aria-label={label}
        className="fixed z-[61] w-[260px] bg-surface-container border border-white/10 rounded-lg shadow-xl py-1"
        style={{ left, top }}
      >
        {confirming && confirming.confirm ? (
          <div className="px-3 py-2 flex flex-col gap-2">
            <div className={`text-xs font-medium ${confirming.danger ? "text-error" : "text-on-surface"}`}>{confirming.confirm.title}</div>
            <div className="text-xs text-on-surface-variant leading-snug">{confirming.confirm.message}</div>
            {error && <div className="text-xs text-error font-code-sm">{error}</div>}
            <div className="flex gap-2 pt-1">
              <button type="button" onClick={() => void run(confirming)} disabled={pending}
                className={`flex-1 px-2 py-1 rounded text-xs font-medium disabled:opacity-50 border ${confirming.danger ? "bg-error/10 hover:bg-error/20 text-error border-error/30" : "bg-primary/10 hover:bg-primary/20 text-primary border-primary/30"}`}>
                {confirming.confirm.confirmLabel}
              </button>
              <button type="button" onClick={() => { setConfirmKey(null); setError(""); }} disabled={pending}
                className="px-3 py-1 rounded bg-white/10 hover:bg-white/20 text-xs text-on-surface disabled:opacity-50">Cancel</button>
            </div>
          </div>
        ) : (
          <>
            {items.map((it, i) => (
              <button
                key={it.key}
                ref={(el) => { itemRefs.current[i] = el; }}
                type="button"
                role="menuitem"
                onClick={() => onItem(it)}
                disabled={it.disabled || pending}
                title={it.disabled ? it.disabledReason : undefined}
                className={`w-full text-left px-3 py-2 text-sm transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${it.danger ? "text-error hover:bg-error/10" : "text-on-surface hover:bg-white/5"}`}
              >
                {it.label}
                {it.disabled && it.disabledReason && (
                  <span className="block text-[10px] text-on-surface-variant/70">{it.disabledReason}</span>
                )}
              </button>
            ))}
            {error && <div className="px-3 py-1.5 text-xs text-error font-code-sm">{error}</div>}
            {notice && <div role="status" className="px-3 py-1.5 text-xs text-on-surface-variant font-code-sm">{notice}</div>}
          </>
        )}
      </div>
    </>,
    document.body,
  );
}
