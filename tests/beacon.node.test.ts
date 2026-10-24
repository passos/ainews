import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Beacon } from "../src/components/Beacon";

describe("Beacon", () => {
  it("renders the Web Analytics script with the token", () => {
    const html = renderToStaticMarkup(Beacon({ token: "t1" }));
    expect(html).toContain(
      "https://static.cloudflareinsights.com/beacon.min.js",
    );
    expect(html).toContain("&quot;token&quot;:&quot;t1&quot;");
  });

  it("renders nothing for an empty token", () => {
    expect(renderToStaticMarkup(Beacon({ token: "" }))).toBe("");
  });

  it("does not let a token break out of the attribute", () => {
    const html = renderToStaticMarkup(
      Beacon({ token: `"><script>x</script>` }),
    );
    expect(html).not.toContain("<script>x");
  });
});
