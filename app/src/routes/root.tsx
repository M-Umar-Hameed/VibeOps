import { useState, useEffect } from "react";
import { Outlet } from "@tanstack/react-router";
import { Sidebar } from "../components/layout/Sidebar";
import { TopBar } from "../components/layout/TopBar";
import { ShortcutsPopup } from "../components/layout/ShortcutsPopup";
import { Wizard } from "../components/Wizard";
import { api } from "../lib/api";
import { checkForUpdate } from "../lib/updater";

export function Root() {
  const [showWizard, setShowWizard] = useState(false);

  useEffect(() => {
    api.get("/system/first-run").then((res: any) => {
      if (res.firstRun) setShowWizard(true);
    }).catch(() => {});
    checkForUpdate();
  }, []);

  return (
    <div className="flex h-screen w-full relative overflow-hidden">
      {showWizard && <Wizard onComplete={() => setShowWizard(false)} />}
      <Sidebar />

      <main className="md:ml-[280px] flex-1 flex flex-col h-screen overflow-hidden w-full transition-all duration-300">
        <TopBar />
        <div className="relative flex-1 overflow-y-auto p-4 md:p-margin-desktop space-y-4 md:space-y-gutter terminal-scroll">
          <Outlet />
        </div>
      </main>
      <ShortcutsPopup />
    </div>
  );
}
