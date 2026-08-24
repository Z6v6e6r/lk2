import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const SOURCE_AUDIT_COMMIT = '7593288932c66678311cf3ceeef791ada386ca3b';

export const QUESTION_IDS = Array.from(
  { length: 12 },
  (_, index) => `VIVA-Q-${String(index + 1).padStart(2, '0')}`,
);

export const GATE_IDS = [
  'realProviderWriter',
  'realProviderReadBack',
  'publicCallbackRoute',
  'callbackAsAccelerationOnly',
  'providerNativeAmountCurrencyVerification',
  'livePaymentConvergence',
  'SHADOW',
  'WARN',
  'BLOCK',
] as const;

export const ANSWER_STATUSES = [
  'ANSWERED_WITH_VERSIONED_EVIDENCE',
  'ANSWERED_WITHOUT_SUFFICIENT_EVIDENCE',
  'PARTIALLY_ANSWERED',
  'NOT_SUPPORTED',
  'UNKNOWN',
  'NO_RESPONSE',
] as const;

const TEMPLATE_STATUSES = [
  'UNANSWERED_TEMPLATE',
  'RECEIVED_UNREVIEWED',
  'EVIDENCE_REVIEWED',
] as const;
const ENVIRONMENTS = ['PRODUCTION', 'DEMO', 'SANDBOX', 'MULTIPLE', 'OTHER', 'UNKNOWN'] as const;
const EVIDENCE_BASES = [
  'OFFICIAL_WRITTEN_VERSIONED',
  'OFFICIAL_WRITTEN_UNVERSIONED',
  'ORAL_ONLY',
  'MARKETING_ONLY',
  'UI_OBSERVATION_ONLY',
  'NONE',
] as const;
const REVIEWER_CONCLUSIONS = [
  'NOT_REVIEWED',
  'INSUFFICIENT',
  'PARTIAL',
  'CANDIDATE_FOR_PROVEN',
  'CONTRADICTED',
  'SUPPORT_REQUIRED',
] as const;
const REQUIREMENT_STATUSES = [
  'PROVEN',
  'PARTIAL',
  'UNPROVEN',
  'CONTRADICTED',
  'SUPPORT_REQUIRED',
] as const;
const RECEIVED_CHANNELS = [
  'OFFICIAL_EMAIL',
  'SIGNED_DOCUMENT',
  'VERSIONED_PORTAL',
  'SUPPORT_TICKET_EXPORT',
  'ORAL_SUMMARY',
  'NOT_RECEIVED',
] as const;

export const EXPECTED_PACKAGE_FILES = [
  'docs/audits/viva-provider-clarification-catalog.json',
  'docs/audits/viva-provider-clarification-letter.en.md',
  'docs/audits/viva-provider-clarification-letter.ru.md',
  'docs/audits/viva-provider-clarification-package.md',
  'docs/audits/viva-provider-evidence-update-runbook.md',
  'docs/audits/viva-provider-response-template.json',
  'docs/audits/viva-provider-response.schema.json',
  'scripts/verify-viva-provider-response.ts',
  'scripts/viva-provider-clarification-contract.test.ts',
  'scripts/viva-provider-clarification-contract.ts',
] as const;

const QUESTION_KEYS = [
  'answerDate',
  'answerStatus',
  'answeringPerson',
  'attachedDocumentIdentifiers',
  'authoritativeDocumentUrls',
  'contradictoryStatements',
  'environment',
  'evidenceBasis',
  'evidenceReviewerConclusion',
  'exactEndpointMethod',
  'exactRequestHeadersFields',
  'exactResponseFieldsStatusCodes',
  'gateIds',
  'limitationsExceptions',
  'mappedGateImpact',
  'mappedRequirementStatus',
  'productApiVersion',
  'providerAnswer',
  'questionEn',
  'questionId',
  'questionRu',
  'requirementIds',
  'retentionConsistencyRetryWindows',
  'securityMechanism',
] as const;

const TOP_LEVEL_KEYS = [
  'gateReview',
  'provenance',
  'questions',
  'schemaVersion',
  'sourceAudit',
  'templateStatus',
] as const;

const SOURCE_AUDIT_KEYS = ['catalog', 'commit', 'pullRequest'] as const;

const PERSON_KEYS = ['name', 'role', 'team'] as const;

const PROVENANCE_KEYS = [
  'answerDate',
  'answeringPerson',
  'attachments',
  'environment',
  'originalMessageSha256',
  'preservedOriginalReference',
  'productApiVersion',
  'provider',
  'receivedAt',
  'receivedChannel',
] as const;

const GATE_REVIEW_KEYS = [
  'automaticTransition',
  'currentDecision',
  'gateId',
  'reviewedDecision',
] as const;

const ATTACHMENT_KEYS = ['authoritative', 'documentIdentifier', 'fileName', 'sha256'] as const;
const MAPPED_STATUS_KEYS = [
  'rationale',
  'requirementId',
  'reviewedStatus',
  'sourceStatus',
] as const;

type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const readJson = (root: string, path: string): unknown =>
  JSON.parse(readFileSync(resolve(root, path), 'utf8')) as unknown;

