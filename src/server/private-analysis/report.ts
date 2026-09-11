import 'server-only';
import {createHash} from 'node:crypto';
import {renderDeterministicRtlDocument,type RtlBlock} from '@/server/reports/deterministic-hebrew-pdf';

const plain=(s:string)=>s.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/gu,'$1 ($2)').replace(/\*\*([^*]+)\*\*/gu,'$1').replace(/`([^`]+)`/gu,'$1');
const cells=(s:string)=>s.trim().replace(/^\|/u,'').replace(/\|$/u,'').split('|').map(v=>plain(v.trim()));
/** Presentation only: every amount stays in the reviewed input text. */
export function privateMarkdownBlocks(markdown:string):RtlBlock[]{
 const lines=markdown.replaceAll('\r','').split('\n'),blocks:RtlBlock[]=[];
 for(let i=0;i<lines.length;i++){
  const line=lines[i].trim();if(!line)continue;
  const heading=/^#{1,6}\s+(.+)$/u.exec(line);
  if(heading){blocks.push({kind:'heading',level:line.startsWith('# ')?1:2,text:plain(heading[1])});continue;}
  if(/^\|/u.test(line)&&i+1<lines.length&&/^\|?[\s:|-]+\|?$/u.test(lines[i+1].trim())){
   const columns=cells(line),rows:string[][]=[];i+=2;
   while(i<lines.length&&/^\|/u.test(lines[i].trim())){const row=cells(lines[i]);if(row.length!==columns.length)throw Error('PRIVATE_REPORT_TABLE_WIDTH');rows.push(row);i++;}i--;
   blocks.push({kind:'table',columns,rows,wrap_cells:true});continue;
  }
  if(/^[-*_]{3,}$/u.test(line)){blocks.push({kind:'rule'});continue;}
  let text=line;
  while(i+1<lines.length&&lines[i+1].trim()&&!/^(#|\||[-*] |\d+\.)/u.test(lines[i+1].trim()))text+=' '+lines[++i].trim();
  blocks.push({kind:'paragraph',text:plain(text)});
 }
 return blocks;
}
const escape=(s:string)=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
export function renderPrivateOwnerReport(input:{workId:string;markdown:string;fixedDate:string}){
 if(!/^CASE-[0-9]{2,3}$/u.test(input.workId)||!/^\d{8}$/u.test(input.fixedDate)||!input.markdown.trim())throw Error('PRIVATE_REPORT_INPUT');
 const title=`${input.workId} — טיוטת בדיקה פרטית לבעלים`;
 const blocks:RtlBlock[]=[{kind:'heading',level:1,text:title},
  {kind:'paragraph',text:'בדיקת AI של עותקי המקור. טיוטה לבדיקה של הבעלים בלבד; לא נשלחה ללקוח ולא פורסמה. אין כאן חתימה אנושית או קביעת חוב מאושרת.'},...privateMarkdownBlocks(input.markdown)];
 const body=blocks.map(b=>b.kind==='heading'?`<h${b.level}>${escape(b.text)}</h${b.level}>`:b.kind==='paragraph'?`<p>${escape(b.text)}</p>`:b.kind==='rule'?'<hr>':b.kind==='hash'?`<p>${escape(b.label)} <bdi>${escape(b.value)}</bdi></p>`:
  `<table><thead><tr>${b.columns.map(c=>`<th>${escape(c)}</th>`).join('')}</tr></thead><tbody>${b.rows.map(r=>`<tr>${r.map(c=>`<td>${escape(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`).join('\n');
 const html=Buffer.from(`<!doctype html><html lang="he" dir="rtl"><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>${escape(title)}</title><style>body{font-family:Arial,sans-serif;max-width:1050px;margin:32px auto;padding:0 24px;color:#172434;line-height:1.7}h1{font-size:24px}h2{font-size:20px;margin-top:30px}p{white-space:pre-wrap;overflow-wrap:anywhere}table{border-collapse:collapse;width:100%;font-size:14px}td,th{border:1px solid #cbd5e1;padding:9px;text-align:right;vertical-align:top;overflow-wrap:anywhere}th{background:#eef2f6}bdi{direction:ltr}hr{border:0;border-top:1px solid #cbd5e1}@media print{body{margin:0}}</style><body>${body}</body></html>`,'utf8');
 const pdf=renderDeterministicRtlDocument({title,subject:'Private owner review; AI source reading; no customer publication',fixed_date:input.fixedDate,blocks});
 const sha=(v:Uint8Array|string)=>createHash('sha256').update(v).digest('hex');
 return {html,pdf,manifest:{schema_version:'private-owner-report-v1',work_id:input.workId,markdown_sha256:sha(input.markdown),html_sha256:sha(html),pdf_sha256:sha(pdf),blocks_sha256:sha(JSON.stringify(blocks)),customer_publication:false,human_approval:false}};
}
