import { readFile, writeFile } from 'node:fs/promises';
import { gradeFixture, summarizeResearch } from '../src/research-quality.js';

const [packageFile, fixtureFile, outputFile] = process.argv.slice(2);
if (!packageFile || !fixtureFile || !outputFile) {
  throw new Error('Usage: npm run research:grade -- PACKAGE FIXTURE_OR_AUDIT_JSON OUTPUT_JSON (audit JSON is an events array)');
}
const pkg = JSON.parse(await readFile(packageFile,'utf8'));
const reference = JSON.parse(await readFile(fixtureFile,'utf8'));
const result = Array.isArray(reference) ? summarizeResearch(pkg, reference) : gradeFixture(reference, pkg);
await writeFile(outputFile, JSON.stringify(result,null,2)+'\n', {flag:'wx',mode:0o600});
console.log(JSON.stringify(result,null,2));
if ('pass' in result && !result.pass) process.exitCode = 1;
