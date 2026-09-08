import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import { QueryClientProvider } from "@tanstack/react-query";
import { createRootRoute, createRoute, createRouter, redirect, RouterProvider } from "@tanstack/react-router";
import { queryClient, setAuthErrorHandler } from "./lib/queryClient.js";
import { getSettings } from "./settings.js";
import { Root } from "./routes/root.js";
import { ListScreen } from "./routes/list.js";
import { DetailScreen } from "./routes/detail.js";
import { CreateScreen } from "./routes/create.js";
import { KnowledgeScreen } from "./routes/knowledge.js";
import { SettingsScreen } from "./routes/settings.js";
import { ForgeScreen } from "./routes/forge.js";
import { ChatScreen } from "./routes/chat.js";
import { UsageScreen } from "./routes/usage.js";

const rootRoute = createRootRoute({
  component: Root,
  beforeLoad: async ({ location }) => {
    if (location.pathname === "/settings") return;
    // getSettings picks up the sidecar's credentials file on its own; on a
    // first launch that file lands seconds after the window does, so wait for
    // the boot rather than stranding the user in Settings with an empty key.
    for (let i = 0; i < 20; i++) {
      if ((await getSettings()).apiKey) return;
      await new Promise((r) => setTimeout(r, 500));
    }
    throw redirect({ to: "/settings" });
  },
});

const listRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: ListScreen });

const detailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/tickets/$id",
  component: () => {
    const { id } = detailRoute.useParams();
    return <DetailScreen id={id} />;
  },
});

const createRouteDef = createRoute({ getParentRoute: () => rootRoute, path: "/create", component: CreateScreen });
const knowledgeRoute = createRoute({ getParentRoute: () => rootRoute, path: "/knowledge", component: KnowledgeScreen });
const settingsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/settings", component: SettingsScreen });
const forgeRoute = createRoute({ getParentRoute: () => rootRoute, path: "/forge", component: ForgeScreen });
const chatRoute = createRoute({ getParentRoute: () => rootRoute, path: "/chat", component: ChatScreen });
const usageRoute = createRoute({ getParentRoute: () => rootRoute, path: "/usage", component: UsageScreen });

const routeTree = rootRoute.addChildren([listRoute, detailRoute, createRouteDef, knowledgeRoute, settingsRoute, forgeRoute, chatRoute, usageRoute]);

const router = createRouter({ routeTree });

// On any 401, send the user to Settings to fix the key.
setAuthErrorHandler(() => { router.navigate({ to: "/settings" }); });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

import { ProjectProvider } from "./context/project.js";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <ProjectProvider>
        <RouterProvider router={router} />
      </ProjectProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
