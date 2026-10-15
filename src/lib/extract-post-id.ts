/**
 * Extract a Nextdoor post identifier from a URL, or return the input unchanged
 * if it already looks like an id.
 *
 * Nextdoor post URLs take a few shapes, e.g.:
 *   https://nextdoor.com/p/abc123def456
 *   https://nextdoor.com/news_feed/?post=123456789
 *   https://nextdoor.com/post/123456789/
 */
export function extractPostId(input: string): string {
  const trimmed = input.trim();

  // Query-string form: ...?post=<id> or ...&post=<id>
  const queryMatch = trimmed.match(/[?&]post=([A-Za-z0-9_-]+)/);
  if (queryMatch) return queryMatch[1];

  // Path forms: /p/<id>, /post/<id>, /news_feed/<id>
  const pathMatch = trimmed.match(/nextdoor\.com\/(?:p|post|news_feed)\/([A-Za-z0-9_-]+)/);
  if (pathMatch && pathMatch[1] !== 'news_feed') return pathMatch[1];

  // Assume it is already a bare id.
  return trimmed;
}
