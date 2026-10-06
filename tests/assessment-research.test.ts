import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const directory = await mkdtemp(path.join(tmpdir(),'assessment-research-'));
process.chdir(directory);
after(async () => { process.chdir(tmpdir()); await rm(directory,{recursive:true,force:true}); });
const { createSession,workspacePath } = await import('../src/store.js');
const { writeJson } = await import('../src/run-state.js');
const { assessmentContext,retryAssessmentEvidence } = await import('../src/assessments.js');
const { freezeResearchAssignment,startAssessmentResearch,recoverAssessmentResearch } = await import('../src/assessment-research.js');
const session = await createSession('nfl');
const root = workspacePath(session.id);
const { writeFile } = await import('node:fs/promises');
const stamp = new Date(Date.now()-3600000).toISOString();
await mkdir(path.join(root,'data/sleeper/123456789012345678'),{recursive:true});
await writeFile(path.join(root,'LEAGUE.md'),'League name / ID: 123456789012345678\nMy team: roster 1\n');
await writeJson(path.join(root,'data/sleeper/123456789012345678/latest.json'), {league:{league_id:'123456789012345678',sport:'nfl',season:'2026',total_rosters:1,scoring_settings:{rec:.5},roster_positions:['WR']},rosters:[{league_id:'123456789012345678',roster_id:1,players:['1'],starters:['1']}],users:[],summary:{league_id:'123456789012345678',fetched_at:stamp,week:2}});
const catalog = {fetched_at:stamp,players:{'1':{full_name:'Selected Receiver',position:'WR',team:'BUF'},'2':{full_name:'Team Quarterback',position:'QB',team:'BUF'},'3':{full_name:'Other Quarterback',position:'QB',team:'MIA'}}};
await writeJson(path.join(root,'data/sleeper/players-cache.json'),catalog);
const ctx=await assessmentContext(session);
const origin={id:'origin',scope:ctx.scope,assessments:[{player:ctx.request.players[0],league_snapshot:{ref:ctx.request.snapshot_ref},scheduled_game:{id:'game2'}}]};
const frozen=await freezeResearchAssignment(session,origin,['1']);
const guidedFrozen=structuredClone(frozen);delete frozen.guidance;
const coverage=(status='not_checked')=>['availability','practice','role','workload','teammate_context'].map(category=>({player_id:'1',category,status,finding_ids:[],capture_ids:[],limitations:['Unresolved'],questions:[]}));
process.env.RISKOS_URL='http://127.0.0.1:8099';process.env.RISKOS_TOKEN='test-token';
let submitted:any[]=[];
const originalFetch=globalThis.fetch;
after(()=>{globalThis.fetch=originalFetch;});
function mock(mode='ok'){
 submitted=[];
 globalThis.fetch=async(input:any, options:any)=>{
  const body=JSON.parse(options.body);submitted.push({url:String(input),body});
  if(mode==='offline')throw new Error('offline');
  if(mode==='invalid')return Response.json({detail:'Invalid finding'},{status:422});
  return Response.json({version:body.version,batch_id:body.batch_id,assessments:[{id:'revision',player:{id:'1'},research:{runs:[]},baseline_points_if_active:10}]});
 };
}

test('assignment freezes catalog, target games and scope; unrelated players stay excluded',async()=>{
 assert.equal(frozen.catalog.length,2);
 assert.equal(frozen.assignment.games['1'],'game2');
 const copy=structuredClone(origin);copy.assessments[0].player.team='MIA';
 await assert.rejects(freezeResearchAssignment(session,copy,['1']),/context changed/);
 const bridge=await startAssessmentResearch(frozen,session.id,randomUUID());
 origin.scope.week=3;
 assert.equal(JSON.parse(bridge.context).scope.week,2);
 assert.equal((await bridge.handle('lookup_assessment_subjects',{query:'Quarterback'})).subjects.length,1);
 mock();await bridge.finish('cancelled');
 assert.equal(submitted[0].body.scope.week,2);
 assert.equal(submitted[0].body.outcome,'cancelled');
 origin.scope.week=2;
});

test('zero findings and failed captures persist honest coverage and lifecycle',async()=>{
 mock();
 const bridge=await startAssessmentResearch(frozen,session.id,randomUUID(),async()=>{throw new Error('blocked source');});
 await assert.rejects(bridge.handle('capture_assessment_source',{url:'https://example.com/report'}),/blocked/);
 await bridge.handle('submit_assessment_evidence',{findings:[],coverage:coverage()});
 await bridge.finish('completed');
 const body=submitted.at(-1).body;
 assert.equal(body.outcome,'partial');assert.equal(body.findings.length,0);assert.equal(body.coverage.length,5);
 assert.match(body.attempts[0].error,/blocked/);
});

