import {it,expect} from 'vitest';
import {EXTERNAL_MEASUREMENT_ENABLED,safeMeasurementUrl} from './measurement-policy';
it('closes inherited measurement until consent/private-surface isolation exists',()=>{expect(EXTERNAL_MEASUREMENT_ENABLED).toBe(false);});
it('drops tokens, private case paths and untrusted origins from measurement URLs',()=>{expect(safeMeasurementUrl('https://attacker.invalid/case/secret?payment_return=token')).toBe('https://tivdoc.com/');expect(safeMeasurementUrl('https://tivdoc.com/check?email=private@example.invalid')).toBe('https://tivdoc.com/check');});
