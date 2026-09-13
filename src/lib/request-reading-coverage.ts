/** Display links only. Coverage is established by the source-bound server
 * projection; this helper neither accepts an answer nor resolves a conflict. */
export function requestReadingCoverageIds(request: Readonly<{
  covered_by_field_request_id?: string;
  covered_by_field_request_ids?: readonly string[];
}>): readonly string[] {
  return [...new Set([
    ...(request.covered_by_field_request_id ? [request.covered_by_field_request_id] : []),
    ...(request.covered_by_field_request_ids ?? []),
  ])];
}
