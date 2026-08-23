// src/communities-staging-role-split-trusted-inventory-gate-preflight.ts
import { createHash as createHash7 } from "crypto";
import { isAbsolute as isAbsolute3, resolve as resolve2 } from "path";

// ../../packages/database/src/communities-staging-role-split-trusted-inventory-gate.ts
import { createHash as createHash3 } from "crypto";

// ../../packages/database/src/communities-role-split-input-c.ts
import { createHash } from "crypto";
function compareCommunitiesRoleSplitUtf8Bytes(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function communitiesRoleSplitCanonicalJson(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("CANONICAL_JSON_INVALID");
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(communitiesRoleSplitCanonicalJson).join(",")}]`;
  if (!isRecord(value)) throw new Error("CANONICAL_JSON_INVALID");
  return `{${Object.keys(value).sort(compareCommunitiesRoleSplitUtf8Bytes).map((key) => `${JSON.stringify(key)}:${communitiesRoleSplitCanonicalJson(value[key])}`).join(",")}}`;
}

// ../../packages/database/src/communities-staging-role-split.ts
import { createHash as createHash2 } from "crypto";
var COMMUNITIES_STAGING_ROLE_SPLIT_CLONE_CONTRACT_VERSION = "communities-staging-role-split-clone-v1";
var COMMUNITIES_STAGING_ROLE_SPLIT_OBJECT_MANIFEST = [
  ["schema", "community_content", "absent-before-0063"],
  ["schema", "eligibility", "absent-before-0084"],
  ["schema", "communities", "existing-create"],
  ["schema", "games", "existing-create"],
  ["schema", "identity", "existing-usage"],
  ["schema", "integration", "existing-create"],
  ["schema", "messaging", "existing-create"],
  ["schema", "notifications", "existing-create"],
  ["schema", "profile", "existing-usage"],
  ["schema", "public", "existing-usage"],
  ["extension", "pg_trgm", "required-by-0056"],
  ["table", "public.schema_migrations", "ledger"],
  ["table", "profile.privacy_settings", "alter-0053"],
  ["table", "profile.privacy_commands", "preexisting"],
  ["table", "profile.user_summaries", "preexisting"],
  ["table", "communities.communities", "alter-0055"],
  ["table", "communities.memberships", "alter-0054"],
  ["table", "integration.notification_endpoints", "alter-0070"],
  ["table", "integration.external_entity_map", "preexisting"],
  ["table", "integration.user_profile_photo_sync", "alter-0079"],
  ["table", "integration.community_logo_sync", "alter-0080"],
  ["table", "identity.tenants", "foreign-key-dependency"],
  ["table", "identity.users", "foreign-key-dependency"],
  ["table", "messaging.conversations", "preexisting"],
  ["table", "messaging.tenant_runtime_settings", "preexisting-0043"],
  ["table", "messaging.direct_conversation_commands", "preexisting-0043"],
  ["table", "messaging.read_cursor_commands", "preexisting-0043"],
  ["table", "notifications.tenant_runtime_settings", "alter-0073"],
  ["table", "games.games", "alter-0084"],
  ["table", "games.participations", "alter-0084"],
  ["table", "games.seat_reservations", "alter-0084"],
  ["table", "games.waitlist_entries", "alter-0084"],
  ["catalog", "database-acl-default-acl", "inventory-only"],
  ["catalog", "relation-column-acl-rls-policy", "inventory-only"],
  ["catalog", "sequences-functions-types", "inventory-only"]
];
var COMMUNITIES_STAGING_ROLE_SPLIT_INITIAL_PREEXISTING_RELATIONS = COMMUNITIES_STAGING_ROLE_SPLIT_OBJECT_MANIFEST.filter((entry) => entry[0] === "table").map(
  (entry) => entry[1]
);
var COMMUNITIES_STAGING_ROLE_SPLIT_CLONE_MANIFEST_SHA256 = createHash2("sha256").update(
  `${COMMUNITIES_STAGING_ROLE_SPLIT_CLONE_CONTRACT_VERSION}
