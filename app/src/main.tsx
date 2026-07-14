import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import { QueryClientProvider } from "@tanstack/react-query";
import { createRootRoute, createRoute, createRouter, redirect, RouterProvider } from "@tanstack/react-router";
import { queryClient, setAuthErrorHandler } from "./lib/queryClient.js";
import { getSettings, saveSettings, detectLocalNode } from "./settings.js";
import { Root } from "./routes/root.js";
import { ListScreen } from "./routes/list.js";
import { DetailScreen } from "./routes/detail.js";
import { CreateScreen } from "./routes/create.js";
import { KnowledgeScreen } from "./routes/knowledge.js";
import { SettingsScreen } from "./routes/settings.js";
import { ForgeScreen } from "./routes/forge.js";

const rootRoute = createRootRoute({
  component: Root,
  beforeLoad: async ({ location }) => {
    if (location.pathname === "/settings") return;
    const { apiKey } = await getSettings();
    if (!apiKey) {
      const found = await detectLocalNode();
      if (found) {
        await saveSettings(found);
        return;
      }
      throw redirect({ to: "/settings" });
    }
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

const routeTree = rootRoute.addChildren([listRoute, detailRoute, createRouteDef, knowledgeRoute, settingsRoute, forgeRoute]);

const router = createRouter({ routeTree });

// On any 401, send the user to Settings to fix the key.
setAuthErrorHandler(() => { router.navigate({ to: "/settings" }); });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </React.StrictMode>,
);
