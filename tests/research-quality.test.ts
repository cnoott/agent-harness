import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile,readdir} from 'node:fs/promises';
import {gradeFixture,contentHash,summarizeResearch} from '../src/research-quality.js';
import {categories} from '../src/assessment-playbook.js';

const root=new URL('./fixtures/research-quality/',import.meta.url);
function correctPackage(spec:any){
  const findings=spec.expected.map((e:any,i:number)=>({...e,id:`f${i}`,target_ids:[spec.target.id],capture_id:e.source_id}));
  return {findings,documents:spec.sources.map((s:any)=>({capture_id:s.id,source_url:s.url,text:s.text,sha256:contentHash(s.text)})),coverage:categories.map(category=>({player_id:spec.target.id,category,status:category===spec.category?spec.status:'not_checked',finding_ids:category===spec.category?findings.map((f:any)=>f.id):[]}))};
}
for(const file of await readdir(root)){
  const spec=JSON.parse(await readFile(new URL(file,root),'utf8'));
  test(`quality rubric: ${spec.id} accepts exact evidence and rejects false completeness`,()=>{
    const pkg=correctPackage(spec);assert.equal(gradeFixture(spec,pkg).pass,true);
    pkg.coverage.find(c=>c.category!==spec.category)!.status='supported';
    assert.equal(gradeFixture(spec,pkg).pass,false);
  });
}
test('missing known evidence, wrong attribution class, duplicate reports and fake captures fail',async()=>{
  const spec=JSON.parse(await readFile(new URL('official-status.json',root),'utf8'));
  const original=correctPackage(spec);
  const missing=structuredClone(original);missing.findings=[];assert.equal(gradeFixture(spec,missing).missed,1);
  for(const key of ['subject_id','classification','excerpt','value']){
    const wrong=structuredClone(original);wrong.findings[0][key]='incorrect';assert.equal(gradeFixture(spec,wrong).pass,false);
  }
  const fabricated=structuredClone(original);fabricated.documents[0].text='Not the captured source';assert.equal(gradeFixture(spec,fabricated).pass,false);
  const duplicate=structuredClone(original);duplicate.findings.push({...duplicate.findings[0],id:'duplicate'});assert.equal(gradeFixture(spec,duplicate).duplicates,1);assert.equal(gradeFixture(spec,duplicate).pass,false);
  const missingReference=structuredClone(original);missingReference.coverage[0].finding_ids=['missing'];assert.equal(gradeFixture(spec,missingReference).pass,false);
});
test('teammate report must not claim target absence',async()=>{
  const spec=JSON.parse(await readFile(new URL('teammate.json',root),'utf8'));const pkg=correctPackage(spec);
  pkg.findings[0].subject_id=spec.target.id;assert.equal(gradeFixture(spec,pkg).pass,false);
});
test('host summary preserves failed/undelivered reports without inventing acceptance or cost',()=>{
  const pkg={run_id:'r',outcome:'failed',findings:[{}],documents:[],attempts:[{error:'blocked'}],guidance:{activity:[{kind:'search',stage:'wider'}],stop_reason:'budget'}};
  const events=[{kind:'model_start',data:{}},{kind:'tool_start',data:{}},{kind:'run_end',data:{durationMs:500,stats:{inputTokens:100}}}];
  const result=summarizeResearch(pkg,events);
  assert.equal(result.accepted_findings,null);assert.equal(result.cost_usd,null);assert.equal(result.review.status,'pending');
  assert.equal(result.model_calls,1);assert.equal(result.capture_failures,1);assert.equal(result.elapsed_ms,500);
  assert.equal(summarizeResearch({...pkg,delivered:true},events).accepted_findings,1);
});