${COMMUNITIES_STAGING_ROLE_SPLIT_OBJECT_MANIFEST.map((entry) => entry.join("|")).join("\n")}
`
).digest("hex");
var CommunitiesStagingRoleSplitError = class extends Error {
  constructor(code) {
    super(code);
    this.code = code;
    this.name = "CommunitiesStagingRoleSplitError";
  }
  code;
};
function failCommunitiesStagingRoleSplit(code) {
  throw new CommunitiesStagingRoleSplitError(`COMMUNITIES_STAGING_ROLE_SPLIT_${code}`);
}

// ../../packages/database/src/communities-staging-role-split-trusted-inventory-gate.ts
var COMMUNITIES_STAGING_ROLE_SPLIT_TRUSTED_INVENTORY_GATE_VERSION = "communities-staging-role-split-trusted-inventory-gate-v1";
var SHA256 = /^[a-f0-9]{64}$/u;
var COMMIT = /^[a-f0-9]{40}$/u;
var authorizationKeys = [
  "inventoryConnection",
  "inventoryRead",
  "artifactWrite",
  "trustedInventoryDesignation",
  "roleCreation",
  "roleSplit",
  "aclMutation",
  "sharedDatabaseMutation",
  "migration",
  "deploy",
  "activation"
];
function fail(code) {
  return failCommunitiesStagingRoleSplit(`TRUSTED_INVENTORY_GATE_${code}`);
}
function isRecord2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exactKeys(value, expected) {
  if (!isRecord2(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}
function canonicalText(value) {
  return `${communitiesRoleSplitCanonicalJson(value)}
