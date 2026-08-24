import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  validateRepositoryPackage,
  validateResponseData,
} from './viva-provider-clarification-contract.js';

const root = process.cwd();
const readJson = (path: string): unknown =>
  JSON.parse(readFileSync(resolve(root, path), 'utf8')) as unknown;
const catalog = readJson('docs/audits/viva-provider-clarification-catalog.json') as {
  questions: Array<Record<string, unknown>>;
};
const audit = readJson('docs/audits/viva-provider-contract-evidence.json') as {
  requirements: Array<{ id: string; status: string }>;
};
const schema = readJson('docs/audits/viva-provider-response.schema.json');
const template = readJson('docs/audits/viva-provider-response-template.json') as {
  templateStatus: string;
  provenance: Record<string, unknown>;
  gateReview: Array<Record<string, unknown>>;
  questions: Array<Record<string, unknown>>;
};

const clone = <T>(value: T): T => structuredClone(value);

const responseErrors = (value: unknown): string[] =>
  validateResponseData(value, catalog, audit, schema);

const makeFirstAnswerVersioned = (value: typeof template): void => {
  value.templateStatus = 'EVIDENCE_REVIEWED';
  value.provenance = {
    ...value.provenance,
    receivedAt: '2026-08-25T12:00:00Z',
    receivedChannel: 'OFFICIAL_EMAIL',
    answeringPerson: {
      name: 'Synthetic Provider Representative',
      role: 'API Product Owner',
      team: 'API Product',
    },
    answerDate: '2026-08-25',
    productApiVersion: 'synthetic-v1',
    environment: 'PRODUCTION',
    originalMessageSha256: 'a'.repeat(64),
    preservedOriginalReference: 'restricted-evidence-ledger-entry',
  };
  const question = value.questions[0]!;
  const requirementIds = question.requirementIds as string[];
  question.providerAnswer = 'Synthetic written contract answer for validator coverage.';
  question.answerStatus = 'ANSWERED_WITH_VERSIONED_EVIDENCE';
  question.answeringPerson = {
    name: 'Synthetic Provider Representative',
    role: 'API Product Owner',
    team: 'API Product',
  };
  question.answerDate = '2026-08-25';
  question.productApiVersion = 'synthetic-v1';
  question.environment = 'PRODUCTION';
  question.authoritativeDocumentUrls = ['https://docs.example.invalid/viva/synthetic-v1'];
  question.evidenceBasis = 'OFFICIAL_WRITTEN_VERSIONED';
  question.evidenceReviewerConclusion = 'CANDIDATE_FOR_PROVEN';
  question.mappedRequirementStatus = requirementIds.map((requirementId) => {
    const sourceStatus = audit.requirements.find((entry) => entry.id === requirementId)?.status;
    return {
      requirementId,
      sourceStatus,
      reviewedStatus: 'PROVEN',
      rationale: 'Synthetic validator fixture; no gate change.',
    };
  });
  value.questions.slice(1).forEach((unansweredQuestion) => {
    unansweredQuestion.evidenceReviewerConclusion = 'SUPPORT_REQUIRED';
    unansweredQuestion.mappedRequirementStatus = (
      unansweredQuestion.requirementIds as string[]
    ).map((requirementId) => {
      const sourceStatus = audit.requirements.find((entry) => entry.id === requirementId)?.status;
      return {
        requirementId,
        sourceStatus,
        reviewedStatus: sourceStatus,
        rationale: 'No provider response; source status remains unchanged.',
      };
    });
  });
};

