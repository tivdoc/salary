import {describe,it,expect} from 'vitest';
import {normalizeMoney} from '../normalization.ts';
import {normalizeDocumentEvidenceMoney} from './money.ts';

describe('document evidence exact-money grammar v2',()=>{
 it.each([
  ['1,234.50',123450],['1.234,50',123450],['₪ 1,234.50',123450],
  ['1,234,567.89',123456789],['1.234.567,89',123456789],
  ['(500.00)',-50000],['(-500.00)',-50000],['+500.00',50000],
  ['ש״ח 500.00',50000],['ILS 500.00',50000],['1.234',123400],
  ['12.3400',1234],['0.00100',null],['1.2345',null],
  ['90071992547409.91',Number.MAX_SAFE_INTEGER],
  ['-90071992547409.91',Number.MIN_SAFE_INTEGER],
  ['90071992547409.92',null],['-90071992547409.92',null],
  ['\u200e₪\u00a01,234.50\u200f',123450],['ＩＬＳ ５００．００',50000],
  ['0',0],['(-0)',0],
 ] as const)('normalizes literal %s to exact agorot %s',(raw,expected)=>{
  expect(normalizeDocumentEvidenceMoney(raw)?.minor_units??null).toBe(expected);
 });
 it.each(['1..2','1,2,3','12,34.50','1.23.456','1,234,56','1,234.','1.','1,','--1','(1','1)','12%','1e3','', '1234,567,890'])
 ('rejects malformed %s without manufacturing a number',raw=>{
  expect(normalizeDocumentEvidenceMoney(raw)).toBeNull();
 });
 it('leaves the historical general parser unchanged',()=>{
  expect(normalizeMoney('1..2')?.minor_units).toBe(120);
  expect(normalizeMoney('1,2,3')?.minor_units).toBe(1230);
  expect(normalizeDocumentEvidenceMoney('1..2')).toBeNull();
  expect(normalizeDocumentEvidenceMoney('1,2,3')).toBeNull();
 });
});
