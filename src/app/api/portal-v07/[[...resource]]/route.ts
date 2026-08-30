export const dynamic = "force-dynamic";

/**
 * Default-off and non-disclosing by construction. Integration must replace this
 * boundary with createPortalApi plus the proven P2 server identity adapter.
 */
export async function GET(): Promise<Response> { return disabled(); }
export async function POST(): Promise<Response> { return disabled(); }

function disabled(): Response {
  return new Response(null, {
    status: 404,
    headers: {
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