`;
}
function assertCommunitiesStagingRoleSplitTrustedInventoryGate(value) {
  if (!exactKeys(value, [
    "schemaVersion",
    "status",
    "candidateCommitSha",
    "phase",
    "installedCandidateReceiptSha256",
    "runtimeBundleSha256",
    "preparationSha256",
    "preparationVerificationSha256",
    "connectionDescriptorSha256",
    "producerExecutableSha256",
    "credentialDescriptorPathSha256",
    "producerDescriptorPathSha256",
    "outputDirectoryPathSha256",
    "outputArtifactPathSha256",
    "outputReceiptPathSha256",
    "markerRequestPathSha256",
    "markerEvidencePathSha256",
    "roleMappingPathSha256",
    "runtimeWiringVersion",
    "collectionTimeoutMillis",
    "terminationGraceMillis",
    "authorizes"
  ]) || value.schemaVersion !== COMMUNITIES_STAGING_ROLE_SPLIT_TRUSTED_INVENTORY_GATE_VERSION || value.status !== "PREPARED_FOR_SEPARATE_AUTHORIZATION_REVIEW" || !COMMIT.test(value.candidateCommitSha) || !["BEFORE", "AFTER"].includes(value.phase) || [
    value.installedCandidateReceiptSha256,
    value.runtimeBundleSha256,
    value.preparationSha256,
    value.preparationVerificationSha256,
    value.connectionDescriptorSha256,
    value.producerExecutableSha256,
    value.credentialDescriptorPathSha256,
    value.producerDescriptorPathSha256,
    value.outputDirectoryPathSha256,
    value.outputArtifactPathSha256,
    value.outputReceiptPathSha256,
    value.markerRequestPathSha256,
    value.markerEvidencePathSha256,
    value.roleMappingPathSha256
  ].some((entry) => !SHA256.test(entry)) || value.runtimeWiringVersion !== "communities-staging-role-split-trusted-inventory-runtime-wiring-v1" || value.collectionTimeoutMillis !== 45e3 || value.terminationGraceMillis !== 5e3 || !exactKeys(value.authorizes, authorizationKeys) || authorizationKeys.some((key) => value.authorizes[key] !== false))
    fail("INVALID");
}
function canonicalCommunitiesStagingRoleSplitTrustedInventoryGate(value) {
  assertCommunitiesStagingRoleSplitTrustedInventoryGate(value);
  return canonicalText(value);
}
function parseCommunitiesStagingRoleSplitTrustedInventoryGate(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail("CANONICAL_INVALID");
  }
  assertCommunitiesStagingRoleSplitTrustedInventoryGate(
    parsed
  );
  if (canonicalText(parsed) !== text) fail("CANONICAL_INVALID");
  return parsed;
}
function communitiesStagingRoleSplitTrustedInventoryGateSha256(value) {
  return createHash3("sha256").update(canonicalCommunitiesStagingRoleSplitTrustedInventoryGate(value), "utf8").digest("hex");
}

// ../../packages/database/src/communities-staging-role-split-inventory-preparation.ts
import { createHash as createHash4 } from "crypto";
var COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_PREPARATION_VERSION = "communities-staging-role-split-inventory-preparation-v1";
var COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_PREPARATION_INPUT_CODES = [
  "MARKER_REQUEST",
  "MARKER_EVIDENCE",
  "ROLE_MAPPING",
  "INDEPENDENT_SOURCE_PROVENANCE",
  "CONNECTION_DESCRIPTOR",
  "CREDENTIAL_CUSTODY",
  "EXECUTABLE_CUSTODY",
  "OUTPUT_CUSTODY"
];
var sha256Pattern = /^[a-f0-9]{64}$/u;
var commitPattern = /^[a-f0-9]{40}$/u;
var oidPattern = /^[1-9][0-9]*$/u;
var systemIdentifierPattern = /^[0-9]{10,32}$/u;
var authorizationKeys2 = [
  "inventoryConnection",
  "inventoryRead",
  "artifactWrite",
  "trustedInventoryDesignation",
  "roleCreation",
  "roleSplit",
  "aclMutation",
  "sharedDatabaseMutation",
  "migration",
  "deploy",
  "activation"
];
function fail2(code) {
  return failCommunitiesStagingRoleSplit(`INVENTORY_PREPARATION_${code}`);
}
function isRecord3(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function hasExactKeys(value, expected) {
  if (!isRecord3(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}
function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "number")
    return JSON.stringify(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord3(value))
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return fail2("VALUE_INVALID");
}
function assertCommunitiesStagingRoleSplitInventoryPreparation(input) {
  if (!hasExactKeys(input, [
    "schemaVersion",
    "status",
    "candidateCommitSha",
    "phase",
    "requestSha256",
    "creationReceiptSha256",
    "cloneDatabaseOid",
    "sourceDatabaseOid",
    "systemIdentifier",
    "inputs",
    "outputArtifactPathSha256",
    "authorizes"
  ]) || input.schemaVersion !== COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_PREPARATION_VERSION || input.status !== "CODE_ONLY_DISABLED" || !commitPattern.test(input.candidateCommitSha) || !["BEFORE", "AFTER"].includes(input.phase) || !sha256Pattern.test(input.requestSha256) || !sha256Pattern.test(input.creationReceiptSha256) || !oidPattern.test(input.cloneDatabaseOid) || !oidPattern.test(input.sourceDatabaseOid) || !systemIdentifierPattern.test(input.systemIdentifier) || !sha256Pattern.test(input.outputArtifactPathSha256) || !Array.isArray(Reflect.get(input, "inputs")) || input.inputs.length !== COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_PREPARATION_INPUT_CODES.length || !hasExactKeys(input.authorizes, authorizationKeys2) || authorizationKeys2.some((key) => input.authorizes[key] !== false))
    fail2("SHAPE_INVALID");
  input.inputs.forEach((binding, index) => {
    if (!hasExactKeys(binding, ["code", "pathSha256", "contentSha256"]) || binding.code !== COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_PREPARATION_INPUT_CODES[index] || !sha256Pattern.test(binding.pathSha256) || !sha256Pattern.test(binding.contentSha256))
      fail2("INPUT_BINDING_INVALID");
  });
}
function canonicalCommunitiesStagingRoleSplitInventoryPreparation(input) {
  assertCommunitiesStagingRoleSplitInventoryPreparation(input);
  return `${canonicalJson(input)}
`;
}
function communitiesStagingRoleSplitInventoryPreparationSha256(input) {
  return createHash4("sha256").update(canonicalCommunitiesStagingRoleSplitInventoryPreparation(input), "utf8").digest("hex");
}
function parseCommunitiesStagingRoleSplitInventoryPreparation(input) {
  let parsed;
  try {
    parsed = JSON.parse(input);
  } catch {
    fail2("PARSE_INVALID");
  }
  const preparation = parsed;
  assertCommunitiesStagingRoleSplitInventoryPreparation(preparation);
  if (canonicalCommunitiesStagingRoleSplitInventoryPreparation(preparation) !== input)
    fail2("CANONICAL_ENCODING_INVALID");
  return preparation;
}

// ../../packages/database/src/communities-staging-role-split-trusted-inventory.ts
import { createHash as createHash5 } from "crypto";
var COMMUNITIES_STAGING_ROLE_SPLIT_TRUSTED_INVENTORY_CONNECTION_VERSION = "communities-staging-role-split-trusted-inventory-connection-v1";
var SHA2562 = /^[a-f0-9]{64}$/u;
var DATABASE = /^phub_restore_[1-9][0-9]*_[1-9][0-9]*$/u;
var ROLE = /^[A-Za-z_][A-Za-z0-9_]*$/u;
function fail3(code) {
  return failCommunitiesStagingRoleSplit(`TRUSTED_INVENTORY_${code}`);
}
function isRecord4(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exactKeys2(value, expected) {
  if (!isRecord4(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}
function sha256(value) {
  return createHash5("sha256").update(value, "utf8").digest("hex");
}
function canonicalText2(value) {
  return `${communitiesRoleSplitCanonicalJson(value)}
