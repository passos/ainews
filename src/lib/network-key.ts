// Network key and salted hash for public write entries (architecture §3
// "公开写入口" rule 4): IPv4 is the full address, IPv6 the first 64 bits.

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const HEX_GROUP = /^[0-9a-f]{1,4}$/;

function ipv4(text: string): number[] | null {
  const m = IPV4.exec(text);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((p) => p <= 255) ? parts : null;
}

// Eight 16-bit groups, or null. Accepts one "::" and an IPv4 tail.
function ipv6Groups(text: string): number[] | null {
  let s = text.toLowerCase();
  const lastColon = s.lastIndexOf(":");
  if (lastColon !== -1 && s.includes(".", lastColon)) {
    const v4 = ipv4(s.slice(lastColon + 1));
    if (!v4) return null;
    const hi = ((v4[0] << 8) | v4[1]).toString(16);
    const lo = ((v4[2] << 8) | v4[3]).toString(16);
    s = `${s.slice(0, lastColon + 1)}${hi}:${lo}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string) => (part === "" ? [] : part.split(":"));
  const head = parse(halves[0]);
  const tail = halves.length === 2 ? parse(halves[1]) : [];
  const all = [...head, ...tail];
  if (!all.every((g) => HEX_GROUP.test(g))) return null;
  const missing = 8 - all.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const groups = [...head, ...Array<string>(missing).fill("0"), ...tail];
  return groups.map((g) => parseInt(g, 16));
}

/**
 * The network part of a client address: IPv4 as is, IPv6 as
 * "<g1>:<g2>:<g3>:<g4>::/64", IPv4-mapped IPv6 as IPv4. Null for anything else.
 */
export function networkKey(ip: string): string | null {
  const v4 = ipv4(ip);
  if (v4) return v4.join(".");
  const g = ipv6Groups(ip);
  if (!g) return null;
  const mapped = g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff;
  if (mapped) {
    return [g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff].join(".");
  }
  return `${g
    .slice(0, 4)
    .map((x) => x.toString(16))
    .join(":")}::/64`;
}

/** sha256hex(`${salt}:${purpose}:${day}:${key}`), lower-case hex. */
export async function networkHash(
  salt: string,
  purpose: string,
  day: string,
  key: string,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${salt}:${purpose}:${day}:${key}`),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