const sorted = (values: readonly string[]): string[] => [...values].sort();

const sameStrings = (left: readonly string[], right: readonly string[]): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

const normalizeQuestion = (value: string): string =>
  value.replaceAll('**', '').replaceAll('`', '').replace(/\s+/g, ' ').trim();

const unique = (values: readonly string[]): boolean => new Set(values).size === values.length;

const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === 'string');

const nonEmptyStrings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(nonEmptyString);

const pushExactKeysError = (
  errors: string[],
  value: unknown,
  expected: readonly string[],
  context: string,
): value is JsonObject => {
  if (!isObject(value)) {
    errors.push(`${context} must be an object`);
    return false;
  }
  const actual = sorted(Object.keys(value));
  const wanted = sorted(expected);
  if (!sameStrings(actual, wanted)) {
    errors.push(
      `${context} keys mismatch: expected ${wanted.join(', ')}; got ${actual.join(', ')}`,
    );
  }
  return true;
};

const extractMarkdownQuestions = (markdown: string): string[] => {
  const startMarker = '### Questions requiring written Viva/provider confirmation';
  const endMarker = '## Gate matrix';
  const start = markdown.indexOf(startMarker);
  const end = markdown.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end < 0) return [];

  const result: string[] = [];
  let current: string[] | null = null;
  for (const rawLine of markdown.slice(start + startMarker.length, end).split('\n')) {
    const questionStart = rawLine.match(/^\d+\.\s+(.*)$/);
    if (questionStart) {
      if (current) result.push(normalizeQuestion(current.join(' ')));
      current = [questionStart[1] ?? ''];
      continue;
    }
    if (current && rawLine.trim()) current.push(rawLine.trim());
  }
  if (current) result.push(normalizeQuestion(current.join(' ')));
  return result;
};

const validDate = (value: unknown): value is string => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
};

const validDateTime = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
  validDate(value.slice(0, 10)) &&
  !Number.isNaN(Date.parse(value));

const validHttpsUrl = (value: unknown): value is string => {
  if (typeof value !== 'string') return false;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
};

const nonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const nullableNonEmptyString = (value: unknown): value is string | null =>
  value === null || nonEmptyString(value);

const validatePerson = (value: unknown, context: string, errors: string[]): void => {
  if (!pushExactKeysError(errors, value, PERSON_KEYS, context)) return;
  for (const key of PERSON_KEYS) {
    if (!nullableNonEmptyString(value[key]))
      errors.push(`${context}.${key} must be null or a non-empty string`);
  }
};

const collectStringLeaves = (value: unknown, result: string[] = []): string[] => {
  if (typeof value === 'string') result.push(value);
  else if (Array.isArray(value)) value.forEach((entry) => collectStringLeaves(entry, result));
  else if (isObject(value))
    Object.values(value).forEach((entry) => collectStringLeaves(entry, result));
  return result;
};

const passesLuhn = (digits: string): boolean => {
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index]);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
};

