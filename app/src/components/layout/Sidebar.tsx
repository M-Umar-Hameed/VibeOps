import { Link, useLocation } from "@tanstack/react-router";

export function Sidebar({ isOpen = false, setIsOpen = (_v: boolean) => {} }) {
  const location = useLocation();
  const path = location.pathname;

  const isActive = (route: string) => path === route;

  return (
    <aside className={`fixed left-0 top-0 h-full w-[280px] bg-surface-container/95 md:bg-surface-container/60 backdrop-blur-xl border-r border-white/10 flex flex-col py-6 z-50 transform transition-transform duration-300 md:translate-x-0 ${isOpen ? "translate-x-0" : "-translate-x-full"}`}>
      <div className="px-6 mb-10">
        <h1 className="font-headline-md text-headline-md font-bold text-primary tracking-tighter">VibeOps</h1>
        <p className="font-code-label text-code-label text-on-surface-variant opacity-60">Terminal Access</p>
      </div>
      
      <nav className="flex-1 space-y-1">
        <Link
          to="/"
          onClick={() => setIsOpen(false)}
          className={`flex items-center gap-3 px-4 py-3 transition-all duration-200 active:scale-[0.98] ${
            isActive("/")
              ? "border-l-2 border-primary-fixed-dim bg-primary-fixed-dim/5 text-primary-fixed-dim"
              : "text-on-surface-variant hover:bg-white/5 hover:text-on-surface"
          }`}
        >
          <span className="material-symbols-outlined" style={{ fontVariationSettings: isActive("/") ? "'FILL' 1" : "" }}>dashboard</span>
          <span className="font-body-md">Dashboard</span>
        </Link>
        <Link
          to="/create"
          onClick={() => setIsOpen(false)}
          className={`flex items-center gap-3 px-4 py-3 transition-all duration-200 active:scale-[0.98] ${
            isActive("/create")
              ? "border-l-2 border-primary-fixed-dim bg-primary-fixed-dim/5 text-primary-fixed-dim"
              : "text-on-surface-variant hover:bg-white/5 hover:text-on-surface"
          }`}
        >
          <span className="material-symbols-outlined" style={{ fontVariationSettings: isActive("/create") ? "'FILL' 1" : "" }}>confirmation_number</span>
          <span className="font-body-md">New Ticket</span>
        </Link>
        <Link
          to="/knowledge"
          onClick={() => setIsOpen(false)}
          className={`flex items-center gap-3 px-4 py-3 transition-all duration-200 active:scale-[0.98] ${
            isActive("/knowledge")
              ? "border-l-2 border-primary-fixed-dim bg-primary-fixed-dim/5 text-primary-fixed-dim"
              : "text-on-surface-variant hover:bg-white/5 hover:text-on-surface"
          }`}
        >
          <span className="material-symbols-outlined" style={{ fontVariationSettings: isActive("/knowledge") ? "'FILL' 1" : "" }}>analytics</span>
          <span className="font-body-md">Knowledge</span>
        </Link>
        <Link
          to="/forge"
          onClick={() => setIsOpen(false)}
          className={`flex items-center gap-3 px-4 py-3 transition-all duration-200 active:scale-[0.98] ${
            isActive("/forge")
              ? "border-l-2 border-primary-fixed-dim bg-primary-fixed-dim/5 text-primary-fixed-dim"
              : "text-on-surface-variant hover:bg-white/5 hover:text-on-surface"
          }`}
        >
          <span className="material-symbols-outlined" style={{ fontVariationSettings: isActive("/forge") ? "'FILL' 1" : "" }}>construction</span>
          <span className="font-body-md">Forge</span>
        </Link>
        <Link
          to="/settings"
          onClick={() => setIsOpen(false)}
          className={`flex items-center gap-3 px-4 py-3 transition-all duration-200 active:scale-[0.98] ${
            isActive("/settings")
              ? "border-l-2 border-primary-fixed-dim bg-primary-fixed-dim/5 text-primary-fixed-dim"
              : "text-on-surface-variant hover:bg-white/5 hover:text-on-surface"
          }`}
        >
          <span className="material-symbols-outlined" style={{ fontVariationSettings: isActive("/settings") ? "'FILL' 1" : "" }}>settings</span>
          <span className="font-body-md">Settings</span>
        </Link>
      </nav>
    </aside>
  );
}
