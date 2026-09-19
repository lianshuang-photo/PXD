'use strict';
// Release authorization is evidence-based; dispatching a workflow is insufficient.
async function releaseGate({ github, context }) {
  const { owner, repo } = context.repo, sha = context.sha;
  if (context.ref !== 'refs/heads/main') throw new Error('Release dispatch must target protected main');
  const main = await github.rest.repos.getBranch({ owner, repo, branch: 'main' });
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
    const evidence = new URL(live.target_url);
    if (evidence.protocol !== 'https:' || evidence.hostname !== 'github.com' || !evidence.pathname.startsWith('/' + owner + '/' + repo + '/')) continue;
    return { sha, reviewedHead: pr.head.sha, pullRequest: pr.number, evidence: live.target_url };
  }
  throw new Error('No independently approved PR with matching release tree and successful computer-use evidence');
}
module.exports = releaseGate;
