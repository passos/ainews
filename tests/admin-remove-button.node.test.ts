import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  REMOVE_CONFIRM_TEXT,
  RemoveConfirm,
  TakedownPanel,
  currentDecision,
} from "../src/components/admin/RemoveButton";

// #87 A3b: the admin Remove / Restore controls. No jsdom here, so the
// two-step confirm is checked through its stateless renderer.
const noop = () => {};

function panel(decision: "approved" | "rejected" | null) {
  return renderToStaticMarkup(
    createElement(TakedownPanel, {
      decision,
      working: false,
      onRemove: noop,
      onRestore: noop,
    }),
  );
}

describe("currentDecision", () => {
  const reviews = [
    { bodySha: "old", decision: "approved" },
    { bodySha: "new", decision: "rejected" },
  ];

  it("reads only the review of the current body", () => {
    expect(currentDecision(reviews, "new")).toBe("rejected");
    expect(currentDecision(reviews, "old")).toBe("approved");
  });

  it("is null without a review of the current body", () => {
    expect(currentDecision(reviews, "other")).toBeNull();
    expect(currentDecision([], "new")).toBeNull();
    expect(currentDecision(reviews, null)).toBeNull();
  });
});

describe("TakedownPanel", () => {
  it("shows Remove when the current body is approved", () => {
    const html = panel("approved");
    expect(html).toContain("Remove from site");
    expect(html).toContain(">Remove</button>");
    expect(html).not.toContain("Restore");
    // The first render is step one: no confirm text yet.
    expect(html).not.toContain(REMOVE_CONFIRM_TEXT);
  });

  it("shows Restore when the current body is rejected", () => {
    const html = panel("rejected");
    expect(html).toContain(">Restore</button>");
    expect(html).not.toContain(">Remove</button>");
  });

  it("renders nothing without a review", () => {
    expect(panel(null)).toBe("");
  });
});

describe("RemoveConfirm", () => {
  const render = (confirming: boolean) =>
    renderToStaticMarkup(
      createElement(RemoveConfirm, {
        confirming,
        working: false,
        onStart: noop,
        onConfirm: noop,
        onCancel: noop,
      }),
    );

  it("asks for confirmation only after the first click", () => {
    expect(REMOVE_CONFIRM_TEXT).toContain(
      "its story is rebuilt from the reports that remain",
    );

    const first = render(false);
    expect(first).toContain(">Remove</button>");
    expect(first).not.toContain(REMOVE_CONFIRM_TEXT);
    expect(first).not.toContain(">Confirm</button>");

    const second = render(true);
    expect(second).toContain(REMOVE_CONFIRM_TEXT);
    expect(second).toContain(">Confirm</button>");
    expect(second).toContain(">Cancel</button>");
    expect(second).not.toContain(">Remove</button>");
  });
});
