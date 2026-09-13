import {OrderPurchase} from '@/components/case/order-purchase';
import {requireVerifiedFunnelCase} from '@/server/product/case-access/funnel-guard';
import {guardStableAppEntrypoint} from '@/server/platform/capabilities/stable-next-entrypoint';
export default async function PaymentPage(){await guardStableAppEntrypoint("CEP-004");await requireVerifiedFunnelCase();return <OrderPurchase initial/>;}