`;
}
function parseCanonical(text, assertValue) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail3("CANONICAL_INVALID");
  }
  assertValue(parsed);
  if (canonicalText2(parsed) !== text) fail3("CANONICAL_INVALID");
  return parsed;
}
function assertCommunitiesStagingRoleSplitTrustedInventoryConnectionDescriptor(value) {
  if (!exactKeys2(value, [
    "schemaVersion",
    "sourceKind",
    "host",
    "port",
    "database",
    "user",
    "sslMode",
    "passwordTransport",
    "defaultTransactionReadOnly",
    "applicationName",
    "connectTimeoutMillis",
    "statementTimeoutMillis",
    "lockTimeoutMillis",
    "markerRequestSha256",
    "markerEvidenceSha256",
    "roleMappingSha256"
  ]) || value.schemaVersion !== COMMUNITIES_STAGING_ROLE_SPLIT_TRUSTED_INVENTORY_CONNECTION_VERSION || value.sourceKind !== "INDEPENDENTLY_SOURCED_CLEAN_CLONE" || value.host !== "postgres" || value.port !== 5432 || !DATABASE.test(value.database) || !ROLE.test(value.user) || value.sslMode !== "disable" || value.passwordTransport !== "FD_3" || value.defaultTransactionReadOnly !== true || value.applicationName !== "phub-communities-role-split-input-c-v1" || value.connectTimeoutMillis !== 1e4 || value.statementTimeoutMillis !== 3e4 || value.lockTimeoutMillis !== 5e3 || !SHA2562.test(value.markerRequestSha256) || !SHA2562.test(value.markerEvidenceSha256) || !SHA2562.test(value.roleMappingSha256))
    fail3("CONNECTION_DESCRIPTOR_INVALID");
}
function canonicalCommunitiesStagingRoleSplitTrustedInventoryConnectionDescriptor(value) {
  assertCommunitiesStagingRoleSplitTrustedInventoryConnectionDescriptor(value);
  return canonicalText2(value);
}
function parseCommunitiesStagingRoleSplitTrustedInventoryConnectionDescriptor(text) {
  return parseCanonical(
    text,
    assertCommunitiesStagingRoleSplitTrustedInventoryConnectionDescriptor
  );
}
function communitiesStagingRoleSplitTrustedInventoryConnectionDescriptorSha256(value) {
  return sha256(canonicalCommunitiesStagingRoleSplitTrustedInventoryConnectionDescriptor(value));
}

// src/communities-staging-role-split-trusted-inventory-gate.ts
import { createHash as createHash6 } from "crypto";
import { dirname, isAbsolute, resolve } from "path";
var SHA2563 = /^[a-f0-9]{64}$/u;
var bindingKeys = [
  "callerSuppliedPreparationPinMatched",
  "canonicalPreparationBytes",
  "exactInputPathSetMatched",
  "exactInputContentSetMatched",
  "markerRequestEvidenceMatched",
  "roleMappingShapeValidated",
  "outputArtifactPathMatched"
];
var limitationKeys = [
  "organizationalIndependenceNotAttested",
  "cleanCloneProvenanceSemanticsNotAttested",
  "connectionDescriptorSemanticsNotAttested",
  "credentialCustodySemanticsNotAttested",
  "executableCustodySemanticsNotAttested",
  "outputCustodySemanticsNotAttested",
  "parentDirectoryCustodyNotAttested",
  "outputAbsenceNotAttested",
  "databaseNotConnected",
  "artifactNotCreated"
];
var authorizationKeys3 = [
  "inventoryConnection",
  "inventoryRead",
  "artifactWrite",
  "trustedInventoryDesignation",
  "roleCreation",
  "roleSplit",
  "aclMutation",
  "sharedDatabaseMutation",
  "migration",
  "deploy",
  "activation"
];
function fail4() {
  throw new Error("COMMUNITIES_STAGING_ROLE_SPLIT_TRUSTED_INVENTORY_GATE_INVALID");
}
function isRecord5(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exactKeys3(value, expected) {
  if (!isRecord5(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}
function sha2562(value) {
  return createHash6("sha256").update(value, "utf8").digest("hex");
}
function pathSha256(path) {
  return sha2562(`${path}
