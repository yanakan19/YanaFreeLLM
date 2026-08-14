import { describe, it, expect } from 'vitest';
import { CRITERIA, scoreAndRank } from '../server/scoring.js';

const byKey = Object.fromEntries(CRITERIA.map((c) => [c.key, c]));
const score = (key, content, question = '') => byKey[key].score({ content, question });

describe('CRITERIA metadata', () => {
  it('weights sum to 1', () => {
    const total = CRITERIA.reduce((sum, c) => sum + c.weight, 0);
    expect(total).toBeCloseTo(1, 6);
  });

  it('every criterion has a key, describe and score function', () => {
    for (const c of CRITERIA) {
      expect(typeof c.key).toBe('string');
      expect(typeof c.describe).toBe('string');
      expect(typeof c.score).toBe('function');
    }
  });

  it('keys are unique', () => {
    expect(new Set(CRITERIA.map((c) => c.key)).size).toBe(CRITERIA.length);
  });
});

describe('relevance', () => {
  it('returns 50 when the question has no scorable keywords', () => {
    expect(score('relevance', 'anything', 'is it?')).toBe(50);
  });

  it('returns 100 when every keyword appears in the answer', () => {
    expect(score('relevance', 'bergamot and vetiver notes', 'what are bergamot vetiver notes')).toBe(100);
  });

  it('returns 0 when no keyword appears', () => {
    expect(score('relevance', 'completely unrelated prose', 'bergamot vetiver')).toBe(0);
  });

  it('scales with partial overlap', () => {
    // keywords: bergamot, vetiver -> one hit
    expect(score('relevance', 'bergamot only', 'bergamot vetiver')).toBe(50);
  });

  it('is case-insensitive', () => {
    expect(score('relevance', 'BERGAMOT', 'bergamot')).toBe(100);
  });
});

describe('structure', () => {
  it('gives a bare short wall of text the floor-ish score', () => {
    expect(score('structure', 'just one line of prose')).toBe(55); // 40 + short lines
  });

  it('rewards lists and paragraphs', () => {
    expect(score('structure', '- one\n- two\n\nand a closing paragraph')).toBe(100);
  });

  it('never exceeds 100', () => {
    expect(score('structure', '1. a\n2. b\n\nc\n\nd')).toBeLessThanOrEqual(100);
  });

  it('penalises very long unbroken lines', () => {
    const wall = 'x'.repeat(500);
    expect(score('structure', wall)).toBe(40);
  });
});

describe('actionability', () => {
  it('has a base score of 20 with no markers and no digits', () => {
    expect(score('actionability', 'purely descriptive text')).toBe(20);
  });

  it('adds 20 for containing a number', () => {
    expect(score('actionability', 'there are 3 things')).toBe(40);
  });

  it('adds 22 per action marker', () => {
    expect(score('actionability', 'You should try this')).toBe(20 + 44);
  });

  it('caps at 100', () => {
    const c = 'try, recommend, consider, best option, the next step, you should, 5 times';
    expect(score('actionability', c)).toBe(100);
  });
});

describe('concision', () => {
  it('scores empty content 0', () => {
    expect(score('concision', '')).toBe(0);
  });

  it('scores thin answers 60', () => {
    expect(score('concision', 'x'.repeat(50))).toBe(60);
  });

  it('scores the sweet spot 100', () => {
    expect(score('concision', 'x'.repeat(400))).toBe(100);
    expect(score('concision', 'x'.repeat(900))).toBe(100);
  });

  it('tapers off for long answers', () => {
    expect(score('concision', 'x'.repeat(1200))).toBe(70);
    expect(score('concision', 'x'.repeat(5000))).toBe(40);
  });
});

