// Entry for the RSS server route. Routes cannot import `cloudflare:workers`,
// so the env lookup lives here.
import { env } from "cloudflare:workers";
import { getDb } from "../db/client";
import { feedResponse } from "./feed";

export function serveFeed(slug: string): Promise<Response> {
  return feedResponse(getDb(env.DB), env.SITE_URL, slug);
}