`);
}
function canonicalPath(path) {
  if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path) return false;
  return ![...path].some((character) => {
    const code = character.codePointAt(0);
    return code <= 31 || code === 127;
  });
}
function preparationVerificationSha256(value) {
  return sha2562(`${communitiesRoleSplitCanonicalJson(value)}
`);
}
function assertPreparationVerification(verification, preparation, expectedPreparationSha256) {
  if (!exactKeys3(verification, [
    "schemaVersion",
    "status",
    "candidateCommitSha",
    "phase",
    "preparationSha256",
    "requestSha256",
    "creationReceiptSha256",
    "inputCount",
    "outputArtifactPathSha256",
    "bindings",
    "limitations",
    "authorizes"
  ]) || verification.schemaVersion !== "communities-staging-role-split-inventory-preparation-verification-v1" || verification.status !== "PREPARATION_VERIFIED_REVIEW_ONLY" || verification.candidateCommitSha !== preparation.candidateCommitSha || verification.phase !== preparation.phase || verification.preparationSha256 !== expectedPreparationSha256 || verification.requestSha256 !== preparation.requestSha256 || verification.creationReceiptSha256 !== preparation.creationReceiptSha256 || verification.inputCount !== 8 || verification.outputArtifactPathSha256 !== preparation.outputArtifactPathSha256 || !exactKeys3(verification.bindings, bindingKeys) || bindingKeys.some((key) => verification.bindings[key] !== true) || !exactKeys3(verification.limitations, limitationKeys) || limitationKeys.some((key) => verification.limitations[key] !== true) || !exactKeys3(verification.authorizes, authorizationKeys3) || authorizationKeys3.some((key) => verification.authorizes[key] !== false))
    fail4();
}
function preparationInput(preparation, code) {
  const binding = preparation.inputs.find((entry) => entry.code === code);
  if (!binding) fail4();
  return binding;
}
function verifyCommunitiesStagingRoleSplitTrustedInventoryGate(input) {
  try {
    if (!SHA2563.test(input.expectedGateSha256)) fail4();
    const gateSha256 = communitiesStagingRoleSplitTrustedInventoryGateSha256(input.gate);
    if (gateSha256 !== input.expectedGateSha256) fail4();
    const preparationSha256 = communitiesStagingRoleSplitInventoryPreparationSha256(
      input.preparation
    );
    const verificationSha256 = preparationVerificationSha256(input.preparationVerification);
    const connectionDescriptorSha256 = communitiesStagingRoleSplitTrustedInventoryConnectionDescriptorSha256(
      input.connectionDescriptor
    );
    assertPreparationVerification(
      input.preparationVerification,
      input.preparation,
      preparationSha256
    );
    const paths = [
      input.paths.credentialDescriptorPath,
      input.paths.producerDescriptorPath,
      input.paths.outputDirectoryPath,
      input.paths.outputArtifactPath,
      input.paths.outputReceiptPath,
      input.paths.markerRequestPath,
      input.paths.markerEvidencePath,
      input.paths.roleMappingPath
    ];
    if (!exactKeys3(input.paths, [
      "credentialDescriptorPath",
      "producerDescriptorPath",
      "outputDirectoryPath",
      "outputArtifactPath",
      "outputReceiptPath",
      "markerRequestPath",
      "markerEvidencePath",
      "roleMappingPath"
    ]) || paths.some((path) => !canonicalPath(path)) || new Set(paths).size !== paths.length || dirname(input.paths.outputArtifactPath) !== input.paths.outputDirectoryPath || dirname(input.paths.outputReceiptPath) !== input.paths.outputDirectoryPath)
      fail4();
    const markerRequest = preparationInput(input.preparation, "MARKER_REQUEST");
    const markerEvidence = preparationInput(input.preparation, "MARKER_EVIDENCE");
    const roleMapping = preparationInput(input.preparation, "ROLE_MAPPING");
    const connection = preparationInput(input.preparation, "CONNECTION_DESCRIPTOR");
    const evidencePathHashes = new Set(input.preparation.inputs.map((entry) => entry.pathSha256));
    const operationalPathHashes = [
      input.gate.credentialDescriptorPathSha256,
      input.gate.producerDescriptorPathSha256,
      input.gate.outputDirectoryPathSha256,
      input.gate.outputArtifactPathSha256,
      input.gate.outputReceiptPathSha256
    ];
    if (evidencePathHashes.size !== input.preparation.inputs.length || operationalPathHashes.some((pathHash) => evidencePathHashes.has(pathHash)) || input.gate.candidateCommitSha !== input.preparation.candidateCommitSha || input.gate.phase !== input.preparation.phase || input.gate.preparationSha256 !== preparationSha256 || input.gate.preparationVerificationSha256 !== verificationSha256 || input.gate.connectionDescriptorSha256 !== connectionDescriptorSha256 || connection.contentSha256 !== connectionDescriptorSha256 || markerRequest.contentSha256 !== input.connectionDescriptor.markerRequestSha256 || markerEvidence.contentSha256 !== input.connectionDescriptor.markerEvidenceSha256 || roleMapping.contentSha256 !== input.connectionDescriptor.roleMappingSha256 || input.gate.markerRequestPathSha256 !== pathSha256(input.paths.markerRequestPath) || input.gate.markerEvidencePathSha256 !== pathSha256(input.paths.markerEvidencePath) || input.gate.roleMappingPathSha256 !== pathSha256(input.paths.roleMappingPath) || markerRequest.pathSha256 !== input.gate.markerRequestPathSha256 || markerEvidence.pathSha256 !== input.gate.markerEvidencePathSha256 || roleMapping.pathSha256 !== input.gate.roleMappingPathSha256 || input.gate.credentialDescriptorPathSha256 !== pathSha256(input.paths.credentialDescriptorPath) || input.gate.producerDescriptorPathSha256 !== pathSha256(input.paths.producerDescriptorPath) || input.gate.outputDirectoryPathSha256 !== pathSha256(input.paths.outputDirectoryPath) || input.gate.outputArtifactPathSha256 !== pathSha256(input.paths.outputArtifactPath) || input.gate.outputReceiptPathSha256 !== pathSha256(input.paths.outputReceiptPath) || input.preparation.outputArtifactPathSha256 !== input.gate.outputArtifactPathSha256)
      fail4();
    return {
      schemaVersion: "communities-staging-role-split-trusted-inventory-gate-verification-v1",
      status: "READY_FOR_SEPARATE_AUTHORIZATION_REVIEW_ONLY",
      candidateCommitSha: input.gate.candidateCommitSha,
      phase: input.gate.phase,
      gateSha256,
      installedCandidateReceiptSha256: input.gate.installedCandidateReceiptSha256,
      runtimeBundleSha256: input.gate.runtimeBundleSha256,
      preparationSha256,
      preparationVerificationSha256: verificationSha256,
      connectionDescriptorSha256,
      producerExecutableSha256: input.gate.producerExecutableSha256,
      bindings: {
        canonicalGate: true,
        preparationVerifiedReviewOnly: true,
        candidateAndPhaseMatched: true,
        connectionDescriptorMatched: true,
        evidenceContentBindingsMatched: true,
        evidencePathBindingsMatched: true,
        descriptorPathBindingsMatched: true,
        outputPathBindingsMatched: true,
        fixedRuntimeAndTimeoutPolicyMatched: true
      },
      limitations: {
        preparationVerificationProvenanceNotAttested: true,
        installedCandidateReceiptSemanticsNotAttested: true,
        runtimeBundleCustodyNotAttested: true,
        credentialDescriptorCustodyNotAttested: true,
        producerDescriptorCustodyNotAttested: true,
        outputCustodyNotAttested: true,
        independentlySourcedCloneNotAttested: true,
        separateAuthorizationNotGranted: true,
        authorizationReceiptNotCreated: true,
        databaseNotConnected: true,
        processNotStarted: true,
        artifactNotCreated: true,
        trustedInventoryDesignationNotGranted: true
      },
      authorizes: {
        inventoryConnection: false,
        inventoryRead: false,
        artifactWrite: false,
        trustedInventoryDesignation: false,
        roleCreation: false,
        roleSplit: false,
        aclMutation: false,
        sharedDatabaseMutation: false,
        migration: false,
        deploy: false,
        activation: false
      }
    };
  } catch {
    fail4();
  }
}
function communitiesStagingRoleSplitTrustedInventoryGateVerificationText(value) {
  return `${communitiesRoleSplitCanonicalJson(value)}