describe('calibratedConfidence', () => {
  it('defaults to 70 with no hedges and no overclaims', () => {
    expect(score('calibratedConfidence', 'plain statement of fact')).toBe(70);
  });

  it('rewards a small number of hedges', () => {
    expect(score('calibratedConfidence', 'it may be roughly correct')).toBe(90);
  });

  it('punishes over-hedging', () => {
    const c = 'may might approximately around roughly typically can vary as of';
    expect(score('calibratedConfidence', c)).toBe(55);
  });

  it('punishes overclaiming', () => {
    expect(score('calibratedConfidence', 'this is guaranteed to always work')).toBe(40);
  });

  it('clamps to the 0..100 range', () => {
    const s = score('calibratedConfidence', 'may might approximately around roughly typically can vary guaranteed 100%');
    expect(s).toBeGreaterThanOrEqual(0);
    expect(s).toBeLessThanOrEqual(100);
  });
});

describe('safety', () => {
  it('gives clean prose 100', () => {
    expect(score('safety', 'a plain hedge-free sentence with no figures')).toBe(100);
  });

  it('penalises unhedged exact figures', () => {
    expect(score('safety', 'it costs $49.99')).toBe(85);
  });

  it('does not penalise hedged figures', () => {
    expect(score('safety', 'it costs roughly $49.99')).toBe(100);
  });

  it('penalises URLs', () => {
    expect(score('safety', 'see https://example.com for roughly more')).toBe(85);
  });

  it('stacks both penalties', () => {
    expect(score('safety', 'pay $10 at https://example.com')).toBe(70);
  });
});

describe('scoreAndRank', () => {
  const answers = [
    { agentNumber: 1, content: 'no.' },
    {
      agentNumber: 2,
      content:
        '- Bergamot is a citrus top note.\n- Vetiver is an earthy base note.\n\nI would recommend you try roughly 2 sprays of a bergamot vetiver blend to see how it wears.',
    },
    { agentNumber: 3, content: 'Bergamot and vetiver are notes.' },
  ];

  it('returns criteria metadata without the score functions', () => {
    const { criteria } = scoreAndRank('bergamot vetiver notes', answers);
    expect(criteria).toHaveLength(CRITERIA.length);
    for (const c of criteria) {
      expect(Object.keys(c).sort()).toEqual(['describe', 'key', 'weight']);
    }
  });

  it('ranks the richest answer first and assigns sequential ranks', () => {
    const { matrix } = scoreAndRank('bergamot vetiver notes', answers);
    expect(matrix).toHaveLength(3);
    expect(matrix[0].agentNumber).toBe(2);
    expect(matrix.map((m) => m.rank)).toEqual([1, 2, 3]);
  });

  it('sorts by descending totalScore', () => {
    const { matrix } = scoreAndRank('bergamot vetiver notes', answers);
    const totals = matrix.map((m) => m.totalScore);
    expect([...totals].sort((a, b) => b - a)).toEqual(totals);
  });

  it('keeps every criterion in each row and preserves content', () => {
    const { matrix } = scoreAndRank('bergamot vetiver notes', answers);
    for (const row of matrix) {
      expect(Object.keys(row.criteriaScores).sort()).toEqual(CRITERIA.map((c) => c.key).sort());
      expect(typeof row.content).toBe('string');
    }
  });

  it('totalScore equals the weighted sum, rounded to 1dp', () => {
    const { matrix } = scoreAndRank('bergamot vetiver notes', answers);
    for (const row of matrix) {
      const expected =
        Math.round(CRITERIA.reduce((sum, c) => sum + row.criteriaScores[c.key] * c.weight, 0) * 10) / 10;
      expect(row.totalScore).toBe(expected);
    }
  });

  it('handles an empty answer list', () => {
    const { matrix } = scoreAndRank('anything', []);
    expect(matrix).toEqual([]);
  });

  it('is deterministic', () => {
    const a = scoreAndRank('bergamot vetiver', answers);
    const b = scoreAndRank('bergamot vetiver', answers);
    expect(a.matrix).toEqual(b.matrix);
  });
});
