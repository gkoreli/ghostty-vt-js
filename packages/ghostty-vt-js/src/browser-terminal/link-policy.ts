/**
 * Which links a terminal opens: {@link ITerminalOptions.linkSchemes}.
 *
 * A link's scheme is read by the WHATWG URL parser (`new URL`), never by matching text, so `HTTPS:` and `https:` are
 * one scheme and a string the parser rejects opens nothing. Without a list, every link the providers find opens, as
 * before the option existed.
 */
export function linkOpens(uri: string, schemes: readonly string[] | undefined): boolean {
  if (schemes === undefined) return true;
  let scheme: string;
  try {
    scheme = new URL(uri).protocol.slice(0, -1).toLowerCase();
  } catch {
    return false;
  }
  return schemes.some((allowed) => allowed.toLowerCase() === scheme);
}