const scanSensitiveValues = (
  value: unknown,
  context: string,
  errors: string[],
  rejectStructuredPayload = true,
): void => {
  const patterns: Array<[string, RegExp]> = [
    [
      'credential assignment',
      /(?:api[_-]?key|client[_-]?secret|password|access[_-]?token|refresh[_-]?token)\s*[:=]\s*["'`]?[A-Za-z0-9._~+/=-]{8,}/i,
    ],
    ['bearer/basic credential', /\bauthorization:\s*(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/i],
    ['known token prefix', /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16})\b/],
    ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
    ['email address', /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i],
    ['Russian phone number', /(?<!\d)(?:\+7|8)[ ()-]*\d{3}[ ()-]*\d{3}[ -]*\d{2}[ -]*\d{2}(?!\d)/],
    ['international phone number', /(?<!\w)\+\d{1,3}(?:[ ()-]*\d){7,14}(?!\d)/],
    [
      'provider/payment identifier assignment',
      /(?:merchant|transaction|payment|booking|client|customer)[_-]?id\s*[:=]\s*["'`]?[A-Za-z0-9._~+/-]{8,}/i,
    ],
    [
      'UUID-shaped real identifier',
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i,
    ],
  ];
  const isStructuredPayload = (text: string): boolean => {
    const candidates = [text.trim()];
    for (const match of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
      if (match[1]) candidates.push(match[1].trim());
    }
    const structuredStarts = [text.indexOf('{'), text.indexOf('[')].filter((index) => index >= 0);
    const embeddedStart = structuredStarts.length > 0 ? Math.min(...structuredStarts) : -1;
    if (embeddedStart > 0) candidates.push(text.slice(embeddedStart).trim());
    return candidates.some((candidate) => {
      if (!(candidate.startsWith('{') || candidate.startsWith('[')) || candidate.length <= 2)
        return false;
      try {
        const parsed = JSON.parse(candidate) as unknown;
        return isObject(parsed) || Array.isArray(parsed);
      } catch {
        return false;
      }
    });
  };
  for (const leaf of collectStringLeaves(value)) {
    for (const [label, pattern] of patterns) {
      if (pattern.test(leaf)) errors.push(`${context} contains ${label}`);
    }
    const compactDigits = leaf.replace(/[ -]/g, '');
    for (const match of compactDigits.matchAll(/(?<!\d)\d{13,19}(?!\d)/g)) {
      if (passesLuhn(match[0])) errors.push(`${context} contains a payment-card-shaped value`);
    }
    if (rejectStructuredPayload && isStructuredPayload(leaf))
      errors.push(`${context} contains a raw structured payload`);
  }
};

export const validateResponseData = (
  response: unknown,
  catalog: unknown,
  audit: unknown,
  schema: unknown,
): string[] => {
  const errors = validateSchemaContract(schema);
  if (!pushExactKeysError(errors, response, TOP_LEVEL_KEYS, 'response')) return errors;
  if (!isObject(catalog) || !Array.isArray(catalog.questions))
    return [...errors, 'catalog.questions must be an array'];
  if (!isObject(audit) || !Array.isArray(audit.requirements) || !isObject(audit.gates)) {
    return [...errors, 'source audit structure is invalid'];
  }
  if (!isObject(schema) || !isObject(schema.$defs))
    return [...errors, 'response schema definitions are unavailable'];
  const schemaDefs = schema.$defs;

  const schemaEnum = (name: string, expected: readonly string[]): string[] => {
    const definition = schemaDefs[name];
    if (!isObject(definition) || !strings(definition.enum)) {
      errors.push(`schema ${name} enum is unavailable`);
      return [];
    }
    if (!sameStrings(definition.enum, [...expected])) errors.push(`schema ${name} enum drift`);
    return definition.enum;
  };
  const allowedQuestionIds = schemaEnum('questionId', QUESTION_IDS);
  const allowedRequirementIds = schemaEnum(
    'requirementId',
    audit.requirements
      .filter(isObject)
      .map((entry) => entry.id)
      .filter((id): id is string => typeof id === 'string'),
  );
  const allowedGateIds = schemaEnum('gateId', GATE_IDS);
  const allowedAnswerStatuses = schemaEnum('answerStatus', ANSWER_STATUSES);
  const allowedEnvironments = schemaEnum('environment', ENVIRONMENTS);
  const allowedEvidenceBases = schemaEnum('evidenceBasis', EVIDENCE_BASES);
  const allowedReviewerConclusions = schemaEnum('reviewerConclusion', REVIEWER_CONCLUSIONS);

  if (response.schemaVersion !== '1.0.0') errors.push('response.schemaVersion must be 1.0.0');
  if (!TEMPLATE_STATUSES.includes(response.templateStatus as (typeof TEMPLATE_STATUSES)[number])) {
    errors.push('response.templateStatus is invalid');
  }
  if (pushExactKeysError(errors, response.sourceAudit, SOURCE_AUDIT_KEYS, 'response.sourceAudit')) {
    if (response.sourceAudit.pullRequest !== 123)
      errors.push('response source pull request mismatch');
    if (response.sourceAudit.commit !== SOURCE_AUDIT_COMMIT)
      errors.push('response source audit commit mismatch');
    if (response.sourceAudit.catalog !== 'docs/audits/viva-provider-clarification-catalog.json')
      errors.push('response catalog reference mismatch');
  }
  if (!Array.isArray(response.questions)) return [...errors, 'response.questions must be an array'];

  const requirementIds = audit.requirements
    .filter(isObject)
    .map((entry) => entry.id)
    .filter((id): id is string => typeof id === 'string');
  const requirementStatuses = new Map(
    audit.requirements
      .filter(isObject)
      .filter(
        (entry): entry is JsonObject & { id: string; status: string } =>
          typeof entry.id === 'string' && typeof entry.status === 'string',
      )
      .map((entry) => [entry.id, entry.status]),
  );
  if (requirementIds.length !== 34 || !unique(requirementIds))
    errors.push('source audit must contain 34 unique requirements');
  if (!sameStrings(Object.keys(audit.gates), [...GATE_IDS]))
    errors.push('source audit gate IDs or order changed');

  const responseIds = response.questions
    .filter(isObject)
    .map((entry) => entry.questionId)
    .filter((id): id is string => typeof id === 'string');
  if (response.questions.length !== 12) errors.push('response must contain exactly 12 questions');
  if (!unique(responseIds)) errors.push('response question IDs must be unique');
  if (!sameStrings(responseIds, allowedQuestionIds))
    errors.push('response question IDs/order mismatch');

  const catalogById = new Map(
    catalog.questions.filter(isObject).map((entry) => [entry.questionId, entry]),
  );
  const attachmentIds = new Set<string>();
  const authoritativeAttachmentIds = new Set<string>();

  if (pushExactKeysError(errors, response.provenance, PROVENANCE_KEYS, 'response.provenance')) {
    const provenance = response.provenance;
    if (provenance.provider !== 'Viva CRM')
      errors.push('response.provenance.provider must be Viva CRM');
    if (provenance.receivedAt !== null && !validDateTime(provenance.receivedAt)) {
      errors.push('response.provenance.receivedAt must be null or a valid date-time');
    }
    if (
      !RECEIVED_CHANNELS.includes(provenance.receivedChannel as (typeof RECEIVED_CHANNELS)[number])
    )
      errors.push('response.provenance.receivedChannel is invalid');
    validatePerson(provenance.answeringPerson, 'response.provenance.answeringPerson', errors);
    if (provenance.answerDate !== null && !validDate(provenance.answerDate))
      errors.push('response.provenance.answerDate must be null or a valid date');
    if (!nullableNonEmptyString(provenance.productApiVersion))
      errors.push('response.provenance.productApiVersion must be null or non-empty');
    if (!allowedEnvironments.includes(String(provenance.environment)))
      errors.push('response.provenance.environment is invalid');
    if (
      provenance.originalMessageSha256 !== null &&
      (typeof provenance.originalMessageSha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(provenance.originalMessageSha256))
    )
      errors.push('response.provenance.originalMessageSha256 is invalid');
    if (!nullableNonEmptyString(provenance.preservedOriginalReference))
      errors.push('response.provenance.preservedOriginalReference must be null or non-empty');
    if (!Array.isArray(provenance.attachments))
      errors.push('response.provenance.attachments must be an array');
    else {
      provenance.attachments.forEach((attachment, index) => {
        const context = `response.provenance.attachments[${index}]`;
        if (!pushExactKeysError(errors, attachment, ATTACHMENT_KEYS, context)) return;
        if (!nonEmptyString(attachment.documentIdentifier))
          errors.push(`${context}.documentIdentifier is invalid`);
        else if (attachmentIds.has(attachment.documentIdentifier))
          errors.push(`${context}.documentIdentifier is duplicated`);
        else {
          attachmentIds.add(attachment.documentIdentifier);
          if (attachment.authoritative === true)
            authoritativeAttachmentIds.add(attachment.documentIdentifier);
        }
        if (!nonEmptyString(attachment.fileName)) errors.push(`${context}.fileName is invalid`);
        if (typeof attachment.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(attachment.sha256))
          errors.push(`${context}.sha256 is invalid`);
        if (typeof attachment.authoritative !== 'boolean')
          errors.push(`${context}.authoritative must be boolean`);
      });
    }
  }

  response.questions.forEach((entry, index) => {
    const context = `response.questions[${index}]`;
    if (!pushExactKeysError(errors, entry, QUESTION_KEYS, context)) return;
    const catalogEntry = catalogById.get(entry.questionId);
    if (!catalogEntry) {
      errors.push(`${context} has unknown questionId`);
      return;
    }
    if (!nonEmptyString(entry.questionEn) || !nonEmptyString(entry.questionRu))
      errors.push(`${context} question text must be non-empty`);
    if (
      entry.questionEn !== catalogEntry.questionEn ||
      entry.questionRu !== catalogEntry.questionRu
    )
      errors.push(`${context} question text differs from catalog`);
    if (!strings(entry.requirementIds) || !unique(entry.requirementIds))
      errors.push(`${context} requirementIds must be unique strings`);
    if (
      !strings(catalogEntry.requirementIds) ||
      !strings(entry.requirementIds) ||
      !sameStrings(entry.requirementIds, catalogEntry.requirementIds)
    )
      errors.push(`${context} requirement mapping differs from catalog`);
    if (
      strings(entry.requirementIds) &&
      entry.requirementIds.some((id) => !allowedRequirementIds.includes(id))
    )
      errors.push(`${context} contains an unknown requirement ID`);
    if (!strings(entry.gateIds) || !unique(entry.gateIds))
      errors.push(`${context} gateIds must be unique strings`);
    if (
      !strings(catalogEntry.gateIds) ||
      !strings(entry.gateIds) ||
      !sameStrings(entry.gateIds, catalogEntry.gateIds)
    )
      errors.push(`${context} gate mapping differs from catalog`);
    if (strings(entry.gateIds) && entry.gateIds.some((id) => !allowedGateIds.includes(id)))
      errors.push(`${context} contains an unknown gate ID`);
    if (!allowedAnswerStatuses.includes(String(entry.answerStatus)))
      errors.push(`${context} has an invalid answerStatus`);
    if (!nullableNonEmptyString(entry.providerAnswer))
      errors.push(`${context}.providerAnswer must be null or non-empty`);
    validatePerson(entry.answeringPerson, `${context}.answeringPerson`, errors);
    if (entry.answerDate !== null && !validDate(entry.answerDate))
      errors.push(`${context}.answerDate is invalid`);
    if (!nullableNonEmptyString(entry.productApiVersion))
      errors.push(`${context}.productApiVersion must be null or non-empty`);
    if (!allowedEnvironments.includes(String(entry.environment)))
      errors.push(`${context} has an invalid environment`);
    if (
      !Array.isArray(entry.authoritativeDocumentUrls) ||
      !entry.authoritativeDocumentUrls.every(validHttpsUrl) ||
      !unique(entry.authoritativeDocumentUrls)
    )
      errors.push(`${context}.authoritativeDocumentUrls must contain unique HTTPS URLs`);
    if (
      !nonEmptyStrings(entry.attachedDocumentIdentifiers) ||
      !unique(entry.attachedDocumentIdentifiers)
    )
      errors.push(`${context}.attachedDocumentIdentifiers must be unique strings`);
    else if (entry.attachedDocumentIdentifiers.some((id) => !attachmentIds.has(id)))
      errors.push(`${context} references an unknown attachment`);
    for (const field of [
      'exactEndpointMethod',
      'retentionConsistencyRetryWindows',
      'securityMechanism',
      'limitationsExceptions',
    ] as const) {
      if (!nullableNonEmptyString(entry[field]))
        errors.push(`${context}.${field} must be null or non-empty`);
    }
    for (const field of ['exactRequestHeadersFields', 'exactResponseFieldsStatusCodes'] as const) {
      if (!nonEmptyStrings(entry[field]) || !unique(entry[field]))
        errors.push(`${context}.${field} must contain unique non-empty strings`);
    }
    if (!allowedEvidenceBases.includes(String(entry.evidenceBasis)))
      errors.push(`${context} has an invalid evidenceBasis`);
    if (!nonEmptyStrings(entry.contradictoryStatements) || !unique(entry.contradictoryStatements)) {
      errors.push(`${context} contradictoryStatements must be unique non-empty strings`);
    } else if (entry.contradictoryStatements.length > 0) {
      errors.push(`${context} contains unresolved contradictory statements`);
      if (entry.evidenceReviewerConclusion !== 'CONTRADICTED')
        errors.push(
          `${context} must be reviewed as CONTRADICTED while contradictory statements remain`,
        );
      if (
        !Array.isArray(entry.mappedRequirementStatus) ||
        !entry.mappedRequirementStatus.every(
          (status) => isObject(status) && status.reviewedStatus === 'CONTRADICTED',
        )
      ) {
        errors.push(
          `${context} contradictory evidence must map every affected requirement to CONTRADICTED`,
        );
      }
    }
    if (!allowedReviewerConclusions.includes(String(entry.evidenceReviewerConclusion)))
      errors.push(`${context} has an invalid evidenceReviewerConclusion`);
    if (entry.mappedGateImpact !== 'NO_CHANGE_NO_GO')
      errors.push(`${context} attempts an automatic gate change`);

    if (entry.mappedRequirementStatus !== null) {
      if (
        !Array.isArray(entry.mappedRequirementStatus) ||
        entry.mappedRequirementStatus.length === 0
      )
        errors.push(`${context}.mappedRequirementStatus must be null or a non-empty array`);
      else {
        const mappedIds: string[] = [];
        entry.mappedRequirementStatus.forEach((status, statusIndex) => {
          const statusContext = `${context}.mappedRequirementStatus[${statusIndex}]`;
          if (!pushExactKeysError(errors, status, MAPPED_STATUS_KEYS, statusContext)) return;
          if (!nonEmptyString(status.requirementId))
            errors.push(`${statusContext}.requirementId is invalid`);
          else mappedIds.push(status.requirementId);
          if (
            !REQUIREMENT_STATUSES.includes(
              status.sourceStatus as (typeof REQUIREMENT_STATUSES)[number],
            )
          )
            errors.push(`${statusContext}.sourceStatus is invalid`);
          if (
            !REQUIREMENT_STATUSES.includes(
              status.reviewedStatus as (typeof REQUIREMENT_STATUSES)[number],
            )
          )
            errors.push(`${statusContext}.reviewedStatus is invalid`);
          if (!nonEmptyString(status.rationale))
            errors.push(`${statusContext}.rationale is required`);
          if (
            typeof status.requirementId === 'string' &&
            requirementStatuses.get(status.requirementId) !== status.sourceStatus
          )
            errors.push(`${statusContext}.sourceStatus differs from source audit`);
        });
        if (
          !unique(mappedIds) ||
          !strings(entry.requirementIds) ||
          !sameStrings(mappedIds, entry.requirementIds)
        )
          errors.push(
            `${context} mapped requirement review is incomplete, duplicated or reordered`,
          );
      }
    }

    const isVersioned = entry.answerStatus === 'ANSWERED_WITH_VERSIONED_EVIDENCE';
    if (isVersioned) {
      if (!nonEmptyString(entry.providerAnswer)) errors.push(`${context} lacks providerAnswer`);
      const person = entry.answeringPerson;
      if (!isObject(person) || !PERSON_KEYS.every((key) => nonEmptyString(person[key])))
        errors.push(`${context} lacks answering person name/role/team`);
      if (!validDate(entry.answerDate)) errors.push(`${context} lacks a valid answerDate`);
      if (!nonEmptyString(entry.productApiVersion))
        errors.push(`${context} lacks productApiVersion`);
      if (
        entry.environment === 'UNKNOWN' ||
        !allowedEnvironments.includes(String(entry.environment))
      )
        errors.push(`${context} lacks a concrete valid environment`);
      const hasUrlEvidence =
        Array.isArray(entry.authoritativeDocumentUrls) &&
        entry.authoritativeDocumentUrls.length > 0 &&
        entry.authoritativeDocumentUrls.every(validHttpsUrl);
      const hasAttachmentEvidence =
        strings(entry.attachedDocumentIdentifiers) &&
        entry.attachedDocumentIdentifiers.length > 0 &&
        entry.attachedDocumentIdentifiers.every((id) => authoritativeAttachmentIds.has(id));
      if (!hasUrlEvidence && !hasAttachmentEvidence)
        errors.push(`${context} lacks authoritative URL or attachment evidence`);
      if (entry.evidenceBasis !== 'OFFICIAL_WRITTEN_VERSIONED')
        errors.push(`${context} is sufficient without official written versioned evidence`);
      if (
        !Array.isArray(entry.mappedRequirementStatus) ||
        entry.mappedRequirementStatus.length === 0
      )
        errors.push(`${context} lacks mapped requirement review`);
      if (isObject(response.provenance)) {
        if (response.provenance.productApiVersion !== entry.productApiVersion)
          errors.push(`${context} product/API version differs from provenance`);
        if (
          response.provenance.environment !== 'MULTIPLE' &&
          response.provenance.environment !== entry.environment
        )
          errors.push(`${context} environment differs from provenance`);
      }
    }

    if (entry.evidenceReviewerConclusion === 'CANDIDATE_FOR_PROVEN') {
      if (!isVersioned || entry.evidenceBasis !== 'OFFICIAL_WRITTEN_VERSIONED')
        errors.push(`${context} is a PROVEN candidate without versioned written evidence`);
      if (
        !Array.isArray(entry.mappedRequirementStatus) ||
        !entry.mappedRequirementStatus.some(
          (status) => isObject(status) && status.reviewedStatus === 'PROVEN',
        )
      )
        errors.push(`${context} is a PROVEN candidate without a reviewed PROVEN requirement`);
    }
    if (
      !isVersioned &&
      Array.isArray(entry.mappedRequirementStatus) &&
      entry.mappedRequirementStatus.some(
        (status) =>
          isObject(status) &&
          status.reviewedStatus === 'PROVEN' &&
          status.sourceStatus !== 'PROVEN',
      )
    ) {
      errors.push(`${context} maps a requirement to PROVEN without versioned written evidence`);
    }
    if (
      ['ORAL_ONLY', 'MARKETING_ONLY', 'UI_OBSERVATION_ONLY', 'NONE'].includes(
        String(entry.evidenceBasis),
      ) &&
      entry.evidenceReviewerConclusion === 'CANDIDATE_FOR_PROVEN'
    )
      errors.push(`${context} treats a non-authoritative basis as sufficient evidence`);
    if (
      (entry.evidenceBasis === 'ORAL_ONLY' ||
        (isObject(response.provenance) &&
          response.provenance.receivedChannel === 'ORAL_SUMMARY')) &&
      (isVersioned || entry.evidenceReviewerConclusion === 'CANDIDATE_FOR_PROVEN')
    ) {
      errors.push(`${context} treats an oral answer as sufficient evidence`);
    }
    if (entry.answerStatus === 'NOT_SUPPORTED') {
      if (
        !nonEmptyString(entry.providerAnswer) ||
        !['OFFICIAL_WRITTEN_VERSIONED', 'OFFICIAL_WRITTEN_UNVERSIONED'].includes(
          String(entry.evidenceBasis),
        )
      )
        errors.push(`${context} marks NOT_SUPPORTED without an official written answer`);
    }
  });

  const versionedAnswers = response.questions
    .filter(isObject)
    .filter((entry) => entry.answerStatus === 'ANSWERED_WITH_VERSIONED_EVIDENCE');
  if (versionedAnswers.length > 0) {
    if (!isObject(response.provenance))
      errors.push('versioned answers require response provenance');
    else {
      if (
        ![
          'OFFICIAL_EMAIL',
          'SIGNED_DOCUMENT',
          'VERSIONED_PORTAL',
          'SUPPORT_TICKET_EXPORT',
        ].includes(String(response.provenance.receivedChannel))
      )
        errors.push('versioned answers require an official written provenance channel');
      if (
        !nonEmptyString(response.provenance.receivedAt) ||
        Number.isNaN(Date.parse(response.provenance.receivedAt))
      )
        errors.push('versioned answers require a valid provenance receivedAt');
      if (!validDate(response.provenance.answerDate))
        errors.push('versioned answers require a provenance answerDate');
      if (!nonEmptyString(response.provenance.productApiVersion))
        errors.push('versioned answers require a provenance productApiVersion');
      if (
        response.provenance.environment === 'UNKNOWN' ||
        !allowedEnvironments.includes(String(response.provenance.environment))
      )
        errors.push('versioned answers require a concrete provenance environment');
      if (
        !nonEmptyString(response.provenance.originalMessageSha256) ||
        !/^[a-f0-9]{64}$/.test(response.provenance.originalMessageSha256)
      )
        errors.push('versioned answers require a SHA-256 originalMessageSha256');
      if (!nonEmptyString(response.provenance.preservedOriginalReference))
        errors.push('versioned answers require a preservedOriginalReference');
    }
  }

  if (response.templateStatus === 'UNANSWERED_TEMPLATE') {
    const invalid = response.questions
      .filter(isObject)
      .some(
        (entry) =>
          entry.answerStatus !== 'NO_RESPONSE' ||
          entry.evidenceBasis !== 'NONE' ||
          entry.evidenceReviewerConclusion !== 'NOT_REVIEWED' ||
          entry.mappedRequirementStatus !== null ||
          entry.providerAnswer !== null,
      );
    if (invalid) errors.push('UNANSWERED_TEMPLATE contains answered or reviewed evidence');
    if (!isObject(response.provenance) || response.provenance.receivedChannel !== 'NOT_RECEIVED')
      errors.push('UNANSWERED_TEMPLATE must use NOT_RECEIVED provenance');
    if (isObject(response.provenance)) {
      const person = response.provenance.answeringPerson;
      const hasPopulatedPerson =
        isObject(person) && (person.name !== null || person.role !== null || person.team !== null);
      const hasPopulatedProvenance =
        response.provenance.receivedAt !== null ||
        hasPopulatedPerson ||
        response.provenance.answerDate !== null ||
        response.provenance.productApiVersion !== null ||
        response.provenance.environment !== 'UNKNOWN' ||
        response.provenance.originalMessageSha256 !== null ||
        response.provenance.preservedOriginalReference !== null ||
        !Array.isArray(response.provenance.attachments) ||
        response.provenance.attachments.length !== 0;
      if (hasPopulatedProvenance)
        errors.push('UNANSWERED_TEMPLATE must not contain received provenance or attachments');
    }
  }
  if (response.templateStatus === 'RECEIVED_UNREVIEWED') {
    if (
      !isObject(response.provenance) ||
      response.provenance.receivedChannel === 'NOT_RECEIVED' ||
      response.provenance.receivedAt === null
    )
      errors.push('RECEIVED_UNREVIEWED requires received provenance');
    const prematurelyReviewed = response.questions
      .filter(isObject)
      .some(
        (entry) =>
          entry.evidenceReviewerConclusion !== 'NOT_REVIEWED' ||
          entry.mappedRequirementStatus !== null,
      );
    if (prematurelyReviewed)
      errors.push('RECEIVED_UNREVIEWED contains review conclusions or mapped statuses');
  }
  if (response.templateStatus === 'EVIDENCE_REVIEWED') {
    const incomplete = response.questions
      .filter(isObject)
      .some(
        (entry) =>
          entry.evidenceReviewerConclusion === 'NOT_REVIEWED' ||
          !Array.isArray(entry.mappedRequirementStatus),
      );
    if (incomplete)
      errors.push(
        'EVIDENCE_REVIEWED contains unreviewed questions or missing requirement mappings',
      );
  }

  if (!Array.isArray(response.gateReview) || response.gateReview.length !== 9)
    errors.push('response.gateReview must contain exactly nine gates');
  else {
    const gateIds = response.gateReview
      .filter(isObject)
      .map((entry) => entry.gateId)
      .filter((id): id is string => typeof id === 'string');
    if (!unique(gateIds) || !sameStrings(gateIds, allowedGateIds))
      errors.push('response.gateReview IDs/order mismatch');
    response.gateReview.forEach((entry, index) => {
      const context = `response.gateReview[${index}]`;
      if (!pushExactKeysError(errors, entry, GATE_REVIEW_KEYS, context)) return;
      if (
        entry.currentDecision !== 'NO-GO' ||
        entry.reviewedDecision !== 'NO-GO' ||
        entry.automaticTransition !== false
      )
        errors.push(
          `gate ${String(entry.gateId)} moved from NO-GO or permits automatic transition`,
        );
    });
  }

  scanSensitiveValues(response, 'response', errors);
  return errors;
};

const validateCatalog = (catalog: unknown, audit: unknown, markdown: string): string[] => {
  const errors: string[] = [];
  if (!isObject(catalog) || !Array.isArray(catalog.questions))
    return ['catalog.questions must be an array'];
  if (
    !isObject(audit) ||
    !Array.isArray(audit.questionsRequiringWrittenProviderConfirmation) ||
    !Array.isArray(audit.requirements) ||
    !isObject(audit.gates)
  ) {
    return ['source audit structure is invalid'];
  }
  const markdownQuestions = extractMarkdownQuestions(markdown);
  const auditQuestions = audit.questionsRequiringWrittenProviderConfirmation;
  const requirements = audit.requirements
    .filter(isObject)
    .map((entry) => entry.id)
    .filter((id): id is string => typeof id === 'string');
  const catalogIds = catalog.questions
    .filter(isObject)
    .map((entry) => entry.questionId)
    .filter((id): id is string => typeof id === 'string');
  if (
    catalog.questions.length !== 12 ||
    !unique(catalogIds) ||
    !sameStrings(catalogIds, QUESTION_IDS)
  )
    errors.push('catalog must contain VIVA-Q-01..12 exactly once in order');
  if (markdownQuestions.length !== 12 || auditQuestions.length !== 12)
    errors.push('source audit must contain exactly 12 Markdown and JSON questions');

  const mappedRequirements = new Set<string>();
  const mappedGates = new Set<string>();
  catalog.questions.filter(isObject).forEach((entry, index) => {
    if (entry.sourceAuditQuestion !== auditQuestions[index])
      errors.push(`${String(entry.questionId)} compressed source question drift`);
    const sourceQuestionEn =
      typeof entry.sourceQuestionEn === 'string' ? entry.sourceQuestionEn : entry.questionEn;
    if (
      typeof sourceQuestionEn !== 'string' ||
      normalizeQuestion(sourceQuestionEn) !== markdownQuestions[index]
    )
      errors.push(`${String(entry.questionId)} Markdown question drift`);
    if (!strings(entry.requirementIds) || !unique(entry.requirementIds))
      errors.push(`${String(entry.questionId)} has invalid requirementIds`);
    else
      entry.requirementIds.forEach((id) => {
        if (!requirements.includes(id))
          errors.push(`${String(entry.questionId)} has unknown requirement ${id}`);
        mappedRequirements.add(id);
      });
    if (!strings(entry.gateIds) || !unique(entry.gateIds))
      errors.push(`${String(entry.questionId)} has invalid gateIds`);
    else
      entry.gateIds.forEach((id) => {
        if (!GATE_IDS.includes(id as (typeof GATE_IDS)[number]))
          errors.push(`${String(entry.questionId)} has unknown gate ${id}`);
        mappedGates.add(id);
      });
  });
  if (!sameStrings(sorted([...mappedRequirements]), sorted(requirements)))
    errors.push('catalog does not cover all 34 source requirements');
  if (!sameStrings(sorted([...mappedGates]), sorted([...GATE_IDS])))
    errors.push('catalog does not cover all nine source gates');
  return errors;
};

const validateSchemaContract = (schema: unknown): string[] => {
  const errors: string[] = [];
  if (!isObject(schema)) return ['response schema must be an object'];
  if (schema.$schema !== 'https://json-schema.org/draft/2020-12/schema')
    errors.push('schema dialect must be Draft 2020-12');
  if (schema.additionalProperties !== false) errors.push('schema root must be closed-world');
  if (!isObject(schema.$defs)) return [...errors, 'schema.$defs must be an object'];
  const questionId = schema.$defs.questionId;
  const gateId = schema.$defs.gateId;
  const answerStatus = schema.$defs.answerStatus;
  if (
    !isObject(questionId) ||
    !strings(questionId.enum) ||
    !sameStrings(questionId.enum, QUESTION_IDS)
  )
    errors.push('schema question ID enum mismatch');
  if (!isObject(gateId) || !strings(gateId.enum) || !sameStrings(gateId.enum, [...GATE_IDS]))
    errors.push('schema gate ID enum mismatch');
  if (
    !isObject(answerStatus) ||
    !strings(answerStatus.enum) ||
    !sameStrings(answerStatus.enum, [...ANSWER_STATUSES])
  )
    errors.push('schema answer status enum mismatch');
  return errors;
};

const changedFiles = (root: string): string[] => {
  const committed = execFileSync('git', ['diff', '--name-only', `${SOURCE_AUDIT_COMMIT}..HEAD`], {
    cwd: root,
    encoding: 'utf8',
  });
  const status = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
    cwd: root,
    encoding: 'utf8',
  });
  const fromStatus = status
    .split('\n')
    .filter(Boolean)
    .map((line) => line.slice(3).split(' -> ').at(-1) ?? '');
  return [...new Set([...committed.split('\n').filter(Boolean), ...fromStatus])].sort();
};

