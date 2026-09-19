'use strict';
const requiredCases = Array.from({ length: 12 }, (_, i) => 'V' + String(i + 1).padStart(2, '0'));
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
async function verifyHostEvidence(github, { owner, repo }, target, reviewedHead) {
  let url;
  try { url = new URL(target); } catch (_) { return false; }
  const prefix = '/' + owner + '/' + repo + '/blob/';
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password || url.search || url.hash || !url.pathname.startsWith(prefix)) return false;
  const match = /^([a-f0-9]{40})\/(docs\/v2\/evidence\/[A-Za-z0-9._-]+\.json)$/.exec(url.pathname.slice(prefix.length));
  if (!match) return false;
  let record;
  try {
    const file = await github.rest.repos.getContent({ owner, repo, ref: match[1], path: match[2] });
    if (file.data.type !== 'file' || file.data.encoding !== 'base64' || file.data.size > 256 * 1024 || typeof file.data.content !== 'string') return false;
    record = JSON.parse(Buffer.from(file.data.content, 'base64').toString('utf8'));
  } catch (error) {
    if (error.status === 404 || error instanceof SyntaxError) return false;
    throw error;
  }
  if (!record || record.schemaVersion !== 1 || record.suite !== 'ls-studio-m0-m1' || record.sourceCommit !== reviewedHead || record.result !== 'passed' || !nonempty(record.testedAt) || !Number.isFinite(Date.parse(record.testedAt)) || !nonempty(record.tester)) return false;
  const env = record.environment;
  if (!env || !nonempty(env.photoshop) || !nonempty(env.uxp) || !nonempty(env.os) || !nonempty(env.pluginId) || env.surface !== 'uxp-panel') return false;
  if (!Array.isArray(record.cases) || record.cases.length !== requiredCases.length) return false;
  return requiredCases.every(id => {
    const cases = record.cases.filter(item => item && item.id === id);
    return cases.length === 1 && cases[0].status === 'passed' && nonempty(cases[0].procedure) && nonempty(cases[0].observation);
  });
}
// Release authorization is evidence-based; dispatching a workflow is insufficient.
async function releaseGate({ github, context }) {
  const { owner, repo } = context.repo, sha = context.sha;
  if (context.ref !== 'refs/heads/main') throw new Error('Release dispatch must target protected main');
  const main = await github.rest.repos.getBranch({ owner, repo, branch: 'main' });
  if (!main.data.protected) throw new Error('Main must remain protected');
  if (main.data.commit.sha !== sha) throw new Error('Main changed after dispatch; review and dispatch the current commit');
  const checks = await github.paginate(github.rest.checks.listForRef, { owner, repo, ref: sha, filter: 'latest', per_page: 100 });
  if (!checks.some(check => check.name === 'ls-studio-tests' && check.conclusion === 'success' && check.app && check.app.slug === 'github-actions')) throw new Error('Required CI has not succeeded on this main commit');
  const commit = await github.rest.repos.getCommit({ owner, repo, ref: sha });
  const prs = await github.paginate(github.rest.repos.listPullRequestsAssociatedWithCommit, { owner, repo, commit_sha: sha, per_page: 100 });
  for (const pr of prs.filter(pr => pr.merged_at && pr.base.ref === 'main')) {
    const head = await github.rest.repos.getCommit({ owner, repo, ref: pr.head.sha });
    if (head.data.commit.tree.sha !== commit.data.commit.tree.sha) continue;
    const reviews = await github.paginate(github.rest.pulls.listReviews, { owner, repo, pull_number: pr.number, per_page: 100 });
    const latest = new Map();
    for (const review of reviews) if (review.state !== 'COMMENTED' && review.user) latest.set(review.user.login, review);
    const approved = [...latest.values()].some(review => review.state === 'APPROVED' && review.commit_id === pr.head.sha && review.user.login !== pr.user.login);
    if (!approved || [...latest.values()].some(review => review.state === 'CHANGES_REQUESTED')) continue;
    const status = await github.rest.repos.getCombinedStatusForRef({ owner, repo, ref: pr.head.sha });
    const live = status.data.statuses.find(status => status.context === 'ls-studio/computer-use');
    if (!live || live.state !== 'success' || !live.target_url) continue;
    if (!await verifyHostEvidence(github, { owner, repo }, live.target_url, pr.head.sha)) continue;
    return { sha, reviewedHead: pr.head.sha, pullRequest: pr.number, evidence: live.target_url };
  }
  throw new Error('No independently approved PR with matching release tree and successful computer-use evidence');
}
module.exports = releaseGate;
