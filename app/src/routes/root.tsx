import { Outlet } from "@tanstack/react-router";
import { Sidebar } from "../components/layout/Sidebar";
import { TopBar } from "../components/layout/TopBar";
import { ShortcutsPopup } from "../components/layout/ShortcutsPopup";

export function Root() {
  return (
    <div className="flex h-screen w-full relative">
      <Sidebar />
      <main className="ml-[280px] flex-1 flex flex-col h-screen overflow-hidden">
        <TopBar />
        <div className="flex-1 overflow-y-auto p-margin-desktop space-y-gutter terminal-scroll">
          <Outlet />
        </div>
      </main>
      <ShortcutsPopup />
    </div>
  );
}
