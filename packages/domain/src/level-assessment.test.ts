import { describe, expect, it } from 'vitest';

import {
  evaluatePadelLevelAssessment,
  PADEL_LEVEL_ASSESSMENT_DEFINITION,
  PADEL_LEVEL_ASSESSMENT_VERSION,
} from './level-assessment.js';

describe('padel level assessment', () => {
  it('preserves the established beginner formula and derives the grade on the server', () => {
    expect(
      evaluatePadelLevelAssessment(PADEL_LEVEL_ASSESSMENT_VERSION, {
        q1_1: ['less_month'],
        q1_2: ['more_year'],
        q1_3: ['fitness', 'progress'],
        q1_4: ['fast'],
        q1_5: ['regular'],
      }),
    ).toEqual({
      outcome: 'completed',
      version: PADEL_LEVEL_ASSESSMENT_VERSION,
      numericScore: 2.8,
      levelCode: 'D+',
    });
  });

  it('preserves multiplication order and branch cap behavior', () => {
    expect(
      evaluatePadelLevelAssessment(PADEL_LEVEL_ASSESSMENT_VERSION, {
        q1_1: ['one_two_years'],
        q3_1: ['3_4'],
        q3_2: ['yes'],
        q3_3: ['regular'],
        q3_4: ['yes'],
        q3_5: ['8_plus'],
        q3_6: ['3_plus'],
      }),
    ).toMatchObject({ outcome: 'completed', numericScore: 4, levelCode: 'B' });
  });

  it.each([
    ['unknown version', 'legacy-v0', { q1_1: ['less_month'] }],
    ['missing branch answers', PADEL_LEVEL_ASSESSMENT_VERSION, { q1_1: ['less_month'] }],
    [
      'hidden branch injection',
      PADEL_LEVEL_ASSESSMENT_VERSION,
      {
        q1_1: ['less_year'],
        q2_2: ['no'],
        q2_3: ['ok'],
        q2_4: ['sometimes'],
        q2_5: ['4_8'],
        q4_6: ['3_plus'],
      },
    ],
    [
      'unknown option',
      PADEL_LEVEL_ASSESSMENT_VERSION,
      {
        q1_1: ['less_year'],
        q2_2: ['spoofed'],
        q2_3: ['ok'],
        q2_4: ['sometimes'],
        q2_5: ['4_8'],
      },
    ],
  ])('rejects %s', (_name, version, answers) => {
    expect(evaluatePadelLevelAssessment(version, answers)).toMatchObject({ outcome: 'invalid' });
  });

  it('publishes only question labels and branch structure, never scoring operations', () => {
    expect(PADEL_LEVEL_ASSESSMENT_DEFINITION.questions).toHaveLength(21);
    expect(JSON.stringify(PADEL_LEVEL_ASSESSMENT_DEFINITION)).not.toContain('operation');
    expect(JSON.stringify(PADEL_LEVEL_ASSESSMENT_DEFINITION)).not.toContain('cap');
  });
});
