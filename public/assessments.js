const panel = document.querySelector('#player-assessments');
const list = document.querySelector('#assessments-list');
const status = document.querySelector('#assessments-status');
const error = document.querySelector('#assessments-error');
const refresh = document.querySelector('#assessments-refresh');
let chatId = null, data = null, busy = false, loading = false, generation = 0, timer;
let selected = new Map();
const el = (tag, text, className = '') => { const node = document.createElement(tag); node.textContent = text; node.className = className; return node; };
const num = value => value == null ? 'Unavailable' : Number(value).toFixed(2);
const date = value => value ? new Date(value).toLocaleString() : 'Unknown';
const label = value => String(value || 'unknown').replaceAll('_', ' ');
const active = () => ['queued', 'running'].includes(data?.status);
function controls() { document.querySelector('#assessments-retry-evidence').disabled = !chatId || busy || loading || active(); refresh.disabled = !chatId || busy || loading || active(); panel.querySelectorAll('[data-research]').forEach(b => b.disabled = busy || active()); }
function draft(a, research) {
  if (busy || !chatId) return;
  const text = research
    ? `Research current availability and workload concerns for ${a.player.name} (Sleeper ${a.player.id}) for NFL ${a.scope.season}, week ${a.scope.week}. Use the assessment source capture and evidence submission tools to save supported findings for assessment run ${a.run_id}. Include relevant teammate news. Save official statements and attributed expectations separately, plus coverage and unanswered questions even when there are no findings. Keep unsupported or conflicting claims unresolved; do not adjust numerical points.`
    : `Discuss the saved assessment ${a.id} for ${a.player.name} (Sleeper ${a.player.id}), NFL ${a.scope.season} week ${a.scope.week}. Read it with get_player_assessments and explain its baseline if active, experimental forecast if playing when available, variability, evidence and missing inputs. Keep participation uncertainty separate from the conditional forecast. Do not start new research unless I request it.`;
  document.dispatchEvent(new CustomEvent('roster-chat-draft', { detail: { chatId, text, ...(research ? { assessmentResearch: { runId: a.run_id, playerIds: [a.player.id] } } : {}) } }));
}
function table(headings, rows) {
  const wrap = el('div', '', 'assessment-table'); const t = document.createElement('table');
  const head = document.createElement('tr'); headings.forEach(h => head.append(el('th', h))); const thead = document.createElement('thead'); thead.append(head); t.append(thead);
  const body = document.createElement('tbody'); rows.forEach(row => { const tr = document.createElement('tr'); row.forEach(v => tr.append(el('td', String(v ?? 'Unavailable')))); body.append(tr); }); t.append(body); wrap.append(t); return wrap;
}
function render() {
  const opened = new Set([...list.querySelectorAll('details[open]')].map(d => d.dataset.player));
  list.replaceChildren();
  const selectedBox = document.querySelector('#assessments-selected'); selectedBox.replaceChildren();
  if (selected.size) {
    selectedBox.append(el('p', 'Selected alternatives · included on next refresh', 'workspace-copy'));
    for (const [id, name] of selected) { const b = el('button', `${name} ×`, 'secondary'); b.type = 'button'; b.setAttribute('aria-label', `Remove ${name} from assessment selection`); b.onclick = () => { selected.delete(id); render(); }; selectedBox.append(b); }
  }
  error.textContent = [data?.error, data?.pending_evidence?.length ? `${data.pending_evidence.length} saved research package(s) await delivery. Use Retry saved evidence delivery; this makes no AI calls.` : ''].filter(Boolean).join(' ');
  status.textContent = data ? `NFL ${data.scope.season} · Week ${data.scope.week} · ${active() ? 'Refreshing; previous results remain below.' : data.offline ? 'Service unavailable; showing saved results.' : label(data.status || 'Saved assessments')} · ${data.assessments.length} saved players` : 'Your roster is assessed by default. Add individual alternatives from Teams or Waivers.';
  const rosterIds = new Set((data?.roster || []).map(p => p.id));
  const assessments = (data?.assessments || []).filter(a => rosterIds.has(a.player.id) || selected.has(a.player.id));
  for (const a of assessments) {
    const detail = document.createElement('details'); detail.className = 'assessment-card'; detail.dataset.player = a.player.id; detail.open = opened.has(a.player.id);
    const summary = document.createElement('summary'); summary.append(el('strong', `${a.player.name} · ${a.player.position}`));
    summary.append(el('span', a.state === 'unsupported_position' ? 'Not supported yet' : `${num(a.baseline_points_if_active)} baseline points if active`, 'assessment-baseline'));
    if (a.forecast?.status === 'ready' && !['bye', 'confirmed_absent'].includes(a.participation)) summary.append(el('span', `${num(a.forecast.points_if_playing)} experimental forecast if playing`, 'assessment-baseline'));
    summary.append(el('span', `${label(a.participation)} · ${num(a.historical_standard_deviation)} historical SD · ${a.sample_size} games`, 'workspace-copy'));
    const concerns = [...(a.missing_inputs || []), ...(a.factors?.evidence_gaps || []), ...(a.evidence || []).map(f => f.claim)];
    if (concerns.length) summary.append(el('span', concerns.slice(0, 2).join(' · '), 'assessment-concerns'));
    summary.append(el('small', `Assessed ${date(a.as_of)}`)); detail.append(summary);
    const body = el('div', '', 'assessment-body');
    if (['bye', 'confirmed_absent'].includes(a.participation)) body.append(el('p', 'No expected participation for this week. Historical baseline is shown for context.'));
    body.append(el('p', `${label(a.state)} · Experimental model ${a.model_version.replace('nfl-active-baseline-', '')}`, 'workspace-copy'));
    if (a.state !== 'unsupported_position') {
      const actions = el('div', '', 'assessment-actions');
      for (const [text, research] of [['Research concerns', true], ['Discuss assessment', false]]) { const b = el('button', text, 'secondary'); b.type = 'button'; b.dataset.research = 'true'; b.onclick = () => draft(a, research); actions.append(b); }
      actions.append(el('small', 'Opens a chat draft for you to send.')); body.append(actions);
    }
    if (a.missing_inputs?.length) body.append(el('p', `Missing inputs: ${a.missing_inputs.join('; ')}`));
    if (a.forecast) {
      const f = a.forecast;
      body.append(el('h4', 'Experimental forecast if playing'));
      body.append(el('p', 'Assumes participation. Does not adjust for injury, opponent, or weather.', 'workspace-copy'));
      body.append(el('p', `Forecast calculated: ${date(f.calculated_at)} · Target: ${f.target_game?.id || 'Unavailable'}`, 'workspace-copy'));
      if (f.status !== 'ready') body.append(el('p', `Unavailable: ${(f.reasons || []).join('; ')}`));
      else {
        const calc = document.createElement('details');
        calc.append(el('summary', ['bye', 'confirmed_absent'].includes(a.participation) ? 'Hypothetical calculation only · no expected participation' : 'Forecast inputs and calculation'));
        calc.append(el('p', `${num(f.features.baseline)} historical baseline + ${num(f.baseline_adjustment)} model adjustment = ${num(f.points_if_playing)} points if playing.`));
        calc.append(el('p', 'These contributions describe model arithmetic, not proof that an input caused a change in points. Historical variability is not a forecast range.'));
        calc.append(table(['Input', 'Value', 'Adjustment contribution'], Object.entries(f.features).map(([k,v])=>[label(k),num(v),num(f.adjustment_breakdown?.[k])])));
        calc.append(el('p', `Intercept contribution: ${num(f.adjustment_breakdown?.intercept)} · Model: ${f.model_version}`));
        calc.append(el('p', `Supporting games: ${(f.supporting_games || []).map(g=>g.game_id).join(', ')}`));
        calc.append(el('p', `Artifact: ${f.artifact_hash} · Scoring: ${f.scoring_hash}`, 'workspace-copy'));
        body.append(calc);
      }
      if (f.evaluation) {
        const evaluation = document.createElement('details'); evaluation.append(el('summary', 'Historical evaluation and release gate'));
        evaluation.append(el('p', '2025 retrospective analysis using corrected historical data; active-participation outcomes only. Not observation-time replay or a guarantee of future accuracy.'));
        evaluation.append(table(['Model', 'Outcomes', 'Average absolute error', 'RMSE', 'Bias'], Object.entries(f.evaluation.models).map(([k,v])=>[label(k),v.count,num(v.mae),num(v.rmse),num(v.bias)])));
        evaluation.append(el('p', `Coverage: ${(f.evaluation.coverage * 100).toFixed(1)}% · Release gate: ${f.release_gate?.passed ? 'Passed' : 'Not passed'}`)); body.append(evaluation);
      }
    }
    body.append(el('h4', 'Supporting games · newest first'));
    body.append(table(['Game', 'Offensive snaps', 'Points'], a.games.map(g => [g.game_id, g.offense_snaps, num(g.points)])));
    for (const g of a.games) {
      const calc = document.createElement('details'); calc.append(el('summary', `${g.game_id} calculation`));
      calc.append(table(['Rule', 'Statistic', 'League weight', 'Points'], Object.entries(g.contributions || {}).map(([k, v]) => [k, v.stat, v.weight, num(v.points)]))); body.append(calc);
    }
    body.append(el('p', 'Baseline: newest game has weight 1, then 0.8, 0.64, and so on, normalized across up to six games. At least three games are required.', 'workspace-copy'));
    body.append(el('h4', 'Workload changes'));
    const work = a.factors?.workload_change;
    body.append(work ? table(['Measure', 'Latest two', 'Preceding four', 'Difference'], Object.entries(work).map(([k, v]) => [label(k), num(v.latest_two), num(v.preceding_four), num(v.difference)])) : el('p', 'Six complete games are required for this comparison.'));
    body.append(el('h4', 'Research summary'));
    body.append(el('p', `Statistics calculated: ${date(a.statistics_as_of)} · Last researched: ${date(a.research?.last_researched_at)}`, 'workspace-copy'));
    if (!a.research) body.append(el('p', 'No structured research report yet. Earlier evidence remains available below.'));
    for (const run of (a.research?.runs || []).slice().reverse()) {
      const report = document.createElement('details');
      report.append(el('summary', `${label(run.outcome)} · ${date(run.completed_at)}`));
      for (const c of run.coverage) {
        const entry = el('div', '', 'assessment-coverage');
        entry.append(el('strong', `${label(c.category)} · ${{supported:'Answered',conflicting:'Conflicting',unresolved:'Unknown',not_checked:'Not checked'}[c.status] || label(c.status)}`));
        entry.append(el('p', [...c.limitations, ...c.questions].join('; ') || 'Source-linked findings saved; inspect their evidence below.'));
        const q = run.guidance?.checklist?.find(q => q.player_id === a.player.id && q.category === c.category);
        if (q) {
          entry.append(el('p', q.question));
          if (q.answer) entry.append(el('p', q.answer));
          const details = document.createElement('details'); details.append(el('summary', 'Sources and search details'));
          details.append(el('p', `Search stage: ${q.stage === 'not_started' && c.capture_ids.length ? 'Direct source check' : label(q.stage)} · Stopped: ${label(q.stop_reason || run.guidance.stop_reason || 'Partial save; no stopping reason recorded')}`));
          for (const f of run.findings || []) if (c.finding_ids.includes(f.id)) {
            details.append(el('p', `${label(f.classification)} · ${f.subject_id !== a.player.id ? 'Teammate ' + f.subject.name + ' · ' : ''}${f.claim}`), el('blockquote', f.excerpt));
            const link = el('a', `Source · ${f.attributed_to}`); if (/^https:\/\//.test(f.source_url)) link.href=f.source_url; link.target='_blank';link.rel='noopener noreferrer'; details.append(link);
            const observed = f.event_at || f.published_at;
            const timing = !observed ? 'Timing unknown' : Date.parse(a.as_of) - Date.parse(observed) > 48 * 3600000 ? 'Older context · outside 48-hour freshness window' : 'Within 48 hours of this assessment';
            details.append(el('p', `${timing} · Published: ${date(f.published_at)} · Captured: ${date(f.captured_at)}${f.relation ? ' · ' + label(f.relation) + ' of ' + f.related_finding_id : ''}`));
            if (f.source_review) details.append(el('p', `${f.source_review.directory_entry_id ? 'Preferred starting source' : 'Discovered source'} · Researcher’s assessment: ${f.source_review.rationale}`));
          }
          for (const source of run.sources || (run.attempts || []).filter(a=>a.capture_id).map(a=>({capture_id:a.capture_id,source_url:a.url,captured_at:a.at}))) if (c.capture_ids.includes(source.capture_id) && !(run.findings || []).some(f=>c.finding_ids.includes(f.id) && f.capture_id===source.capture_id)) {
            const review = run.guidance.source_reviews.find(r=>r.capture_id===source.capture_id);
            const link=el('a','Checked source');if (/^https:\/\//.test(source.source_url)) link.href=source.source_url;link.target='_blank';link.rel='noopener noreferrer';details.append(link);
            details.append(el('p', `Captured ${date(source.captured_at)} · ${review?.directory_entry_id ? 'Preferred starting source' : 'Discovered source'}${review ? ' · Researcher’s assessment: ' + review.rationale : ''}`));
          }
          for (const activity of run.guidance.activity || []) if (activity.player_id === a.player.id && activity.categories.includes(c.category)) details.append(el('p', `${label(activity.stage)} search · ${date(activity.at)} · Researcher’s reason: ${activity.reason}${activity.error ? ' · ' + activity.error : ''}`));
          entry.append(details);
        }
        report.append(entry);
      }
      if (run.guidance) {
        const inspected=document.createElement('details');inspected.append(el('summary','Sources inspected during this run'));
        inspected.append(el('p','A captured page is not automatically evidence for an answer.'));
        for (const source of run.sources || (run.attempts || []).filter(a=>a.capture_id).map(a=>({capture_id:a.capture_id,source_url:a.url,captured_at:a.at}))) {
          const link=el('a',source.source_url);if (/^https:\/\//.test(source.source_url)) link.href=source.source_url;link.target='_blank';link.rel='noopener noreferrer';inspected.append(link);
          const review=run.guidance.source_reviews.find(r=>r.capture_id===source.capture_id);
          inspected.append(el('p',`Captured ${date(source.captured_at)} · ${review?.directory_entry_id ? 'Preferred starting source' : review ? 'Discovered source' : 'Not reviewed'}${review ? ' · Researcher’s assessment: '+review.rationale : ''}`));
        }
        report.append(inspected);
      }
      for (const attempt of run.attempts || []) if (attempt.error) report.append(el('p', `Source could not be checked: ${attempt.url} · ${attempt.error}`));
      if (run.guidance) report.append(el('p', `Playbook ${run.guidance.playbook_version} · Directory ${run.guidance.directory_version} · Run stopped: ${run.guidance.stop_reason || 'Partial save'}`));
      report.append(el('small', `Research run ${run.run_id}`)); body.append(report);
    }
    body.append(el('h4', 'Evidence and concerns'));
    if (!a.evidence?.length) body.append(el('p', 'No research evidence saved. Catalog status alone is not a verified participation report.'));
    for (const f of a.evidence || []) {
      const item = el('blockquote', `${f.teammate ? 'Teammate context · ' + f.subject.name + ' · ' : ''}${label(f.classification || 'legacy_evidence')} · ${label(f.kind)} · ${f.claim}`); item.append(el('p', f.excerpt));
      const link = el('a', 'Source'); if (/^https?:\/\//.test(f.source_url)) link.href = f.source_url; link.target = '_blank'; link.rel = 'noopener noreferrer';
      if (f.classification) item.append(el('p', `Attributed to ${f.attributed_to} · ${label(f.status)} · Game ${f.game_id} · Published ${date(f.published_at)}${f.relation ? ' · ' + label(f.relation) + ' of ' + f.related_finding_id : ''}`));
      item.append(link, el('small', ` · Effective ${date(f.effective_at)} · Captured ${date(f.captured_at)} · Cause ${f.cause_id}`)); body.append(item);
    }
    for (const gap of a.factors?.evidence_gaps || []) body.append(el('p', gap, 'assessment-concerns'));
    for (const role of a.factors?.team_role_change || []) body.append(el('p', role.claim || `${role.note}: ${role.historical_team} → ${role.catalog_team}`));
    body.append(el('h4', 'Changes since previous assessment'));
    if (!a.changes?.length) body.append(el('p', 'First assessment or no material changes.'));
    for (const change of a.changes || []) {
      if (change.field === 'research') { body.append(el('p', 'Research coverage or findings updated; numerical baseline unchanged.')); }
      else if (change.field === 'forecast') { body.append(el('p', `Forecast if playing: ${num(change.before?.points_if_playing)} → ${num(change.after?.points_if_playing)}. Calculated ${date(change.after?.calculated_at)}; inspect the full change record for input revisions.`)); }
      else if (change.field === 'factors') {
        const before = change.before || {}, after = change.after || {};
        for (const key of Object.keys(after)) {
          if (JSON.stringify(before[key]) === JSON.stringify(after[key])) continue;
          const message = key === 'availability'
            ? `Availability evidence: ${before[key]?.reports?.length || 0} → ${after[key]?.reports?.length || 0} status reports; ${before[key]?.practice?.length || 0} → ${after[key]?.practice?.length || 0} practice findings.`
            : key === 'team_role_change' ? `Team/role evidence: ${before[key]?.length || 0} → ${after[key]?.length || 0} findings.`
            : key === 'evidence_gaps' ? `Evidence gaps: ${(after[key] || []).join('; ') || 'None'}` : `${label(key)} updated; current inputs are shown above.`;
          body.append(el('p', message));
        }
      } else body.append(el('p', `${label(change.field)}: ${Array.isArray(change.before) ? change.before.join('; ') : change.before ?? 'Unavailable'} → ${Array.isArray(change.after) ? change.after.join('; ') : change.after ?? 'Unavailable'}`));
    }
    if (a.changes?.length) { const audit = document.createElement('details'); audit.append(el('summary', 'Full change record'), el('pre', JSON.stringify(a.changes, null, 2))); body.append(audit); }
    const sources = document.createElement('details'); sources.append(el('summary', 'Source snapshots and freshness'), el('p', `Model ${a.model_version} · Scoring version ${a.scoring_version}`), el('p', `League snapshot ${a.league_snapshot?.ref || 'Unknown'} · Saved ${date(a.league_snapshot?.observed_at)}`));
    for (const s of a.sources || []) { const p = el('p', `Snapshot ${s.id} · Retrieved ${date(s.observed_at)} · SHA-256 ${s.digest || s.sha256}`); const link = el('a', s.url || 'Source'); if (/^https?:\/\//.test(s.url)) link.href = s.url; link.target = '_blank'; link.rel = 'noopener noreferrer'; p.append(document.createElement('br'), link); sources.append(p); } body.append(sources);
    const history = el('button', 'Earlier revisions', 'secondary'); history.type = 'button';
    const versions = el('div', '', 'assessment-history');
    history.onclick = async () => { history.disabled = true; try { const response = await fetch(`/api/chats/${chatId}/assessments/${encodeURIComponent(a.player.id)}/history`); const result = await response.json(); if (!response.ok) throw new Error(result.error || 'History unavailable'); versions.replaceChildren(); for (const v of result.history) { const entry = document.createElement('details'); entry.append(el('summary', `${date(v.as_of)} · ${num(v.baseline_points_if_active)} points if active · ${label(v.participation)}`), el('pre', JSON.stringify(v, null, 2))); versions.append(entry); } } catch (e) { versions.textContent = e.message; } finally { history.disabled = false; } };
    body.append(history, versions);
    body.append(el('small', `Assessment ${a.id} · Previous ${a.previous_id || 'none'}`)); detail.append(body); list.append(detail);
  }
  if (!assessments.length) list.append(el('p', 'Refresh to calculate your roster’s first assessment. Kicker and defense calculations are not supported yet.', 'workspace-copy'));
  controls();
}
export async function refreshAssessmentsView() {
  if (!chatId || panel.classList.contains('hidden')) return;
  const id = chatId, gen = generation;
  try { const response = await fetch(`/api/chats/${id}/assessments`, { cache: 'no-store' }); const next = await response.json(); if (gen !== generation) return; if (!response.ok) throw new Error(next.error || 'Could not read assessments'); data = next; for (const id of next.selected || []) if (!selected.has(id)) selected.set(id, next.assessments.find(a => a.player.id === id)?.player.name || id); render(); if (active()) { clearTimeout(timer); timer = setTimeout(refreshAssessmentsView, 2000); } }
  catch (e) { if (gen === generation) { error.textContent = e.message; controls(); } }
}
export function setAssessmentChat(id, sport) { generation++; clearTimeout(timer); chatId = sport === 'nfl' ? id : null; data = null; selected = new Map(); loading = false; render(); }
export function setAssessmentBusy(value) { busy = value; controls(); }
refresh.addEventListener('click', async () => {
  if (!chatId || refresh.disabled) return;
  const gen = generation; loading = true; controls(); error.textContent = ''; status.textContent = 'Starting statistical refresh; no model calls…';
  try { const response = await fetch(`/api/chats/${chatId}/assessments/refresh`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ playerIds: [...selected.keys()] }) }); const result = await response.json(); if (gen !== generation) return; if (!response.ok) throw new Error(result.error || 'Refresh failed'); data = { ...data, ...result }; await refreshAssessmentsView(); }
  catch (e) { if (gen === generation) error.textContent = e.message; }
  finally { if (gen === generation) { loading = false; controls(); } }
});
document.addEventListener('panel-change', e => { clearTimeout(timer); if (e.detail === 'assessments') void refreshAssessmentsView(); });
document.addEventListener('assessment-select-player', e => { if (e.detail.chatId !== chatId || busy) return; selected.set(e.detail.playerId, e.detail.name); render(); if (panel.classList.contains('hidden')) document.querySelector('#assessments-toggle').click(); });

document.querySelector('#assessments-retry-evidence').addEventListener('click', async () => {
  if (!chatId || busy || active()) return;
  const gen = generation;
  try { const response = await fetch(`/api/chats/${chatId}/assessments/evidence/retry`, { method: 'POST' }); const result = await response.json(); if (gen !== generation) return; if (!response.ok) throw new Error(result.error); await refreshAssessmentsView(); error.textContent = result.failures?.map(f => f.error).join('; ') || (result.delivered.length ? `Delivered ${result.delivered.length} saved evidence batches.` : 'No pending evidence for this league/week.'); }
  catch (e) { if (gen === generation) error.textContent = e.message; }
});
