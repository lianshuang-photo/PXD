const test = require('node:test');
const assert = require('node:assert/strict');
const gate = require('../../../.github/scripts/release-gate.cjs');
function setup() {
  const state = { main: 'main-sha', tree: 'tree-a', headTree: 'tree-a', live: 'success', approved: true, ci: true };
  const context = { repo: { owner: 'owner', repo: 'PXD' }, sha: 'main-sha', ref: 'refs/heads/main' };
  const github = { rest: { repos: {
    getBranch: async () => ({ data: { commit: { sha: state.main } } }),
    getCommit: async ({ ref }) => ({ data: { commit: { tree: { sha: ref === 'main-sha' ? state.tree : state.headTree } } } }),
    listPullRequestsAssociatedWithCommit: () => {},
    getCombinedStatusForRef: async () => ({ data: { statuses: [{ context: 'ls-studio/computer-use', state: state.live, target_url: 'https://github.com/owner/PXD/pull/1' }] } }),
  }, checks: { listForRef: () => {} }, pulls: { listReviews: () => {} } } };
  github.paginate = async method => {
    if (method === github.rest.checks.listForRef) return [{ name: 'ls-studio-tests', conclusion: state.ci ? 'success' : 'failure', app: { slug: 'github-actions' } }];
    if (method === github.rest.repos.listPullRequestsAssociatedWithCommit) return [{ merged_at: 'date', number: 1, base: { ref: 'main' }, head: { sha: 'head-sha' }, user: { login: 'author' } }];
    if (method === github.rest.pulls.listReviews) return [{ state: state.approved ? 'APPROVED' : 'CHANGES_REQUESTED', commit_id: 'head-sha', user: { login: 'reviewer' } }];
    throw Error('Unexpected request');
  };
  return { state, github, context };
}
test('release gate accepts reviewed matching tree and separately recorded computer-use evidence', async () => {
  const f = setup(); assert.equal((await gate(f)).reviewedHead, 'head-sha');
});
test('release gate refuses pending live evidence, stale trees, missing review and failed CI', async () => {
  for (const [key, value] of [['live', 'pending'], ['headTree', 'different-tree'], ['approved', false], ['ci', false], ['main', 'new-main']]) {
    const f = setup(); f.state[key] = value; await assert.rejects(gate(f));
  }
});
test('a workflow dispatch from a feature branch cannot release', async () => {
  const f = setup(); f.context.ref = 'refs/heads/feature'; await assert.rejects(gate(f), /protected main/);
});