describe('Viva provider clarification contract', () => {
  it('accepts the tracked unanswered package and verifies all cross-references', () => {
    expect(validateRepositoryPackage(root)).toEqual([]);
  });

  it('accepts a complete synthetic versioned answer without changing a gate', () => {
    const value = clone(template);
    makeFirstAnswerVersioned(value);
    expect(responseErrors(value)).toEqual([]);
  });

  it('rejects a missing question', () => {
    const value = clone(template);
    value.questions.pop();
    expect(responseErrors(value).join('\n')).toContain('exactly 12 questions');
  });

  it('rejects duplicate and unknown question IDs', () => {
    const duplicate = clone(template);
    duplicate.questions[1]!.questionId = 'VIVA-Q-01';
    expect(responseErrors(duplicate).join('\n')).toContain('must be unique');

    const unknown = clone(template);
    unknown.questions[0]!.questionId = 'VIVA-Q-99';
    expect(responseErrors(unknown).join('\n')).toContain('question IDs/order mismatch');
  });

  it('rejects mapping drift and unknown requirements or gates', () => {
    const requirement = clone(template);
    requirement.questions[0]!.requirementIds = ['UNKNOWN-01'];
    expect(responseErrors(requirement).join('\n')).toContain(
      'requirement mapping differs from catalog',
    );

    const gate = clone(template);
    gate.questions[0]!.gateIds = ['UNKNOWN-GATE'];
    expect(responseErrors(gate).join('\n')).toContain('gate mapping differs from catalog');
  });

  it('rejects versioned sufficiency without version, environment or evidence', () => {
    const value = clone(template);
    value.questions[0]!.answerStatus = 'ANSWERED_WITH_VERSIONED_EVIDENCE';
    expect(responseErrors(value).join('\n')).toContain('lacks providerAnswer');
    expect(responseErrors(value).join('\n')).toContain('lacks productApiVersion');
    expect(responseErrors(value).join('\n')).toContain(
      'lacks authoritative URL or attachment evidence',
    );
  });

  it('rejects candidate or PROVEN mapping under a non-versioned status', () => {
    const value = clone(template);
    value.templateStatus = 'EVIDENCE_REVIEWED';
    const question = value.questions[0]!;
    question.providerAnswer = 'Synthetic unversioned response.';
    question.answerStatus = 'ANSWERED_WITHOUT_SUFFICIENT_EVIDENCE';
    question.evidenceBasis = 'MARKETING_ONLY';
    question.evidenceReviewerConclusion = 'CANDIDATE_FOR_PROVEN';
    question.mappedRequirementStatus = (question.requirementIds as string[]).map(
      (requirementId) => ({
        requirementId,
        sourceStatus: audit.requirements.find((entry) => entry.id === requirementId)?.status,
        reviewedStatus: 'PROVEN',
        rationale: 'Synthetic invalid fixture.',
      }),
    );
    const errors = responseErrors(value).join('\n');
    expect(errors).toContain('PROVEN candidate without versioned written evidence');
    expect(errors).toContain('maps a requirement to PROVEN without versioned written evidence');
  });

  it('rejects a false EVIDENCE_REVIEWED lifecycle state', () => {
    const value = clone(template);
    value.templateStatus = 'EVIDENCE_REVIEWED';
    expect(responseErrors(value).join('\n')).toContain('contains unreviewed questions');
  });

  it('rejects populated provenance in an UNANSWERED_TEMPLATE', () => {
    const value = clone(template);
    value.provenance = {
      ...value.provenance,
      receivedAt: '2026-08-25T12:00:00Z',
      answeringPerson: {
        name: 'Synthetic Provider Representative',
        role: 'API Product Owner',
        team: 'API Product',
      },
      answerDate: '2026-08-25',
      productApiVersion: 'synthetic-v1',
      environment: 'PRODUCTION',
      originalMessageSha256: 'a'.repeat(64),
      preservedOriginalReference: 'restricted-evidence-ledger-entry',
      attachments: [
        {
          documentIdentifier: 'synthetic-versioned-contract',
          fileName: 'synthetic-contract.pdf',
          sha256: 'b'.repeat(64),
          authoritative: true,
        },
      ],
    };
    expect(responseErrors(value).join('\n')).toContain(
      'must not contain received provenance or attachments',
    );
  });

  it('rejects schema-invalid nested values and version/provenance mismatch', () => {
    const value = clone(template);
    makeFirstAnswerVersioned(value);
    value.provenance.receivedChannel = 'INVALID';
    value.provenance.receivedAt = '2026-08-25';
    value.provenance.attachments = [{ unexpected: true }];
    const question = value.questions[0]!;
    question.environment = 'MARS';
    question.answerDate = '2026-02-30';
    question.productApiVersion = 'mismatched-version';
    question.exactRequestHeadersFields = [''];
    question.contradictoryStatements = 'not-an-array';
    question.evidenceReviewerConclusion = 'PROVEN';
    question.mappedRequirementStatus = [
      {
        requirementId: 'ID-01',
        sourceStatus: 'UNPROVEN',
        reviewedStatus: 'AUTOMATIC_PROVEN',
        rationale: null,
      },
    ];
    const errors = responseErrors(value).join('\n');
    expect(errors).toContain('receivedChannel is invalid');
    expect(errors).toContain('receivedAt must be null or a valid date-time');
    expect(errors).toContain('keys mismatch');
    expect(errors).toContain('invalid environment');
    expect(errors).toContain('answerDate is invalid');
    expect(errors).toContain('product/API version differs from provenance');
    expect(errors).toContain('must contain unique non-empty strings');
    expect(errors).toContain('contradictoryStatements must be unique non-empty strings');
    expect(errors).toContain('invalid evidenceReviewerConclusion');
    expect(errors).toContain('reviewedStatus is invalid');
    expect(errors).toContain('rationale is required');
  });

  it('accepts authoritative digest-pinned attachment evidence without a URL', () => {
    const value = clone(template);
    makeFirstAnswerVersioned(value);
    value.provenance.attachments = [
      {
        documentIdentifier: 'synthetic-versioned-contract',
        fileName: 'synthetic-contract.pdf',
        sha256: 'b'.repeat(64),
        authoritative: true,
      },
    ];
    value.questions[0]!.authoritativeDocumentUrls = [];
    value.questions[0]!.attachedDocumentIdentifiers = ['synthetic-versioned-contract'];
    expect(responseErrors(value)).toEqual([]);
  });

  it('rejects oral-only sufficiency', () => {
    const value = clone(template);
    makeFirstAnswerVersioned(value);
    value.provenance.receivedChannel = 'ORAL_SUMMARY';
    value.questions[0]!.evidenceBasis = 'ORAL_ONLY';
    expect(responseErrors(value).join('\n')).toContain(
      'treats an oral answer as sufficient evidence',
    );
  });

  it('rejects unresolved contradictions and gate transitions', () => {
    const contradiction = clone(template);
    contradiction.questions[0]!.contradictoryStatements = ['Synthetic contradiction'];
    const contradictionErrors = responseErrors(contradiction).join('\n');
    expect(contradictionErrors).toContain('unresolved contradictory statements');
    expect(contradictionErrors).toContain('must be reviewed as CONTRADICTED');

    const gateChange = clone(template);
    gateChange.gateReview[0]!.reviewedDecision = 'GO';
    expect(responseErrors(gateChange).join('\n')).toContain('moved from NO-GO');
  });

  it('rejects extra fields and PII/token-shaped values', () => {
    const extra = clone(template) as typeof template & { authorization?: boolean };
    extra.authorization = true;
    expect(responseErrors(extra).join('\n')).toContain('response keys mismatch');

    const pii = clone(template);
    pii.questions[0]!.providerAnswer = ['synthetic.person', 'example.invalid'].join('@');
    expect(responseErrors(pii).join('\n')).toContain('email address');

    const token = clone(template);
    token.questions[0]!.providerAnswer = [
      'Authorization:',
      'Bearer',
      'syntheticTokenValue123',
    ].join(' ');
    expect(responseErrors(token).join('\n')).toContain('bearer/basic credential');

    const unquoted = clone(template);
    unquoted.questions[0]!.providerAnswer = ['api', 'key:'].join('_') + ' syntheticSecretValue123';
    expect(responseErrors(unquoted).join('\n')).toContain('credential assignment');

    const internationalPhone = clone(template);
    internationalPhone.questions[0]!.providerAnswer = ['Contact', '+44', '7700', '900123'].join(
      ' ',
    );
    expect(responseErrors(internationalPhone).join('\n')).toContain('international phone number');

    const rawPayload = clone(template);
    rawPayload.questions[0]!.providerAnswer = JSON.stringify({
      event: 'synthetic',
      body: { client: 'redacted' },
    });
    expect(responseErrors(rawPayload).join('\n')).toContain('raw structured payload');

    const prefixedPayload = clone(template);
    prefixedPayload.questions[0]!.providerAnswer =
      'Callback payload:\n' + JSON.stringify({ customer: { name: 'Synthetic Name' } });
    expect(responseErrors(prefixedPayload).join('\n')).toContain('raw structured payload');

    const fencedPayload = clone(template);
    fencedPayload.questions[0]!.providerAnswer =
      '```json\n' + JSON.stringify({ customer: { address: 'Synthetic Address' } }) + '\n```';
    expect(responseErrors(fencedPayload).join('\n')).toContain('raw structured payload');
  });
});
