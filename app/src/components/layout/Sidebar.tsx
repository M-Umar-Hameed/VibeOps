import { Link, useLocation } from "@tanstack/react-router";

export function Sidebar() {
  const location = useLocation();
  const path = location.pathname;

  const isActive = (route: string) => path === route;

  return (
    <aside className="fixed left-0 top-0 h-full w-[280px] bg-surface-container/60 backdrop-blur-xl border-r border-white/10 flex flex-col py-6 z-50">
      <div className="px-6 mb-10">
        <h1 className="font-headline-md text-headline-md font-bold text-primary tracking-tighter">VibeOps</h1>
        <p className="font-code-label text-code-label text-on-surface-variant opacity-60">Terminal Access</p>
      </div>
      
      <nav className="flex-1 space-y-1">
        <Link
          to="/"
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
          to="/settings"
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
      
      <div className="mt-auto border-t border-white/5 pt-6 space-y-1">
        <a className="flex items-center gap-3 px-4 py-3 text-on-surface-variant hover:bg-white/5 transition-all" href="#">
          <span className="material-symbols-outlined">help_outline</span>
          <span className="font-body-md">Support</span>
        </a>
        <a className="flex items-center gap-3 px-4 py-3 text-error/80 hover:bg-error/5 transition-all" href="#">
          <span className="material-symbols-outlined">logout</span>
          <span className="font-body-md">Logout</span>
        </a>
        <div className="px-4 mt-4 flex items-center gap-3">
          <div className="w-8 h-8 rounded-full bg-surface-container-highest border border-white/10 flex items-center justify-center overflow-hidden">
            <span className="material-symbols-outlined text-on-surface-variant text-sm">person</span>
          </div>
          <div className="flex flex-col">
            <span className="text-xs font-bold text-on-surface">Admin_User</span>
            <span className="text-[10px] text-primary-fixed-dim">ID: #0X77F</span>
          </div>
        </div>
      </div>
    </aside>
  );
}
