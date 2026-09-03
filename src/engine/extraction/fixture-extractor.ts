import { extractionRequestSchema, extractionResultSchema } from "./contracts.ts";
import type { DocumentExtractor, PrivateDocumentSource } from "./provider.ts";
import type { SyntheticPayslipFixture } from "./fixtures/source-fixtures.ts";

export class FixtureDocumentExtractor implements DocumentExtractor {
  readonly providerId = "synthetic_fixture";
  readonly extractorVersion = "1.0";
  private readonly fixturesByDocumentId: ReadonlyMap<string, SyntheticPayslipFixture>;

  constructor(fixtures: readonly SyntheticPayslipFixture[]) {
    this.fixturesByDocumentId = new Map(fixtures.map((fixture) => [fixture.request.document.document_id, fixture]));
  }

  async extract(requestInput: Parameters<DocumentExtractor["extract"]>[0], source: PrivateDocumentSource) {
    const request = extractionRequestSchema.parse(requestInput);
    const bytes = await source.read(request.document);
    if (bytes.byteLength === 0) throw new TypeError("Private document source returned an empty fixture");
    const fixture = this.fixturesByDocumentId.get(request.document.document_id);
    if (!fixture) throw new TypeError("No synthetic extraction fixture exists for the requested document");
    return extractionResultSchema.parse(fixture.extraction);
  }
}

export class SyntheticDocumentSource implements PrivateDocumentSource {
  async read(document: Parameters<PrivateDocumentSource["read"]>[0]) {
    return new TextEncoder().encode(`synthetic-private-document:${document.document_id}`);
  }
}
