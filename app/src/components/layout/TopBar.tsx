import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { tickets } from "../../api/tickets.js";
import { StatusBadge } from "../StatusBadge.js";

export function TopBar() {
  const searchInputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [isOpen, setIsOpen] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQ(q), 300);
    return () => clearTimeout(timer);
  }, [q]);

  const searchQ = useQuery({
    queryKey: ["tickets", "search", debouncedQ],
    queryFn: () => tickets.search(debouncedQ),
    enabled: debouncedQ.length > 0,
  });

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        searchInputRef.current?.focus();
      }
      if (e.key === 'Escape') {
        setIsOpen(false);
        searchInputRef.current?.blur();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  useEffect(() => {
    const handleMouseUp = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener("mouseup", handleMouseUp);
    return () => document.removeEventListener("mouseup", handleMouseUp);
  }, []);

  const handleTicketClick = (id: string) => {
    setIsOpen(false);
    setQ("");
    navigate({ to: "/tickets/$id", params: { id } });
  };

  return (
    <header className="h-16 flex justify-between items-center px-margin-desktop bg-background/80 backdrop-blur-md border-b border-outline-variant z-40 relative">
      <div className="relative" ref={containerRef}>
        <div className="flex items-center gap-4 bg-surface-container-low px-4 py-1.5 rounded-lg border border-white/5 focus-within:ring-1 focus-within:ring-primary-container transition-all">
          <span className="material-symbols-outlined text-on-surface-variant text-sm">search</span>
          <input 
            ref={searchInputRef}
            className="bg-transparent border-none focus:ring-0 text-code-label font-code-label w-64 placeholder:text-on-surface-variant/40 outline-none text-on-surface" 
            placeholder="Search commands or tickets..." 
            type="text"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setIsOpen(true);
            }}
            onFocus={() => {
              if (q) setIsOpen(true);
            }}
          />
          <span className="text-[10px] text-on-surface-variant/40 px-1.5 py-0.5 border border-white/10 rounded uppercase font-code-sm">Ctrl K</span>
        </div>

        {isOpen && q && (
          <div className="absolute top-full left-0 mt-2 w-[400px] glass-card bg-surface-container-high/95 backdrop-blur-xl border border-white/10 rounded-lg shadow-2xl overflow-hidden z-50 flex flex-col glow-blue">
            <div className="px-4 py-2 text-xs font-code-label text-on-surface-variant/60 uppercase tracking-widest border-b border-white/5">
              Search Results
            </div>
            
            <div className="max-h-[300px] overflow-y-auto">
              {searchQ.isLoading && (
                <div className="p-4 text-center text-primary-fixed-dim neon-pulse font-code-sm text-xs">
                  Searching vectors...
                </div>
              )}
              
              {searchQ.isError && (
                <div className="p-4 text-center text-error font-code-sm text-xs">
                  Failed to search.
                </div>
              )}

              {searchQ.isSuccess && searchQ.data?.length === 0 && (
                <div className="p-4 text-center text-on-surface-variant/60 font-code-sm text-xs">
                  No tickets found.
                </div>
              )}

              {searchQ.isSuccess && searchQ.data?.length > 0 && (
                <ul className="flex flex-col divide-y divide-white/5">
                  {searchQ.data.map(t => (
                    <li 
                      key={t.id}
                      className="px-4 py-3 hover:bg-white/[0.05] transition-colors cursor-pointer group flex items-start gap-3"
                      onClick={() => handleTicketClick(t.id)}
                    >
                      <span className="material-symbols-outlined text-primary-fixed-dim/60 group-hover:text-primary mt-0.5">confirmation_number</span>
                      <div className="flex-1 min-w-0">
                        <div className="flex justify-between items-start mb-1">
                          <span className="font-code-sm text-xs text-primary/80">#{t.id.substring(0,8)}</span>
                          <StatusBadge status={t.status} />
                        </div>
                        <h4 className="text-sm text-on-surface font-medium truncate group-hover:text-primary transition-colors">
                          {t.title}
                        </h4>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
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
