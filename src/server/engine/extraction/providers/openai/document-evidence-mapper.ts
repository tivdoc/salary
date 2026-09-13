import {normalizeDocumentEvidence} from '@/engine/extraction/document-evidence/normalization';
import {rawDocumentEvidenceSchema} from '@/engine/extraction/document-evidence/contracts';
import type {ImmutableDocument} from '@/engine/domain/documents';
export function mapOpenAiDocumentEvidence(input:{output:unknown;document:ImmutableDocument;physicalPageCount:number}){
 const raw=rawDocumentEvidenceSchema.parse(input.output);
 return {raw,normalized:normalizeDocumentEvidence({raw,document:input.document,physicalPageCount:input.physicalPageCount})};
}
