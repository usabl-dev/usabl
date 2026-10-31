/**
 * Whether a configured URL carries a user name or a password.
 *
 * One reading for every configured URL, surfaces[].url, appBaseUrl, and the docs manifest's
 * docsBaseUrl, so a refusal in one place is a refusal in all of them.
 *
 * Userinfo is read three ways, and any one of them is enough. URL parsing finds it in the
 * spellings a browser accepts, such as a backslash for a slash or a tab inside the name. The two
 * shape checks below run on every value, with backslashes read as slashes, because a person or
 * another parser can read a credential where URL parsing finds none. The first finds an @ in the
 * authority after "//". The second finds an @ before the first slash, query, or fragment, which
 * covers a value with no "//" at all: URL parsing reads "admin:" in "admin:secret@host" as a
 * scheme and reports no password. An @ in a path, a query, or a fragment is none of these.
 */
const USERINFO_SHAPE = /^[^/?#]*\/\/[^/?#]*@/;
const LEADING_USERINFO_SHAPE = /^[^/?#]*@/;

export function carriesUserinfo(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.username !== '' || url.password !== '') {
      return true;
    }
  } catch {
    // Not a URL the parser accepts. The shape checks below still apply.
  }
  const slashed = raw.replace(/\\/g, '/');
  return USERINFO_SHAPE.test(slashed) || LEADING_USERINFO_SHAPE.test(slashed);
}
