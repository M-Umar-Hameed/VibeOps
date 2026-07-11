import { useEffect, useState } from "react";

export function ShortcutsPopup() {
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Toggle popup on F4
      if (e.key === "F4") {
        e.preventDefault();
        setIsOpen((prev) => !prev);
      }
      
      // Close on Escape
      if (e.key === "Escape" && isOpen) {
        setIsOpen(false);
      }
    };
    
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen]);

  if (!isOpen) return null;

  const shortcuts = [
    { key: "Ctrl + K", desc: "Focus Search Bar" },
    { key: "F4", desc: "Toggle Shortcuts Menu" },
    { key: "Esc", desc: "Close Modals / Menus" },
  ];

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center pointer-events-auto">
      <div 
        className="absolute inset-0 bg-background/80 backdrop-blur-sm transition-opacity duration-300"
        onClick={() => setIsOpen(false)}
      />
      
      <div className="relative bg-surface-container border border-white/10 rounded-2xl shadow-2xl p-6 w-full max-w-md transform transition-all">
        <div className="flex justify-between items-center mb-6">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-primary-fixed-dim">keyboard</span>
            <h2 className="font-headline-sm font-bold text-on-surface">Keyboard Shortcuts</h2>
          </div>
          <button 
            className="p-2 text-on-surface-variant hover:text-on-surface hover:bg-white/5 rounded-full transition-colors cursor-pointer"
            onClick={() => setIsOpen(false)}
          >
            <span className="material-symbols-outlined text-sm">close</span>
          </button>
        </div>
        
        <div className="space-y-4">
          {shortcuts.map((s, i) => (
            <div key={i} className="flex justify-between items-center py-2 border-b border-white/5 last:border-0">
              <span className="text-on-surface-variant text-sm">{s.desc}</span>
              <kbd className="bg-surface-container-highest px-2.5 py-1 rounded-md text-on-surface font-code-sm text-xs border border-white/10 shadow-sm">
                {s.key}
              </kbd>
            </div>
          ))}
        </div>
        
        <div className="mt-8 text-center">
          <p className="text-xs text-on-surface-variant/50">More shortcuts coming soon...</p>
        </div>
      </div>
    </div>
  );
}
