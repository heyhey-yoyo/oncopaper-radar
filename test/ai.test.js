import test from 'node:test';
import assert from 'node:assert/strict';
import { heuristicScore } from '../src/ai.js';

test('heuristicScore always returns bounded integer scores and a consistent total', () => {
  const score = heuristicScore({
    title: 'KRAS G12D drives ferroptosis resistance in pancreatic cancer',
    abstract: 'CRISPR knockout and rescue experiments in organoids and mice reveal a novel pathway.',
  }, ['KRAS G12D | KRASG12D', 'pancreatic cancer | PDAC']);

  for (const key of ['relevance', 'novelty', 'evidence', 'surprise', 'experiment_value']) {
    assert.equal(Number.isInteger(score[key]), true);
    assert.ok(score[key] >= 1 && score[key] <= 10);
  }
  assert.equal(
    score.total,
    score.relevance + score.novelty + score.evidence + score.surprise + score.experiment_value,
  );
});

test('heuristicScore tolerates missing metadata', () => {
  const score = heuristicScore({}, []);
  assert.equal(Number.isFinite(score.total), true);
  assert.ok(score.total >= 5 && score.total <= 50);
});

test('generateProfile degrades to a bounded title-based profile when Workers AI fails', async () => {
  const { generateProfile } = await import('../src/ai.js');
  const env = {
    AI: {
      run: async () => { throw new Error('model unavailable'); },
    },
  };
  const result = await generateProfile(env, [{
    pmid: '12345678',
    title: 'KRAS G12D signaling in pancreatic cancer',
    abstract: '',
  }]);

  assert.equal(result.model, 'heuristic');
  assert.ok(result.query_groups.length >= 1 && result.query_groups.length <= 2);
  assert.ok(result.query_groups.every(group => group.split('|').length <= 4));
  assert.equal(result.query_plan.fallback, true);
});
