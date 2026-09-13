/** Rendering is an execution dependency. Historical receipts retain v1 bytes. */
export const DOCUMENT_REVIEW_RENDER_POLICY='group-identical-v2' as const;
export type DocumentReviewRenderPolicy='individual-v1'|typeof DOCUMENT_REVIEW_RENDER_POLICY;
