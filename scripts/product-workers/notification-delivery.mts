import pg from 'pg';import {randomUUID} from 'node:crypto';
import {postgresCaseAccessDb} from '../../src/server/product/case-access/db.ts';
import {deliverNotificationOutbox,enqueueRequestReminders,enqueuePublishedReports} from '../../src/server/product/case-access/notification-outbox.ts';
import {resendProvider} from '../../src/server/product/case-access/resend-provider.ts';
if(process.env.TIVDOC_NOTIFICATION_WORKER_ENABLED!=='true')throw new Error('NOTIFICATION_WORKER_DISABLED');
const url=process.env.TIVDOC_WORKER_POSTGRES_URL,secret=process.env.TIVDOC_NOTIFICATION_ENCRYPTION_KEY,apiKey=process.env.RESEND_API_KEY,from=process.env.RESEND_FROM;
if(!url||!secret||!apiKey||!from)throw new Error('NOTIFICATION_WORKER_CONFIGURATION_MISSING');
const connection=new pg.Client({connectionString:url,connectionTimeoutMillis:15000,application_name:'tivdoc_notification_worker'});await connection.connect();
try{const store=postgresCaseAccessDb(connection);if(process.env.TIVDOC_REQUEST_REMINDER_DELIVERY_ENABLED==='true'){const origin=process.env.NEXT_PUBLIC_SITE_URL;if(!origin)throw new Error('NOTIFICATION_ORIGIN_MISSING');await enqueueRequestReminders(store,secret,origin);}if(process.env.TIVDOC_REPORT_NOTIFICATION_DELIVERY_ENABLED==='true'){const origin=process.env.NEXT_PUBLIC_SITE_URL;if(!origin)throw new Error('NOTIFICATION_ORIGIN_MISSING');await enqueuePublishedReports(store,secret,origin);}const workerId=randomUUID();let attempted=0;for(;attempted<20;attempted++){const result=await deliverNotificationOutbox(store,workerId,secret,resendProvider(apiKey,from));if(!result)break;}console.log(JSON.stringify({worker:'notification_delivery',attempted}));}finally{await connection.end();}
