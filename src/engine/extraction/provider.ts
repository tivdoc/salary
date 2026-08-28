import type { ImmutableDocument } from "../domain/documents";
import type { ExtractionRequest, ExtractionResult } from "./contracts";

/** Reads bytes through trusted server code. Implementations must never expose private object URLs to clients. */
export interface PrivateDocumentSource {
  read(document: ImmutableDocument): Promise<Uint8Array>;
}

/** Provider-independent boundary. Vendor adapters translate their responses into ExtractionResult. */
export interface DocumentExtractor {
  readonly providerId: string;
  readonly extractorVersion: string;
  extract(request: ExtractionRequest, source: PrivateDocumentSource): Promise<ExtractionResult>;
}
