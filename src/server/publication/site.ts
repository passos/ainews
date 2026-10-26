import { createServerFn } from "@tanstack/react-start";
import { SITE_NAME } from "../../lib/site";
import { loadSiteShell } from "./shell";

export const getSiteInfo = createServerFn({ method: "GET" }).handler(
  async () => ({ name: SITE_NAME }),
);

export const getSiteShell = createServerFn({ method: "GET" }).handler(
  loadSiteShell,
);
