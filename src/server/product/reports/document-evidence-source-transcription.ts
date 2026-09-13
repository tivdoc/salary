export * from '@/engine/extraction/document-evidence/source-transcription';
import {documentEvidenceSourceTranscriptionTargetSchema,documentEvidenceSourceTranscriptionQuestion,type EvidenceSourceTranscriptionContext} from '@/engine/extraction/document-evidence/source-transcription';
import type {DocumentReadingDisplay} from '@/lib/document-reading-display';

export function documentEvidenceSourceTranscriptionDisplay(input:unknown):DocumentReadingDisplay&{source_transcription_context:EvidenceSourceTranscriptionContext}{
 const t=documentEvidenceSourceTranscriptionTargetSchema.parse(input);
 return {question:documentEvidenceSourceTranscriptionQuestion(t).question,field:'source_transcription.financial_clause',raw_value:null,page:t.page??1,text_fragment:null,bounding_box:null,
  source_transcription_context:t.page===null?{kind:'financial_clause',page:null,page_count:t.page_count,max_characters:1600}:{kind:'financial_clause',page:t.page,max_characters:1600}};
}
