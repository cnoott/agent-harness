/** Read-only audit export. No research, delivery, model calls or database writes. */
import {DatabaseSync} from 'node:sqlite';
import {mkdir,readFile,readdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {summarizeResearch,contentHash} from '../src/research-quality.js';

const [dataRoot,chatId,runId,output]=process.argv.slice(2);
if(!dataRoot || !output || !/^[a-f0-9-]{36}$/.test(chatId ?? '') || !/^[a-f0-9-]{36}$/.test(runId ?? ''))
  throw new Error('Usage: npm run research:inspect -- DATA_ROOT CHAT_ID RUN_ID NEW_OUTPUT_DIR');
const db=new DatabaseSync(path.resolve(dataRoot,'sessions',chatId,'history.sqlite'),{readOnly:true});
let events;
try {events=db.prepare('SELECT kind,data,created_at FROM events WHERE run_id=? ORDER BY id').all(runId).map(row=>({kind:String(row.kind),data:JSON.parse(String(row.data)),created_at:row.created_at}));}
finally {db.close();}
if(!events.length)throw new Error('Run audit not found');
const outbox=path.resolve(dataRoot,'assessments/outbox');
const packages=[];
for(const name of await readdir(outbox)){
  if(!name.endsWith('.json'))continue;
  const pkg=JSON.parse(await readFile(path.join(outbox,name),'utf8'));if(pkg.run_id===runId)packages.push(pkg);
}
packages.sort((a,b)=>Date.parse(a.completed_at)-Date.parse(b.completed_at));
const pkg=[...packages].reverse().find(p=>!p.rejected);
if(!pkg)throw new Error('No saved non-rejected package; wait for finalization');
const report={...summarizeResearch(pkg,events),package_sha256:contentHash(JSON.stringify(pkg)),package_count:packages.length,rejected_packages:packages.filter(p=>p.rejected).length};
const review={version:'1.0',run_id:runId,package_sha256:report.package_sha256,reviewer:null,reviewed_at:null,
  findings:(pkg.findings ?? []).map((f:any)=>({finding_id:f.id,verdict:null,source_id:f.capture_id,identity_correct:null,classification_correct:null,timing_supported:null,excerpt_supports_claim:null,reason:null})),
  checklist:(pkg.coverage ?? []).map((c:any)=>({player_id:c.player_id,category:c.category,verdict:null,missed_source_url:null,reason:null})),
  verdict_options:['correct','unsupported','missed_supported_answer','justified_unknown','not_checked','not_reviewed'],
  limitations:['Review against frozen captures. An answer found later on the web is not proof it was available when this run started.','This is a quality review, not forecast validation.']};
await mkdir(output,{recursive:false});
for(const [name,value] of Object.entries({report,review,package:pkg,audit:events}))await writeFile(path.join(output,name+'.json'),JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify(report,null,2));
