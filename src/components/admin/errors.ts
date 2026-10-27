/**
 * Text for an error from an admin server function. A thrown Response (400,
 * 409, ...) carries the message in its body; String() of it is
 * "[object Response]".
 */
export async function describeError(err: unknown): Promise<string> {
  if (err instanceof Response) {
    const body = (await err.text().catch(() => "")).trim();
    return body || `Request failed (${err.status})`;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}
