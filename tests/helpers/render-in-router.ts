import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import type { ReactNode } from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * Render a component that uses router `Link`s in a one-route memory router.
 * Needed because `Link` throws outside a router.
 */
export async function renderInRouter(
  node: ReactNode,
  url = "/",
): Promise<string> {
  const root = createRootRoute({ component: () => node });
  const index = createRoute({
    getParentRoute: () => root,
    path: "/",
  });
  const router = createRouter({
    routeTree: root.addChildren([index]),
    history: createMemoryHistory({ initialEntries: [url] }),
  });
  await router.load();
  return renderToStaticMarkup(createElement(RouterProvider, { router }));
}
