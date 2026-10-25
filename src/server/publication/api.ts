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
import {
  getDigest as readDigest,
  getRecentDigests as readRecentDigests,
} from "./digests";
import {
  getEvent as readEvent,
  getEventSources as readEventSources,
} from "./events";
import {
  getFundingPage as readFundingPage,
  getFundingRoundDetails as readFundingRoundDetails,
} from "./funding";
import {
  getWatchView as readWatchView,
  getActiveWatchesView as readActiveWatches,
} from "./watches";

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

const eventInput = z.object({ eventId: z.number().int().positive() });

export const getEvent = createServerFn({ method: "GET" })
  .validator(eventInput)
  .handler(({ data }) => readEvent(getDb(env.DB), data.eventId));

export const getEventSources = createServerFn({ method: "GET" })
  .validator(eventInput)
  .handler(({ data }) => readEventSources(getDb(env.DB), data.eventId));

const digestInput = z.object({
  slug: z.string().min(1).max(64),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  kind: z.enum(["daily", "weekly"]).optional(),
});

export const getDigest = createServerFn({ method: "GET" })
  .validator(digestInput)
  .handler(({ data }) =>
    readDigest(getDb(env.DB), data.slug, data.date, data.kind),
  );

const recentDigestsInput = z.object({
  slug: z.string().min(1).max(64),
  kind: z.enum(["daily", "weekly"]).optional(),
});

export const getRecentDigests = createServerFn({ method: "GET" })
  .validator(recentDigestsInput)
  .handler(({ data }) =>
    readRecentDigests(getDb(env.DB), data.slug, 7, data.kind),
  );

const watchInput = z.object({ slug: z.string().min(1).max(64) });

export const getWatch = createServerFn({ method: "GET" })
  .validator(watchInput)
  .handler(({ data }) => readWatchView(getDb(env.DB), data.slug));

export const getPublicWatches = createServerFn({ method: "GET" }).handler(() =>
  readActiveWatches(getDb(env.DB)),
);

const fundingInput = z.object({
  sector: z.string().min(1).max(64).optional(),
  stage: z.string().min(1).max(64).optional(),
  investor: z.string().min(1).max(200).optional(),
  page: z.number().int().min(1).max(10_000).optional(),
});

export const getFundingPage = createServerFn({ method: "GET" })
  .validator(fundingInput)
  .handler(({ data }) => readFundingPage(getDb(env.DB), data));

export const getFundingRoundDetails = createServerFn({ method: "GET" })
  .validator(z.object({ id: z.number().int().positive() }))
  .handler(({ data }) => readFundingRoundDetails(getDb(env.DB), data.id));
