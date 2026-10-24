import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";
import { getDb } from "../db/client";
import { listSections } from "./articles";

export const getSiteInfo = createServerFn({ method: "GET" }).handler(
  async () => ({ name: "Personal News" }),
);

/** What every page needs: the section list and the Web Analytics token. */
export const getSiteShell = createServerFn({ method: "GET" }).handler(
  async () => {
    // The generated Env types the var as the literal "": widen it.
    const beaconToken: string = env.CF_BEACON_TOKEN;
    return {
      name: "Personal News",
      // Name and slug only. The disclaimer is not sent to pages of other
      // sections, not even inside the page's serialized loader data.
      sections: (await listSections(getDb(env.DB))).map(({ slug, name }) => ({
        slug,
        name,
      })),
      beaconToken: beaconToken.trim(),
    };
  },
);
