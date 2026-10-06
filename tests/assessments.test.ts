import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const directory = await mkdtemp(path.join(tmpdir(), 'harness-assessments-'));
process.chdir(directory);
after(async () => { process.chdir(tmpdir()); await rm(directory, { recursive: true, force: true }); });
const { createSession, workspacePath } = await import('../src/store.js');
const { assessmentContext, readAssessments, refreshAssessments, evidenceBridge, assessmentTool } = await import('../src/assessments.js');
const { publicAddress, capturePublicSource } = await import('../src/assessment-sources.js');
const session = await createSession('nfl');
const root = workspacePath(session.id);
const leagueId = '123456789012345678';
const folder = path.join(root, 'data/sleeper', leagueId);
await mkdir(folder, { recursive: true });
await writeFile(path.join(root, 'LEAGUE.md'), `League name / ID: ${leagueId}\nMy team: roster 1\n`);
const stamp = '2026-09-14T01:00:00Z';
await writeFile(path.join(folder,'latest.json'), JSON.stringify({ league: { league_id: leagueId, sport:'nfl', season:'2026', total_rosters:1, scoring_settings:{rec:.5}, roster_positions:['WR','BN'] }, rosters:[{league_id:leagueId,roster_id:1,players:['1'],starters:['1']}], users:[], summary:{league_id:leagueId,fetched_at:stamp,week:2} }));
await writeFile(path.join(root,'data/sleeper/players-cache.json'),JSON.stringify({fetched_at:stamp,players:{'1':{full_name:'Test Player',position:'WR',team:'BUF'},'2':{full_name:'Selected Alternative',position:'RB',team:'MIA'}}}));
process.env.RISKOS_URL='http://127.0.0.1:8099'; process.env.RISKOS_TOKEN='private-test-credential';

test('context is scoped, roster plus individual alternatives; rejects NBA and paths', async () => {
  const context=await assessmentContext(session,['2']);
  assert.deepEqual(context.request.players.map(p=>p.id),['1','2']);
  assert.equal(context.request.scope.week,2);
  assert.deepEqual(context.request.scoring_settings,{rec:.5});
  await assert.rejects(assessmentContext({...session,workspaceId:'nba'}),/not supported/);
  await assert.rejects(assessmentContext(session,['../../secret']),/valid player/);
  await assert.rejects(assessmentContext(session,['missing']),/missing/);
});

test('refresh has no model calls, caches original results and timestamp on failure; evidence captures are host-owned', async () => {
  const original=globalThis.fetch;
  const context=await assessmentContext(session);
  const saved={id:'a',run_id:'r',scope:context.scope,player:context.request.players[0],as_of:stamp,baseline_points_if_active:4.5,forecast:{version:'1.0',status:'ready',points_if_playing:5.1,calculated_at:stamp},factors:{evidence_gaps:[]},sources:[],changes:[],evidence:[]};
  let fail=false, requests=0, submitted:any;
  globalThis.fetch=async(input:any,options:any)=>{
    requests++;
    assert.ok(String(input).startsWith(process.env.RISKOS_URL!));
    assert.equal(options.headers.Authorization,'Bearer private-test-credential');
    if(fail) throw new Error('service unavailable');
    const url=String(input);
    if(url.endsWith('/v1/evidence-batches')) { submitted=JSON.parse(options.body); return Response.json({assessments:[{...saved,id:'revision'}]}); }
    if(url.includes('/v1/assessment-runs'))return Response.json({id:'r',status:options.body?'queued':'completed',scope:context.scope});
    return Response.json({assessments:[saved]});
  };
  try {
    await refreshAssessments(session,[]);
    const ready=await readAssessments(session); assert.equal(ready.assessments[0].as_of,stamp);
    assert.deepEqual((await assessmentTool(session,{player_ids:[]})).assessments[0].forecast,saved.forecast);
    assert.deepEqual((await assessmentTool(session,{player_ids:['1']})).assessments[0].forecast,saved.forecast);
    fail=true;
    const offline=await readAssessments(session); assert.equal(offline.offline,true); assert.deepEqual(offline.assessments,ready.assessments);
    fail=false;
    const text='Test Player is out this week with an ankle injury.';
    const doc={capture_id:'trusted',source_url:'https://nfl.com/news/fixture',captured_at:stamp,text,sha256:createHash('sha256').update(text).digest('hex')};
    const bridge=evidenceBridge(session,'research-id','r',['1'],async()=>doc);
    await bridge('capture_assessment_source',{url:doc.source_url});
    const finding={player_id:'1',capture_id:'trusted',excerpt:text,effective_at:stamp,kind:'availability',value:'out',claim:text,cause_id:'ankle',source_type:'official'};
    await assert.rejects(bridge('submit_assessment_evidence',{findings:[{...finding,capture_id:'invented'}]}),/captures/);
    await assert.rejects(bridge('submit_assessment_evidence',{findings:[{...finding,player_id:'2'}]}),/assigned/);
    await assert.rejects(bridge('submit_assessment_evidence',{findings:[{...finding,excerpt:'invented quote'}]}),/excerpt/);
    await bridge('submit_assessment_evidence',{findings:[finding]});
    assert.equal(submitted.run_id,'research-id'); assert.deepEqual(submitted.documents,[doc]); assert.deepEqual(submitted.scope,context.scope);
    const outbox=JSON.parse(await readFile(path.join(directory,'.data/assessments/outbox',submitted.batch_id+'.json'),'utf8'));
    assert.equal(outbox.delivered,true);
    assert.equal(outbox.response.assessments[0].id,'revision');
    assert.ok(requests>=4);
  }finally{globalThis.fetch=original;}
});

test('capture rejects private addresses and non-public URLs', async()=>{
  for(const address of ['127.0.0.1','10.0.0.1','172.16.1.1','192.168.1.1','169.254.169.254','::1','::ffff:127.0.0.1','100.64.0.1']) assert.equal(publicAddress(address),false,address);
  assert.equal(publicAddress('8.8.8.8'),true);
  for(const url of ['file:///etc/passwd','http://nfl.com','https://127.0.0.1/','https://nfl.com:8443/','https://secret@nfl.com/']) await assert.rejects(capturePublicSource(url));
});

test('lost refresh response reuses the durable request ID', async () => {
  const original=globalThis.fetch; const ids:string[]=[];
  globalThis.fetch=async (_input:any, options:any)=>{
    const request=JSON.parse(options.body); ids.push(request.request_id);
    if(ids.length===1) throw new Error('connection lost after acceptance');
    return Response.json({id:'recovered-run',status:'completed',scope:request.scope});
  };
  try {
    await assert.rejects(refreshAssessments(session,[]),/connection lost/);
    assert.equal((await refreshAssessments(session,[])).runId,'recovered-run');
    assert.equal(ids[0],ids[1]);
  }finally{globalThis.fetch=original;}
});
