import {normalizeMoney} from '../normalization.ts';

/** Literal non-payroll amount grammar v2. Currency/unit classification remains
 * external evidence. Do not reinterpret malformed separator groups as money. */
export function normalizeDocumentEvidenceMoney(raw:string){
 const cleaned=raw.normalize('NFKC').replace(/₪|nis|ils|ש["״']?ח/gi,'')
  .replace(/[\u0009-\u000d\u0020\u00a0\u1680\u2000-\u200f\u2028-\u202e\u202f\u205f\u3000\ufeff]/gu,'');
 let text=cleaned;
 if(text.startsWith('(')&&text.endsWith(')'))text=text.slice(1,-1);
 if(text.startsWith('-')||text.startsWith('+'))text=text.slice(1);
 if(!/^\d+(?:[.,]\d+)?$/u.test(text)
  &&!/^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/u.test(text)
  &&!/^\d{1,3}(?:\.\d{3})+(?:,\d+)?$/u.test(text))return null;
 // The established exact-cents parser supplies signs, three-digit grouping,
 // trailing-zero precision and the signed JS-safe integer bound unchanged.
 return normalizeMoney(cleaned,'ILS');
}
