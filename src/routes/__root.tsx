import type { ReactNode } from "react";
import {
  HeadContent,
  Link,
  Outlet,
  Scripts,
  createRootRoute,
  useRouterState,
} from "@tanstack/react-router";
import { Beacon } from "../components/Beacon";
import { SectionNav, WatchesNavLink } from "../components/SectionNav";
import { ThemeSwitcher } from "../components/ThemeSwitcher";
import { showWatchesNav } from "../lib/follow";
import { THEME_INIT_SCRIPT } from "../lib/theme";
import { getSiteShell } from "../server/publication/site";
import appCss from "../styles.css?url";
import { SITE_NAME } from "../lib/site";

export const Route = createRootRoute({
  loader: () => getSiteShell(),
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: SITE_NAME },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      // Preload the body font only: it sets most of the text on every page.
      {
        rel: "preload",
        href: "/fonts/literata-latin-400-normal.woff2",
        as: "font",
        type: "font/woff2",
        crossOrigin: "anonymous",
      },
      { rel: "icon", href: "/favicon.svg", type: "image/svg+xml" },
      { rel: "icon", href: "/favicon.ico", sizes: "32x32" },
    ],
  }),
  shellComponent: RootDocument,
  component: RootLayout,
});

function RootDocument({ children }: { children: ReactNode }) {
  const { beaconToken } = Route.useLoaderData();
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
        <Beacon token={beaconToken} />
      </body>
    </html>
  );
}

export function SiteHeader({
  name,
  sections,
  hasWatches,
  readerWatchEnabled,
}: {
  name: string;
  sections: { slug: string; name: string }[];
  hasWatches: boolean;
  readerWatchEnabled: boolean;
}) {
  return (
    <header className="pt-5 pb-3">
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2 border-b-[3px] border-foreground pb-3">
        <Link
          to="/"
          className="font-heading text-4xl font-semibold leading-none tracking-[-0.03em] no-underline sm:text-5xl"
        >
          {name}
        </Link>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <p className="text-sm text-muted-foreground">
            Approved stories · every one traced to its source
          </p>
          <ThemeSwitcher />
        </div>
      </div>
      <div className="flex flex-col gap-2 border-b sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-x-5">
          <SectionNav sections={sections} />
          {showWatchesNav({ hasWatches, readerWatchEnabled }) && (
            <WatchesNavLink />
          )}
        </div>
      </div>
    </header>
  );
}

/** /admin and /admin/... have their own header (src/routes/admin/route.tsx). */
export function isAdminPath(pathname: string): boolean {
  return pathname === "/admin" || pathname.startsWith("/admin/");
}

export function RootLayoutView({
  isAdmin,
  shell,
  children,
}: {
  isAdmin: boolean;
  shell: {
    name: string;
    sections: { slug: string; name: string }[];
    hasWatches: boolean;
    readerWatchEnabled: boolean;
  };
  children?: ReactNode;
}) {
  return (
    <div className="mx-auto flex min-h-dvh max-w-6xl flex-col px-3 sm:px-5">
      {!isAdmin && (
        <SiteHeader
          name={shell.name}
          sections={shell.sections}
          hasWatches={shell.hasWatches}
          readerWatchEnabled={shell.readerWatchEnabled}
        />
      )}
      <main className="flex-1 pb-8">{children}</main>
      {!isAdmin && (
        <footer className="border-t py-5 text-sm text-muted-foreground">
          Every story links to its original source.
        </footer>
      )}
    </div>
  );
}

function RootLayout() {
  const shell = Route.useLoaderData();
  // The pathname is known on the server, so SSR and hydration agree.
  const isAdmin = useRouterState({
    select: (state) => isAdminPath(state.location.pathname),
  });
  return (
    <RootLayoutView isAdmin={isAdmin} shell={shell}>
      <Outlet />
    </RootLayoutView>
  );
}
