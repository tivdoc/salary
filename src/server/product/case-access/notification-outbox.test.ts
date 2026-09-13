import {it,expect} from 'vitest';
import {encryptNotification,decryptNotification} from './notification-outbox';
const message={template:'access_code' as const,channel:'email' as const,to:'synthetic@example.invalid',subject:'קוד כניסה',body:'קוד סינתטי 123456'};
it('P07 encrypts message/code and binds ciphertext to one delivery identity',()=>{
 const key=Buffer.alloc(32,3).toString('base64');const encrypted=encryptNotification(message,'delivery-A',key);
 expect(JSON.stringify(encrypted)).not.toContain('123456');expect(decryptNotification(encrypted,'delivery-A',key)).toEqual(message);
 expect(()=>decryptNotification(encrypted,'delivery-B',key)).toThrow();expect(()=>decryptNotification(encrypted,'delivery-A',Buffer.alloc(32,4).toString('base64'))).toThrow();
});