`;
}

// src/root-owned-evidence.ts
import { constants } from "fs";
import { open, lstat } from "fs/promises";
import { isAbsolute as isAbsolute2 } from "path";
var defaultIo = { open, lstat };
function invalid() {
  return new Error("INPUT_CUSTODY_INVALID");
}
function acceptable(metadata, maximumBytes) {
  return metadata.isFile() && !metadata.isSymbolicLink() && metadata.uid === 0 && metadata.nlink === 1 && (metadata.mode & 18) === 0 && metadata.size >= 1 && metadata.size <= maximumBytes;
}
function sameMetadata(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.uid === right.uid && left.nlink === right.nlink && left.mode === right.mode && left.size === right.size;
}
async function readRootOwnedEvidence(path, maximumBytes, io = defaultIo) {
  const noFollow = constants.O_NOFOLLOW;
  const nonBlock = constants.O_NONBLOCK;
  if (!isAbsolute2(path) || !Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || typeof noFollow !== "number" || typeof nonBlock !== "number")
    throw invalid();
  let handle;
  let result;
  let failed = false;
  try {
    handle = await io.open(path, constants.O_RDONLY | noFollow | nonBlock);
  } catch {
    throw invalid();
  }
  try {
    const before = await handle.stat();
    if (!acceptable(before, maximumBytes)) throw invalid();
    const buffer = Buffer.alloc(maximumBytes + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null);
      if (!Number.isSafeInteger(bytesRead) || bytesRead < 0) throw invalid();
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const after = await handle.stat();
    const pathAfter = await io.lstat(path);
    if (offset < 1 || offset > maximumBytes || offset !== before.size || !acceptable(after, maximumBytes) || !sameMetadata(before, after) || !sameMetadata(after, pathAfter))
      throw invalid();
    result = buffer.subarray(0, offset);
  } catch {
    failed = true;
  }
  try {
    await handle.close();
  } catch {
    failed = true;
  }
  if (failed || !result) throw invalid();
  return result;
}

// src/communities-staging-role-split-trusted-inventory-gate-preflight.ts
var SHA2564 = /^[a-f0-9]{64}$/u;
var MAXIMUM_GATE_BYTES = 128 * 1024;
var MAXIMUM_PREPARATION_BYTES = 128 * 1024;
var MAXIMUM_PREPARATION_VERIFICATION_BYTES = 128 * 1024;
var MAXIMUM_CONNECTION_DESCRIPTOR_BYTES = 64 * 1024;
var argumentSpecs = [
  ["--gate", "GATE"],
  ["--gate-sha256", "GATE_SHA256"],
  ["--preparation", "PREPARATION"],
  ["--preparation-verification", "PREPARATION_VERIFICATION"],
  ["--connection-descriptor", "CONNECTION_DESCRIPTOR"],
  ["--credential-descriptor", "CREDENTIAL_DESCRIPTOR"],
  ["--producer-descriptor", "PRODUCER_DESCRIPTOR"],
  ["--output-directory", "OUTPUT_DIRECTORY"],
  ["--output-artifact", "OUTPUT_ARTIFACT"],
  ["--output-receipt", "OUTPUT_RECEIPT"],
  ["--marker-request", "MARKER_REQUEST"],
  ["--marker-evidence", "MARKER_EVIDENCE"],
  ["--role-mapping", "ROLE_MAPPING"]
];
var defaultIo2 = {
  readRootOwnedEvidence
};
function fail5() {
  throw new Error("COMMUNITIES_STAGING_ROLE_SPLIT_TRUSTED_INVENTORY_GATE_PREFLIGHT_INVALID");
}
function canonicalAbsolutePath(path) {
  return typeof path === "string" && isAbsolute3(path) && resolve2(path) === path && ![...path].some((character) => {
    const code = character.codePointAt(0);
    return code <= 31 || code === 127;
  });
}
function sha2563(value) {
  return createHash7("sha256").update(value).digest("hex");
}
function parsePreparationVerification(bytes) {
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) fail5();
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    fail5();
  }
  if (`${communitiesRoleSplitCanonicalJson(value)}
