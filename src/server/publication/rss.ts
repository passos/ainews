// Entry for the RSS server route. Routes cannot import `cloudflare:workers`,
// so the env lookup lives here.
import { env } from "cloudflare:workers";
import { getDb } from "../db/client";
import { digestFeedResponse, feedResponse } from "./feed";

export function serveFeed(slug: string): Promise<Response> {
  return feedResponse(getDb(env.DB), env.SITE_URL, slug);
}

export function serveDigestFeed(slug: string): Promise<Response> {
  return digestFeedResponse(getDb(env.DB), env.SITE_URL, slug);
}
