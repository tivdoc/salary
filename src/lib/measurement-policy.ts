/** P10: the inherited analytics scripts can observe private navigation and have
 * no persisted consent contract. Keep external measurement closed until both
 * consent and isolation from authenticated surfaces are verified. First-party
 * operational counters remain available. Configuration alone cannot reopen it. */
export const EXTERNAL_MEASUREMENT_ENABLED:boolean=false;
export function safeMeasurementUrl(value:string,fallbackOrigin='https://tivdoc.com'){
 try{const url=new URL(value);return new URL(['/', '/check','/privacy','/terms'].includes(url.pathname)?url.pathname:'/',fallbackOrigin).toString();}catch{return new URL('/',fallbackOrigin).toString();}
}