` !== text) fail5();
  return value;
}
function parseArguments(arguments_) {
  if (arguments_.length !== argumentSpecs.length * 2 || argumentSpecs.some(([flag], index) => arguments_[index * 2] !== flag) || argumentSpecs.some((_, index) => !arguments_[index * 2 + 1]))
    fail5();
  return Object.fromEntries(
    argumentSpecs.map(([, code], index) => [code, arguments_[index * 2 + 1]])
  );
}
async function runCommunitiesStagingRoleSplitTrustedInventoryGatePreflight(arguments_, io = defaultIo2) {
  try {
    const values = parseArguments(arguments_);
    const paths = argumentSpecs.map(([, code]) => code).filter((code) => code !== "GATE_SHA256").map((code) => values[code]);
    if (!SHA2564.test(values.GATE_SHA256) || paths.some((path) => !canonicalAbsolutePath(path)) || new Set(paths).size !== paths.length)
      fail5();
    const gateBytes = await io.readRootOwnedEvidence(values.GATE, MAXIMUM_GATE_BYTES);
    const gate = parseCommunitiesStagingRoleSplitTrustedInventoryGate(gateBytes.toString("utf8"));
    if (sha2563(gateBytes) !== values.GATE_SHA256 || communitiesStagingRoleSplitTrustedInventoryGateSha256(gate) !== values.GATE_SHA256)
      fail5();
    const preparationBytes = await io.readRootOwnedEvidence(
      values.PREPARATION,
      MAXIMUM_PREPARATION_BYTES
    );
    const preparation = parseCommunitiesStagingRoleSplitInventoryPreparation(
      preparationBytes.toString("utf8")
    );
    if (sha2563(preparationBytes) !== gate.preparationSha256) fail5();
    const preparationVerificationBytes = await io.readRootOwnedEvidence(
      values.PREPARATION_VERIFICATION,
      MAXIMUM_PREPARATION_VERIFICATION_BYTES
    );
    const preparationVerification = parsePreparationVerification(preparationVerificationBytes);
    if (sha2563(preparationVerificationBytes) !== gate.preparationVerificationSha256) fail5();
    const connectionDescriptorBytes = await io.readRootOwnedEvidence(
      values.CONNECTION_DESCRIPTOR,
      MAXIMUM_CONNECTION_DESCRIPTOR_BYTES
    );
    const connectionDescriptor = parseCommunitiesStagingRoleSplitTrustedInventoryConnectionDescriptor(
      connectionDescriptorBytes.toString("utf8")
    );
    const connectionInput = preparation.inputs.find(
      (entry) => entry.code === "CONNECTION_DESCRIPTOR"
    );
    if (!connectionInput || sha2563(connectionDescriptorBytes) !== gate.connectionDescriptorSha256 || connectionInput.contentSha256 !== gate.connectionDescriptorSha256 || connectionInput.pathSha256 !== sha2563(`${values.CONNECTION_DESCRIPTOR}
