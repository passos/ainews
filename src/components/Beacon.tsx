/** Cloudflare Web Analytics. Nothing is rendered without a token. */
export function Beacon({ token }: { token: string }) {
  if (!token) return null;
  return (
    <script
      type="module"
      src="https://static.cloudflareinsights.com/beacon.min.js"
      data-cf-beacon={JSON.stringify({ token })}
    />
  );
}
