/** Isolated benchmark. Synthetic sources never reach the real RiskOS service. */
import 'dotenv/config';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { freezeGuide, categories, playbookInstructions, assessmentEvidenceInstructions } from '../src/assessment-playbook.js';
import { contentHash, gradeFixture, type QualityCase } from '../src/research-quality.js';
import { ResearchBudget } from '../src/research-budget.js';

const [mode, caseName] = process.argv.slice(2);
if (!['--replay','--model'].includes(mode) || !/^[a-z-]+$/.test(caseName ?? ''))
  throw new Error('Usage: npm run research:benchmark -- --replay|--model CASE. --model makes paid calls; --replay only tests the fixture plumbing.');
const spec: QualityCase = JSON.parse(await readFile(path.resolve('tests/fixtures/research-quality',caseName+'.json'),'utf8'));
const root = path.resolve('.data/research-quality',`${caseName}-${randomUUID()}`);
await mkdir(root,{recursive:true});
process.chdir(root); // Before importing modules that freeze data-root paths.
let latest: any;
const receiptServer = createServer(async (req,res) => {
  if (req.url !== '/v2/evidence-batches' || req.method !== 'POST') { res.writeHead(404).end(); return; }
  const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
  latest=JSON.parse(Buffer.concat(chunks).toString());
  res.setHeader('Content-Type','application/json');
  res.end(JSON.stringify({batch_id:latest.batch_id,assessments:[]}));
});
await new Promise<void>(resolve => receiptServer.listen(0,'127.0.0.1',resolve));
process.env.RISKOS_URL=`http://127.0.0.1:${(receiptServer.address() as any).port}`;
process.env.RISKOS_TOKEN='isolated-fixture-receipt-only';
try {
  const {createSession,saveSession}=await import('../src/store.js');
  const {startAssessmentResearch,researchEvidenceTools}=await import('../src/assessment-research.js');
  const session=await createSession('nfl'), runId=randomUUID(), now=new Date().toISOString();
  const frozen={scope:{sport:'nfl',provider:'sleeper',league_id:'fixture',season:2026,week:2},assessment_run_id:randomUUID(),
    assignment:{target_ids:[spec.target.id],snapshot_ref:'synthetic-fixture',catalog_ref:contentHash(JSON.stringify([spec.target,spec.teammate])),catalog_observed_at:now,started_at:now,games:{[spec.target.id]:'fixture-week-2'}},
    catalog:[spec.target,spec.teammate],guidance:freezeGuide([spec.target]),saved_assessments:[]};
  const bridge=await startAssessmentResearch(frozen,session.id,runId,async url=>{
    const source=spec.sources.find(s=>s.url===url);if(!source)throw new Error('Source unavailable in frozen fixture');
    return {capture_id:source.id,source_url:source.url,text:source.text,sha256:contentHash(source.text),captured_at:new Date().toISOString()};
  },async url=>{
    const preferred=new URL(url).searchParams.get('q')?.includes('site:');
    return {text:'Synthetic discovery leads only. Capture the original page.',results:spec.sources.filter(s=>!preferred || s.stage==='preferred').map(s=>({url:s.url,title:'Player report'}))};
  });
  const started=Date.now();let failure:string|undefined;let stats:any=null;let calls=0;
  try {
    if(mode==='--replay') {
      await bridge.handle('search_assessment_sources',{player_id:spec.target.id,categories:[spec.category],stage:'preferred',terms:'latest report',reason:'Initial official check'});
      if(spec.sources.some(s=>s.stage==='wider'))await bridge.handle('search_assessment_sources',{player_id:spec.target.id,categories:[spec.category],stage:'wider',terms:'original report',reason:'Preferred sources did not answer the question'});
      for(const source of spec.sources){
        await bridge.handle('capture_assessment_source',{url:source.url});
        await bridge.handle('review_assessment_source',{capture_id:source.id,author:source.author,basis:source.basis,rationale:'Controlled fixture source attribution'});
      }
      const findings=spec.expected.map((e,i)=>({id:`finding-${i}`,subject_id:e.subject_id,target_ids:[spec.target.id],kind:e.kind,value:e.value,classification:e.classification,attributed_to:spec.sources.find(s=>s.id===e.source_id)!.author,claim:e.excerpt,excerpt:e.excerpt,capture_id:e.source_id,cause_id:'fixture-event',game_id:'fixture-week-2',event_at:null,published_at:null,timing_excerpt:null,relation:null,related_finding_id:null}));
      await bridge.handle('submit_assessment_evidence',{findings,coverage:categories.map(category=>({player_id:spec.target.id,category,status:category===spec.category?spec.status:'not_checked',finding_ids:category===spec.category?findings.map(f=>f.id):[],capture_ids:category===spec.category?spec.sources.map(s=>s.id):[],limitations:['Synthetic fixture; publication times unknown'],questions:[]})),answers:categories.map(category=>({player_id:spec.target.id,category,answer:category===spec.category&&findings.length?findings.map(f=>f.claim).join(' '):null,stop_reason:category!==spec.category?'not_checked':spec.status==='supported'?'answered':spec.status==='conflicting'?'conflicting':'unknown'}))});
    } else {
      const {runResearchTurn,emptyRunStats}=await import('../src/agent.js');
      const prompt='Research Alex Sample for Week 2. Check all five categories. This is a synthetic evaluation: use only the supplied discovery and capture tools. Save a structured report; do not infer status from silence.';
      session.messages.push({id:randomUUID(),role:'user',text:prompt,createdAt:now});await saveSession(session);
      stats=emptyRunStats();const budget=new ResearchBudget(30);
      try {await runResearchTurn(session,prompt,()=>{}, {cancelled:false,controller:new AbortController()},stats,{runId,allowedTools:[],extraTools:researchEvidenceTools,toolHandler:bridge.handle,sharedContext:`${playbookInstructions} Frozen assignment: ${bridge.context}`,context:async()=>assessmentEvidenceInstructions,skipMemory:true,modelBudget:budget,maxSteps:30,maxRuntimeMs:8*60_000});}
      finally {calls=budget.used;}
    }
  } catch(error){failure=String(error);}
  await bridge.finish(failure?'failed':'completed',failure);
  await writeFile('package.json',JSON.stringify(latest,null,2)+'\n');
  const result={...gradeFixture(spec,latest),execution:mode,transport:'local receipt stub; not RiskOS acceptance',elapsed_ms:Date.now()-started,model_calls:calls,stats,failure:failure??null};
  await writeFile('result.json',JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify({root,...result},null,2));if(!result.pass || failure)process.exitCode=1;
} finally {receiptServer.closeAllConnections();await new Promise<void>((resolve,reject)=>receiptServer.close(e=>e?reject(e):resolve()));}
