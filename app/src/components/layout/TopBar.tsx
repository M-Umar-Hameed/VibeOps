import { useEffect, useRef } from "react";

export function TopBar() {
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        searchInputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  return (
    <header className="h-16 flex justify-between items-center px-margin-desktop bg-background/80 backdrop-blur-md border-b border-outline-variant z-40">
      <div className="flex items-center gap-4 bg-surface-container-low px-4 py-1.5 rounded-lg border border-white/5 focus-within:ring-1 focus-within:ring-primary-container transition-all">
        <span className="material-symbols-outlined text-on-surface-variant text-sm">search</span>
        <input 
          ref={searchInputRef}
          className="bg-transparent border-none focus:ring-0 text-code-label font-code-label w-64 placeholder:text-on-surface-variant/40 outline-none" 
          placeholder="Search commands or tickets..." 
          type="text"
        />
        <span className="text-[10px] text-on-surface-variant/40 px-1.5 py-0.5 border border-white/10 rounded uppercase font-code-sm">Ctrl K</span>
      </div>
      
      <div className="flex items-center gap-6">
        <button className="material-symbols-outlined text-on-surface-variant hover:text-primary transition-colors">sensors</button>
        <button className="material-symbols-outlined text-on-surface-variant hover:text-primary relative transition-colors">
          notifications
          <span className="absolute top-0 right-0 w-2 h-2 bg-primary-fixed-dim rounded-full neon-pulse"></span>
        </button>
        <button className="material-symbols-outlined text-on-surface-variant hover:text-primary transition-colors">account_circle</button>
      </div>
    </header>
  );
}
