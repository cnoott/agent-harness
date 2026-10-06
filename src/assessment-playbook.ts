/** NFL research guidance. Source preference is not a truth score. */
export const categories = ['availability', 'practice', 'role', 'workload', 'teammate_context'] as const;
export const questions = {
  availability: 'What is the latest supported game status?',
  practice: 'What participation or limitation was reported, and when?',
  role: 'Is there supported news about starting status, responsibilities, or a role change?',
  workload: 'What do saved assessments show, and is there reporting about expected usage?',
  teammate_context: 'Is there relevant same-team news that could affect this player’s opportunities?',
};
const teams: Record<string,string> = {
 ARI:'azcardinals.com',ATL:'atlantafalcons.com',BAL:'baltimoreravens.com',BUF:'buffalobills.com',CAR:'panthers.com',CHI:'chicagobears.com',CIN:'bengals.com',CLE:'clevelandbrowns.com',DAL:'dallascowboys.com',DEN:'denverbroncos.com',DET:'detroitlions.com',GB:'packers.com',HOU:'houstontexans.com',IND:'colts.com',JAX:'jaguars.com',KC:'chiefs.com',LV:'raiders.com',LAC:'chargers.com',LA:'therams.com',MIA:'miamidolphins.com',MIN:'vikings.com',NE:'patriots.com',NO:'neworleanssaints.com',NYG:'giants.com',NYJ:'newyorkjets.com',PHI:'philadelphiaeagles.com',PIT:'steelers.com',SF:'49ers.com',SEA:'seahawks.com',TB:'buccaneers.com',TEN:'tennesseetitans.com',WAS:'commanders.com',
};
const alias = (v:string) => ({WSH:'WAS',JAC:'JAX',LAR:'LA'}[v] ?? v);
export const sourceDirectory = [
 {id:'nfl-injuries',domain:'nfl.com',url:'https://www.nfl.com/injuries/',teams:[] as string[],purpose:'Official injury and practice reports'},
 ...Object.entries(teams).map(([team,domain])=>({id:`team-${team}`,domain,url:`https://www.${domain}/`,teams:[team],purpose:'Original team reports, interviews and statements; distinguish reporting and opinion'})),
 {id:'ap-nfl',domain:'apnews.com',url:'https://apnews.com/hub/nfl',teams:[] as string[],purpose:'Attributed NFL reporting'},
 {id:'espn-nfl',domain:'espn.com',url:'https://www.espn.com/nfl/',teams:[] as string[],purpose:'Attributed NFL reporting and explicitly labeled expectations'},
].map(s=>({...s,reviewed_at:'2026-09-20',directory_source:s.id.startsWith('team-')?'https://www.nfl.com/teams/':s.url}));
export type Guide = {playbook_version:string; directory_version:string; sources:typeof sourceDirectory;
 checklist:any[]; activity:any[]; source_reviews:any[]; stop_reason:string|null};
export function freezeGuide(players:any[]):Guide {
 const selectedTeams=new Set(players.map(p=>alias(p.team ?? '')));
 return {playbook_version:'nfl-research-1.0.0',directory_version:'nfl-sources-1.0.0',
  sources:structuredClone(sourceDirectory.filter(s=>!s.teams.length || s.teams.some(t=>selectedTeams.has(t)))),
  checklist:players.flatMap(p=>categories.map(category=>({player_id:p.id,category,question:questions[category],stage:'not_started',answer:null,stop_reason:null}))),
  activity:[],source_reviews:[],stop_reason:null};
}
export function sourceEntry(guide:Guide,url:string) {
 const host=new URL(url).hostname.toLowerCase();
 return guide.sources.find(s=>host===s.domain || host.endsWith(`.${s.domain}`))?.id ?? null;
}
export const playbookInstructions = `Follow the frozen NFL checklist, availability and practice first, then role, workload and teammate context. Read get_player_assessments for saved history; sports_query is optional read-only game context, not a news database. Never import missing datasets. Use search_assessment_sources for targeted discovery. It builds full-name/team/week queries and limits each question to an initial search plus one reformulation in each of preferred and wider stages. Check relevant preferred sources first. Wider searches require a missing, inaccessible, stale, unclear or conflicting answer, or tracing an original report. Stop answered questions unless there is a concrete verification need. A source can answer several questions. Capture original public pages, never search result snippets. Use review_assessment_source to explain authorship and support before submitting its findings. Preferred membership is not truth or official status: team-site predictions remain expectations. Unfamiliar identifiable firsthand reporting is acceptable with attribution; no universal second source required. Trace repeated articles to their underlying cause. Never infer health or unchanged role from silence. For each supported category supply an answer that actually answers its question, with supported findings; a mere player mention is not an answer. Save partial findings throughout using submit_assessment_evidence with checklist answers and stopping reasons. Missing answers remain unknown. All phases share 30 model calls and eight minutes. No delegation, projection, points changes or lineup advice. Finish with a research checklist summary, not a recommendation.`;

/** Shared submission guidance for the production workflow and model benchmark. */
export const assessmentEvidenceInstructions = "Use lookup_assessment_subjects for relevant teammates. Capture public sources; use read_assessment_capture to read exact bounded excerpts when capture output is truncated, then submit_assessment_evidence with all five coverage categories per selected player, even if findings are empty. Separate official_statement, attributed_reporting and attributed_expectation; attributed_to identifies the person or institution making the statement, not just the website. Exact excerpts must identify the subject's full name. Availability values: out, inactive, active, questionable, doubtful, unknown. Practice values: full, limited, did_not_participate, not_listed, unknown. Unknown event/publication times are null; known timestamps require timezone and a timing_excerpt from the source. The future game_id is separate from observation times. Do not infer health from absence on a list. Unsupported interpretations remain questions. No numerical score changes. Coverage is not proof of truth. The host records final lifecycle and failed capture attempts.";
