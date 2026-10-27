import type { ReactNode } from "react";
import {
  HeadContent,
  Link,
  Outlet,
  Scripts,
  createRootRoute,
} from "@tanstack/react-router";
import { z } from "zod";
import { AudienceSelector } from "../components/AudienceSelector";
import { Beacon } from "../components/Beacon";
import { PrefsSync } from "../components/PrefsSync";
import { SectionNav, WatchesNavLink } from "../components/SectionNav";
import { ThemeSwitcher } from "../components/ThemeSwitcher";
import { AUDIENCES } from "../lib/reader-prefs";
import { showWatchesNav } from "../lib/follow";
import { THEME_INIT_SCRIPT } from "../lib/theme";
import { getSiteShell } from "../server/publication/site";
import appCss from "../styles.css?url";
import { SITE_NAME } from "../lib/site";

// Child routes inherit this. An unknown audience becomes "not set".
const searchSchema = z.object({
  audience: z.enum(AUDIENCES).optional().catch(undefined),
});

export const Route = createRootRoute({
  validateSearch: searchSchema,
  loader: () => getSiteShell(),
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: SITE_NAME },
    ],
    links: [{ rel: "stylesheet", href: appCss }],
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

function RootLayout() {
  const { name, sections, hasWatches, readerWatchEnabled } =
    Route.useLoaderData();
  const { audience } = Route.useSearch();
  return (
    <div className="mx-auto flex min-h-dvh max-w-6xl flex-col px-3 sm:px-5">
      <PrefsSync audience={audience} />
      <header className="border-t-[6px] border-foreground pt-2 pb-3">
        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-1">
          <Link
            to="/"
            search={(prev) => ({ audience: prev.audience })}
            className="font-serif text-3xl font-black uppercase leading-none tracking-tight sm:text-5xl"
          >
            {name}
          </Link>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <p className="font-mono text-[0.68rem] uppercase tracking-widest text-muted-foreground">
              Approved stories · every one traced to its source
            </p>
            <ThemeSwitcher />
          </div>
        </div>
        <div className="mt-3 flex flex-col gap-2 border-y-2 py-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap items-center gap-1">
            <SectionNav sections={sections} />
            {showWatchesNav({ hasWatches, readerWatchEnabled }) && (
              <WatchesNavLink />
            )}
          </div>
          <AudienceSelector current={audience} />
        </div>
      </header>
      <main className="flex-1 pb-8">
        <Outlet />
      </main>
      <footer className="border-t-2 py-3 font-mono text-[0.68rem] uppercase tracking-widest text-muted-foreground">
        Every story links to its original source.
      </footer>
    </div>
  );
}
