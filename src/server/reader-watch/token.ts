// Private feed tokens (architecture §6 "读者 watch" 令牌): 32 random bytes as
// unpadded base64url. Only sha256hex(token) is stored.

export const READER_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

export function newReaderToken(): string {
  const binary = String.fromCharCode(...randomBytes(32));
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export async function tokenHash(token: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** "r-" and 16 random lower-case hex digits; not related to the token. */
export function newReaderSlug(): string {
  return `r-${[...randomBytes(8)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")}`;
}