`))
      fail5();
    return communitiesStagingRoleSplitTrustedInventoryGateVerificationText(
      verifyCommunitiesStagingRoleSplitTrustedInventoryGate({
        gate,
        expectedGateSha256: values.GATE_SHA256,
        preparation,
        preparationVerification,
        connectionDescriptor,
        paths: {
          credentialDescriptorPath: values.CREDENTIAL_DESCRIPTOR,
          producerDescriptorPath: values.PRODUCER_DESCRIPTOR,
          outputDirectoryPath: values.OUTPUT_DIRECTORY,
          outputArtifactPath: values.OUTPUT_ARTIFACT,
          outputReceiptPath: values.OUTPUT_RECEIPT,
          markerRequestPath: values.MARKER_REQUEST,
          markerEvidencePath: values.MARKER_EVIDENCE,
          roleMappingPath: values.ROLE_MAPPING
        }
      })
    );
  } catch {
    fail5();
  }
}

// src/verify-communities-staging-role-split-trusted-inventory-gate.ts
try {
  process.stdout.write(
    await runCommunitiesStagingRoleSplitTrustedInventoryGatePreflight(process.argv.slice(2))
  );
} catch {
  process.stderr.write("COMMUNITIES_STAGING_ROLE_SPLIT_TRUSTED_INVENTORY_GATE_PREFLIGHT_INVALID\n");
  process.exitCode = 1;
}
