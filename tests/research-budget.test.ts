import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ResearchBudget } from '../src/research-budget.js';
import { sourceDirectory, freezeGuide } from '../src/assessment-playbook.js';
test('all phases and retry attempts share one model-call allowance',()=>{
 const budget=new ResearchBudget();
 for(const count of [4,18,3,5]) {const phase={budget};for(let n=0;n<count;n++)phase.budget.consume();}
 assert.equal(budget.used,30);assert.throws(()=>budget.consume(),/budget exhausted/);assert.equal(budget.used,30);
});
test('directory covers 32 teams and frozen copies cannot modify later assignments',()=>{
 assert.equal(sourceDirectory.filter(s=>s.id.startsWith('team-')).length,32);
 const first=freezeGuide([{id:'1',team:'WSH'}]);first.sources[0].domain='changed';
 const next=freezeGuide([{id:'1',team:'WAS'}]);assert.equal(next.sources[0].domain,'nfl.com');
 assert(next.sources.some(s=>s.id==='team-WAS'));assert.equal(next.checklist.length,5);
});
