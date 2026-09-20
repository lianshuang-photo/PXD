'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const releaseGate = require('../../../.github/scripts/release-gate.cjs');
const mainSha = 'a'.repeat(40), headSha = 'b'.repeat(40), evidenceSha = 'c'.repeat(40);
const evidenceUrl = `https://github.com/example/PXD/blob/${evidenceSha}/docs/v2/evidence/acceptance.json`;
function setup() {
  const record = {
    schemaVersion: 1, suite: 'ls-studio-m0-m1', sourceCommit: headSha, result: 'passed',
    testedAt: '2026-09-20T00:00:00Z', tester: 'fixture operator',
    environment: { photoshop: '26.0.0', uxp: '8.0.1', os: 'macOS fixture', pluginId: 'fixture.plugin', surface: 'uxp-panel' },
    cases: Array.from({ length: 12 }, (_, i) => ({ id: 'V' + String(i + 1).padStart(2, '0'), status: 'passed', procedure: 'Synthetic test fixture only', observation: 'Synthetic observation, never a live status' }))
  };
  const state = {
    branch: { protected: true, commit: { sha: mainSha } },
    checks: [{ name: 'ls-studio-tests', conclusion: 'success', app: { slug: 'github-actions' } }],
    prs: [{ number: 51, merged_at: '2026-09-20T00:00:00Z', base: { ref: 'main' }, head: { sha: headSha }, user: { login: 'author' } }],
    reviews: [{ state: 'APPROVED', commit_id: headSha, user: { login: 'reviewer' } }],
    statuses: [{ context: 'ls-studio/computer-use', state: 'success', target_url: evidenceUrl }],
    tree: 'tree-a', headTree: 'tree-a', record, fileStatus: 200, fileType: 'file', encoding: 'base64', calls: []
  };
  const github = {
    rest: {
      repos: {
        getBranch: async () => ({ data: state.branch }),
        getCommit: async ({ ref }) => ({ data: { commit: { tree: { sha: ref === mainSha ? state.tree : state.headTree } } } }),
        listPullRequestsAssociatedWithCommit: 'prs',
        getCombinedStatusForRef: async () => ({ data: { statuses: state.statuses } }),
        getContent: async args => {
          state.calls.push(args);
          if (state.fileStatus !== 200) throw Object.assign(new Error('Evidence API failure'), { status: state.fileStatus });
          const content = state.rawRecord === undefined ? JSON.stringify(state.record) : state.rawRecord;
          return { data: { type: state.fileType, encoding: state.encoding, size: state.fileSize || Buffer.byteLength(content), content: Buffer.from(content).toString('base64') } };
        }
      },
      checks: { listForRef: 'checks' },
      pulls: { listReviews: 'reviews' }
    },
    paginate: async method => state[method]
  };
  const context = { repo: { owner: 'example', repo: 'PXD' }, ref: 'refs/heads/main', sha: mainSha };
  return { state, context, run: () => releaseGate({ github, context }) };
}
test('release accepts independently reviewed exact tree and immutable complete evidence for its head', async () => {
  const f = setup();
  assert.deepEqual(await f.run(), { sha: mainSha, reviewedHead: headSha, pullRequest: 51, evidence: evidenceUrl });
  assert.deepEqual(f.state.calls, [{ owner: 'example', repo: 'PXD', ref: evidenceSha, path: 'docs/v2/evidence/acceptance.json' }]);
});
test('release refuses wrong branch, unprotected main and a main commit that advanced', async () => {
  for (const mutate of [f => { f.context.ref = 'refs/heads/feature'; }, f => { f.state.branch.protected = false; }, f => { f.state.branch.commit.sha = 'new-main'; }]) {
    const f = setup(); mutate(f); await assert.rejects(f.run()); assert.equal(f.state.calls.length, 0);
  }
});
test('release requires successful GitHub Actions aggregate on the actual main commit', async () => {
  for (const checks of [[], [{ name: 'ls-studio-tests', conclusion: 'failure', app: { slug: 'github-actions' } }], [{ name: 'ls-studio-tests', conclusion: 'success', app: { slug: 'another-app' } }]]) {
    const f = setup(); f.state.checks = checks; await assert.rejects(f.run(), /CI has not succeeded/);
  }
});
test('unmerged PR, wrong base and different release tree cannot authorize release', async () => {
  for (const mutate of [s => { s.prs[0].merged_at = null; }, s => { s.prs[0].base.ref = 'develop'; }, s => { s.headTree = 'other-tree'; }]) {
    const f = setup(); mutate(f.state); await assert.rejects(f.run(), /No independently approved PR/);
  }
});
test('approval must be independent, on final head, undismissed and without outstanding requested changes', async () => {
  for (const mutate of [
    s => { s.reviews = []; },
    s => { s.reviews[0].user.login = 'author'; },
    s => { s.reviews[0].commit_id = 'stale-head'; },
    s => { s.reviews.push({ state: 'DISMISSED', commit_id: headSha, user: { login: 'reviewer' } }); },
    s => { s.reviews.push({ state: 'CHANGES_REQUESTED', commit_id: headSha, user: { login: 'second-reviewer' } }); }
  ]) {
    const f = setup(); mutate(f.state); await assert.rejects(f.run(), /No independently approved PR/);
  }
});
test('an ordinary review comment does not erase a valid approving review', async () => {
  const f = setup(); f.state.reviews.push({ state: 'COMMENTED', user: { login: 'reviewer' } }); await f.run();
});
test('live status must be successful and link a specific immutable repository evidence file', async () => {
  const targets = [undefined, '', 'not-a-url', 'https://github.com/example/PXD/blob/main/README.md',
    'https://github.com/example/PXD/pull/51', evidenceUrl.replace(evidenceSha, 'main'),
    evidenceUrl.replace('/example/', '/another/'), evidenceUrl.replace('/docs/v2/evidence/', '/other/'),
    evidenceUrl.replace('https:', 'http:'), evidenceUrl + '?raw=true', evidenceUrl + '#section'];
  for (const target of targets) {
    const f = setup(); f.state.statuses[0].target_url = target; await assert.rejects(f.run(), /No independently approved PR/);
  }
  for (const statuses of [[], [{ context: 'ls-studio/computer-use', state: 'pending', target_url: evidenceUrl }], [{ context: 'ls-studio/computer-use', state: 'failure', target_url: evidenceUrl }]]) {
    const f = setup(); f.state.statuses = statuses; await assert.rejects(f.run(), /No independently approved PR/);
  }
});
test('missing, malformed, oversized or non-file evidence cannot authorize release', async () => {
  for (const mutate of [s => { s.fileStatus = 404; }, s => { s.rawRecord = '{broken'; }, s => { s.fileType = 'dir'; }, s => { s.encoding = 'none'; }, s => { s.fileSize = 300000; }]) {
    const f = setup(); mutate(f.state); await assert.rejects(f.run(), /No independently approved PR/);
  }
  const f = setup(); f.state.fileStatus = 500; await assert.rejects(f.run(), /Evidence API failure/);
});
test('evidence must bind exact tested head, real panel environment and every required acceptance case', async () => {
  for (const mutate of [
    r => { r.sourceCommit = 'old-head'; }, r => { r.result = 'partial'; }, r => { r.suite = 'unit-tests'; },
    r => { r.schemaVersion = 2; }, r => { r.testedAt = ''; }, r => { r.tester = ''; },
    r => { r.environment.surface = 'browser'; }, r => { delete r.environment.photoshop; }, r => { delete r.environment.uxp; },
    r => { r.cases.pop(); }, r => { r.cases[0] = r.cases[1]; }, r => { r.cases[0].status = 'not-run'; },
    r => { r.cases[0].status = 'not-applicable'; }, r => { r.cases[0].procedure = ''; }, r => { r.cases[0].observation = ''; }
  ]) {
    const f = setup(); mutate(f.state.record); await assert.rejects(f.run(), /No independently approved PR/);
  }
});
test('revalidation after an earlier success rejects newly stale main, revoked review or changed live status', async () => {
  for (const mutate of [s => { s.branch.commit.sha = 'new-main'; }, s => { s.reviews[0].state = 'DISMISSED'; }, s => { s.statuses[0].state = 'failure'; }]) {
    const f = setup(); await f.run(); mutate(f.state); await assert.rejects(f.run());
  }
});
test('workflow revalidates after environment approval and immediately before creating the tag', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '../../../.github/workflows/ls-studio-release.yml'), 'utf8');
  const draft = workflow.slice(workflow.indexOf('  draft-release:'));
  assert.ok(draft.includes('environment: ls-studio-release'));
  assert.match(draft, /Revalidate after environment approval[\s\S]*release-gate\.cjs[\s\S]*Smoke test exact release bytes/);
  assert.match(draft, /const evidence = await require\('\.\/\.github\/scripts\/release-gate\.cjs'\)\(\{github,context\}\);[\s\S]*github\.rest\.git\.createRef/);
  assert.doesNotMatch(draft, /needs\.verify\.outputs\.evidence/);
});
