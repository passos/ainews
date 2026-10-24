// Server functions of the public pages. They only call the plain read
// functions in articles.ts, which hold the SQL.
import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";
import { z } from "zod";
import { getDb } from "../db/client";
import {
  getHome as readHome,
  getRecentCorrections as readRecentCorrections,
  getSection as readSection,
  getSectionSources as readSectionSources,
} from "./articles";

export const getHome = createServerFn({ method: "GET" }).handler(() =>
  readHome(getDb(env.DB)),
);

export const getRecentCorrections = createServerFn({ method: "GET" }).handler(
  () => readRecentCorrections(getDb(env.DB)),
);

const sectionInput = z.object({ slug: z.string().min(1).max(64) });

export const getSection = createServerFn({ method: "GET" })
  .validator(sectionInput.extend({ page: z.number().int().min(1) }))
  .handler(({ data }) => readSection(getDb(env.DB), data));

export const getSectionSources = createServerFn({ method: "GET" })
  .validator(sectionInput)
  .handler(({ data }) => readSectionSources(getDb(env.DB), data.slug));
