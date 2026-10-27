import { describe, expect, it } from "vitest";
import { networkHash, networkKey } from "../../src/lib/network-key";

describe("networkKey (#132)", () => {
  it("returns an IPv4 address as is", () => {
    expect(networkKey("192.0.2.1")).toBe("192.0.2.1");
    expect(networkKey("203.0.113.255")).toBe("203.0.113.255");
  });

  it("maps IPv6 addresses in one /64 to one key", () => {
    const a = networkKey("2001:db8:a:b:1::1");
    expect(a).toBe("2001:db8:a:b::/64");
    expect(networkKey("2001:0db8:000a:000b:ffff::2")).toBe(a);
    expect(networkKey("2001:DB8:A:B:0:0:0:3")).toBe(a);
    expect(networkKey("2001:db8:a:c::1")).not.toBe(a);
  });

  it("treats an IPv4-mapped IPv6 address as IPv4", () => {
    expect(networkKey("::ffff:192.0.2.1")).toBe("192.0.2.1");
  });

  it("returns null for anything else", () => {
    for (const bad of [
      "not-an-ip",
      "",
      "256.1.1.1",
      "1.2.3",
      "1.2.3.4.5",
      "2001:db8::a::1",
      "2001:db8:a:b:c:d:e:f:1",
      "12345::1",
      "fe80::1%eth0",
      " 192.0.2.1",
    ]) {
      expect(networkKey(bad), bad).toBeNull();
    }
  });
});

describe("networkHash (#132)", () => {
  it("is stable, lower-case hex, and changes with day or purpose", async () => {
    const a = await networkHash("salt", "reader_watch", "2026-10-26", "k");
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await networkHash("salt", "reader_watch", "2026-10-26", "k")).toBe(
      a,
    );
    expect(
      await networkHash("salt", "reader_watch", "2026-10-27", "k"),
    ).not.toBe(a);
    expect(await networkHash("salt", "feedback", "2026-10-26", "k")).not.toBe(
      a,
    );
    expect(
      await networkHash("other", "reader_watch", "2026-10-26", "k"),
    ).not.toBe(a);
  });

  it("is sha256 of salt:purpose:day:key", async () => {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode("s:p:2026-10-26:192.0.2.1"),
    );
    const hex = [...new Uint8Array(digest)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    expect(await networkHash("s", "p", "2026-10-26", "192.0.2.1")).toBe(hex);
  });
});
