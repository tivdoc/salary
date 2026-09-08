import {createElement} from 'react';
import {describe,it,expect} from 'vitest';
import {createHash} from 'node:crypto';
import {renderToStaticMarkup} from 'react-dom/server';
import samples from '@/content/report-samples.json';
import {reportDocumentSchema} from '@/server/product/reports/report-document';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {ReportView} from '@/components/case/report-view';
describe('public synthetic report proof',()=>{
 it('binds both draft documents to the exact supplied synthetic source',()=>{expect(createHash('sha256').update(samples.source).digest('hex')).toBe(samples.sourceSha256);for(const raw of samples.reports){const doc=reportDocumentSchema.parse(raw);expect(doc.publication.state).toBe('draft');expect(doc.publication.published_at).toBeNull();expect(doc.evidence[0].sha256).toBe(samples.sourceSha256);expect(doc.findings[0].evidence_ids).toContain(doc.evidence[0].id);}});
 it('uses the customer renderer and preserves missing information without money',()=>{for(const raw of samples.reports){const doc=reportDocumentSchema.parse(raw);const html=renderToStaticMarkup(createElement(ReportView,{projection:doc.projection,embedded:true}));expect(html).toContain('אי אפשר לקבוע סכום');expect(html).toContain('לא בדקנו את שעות העבודה');expect(html).not.toContain('<h1>');expect(doc.projection.topics.filter(t=>t.gate==='checked').every(t=>t.gate==='checked'&&t.amount===null&&t.range===null)).toBe(true);}});
 it('rejects an amount slipped into the low-certainty example',()=>{const raw=structuredClone(samples.reports[0]);const topic=raw.projection.topics.find(t=>t.topic==='pension')!;Object.assign(topic,{amount:{currency:'ILS',minor_units:999999}});raw.projection_sha256=canonicalSha256(raw.projection);expect(reportDocumentSchema.safeParse(raw).success).toBe(false);});
 it('rejects a missing source and preserves the displayed period',()=>{const raw=structuredClone(samples.reports[1]);raw.evidence=[];expect(reportDocumentSchema.safeParse(raw).success).toBe(false);for(const doc of samples.reports)expect(doc.projection.months_covered).toEqual(['2026-06']);});
});
