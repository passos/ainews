import { createServerFn } from "@tanstack/react-start";

export const getSiteInfo = createServerFn({ method: "GET" }).handler(
  async () => ({ name: "Personal News" }),
);