export const validateRepositoryPackage = (
  root: string,
  responsePath = 'docs/audits/viva-provider-response-template.json',
  checkScope = true,
): string[] => {
  const auditPath = 'docs/audits/viva-provider-contract-evidence.json';
  const auditMarkdownPath = 'docs/audits/viva-provider-contract-evidence.md';
  const catalogPath = 'docs/audits/viva-provider-clarification-catalog.json';
  const schemaPath = 'docs/audits/viva-provider-response.schema.json';
  const audit = readJson(root, auditPath);
  const catalog = readJson(root, catalogPath);
  const response = readJson(root, responsePath);
  const schema = readJson(root, schemaPath);
  const markdown = readFileSync(resolve(root, auditMarkdownPath), 'utf8');

  const errors = [
    ...validateCatalog(catalog, audit, markdown),
    ...validateResponseData(response, catalog, audit, schema),
  ];

  if (checkScope) {
    const actual = changedFiles(root);
    const expected = sorted(EXPECTED_PACKAGE_FILES);
    if (!sameStrings(actual, expected))
      errors.push(
        `package file scope mismatch: expected ${expected.join(', ')}; got ${actual.join(', ')}`,
      );
  }

  for (const path of EXPECTED_PACKAGE_FILES) {
    const content = readFileSync(resolve(root, path), 'utf8');
    scanSensitiveValues(content, path, errors, false);
  }
  return errors;
};

export const assertValidRepositoryPackage = (
  root: string,
  responsePath = 'docs/audits/viva-provider-response-template.json',
  checkScope = true,
): void => {
  const errors = validateRepositoryPackage(root, responsePath, checkScope);
  if (errors.length > 0) throw new Error(errors.join('\n'));
};
