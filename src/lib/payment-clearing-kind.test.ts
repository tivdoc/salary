import {it,expect} from 'vitest';
import {validateInvoice4uClearingLog} from './payment-verification';
// Synthetic rows shaped from the supplier's current Clearing Logs reference.
const charge={Amount:9.99,Currency:1,CurrencyName:'ILS',LogType:2,TransactionType:0,IsCredit:false,CreditedTransaction:false,CreditAmount:0,IsSuccess:true,PaymentId:'synthetic-payment',Id:123,ClearingConfirmationNumber:'synthetic-confirmation'};
it.each([{IsCredit:true},{TransactionType:6},{TransactionType:1},{LogType:1},{CreditedTransaction:true},{CreditAmount:1}])('does not authorize a purchase from non-charge or already-credited evidence %j',change=>{
 expect(()=>validateInvoice4uClearingLog({...charge,...change},'123')).toThrow();
});
it('accepts documented NIS currency 1 without a legacy CurrencyName field',()=>{
 const {CurrencyName,...native}=charge;void CurrencyName;expect(validateInvoice4uClearingLog(native,'123')).toMatchObject({currency:'ILS',amount:9.99});
});
it('rejects conflicting numeric currency even if the legacy name says ILS',()=>{
 expect(()=>validateInvoice4uClearingLog({...charge,Currency:2},'123')).toThrow();
});
it.each([{IsCredit:'false'},{IsCredit:null},{TransactionType:'0'},{TransactionType:99},{LogType:null}])('refuses malformed charge markers %j',change=>{
 expect(()=>validateInvoice4uClearingLog({...charge,...change},'123')).toThrow('transaction_not_charge');
});
it.each([null,-1,'unknown',0.001])('holds ambiguous credited amount %s for reconciliation',CreditAmount=>{
 expect(()=>validateInvoice4uClearingLog({...charge,CreditAmount},'123')).toThrow('transaction_requires_reconciliation');
});
it.each([0,2,3,4,5,7,8])('accepts documented monetary transaction type %i with uncredited successful charge evidence',TransactionType=>{
 expect(validateInvoice4uClearingLog({...charge,TransactionType},'123').amount).toBe(9.99);
});
it.each([{Currency:null},{Currency:0},{Currency:3},{CurrencyName:'USD'},{CurrencyName:null}])('refuses malformed or conflicting currency %j',change=>{
 expect(()=>validateInvoice4uClearingLog({...charge,...change},'123')).toThrow('currency_mismatch');
});