test('teammate captures are host-owned; unknown identities and fake quotes rejected',async()=>{
 mock();
 const text='Team Quarterback is out for this week according to the Buffalo Bills.';
 const bridge=await startAssessmentResearch(frozen,session.id,randomUUID(),async()=>({capture_id:'host',source_url:'https://buffalobills.com/news',captured_at:new Date().toISOString(),text,sha256:createHash('sha256').update(text).digest('hex')}));
 await bridge.handle('capture_assessment_source',{url:'https://buffalobills.com/news'});
 assert.equal((await bridge.handle('read_assessment_capture',{capture_id:'host',offset:0})).text,text);
 await assert.rejects(bridge.handle('read_assessment_capture',{capture_id:'unknown',offset:0}),/Invalid capture/);
 await assert.rejects(bridge.handle('read_assessment_capture',{capture_id:'host',offset:-1}),/Invalid capture/);
 const finding={id:'f',subject_id:'2',target_ids:['1'],kind:'availability',value:'out',classification:'official_statement',attributed_to:'Buffalo Bills',claim:text,excerpt:text,capture_id:'host',cause_id:'injury',game_id:'game2',event_at:null,published_at:null,timing_excerpt:null,relation:null,related_finding_id:null};
 await assert.rejects(bridge.handle('submit_assessment_evidence',{findings:[{...finding,subject_id:'3'}],coverage:coverage()}),/assignment/);
 await assert.rejects(bridge.handle('submit_assessment_evidence',{findings:[{...finding,excerpt:'fake'}],coverage:coverage()}),/quote/);
 await bridge.handle('submit_assessment_evidence',{findings:[finding],coverage:coverage()});
 assert.equal(submitted[0].body.subjects.find((s:any)=>s.id==='2').name,'Team Quarterback');
 assert.equal(submitted[0].body.documents[0].capture_id,'host');
 await bridge.finish('completed');
});

test('invalid drafts do not poison the final coverage package',async()=>{
 mock('invalid');
 const bridge=await startAssessmentResearch(frozen,session.id,randomUUID());
 await assert.rejects(bridge.handle('submit_assessment_evidence',{findings:[],coverage:coverage('made_up')}),/Invalid finding/);
 const badId=submitted[0].body.batch_id;
 const bad=JSON.parse(await readFile(path.join('.data/assessments/outbox',`${badId}.json`),'utf8'));
 assert.equal(bad.rejected,true);
 mock();await bridge.finish('failed');
 assert.equal(submitted[0].body.coverage[0].status,'not_checked');
 assert.equal(submitted[0].body.outcome,'failed');
});

test('transport failure retains package; delivery retries use v2 and same ID',async()=>{
 mock('offline');
 const bridge=await startAssessmentResearch(frozen,session.id,randomUUID());
 await assert.rejects(bridge.finish('completed'),/offline/);
 const id=submitted[0].body.batch_id;
 mock();await retryAssessmentEvidence(session);
 assert.ok(submitted.some(r=>r.body.batch_id===id&&r.url.endsWith('/v2/evidence-batches')));
 assert.ok(submitted.every(r=>!('delivered' in r.body)&&!('response' in r.body)));
});

test('startup seals interrupted journals without calling a provider or delivering automatically',async()=>{
 const id=randomUUID();
 await startAssessmentResearch(frozen,session.id,id);
 let calls=0;globalThis.fetch=async()=>{calls++;throw new Error('must not fetch');};
 await recoverAssessmentResearch();
 const j=JSON.parse(await readFile(path.join('.data/assessments/research',`${id}.json`),'utf8'));
 assert.equal(j.state,'interrupted');assert.equal(calls,0);
 const bodies=await Promise.all((await readdir('.data/assessments/outbox')).map(async f=>JSON.parse(await readFile(path.join('.data/assessments/outbox',f),'utf8'))));
 assert.ok(bodies.some(b=>b.run_id===id&&b.outcome==='interrupted'&&!b.delivered));
 const count=bodies.length;await recoverAssessmentResearch();
 assert.equal((await readdir('.data/assessments/outbox')).length,count);
});

