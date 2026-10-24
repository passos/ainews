// XML text escaping for the RSS output. Characters that XML 1.0 forbids are
// removed: one stray control character in a title would make every RSS
// reader reject the whole feed.
// eslint-disable-next-line no-control-regex
const FORBIDDEN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g;

const ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
};

export function escapeXml(text: string): string {
  return text.replace(FORBIDDEN, "").replace(/[&<>"']/g, (c) => ENTITIES[c]);
}
