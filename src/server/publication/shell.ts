import { env } from "cloudflare:workers";
import { isEnabled } from "../../lib/flags";
import { SITE_NAME } from "../../lib/site";
import { getDb } from "../db/client";
import { listSections } from "./articles";
import { hasActiveWatches } from "./watches";

/** What every page needs: the section list and the Web Analytics token. */
export async function loadSiteShell() {
  // The generated Env types the var as the literal "": widen it.
  const beaconToken: string = env.CF_BEACON_TOKEN;
  return {
    name: SITE_NAME,
    // Name and slug only. The disclaimer is not sent to pages of other
    // sections, not even inside the page's serialized loader data.
    sections: (await listSections(getDb(env.DB))).map(({ slug, name }) => ({
      slug,
      name,
    })),
    beaconToken: beaconToken.trim(),
    // The header links to /w only while an active watch exists.
    hasWatches: await hasActiveWatches(getDb(env.DB)),
    // /follow and its links exist only while the switch is on (#132).
    readerWatchEnabled: isEnabled(env, "READER_WATCH_ENABLED"),
    // The event page shows "Ask about this story" only while it is on (#133).
    askPublicEnabled: isEnabled(env, "ASK_PUBLIC_ENABLED"),
  };
}