test('guided searches freeze sources, build scoped queries, enforce fallback and two searches per stage',async()=>{
 mock();const urls:string[]=[];
 const bridge=await startAssessmentResearch(guidedFrozen,session.id,randomUUID(),undefined,async url=>{urls.push(url);return {text:'discovery only'};});
 const context=JSON.parse(bridge.context);
 assert.equal(context.guidance.playbook_version,'nfl-research-1.0.0');
 assert(context.guidance.sources.some((s:any)=>s.id==='team-BUF'));
 assert(!context.guidance.sources.some((s:any)=>s.id==='team-MIA'));
 const args={player_id:'1',categories:['availability','practice'],stage:'preferred',terms:'injury practice status',reason:'Check the current official report'};
 await assert.rejects(bridge.handle('search_assessment_sources',{...args,stage:'wider'}),/preferred/);
 await bridge.handle('search_assessment_sources',args);
 assert.match(decodeURIComponent(urls[0]),/Selected Receiver.*BUF.*2026 week 2/);
 assert.match(decodeURIComponent(urls[0]),/site:buffalobills.com/);
 await bridge.handle('search_assessment_sources',{...args,terms:'latest practice report'});
 await assert.rejects(bridge.handle('search_assessment_sources',args),/budget/);
 await bridge.handle('search_assessment_sources',{...args,stage:'wider',reason:'Official report did not resolve the current status'});
 assert(!decodeURIComponent(urls.at(-1)!).includes('site:'));
 await assert.rejects(bridge.handle('search_assessment_sources',{...args,player_id:'3'}),/Invalid/);
 await bridge.finish('completed');
 assert.equal(submitted.at(-1).body.version,'2.1');
 assert.equal(submitted.at(-1).body.guidance.activity.length,3);
});

test('source reviews distinguish discovered reporters and resist deceptive domain matches',async()=>{
 mock();const text='Selected Receiver is expected to receive more targets, according to Reporter One.';
 const bridge=await startAssessmentResearch(guidedFrozen,session.id,randomUUID(),async()=>({capture_id:'new',source_url:'https://buffalobills.com.example.org/report',captured_at:new Date().toISOString(),text,sha256:createHash('sha256').update(text).digest('hex')}));
 await bridge.handle('capture_assessment_source',{url:'https://buffalobills.com.example.org/report'});
 const review=await bridge.handle('review_assessment_source',{capture_id:'new',author:'Reporter One',basis:'expectation',rationale:'A named reporter’s prediction, not an official workload announcement.'});
 assert.equal(review.directory_entry_id,null);
 await assert.rejects(bridge.handle('review_assessment_source',{capture_id:'fake',author:'Reporter',basis:'original',rationale:'Unknown capture'}),/Invalid/);
 await bridge.finish('completed');
 assert.equal(submitted.at(-1).body.guidance.source_reviews[0].basis,'expectation');
});

test('failed search is durable and consumes its attempt without fabricating an answer',async()=>{
 mock();const run=randomUUID();
 const bridge=await startAssessmentResearch(guidedFrozen,session.id,run,undefined,async()=>{throw new Error('search unavailable');});
 await assert.rejects(bridge.handle('search_assessment_sources',{player_id:'1',categories:['role'],stage:'preferred',terms:'coach role',reason:'Look for original interview'}),/unavailable/);
 await bridge.finish('failed','search unavailable');
 assert.match(submitted.at(-1).body.guidance.activity[0].error,/unavailable/);
 assert.equal(submitted.at(-1).body.guidance.stop_reason,'search unavailable');
 assert.equal(submitted.at(-1).body.findings.length,0);
});

test('old frozen assignments still produce version 2.0 outbox packages',async()=>{
 mock();const old={...frozen};delete old.guidance;
 const bridge=await startAssessmentResearch(old,session.id,randomUUID());await bridge.finish('completed');
 assert.equal(submitted.at(-1).body.version,'2.0');assert.equal(submitted.at(-1).body.guidance,undefined);
});


test('guided submission requires a disposition for every question, including zero findings',async()=>{
 mock();const bridge=await startAssessmentResearch(guidedFrozen,session.id,randomUUID());
 await assert.rejects(bridge.handle('submit_assessment_evidence',{findings:[],coverage:coverage(),answers:[]}),/every checklist question/);
 const answers=coverage().map(c=>({player_id:c.player_id,category:c.category,answer:null,stop_reason:'not_checked'}));
 await bridge.handle('submit_assessment_evidence',{findings:[],coverage:coverage(),answers});
 assert.equal(submitted.at(-1).body.version,'2.1');assert.equal(submitted.at(-1).body.guidance.checklist.length,5);
 await bridge.finish('completed');
});

test('guided interrupted search recovers coverage and pending delivery without research calls',async()=>{
 mock();const id=randomUUID();const bridge=await startAssessmentResearch(guidedFrozen,session.id,id,undefined,async()=>({text:'No supported answer'}));
 await bridge.handle('search_assessment_sources',{player_id:'1',categories:['practice'],stage:'preferred',terms:'practice report',reason:'Check current practice'});
 await recoverAssessmentResearch();
 const journal=JSON.parse(await readFile(path.resolve('.data/assessments/research',id+'.json'),'utf8'));
 assert.equal(journal.state,'interrupted');assert.equal(journal.guidance.stop_reason,'interrupted');
 assert.equal(journal.coverage.find((c:any)=>c.category==='practice').status,'unresolved');assert.equal(submitted.length,0);
 await retryAssessmentEvidence(session);
 assert(submitted.some(s=>s.body.run_id===id && s.body.version==='2.1' && s.url.endsWith('/v2/evidence-batches')));
});
