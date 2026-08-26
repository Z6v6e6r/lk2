import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { parse, stringify } from 'yaml';
import { describe, expect, it } from 'vitest';

import { parseStrictJson } from './strict-json.js';
import {
  type TimewebTargetContract,
  type TimewebHistoricalInputRole,
  parseEnvironment,
  validateApplicationCompose,
  validateCaddyfile,
  validateDeploymentInputPaths,
  validateFutureReleaseDirectory,
  validateHistoricalEvidenceInput,
  validateIngressCompose,
  validateRuntimeContract,
  validateRuntimeEnvironmentRoot,
  validateRuntimeEnvironments,
  validateTargetContract,
  verifyDeploymentContract,
} from './verify-timeweb-deployment-contract.js';

interface MutableComposeService {
  [key: string]: unknown;
  image: string;
  profiles?: string[];
  ports?: string[];
  volumes?: string[];
  build?: string;
  privileged?: boolean;
  network_mode?: string;
  depends_on?: string[];
  env_file?: { path: string; required: boolean }[];
  environment?: Record<string, string>;
  networks: { beta: { ipv4_address: string } };
}

interface MutableApplicationCompose {
  services: Record<string, MutableComposeService> & {
    web: MutableComposeService;
    api: MutableComposeService;
    realtime: MutableComposeService;
    worker: MutableComposeService;
    migrator: MutableComposeService;
  };
  networks: Record<string, { external: boolean; name: string }> & {
    beta: { external: boolean; name: string };
  };
}

interface PullRequestWorkflow {
  jobs: Record<
    string,
    {
      steps?: { uses?: string; with?: Record<string, string> }[];
    }
  >;
}

const targetSource = readFileSync('deploy/timeweb/target.json', 'utf8');
const runtimeSource = readFileSync('deploy/timeweb/runtime-environment.contract.json', 'utf8');
const caddyfile = readFileSync('deploy/timeweb/Caddyfile', 'utf8');
const ingressCompose = readFileSync('deploy/timeweb/compose.ingress.yaml', 'utf8');
const applicationCompose = readFileSync('deploy/timeweb/compose.beta.yaml', 'utf8');
const runbook = readFileSync('docs/runbooks/timeweb-lk2-beta.md', 'utf8');
const workflow = readFileSync('.github/workflows/pull-request.yaml', 'utf8');
const verifierSource = readFileSync('scripts/verify-timeweb-deployment-contract.js', 'utf8');
const target = validateTargetContract(parseStrictJson<unknown>(targetSource));
const runtime = validateRuntimeContract(parseStrictJson<unknown>(runtimeSource));

function mutatedApplication(mutator: (compose: MutableApplicationCompose) => void): string {
  const compose = parse(applicationCompose, {
    merge: true,
  }) as unknown as MutableApplicationCompose;
  mutator(compose);
  return stringify(compose);
}

function syntheticEnvironments(): Record<string, Record<string, string>> {
  const environments: Record<string, Record<string, string>> = {};
  for (const [serviceName, service] of Object.entries(runtime.services)) {
    const values: Record<string, string> = {};
    for (const key of service.required) values[key] = 'synthetic-non-secret';
    for (const key of service.requiredTrueFlags) values[key] = 'true';
    for (const key of service.requiredFalseFlags) values[key] = 'false';
    for (const key of service.requiredDisabledModes) values[key] = 'disabled';
    for (const key of service.requiredOffModes) values[key] = 'OFF';
    environments[serviceName] = values;
  }
  for (const [serviceName, username] of [
    ['api', 'api'],
    ['worker', 'worker'],
    ['realtime', 'realtime'],
  ] as const) {
    Object.assign(environments[serviceName]!, {
      APP_ENV: 'staging',
      DATABASE_URL: `postgresql://${username}:synthetic@db.invalid:5432/phub`,
      REDIS_URL: `rediss://${username}:synthetic@redis.invalid:6379/0`,
      RABBITMQ_URL: `amqps://${username}:synthetic@rabbit.invalid/phub`,
      JWT_ISSUER: 'phub-identity',
      JWT_AUDIENCE: 'phub-api',
      OTEL_SERVICE_INSTANCE_ID: `timeweb-${serviceName}`,
    });
  }
  Object.assign(environments.api!, {
    LK2_BETA_HOST: target.hostname,
    TENANT_KEY: 'padlhub',
    JWT_REALTIME_AUDIENCE: 'phub-realtime',
    JWT_ACCESS_SECRET: 'synthetic-access-key-material-00000001',
    JWT_REFRESH_SECRET: 'synthetic-refresh-key-material-0000002',
    JWT_REALTIME_SECRET: 'synthetic-realtime-key-material-0000003',
    VIVA_DELEGATION_ENCRYPTION_KEY: 'synthetic-viva-key-material-000000004',
    AUTH_COOKIE_SECURE: 'true',
    CORS_ORIGINS: `https://${target.hostname}`,
    TRUSTED_PROXY_CIDRS: `${target.network.ingressAddress}/32`,
    VIVA_MODE: 'production',
    VIVA_OAUTH_REDIRECT_URI: `https://${target.hostname}/user/api/v1/padlhub/auth/viva/callback`,
    VIVA_OAUTH_SUCCESS_REDIRECT_URL: `https://${target.hostname}/`,
  });
  Object.assign(environments.worker!, {
    TENANT_KEY: 'padlhub',
    OUTBOX_PUBLISH_MODE: 'leased',
  });
  Object.assign(environments.realtime!, {
    JWT_REALTIME_AUDIENCE: 'phub-realtime',
    JWT_REALTIME_SECRET: 'synthetic-realtime-key-material-0000003',
  });
  Object.assign(environments.migrator!, {
    DATABASE_URL: 'postgresql://migrator:synthetic@db.invalid:5432/phub',
    MIGRATOR_ADVISORY_LOCK_TIMEOUT_MS: '30000',
  });
  return environments;
}

describe('Timeweb deployment contract', () => {
  it('1. accepts the exact Target V1 contract', () => {
    expect(() => verifyDeploymentContract()).not.toThrow();
  });

  it('2. rejects the wrong hostname', () => {
    expect(() => validateTargetContract({ ...target, hostname: 'other.invalid' })).toThrow(
      'target_hostname',
    );
  });

  it('3. rejects the wrong IPv4 address', () => {
    expect(() => validateTargetContract({ ...target, ipv4: '192.0.2.1' })).toThrow('target_ipv4');
  });

  it('4. rejects a wrong SSH fingerprint or algorithm downgrade', () => {
    const input: TimewebTargetContract = structuredClone(target);
    input.management.ssh.pinnedFingerprint = 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    expect(() => validateTargetContract(input)).toThrow('target_ssh_fingerprint');
    input.management.ssh.hostKeyAlgorithm = 'ssh-rsa';
    expect(() => validateTargetContract(input)).toThrow('target_ssh_fingerprint');
  });

  it('5. rejects management outside tailscale0', () => {
    const input: TimewebTargetContract = structuredClone(target);
    input.management.requiredInterface = 'eth0';
    expect(() => validateTargetContract(input)).toThrow('target_management_interface');
  });

  it('6. rejects a wrong network name', () => {
    const input: TimewebTargetContract = structuredClone(target);
    input.network.name = 'default';
    expect(() => validateTargetContract(input)).toThrow('target_network_name');
  });

  it('7. rejects a wrong subnet', () => {
    const input: TimewebTargetContract = structuredClone(target);
    input.network.subnet = '172.31.0.0/16';
    expect(() => validateTargetContract(input)).toThrow('target_network_subnet');
  });

  it('8. rejects a historical evidence directory as the release root', () => {
    const input: TimewebTargetContract = structuredClone(target);
    input.release.root = target.release.historicalEvidence[0]!.path;
    expect(() => validateTargetContract(input)).toThrow('target_release_root');
  });

  it('9. rejects a future release outside the releases namespace or with traversal', () => {
    expect(() =>
      validateFutureReleaseDirectory(target, '/opt/phub/timeweb-beta/staging/new'),
    ).toThrow('future_release_directory');
    expect(() =>
      validateFutureReleaseDirectory(target, `${target.release.root}/../rollback`),
    ).toThrow('future_release_directory');
  });

  it('10. rejects an enabled Caddy admin endpoint', () => {
    expect(() =>
      validateCaddyfile(caddyfile.replace('admin off', 'admin :2019'), target),
    ).toThrow();
  });

  it('11. rejects a missing API route', () => {
    expect(() => validateCaddyfile(caddyfile.replace('/user/api/*', ''), target)).toThrow(
      'caddy_required_contract',
    );
  });

  it('12. rejects a missing realtime route', () => {
    expect(() =>
      validateCaddyfile(caddyfile.replace('handle /realtime/*', 'handle /socket/*'), target),
    ).toThrow();
  });

  it('13. rejects an unexpected public route', () => {
    const input = caddyfile.replace(
      '\n\thandle {',
      '\n\thandle /unexpected/* {\n\t\treverse_proxy api:3000\n\t}\n\n\thandle {',
    );
    expect(() => validateCaddyfile(input, target)).toThrow('caddy_unexpected_route');
  });

  it('14. rejects a missing security header', () => {
    expect(() =>
      validateCaddyfile(caddyfile.replace('Strict-Transport-Security', 'X-Removed-HSTS'), target),
    ).toThrow('caddy_required_contract');
  });

  it('15. rejects a mutable Caddy image', () => {
    expect(() =>
      validateIngressCompose(
        ingressCompose.replace(/caddy@sha256:[a-f0-9]{64}/u, 'caddy:2'),
        target,
      ),
    ).toThrow('ingress_image');
  });

  it('16. rejects any ingress port other than 80 and 443', () => {
    expect(() =>
      validateIngressCompose(
        ingressCompose.replace(
          "      - '0.0.0.0:443:443/tcp'",
          "      - '0.0.0.0:443:443/tcp'\n      - '0.0.0.0:2019:2019/tcp'",
        ),
        target,
      ),
    ).toThrow('ingress_ports');
  });

  it('17. rejects an application host port', () => {
    expect(() =>
      validateApplicationCompose(
        mutatedApplication((value) => {
          value.services.web.ports = ['8080:8080'];
        }),
        target,
      ),
    ).toThrow('application_escape');
  });

  it('18. rejects a mutable application image', () => {
    expect(() =>
      validateApplicationCompose(
        mutatedApplication((value) => {
          value.services.web.image = 'ghcr.io/z6v6e6r/phub-web:latest';
        }),
        target,
      ),
    ).toThrow('application_image');
  });

  it('19. rejects a wrong GHCR repository', () => {
    expect(() =>
      validateApplicationCompose(applicationCompose.replace('phub-api@', 'other-api@'), target),
    ).toThrow('application_image');
  });

  it('20. rejects a missing application service', () => {
    expect(() =>
      validateApplicationCompose(
        mutatedApplication((value) => {
          delete (value.services as Partial<typeof value.services>).migrator;
        }),
        target,
      ),
    ).toThrow('application_services');
  });

  it('21. rejects a duplicate application image identity', () => {
    expect(() =>
      validateApplicationCompose(
        mutatedApplication((value) => {
          value.services.api.image = value.services.web.image;
        }),
        target,
      ),
    ).toThrow('application_image');
  });

  it('22. rejects a worker without the background profile', () => {
    expect(() =>
      validateApplicationCompose(
        mutatedApplication((value) => {
          delete value.services.worker.profiles;
        }),
        target,
      ),
    ).toThrow('application_worker_profile');
  });

  it('23. rejects a migrator without the migration profile', () => {
    expect(() =>
      validateApplicationCompose(
        mutatedApplication((value) => {
          delete value.services.migrator.profiles;
        }),
        target,
      ),
    ).toThrow('application_migrator_profile');
  });

  it('24. rejects a default service dependency on worker', () => {
    expect(() =>
      validateApplicationCompose(
        mutatedApplication((value) => {
          value.services.web.depends_on = ['worker'];
        }),
        target,
      ),
    ).toThrow('application_default_dependency');
  });

  it('25. rejects a default service dependency on migrator', () => {
    expect(() =>
      validateApplicationCompose(
        mutatedApplication((value) => {
          value.services.api.depends_on = ['migrator'];
        }),
        target,
      ),
    ).toThrow('application_default_dependency');
  });

  it('26. rejects an internal static IP outside the subnet', () => {
    expect(() =>
      validateApplicationCompose(
        mutatedApplication((value) => {
          value.services.api.networks.beta.ipv4_address = '10.0.0.12';
        }),
        target,
      ),
    ).toThrow('application_address');
  });

  it('27. rejects duplicate static IP addresses', () => {
    expect(() =>
      validateApplicationCompose(
        mutatedApplication((value) => {
          value.services.api.networks.beta.ipv4_address = target.network.applicationAddresses.web;
        }),
        target,
      ),
    ).toThrow('application_address');
  });

  it('28. rejects a non-external application network', () => {
    expect(() =>
      validateApplicationCompose(
        mutatedApplication((value) => {
          value.networks.beta.external = false;
        }),
        target,
      ),
    ).toThrow('application_network');
  });

  it('29. rejects a Docker socket mount', () => {
    expect(() =>
      validateApplicationCompose(
        mutatedApplication((value) => {
          value.services.api.volumes = ['/var/run/docker.sock:/var/run/docker.sock'];
        }),
        target,
      ),
    ).toThrow('application_escape');
  });

  it('30. rejects privileged or host-network application services', () => {
    expect(() =>
      validateApplicationCompose(
        mutatedApplication((value) => {
          value.services.api.privileged = true;
        }),
        target,
      ),
    ).toThrow('application_escape');
    expect(() =>
      validateApplicationCompose(
        mutatedApplication((value) => {
          value.services.api.network_mode = 'host';
        }),
        target,
      ),
    ).toThrow('application_escape');
  });

  it('31. rejects build sections and local source mounts', () => {
    expect(() =>
      validateApplicationCompose(
        mutatedApplication((value) => {
          value.services.web.build = '.';
        }),
        target,
      ),
    ).toThrow('application_escape');
    expect(() =>
      validateApplicationCompose(
        mutatedApplication((value) => {
          value.services.web.volumes = ['./apps/web:/app'];
        }),
        target,
      ),
    ).toThrow('application_escape');
  });

  it('32. rejects an ambient image override', () => {
    expect(() =>
      validateApplicationCompose(
        mutatedApplication((value) => {
          value.services.web.image = '${WEB_IMAGE:-ghcr.io/z6v6e6r/phub-web:latest}';
        }),
        target,
      ),
    ).toThrow('application_image');
  });

  it('33. rejects a missing root-only env-file declaration', () => {
    expect(() =>
      validateApplicationCompose(
        mutatedApplication((value) => {
          delete value.services.api.env_file;
        }),
        target,
      ),
    ).toThrow('application_env_file');
  });

  it('34. rejects a secret literal in Compose', () => {
    expect(() =>
      validateApplicationCompose(
        mutatedApplication((value) => {
          value.services.api.environment = { JWT_ACCESS_SECRET: 'literal' };
        }),
        target,
      ),
    ).toThrow('application_secret_literal');
  });

  it('35. requires exact-head CI to execute Caddy validate', () => {
    expect(workflow).toContain('caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile');
  });

  it('36. requires exact-head CI to execute Caddy adapt offline', () => {
    expect(workflow).toContain(
      'caddy adapt --pretty --config /etc/caddy/Caddyfile --adapter caddyfile',
    );
    expect(workflow).toContain('--network none');
  });

  it('37. records and checks the exact adapted JSON hash', () => {
    expect(target.ingress.caddy.adaptedJsonSha256).toBe(
      'afdc50d2324f94760c2630f78e5da0ade3f72589efbdec7e175cf476d516f21b',
    );
    expect(workflow).toContain('sha256sum --check --strict');
  });

  it('38. rejects both historical evidence paths as activation inputs', () => {
    const roles: TimewebHistoricalInputRole[] = [
      'releaseDirectory',
      'composeWorkingDirectory',
      'caddyWorkingDirectory',
      'activationInput',
      'futureRollbackInput',
      'secretsSource',
      'mountSource',
    ];
    for (const entry of target.release.historicalEvidence) {
      expect(() => validateFutureReleaseDirectory(target, entry.path)).toThrow(
        'historical_evidence_input',
      );
      for (const role of roles) {
        expect(() => validateHistoricalEvidenceInput(target, entry.path, role)).toThrow(
          'historical_evidence_input',
        );
        expect(() =>
          validateHistoricalEvidenceInput(target, `${entry.path}/descendant`, role),
        ).toThrow('historical_evidence_input');
      }
      expect(runbook).toContain(entry.path);
    }
  });

  it('rejects historical deployment sources and binds synthetic environment roots', () => {
    const paths = {
      target: resolve('deploy/timeweb/target.json'),
      caddyfile: resolve('deploy/timeweb/Caddyfile'),
      ingress: resolve('deploy/timeweb/compose.ingress.yaml'),
      application: resolve('deploy/timeweb/compose.beta.yaml'),
      runtime: resolve('deploy/timeweb/runtime-environment.contract.json'),
      runbook: resolve('docs/runbooks/timeweb-lk2-beta.md'),
    };
    const historical = target.release.historicalEvidence[0]!.path;
    for (const key of [
      'target',
      'caddyfile',
      'ingress',
      'application',
      'runtime',
      'runbook',
    ] as const) {
      expect(() =>
        validateDeploymentInputPaths(target, runtime, {
          ...paths,
          [key]: `${historical}/candidate`,
        }),
      ).toThrow('historical_evidence_input');
    }

    const runnerRoot = mkdtempSync(join(realpathSync(tmpdir()), 'timeweb-contract-'));
    const syntheticRoot = join(runnerRoot, 'synthetic-env');
    const symlinkRoot = join(runnerRoot, 'synthetic-env-link');
    mkdirSync(syntheticRoot);
    symlinkSync(syntheticRoot, symlinkRoot);
    const originalRunnerTemp = process.env.RUNNER_TEMP;
    process.env.RUNNER_TEMP = runnerRoot;
    try {
      expect(validateRuntimeEnvironmentRoot(target, runtime, syntheticRoot)).toBe(syntheticRoot);
      expect(() => validateRuntimeEnvironmentRoot(target, runtime, symlinkRoot)).toThrow(
        'env_root_symlink',
      );
      expect(() =>
        validateRuntimeEnvironmentRoot(target, runtime, join(tmpdir(), 'outside-contract-root')),
      ).toThrow('env_root_contract');
      expect(() => validateRuntimeEnvironmentRoot(target, runtime, historical)).toThrow(
        'historical_evidence_input',
      );
    } finally {
      if (originalRunnerTemp === undefined) delete process.env.RUNNER_TEMP;
      else process.env.RUNNER_TEMP = originalRunnerTemp;
      rmSync(runnerRoot, { recursive: true, force: true });
    }
  });

  it('rejects filesystem aliases for source, working-directory, mount, and release roles', () => {
    const fixtureRoot = mkdtempSync(join(realpathSync(tmpdir()), 'timeweb-alias-contract-'));
    const historicalRoot = join(fixtureRoot, 'historical');
    const aliasDirectory = join(fixtureRoot, 'historical-alias');
    const aliasFile = join(fixtureRoot, 'Caddyfile-alias');
    const releaseRoot = join(fixtureRoot, 'releases');
    const releaseTarget = join(fixtureRoot, 'release-target');
    const releaseAlias = join(releaseRoot, 'future-release-id');
    mkdirSync(historicalRoot);
    mkdirSync(releaseRoot);
    mkdirSync(releaseTarget);
    writeFileSync(join(historicalRoot, 'Caddyfile'), 'historical evidence\n');
    symlinkSync(historicalRoot, aliasDirectory);
    symlinkSync(join(historicalRoot, 'Caddyfile'), aliasFile);
    symlinkSync(releaseTarget, releaseAlias);
    const aliasTarget = structuredClone(target);
    aliasTarget.release.root = releaseRoot;
    aliasTarget.release.historicalEvidence[0]!.path = historicalRoot;
    const paths = {
      target: resolve('deploy/timeweb/target.json'),
      caddyfile: resolve('deploy/timeweb/Caddyfile'),
      ingress: resolve('deploy/timeweb/compose.ingress.yaml'),
      application: resolve('deploy/timeweb/compose.beta.yaml'),
      runtime: resolve('deploy/timeweb/runtime-environment.contract.json'),
      runbook: resolve('docs/runbooks/timeweb-lk2-beta.md'),
    };
    try {
      expect(() => validateHistoricalEvidenceInput(aliasTarget, aliasFile, 'mountSource')).toThrow(
        'filesystem_alias_input',
      );
      expect(() =>
        validateDeploymentInputPaths(aliasTarget, runtime, { ...paths, caddyfile: aliasFile }),
      ).toThrow('filesystem_alias_input');
      expect(() =>
        validateDeploymentInputPaths(aliasTarget, runtime, {
          ...paths,
          ingress: join(aliasDirectory, 'compose.ingress.yaml'),
        }),
      ).toThrow('filesystem_alias_input');
      expect(() => validateFutureReleaseDirectory(aliasTarget, releaseAlias)).toThrow(
        'filesystem_alias_input',
      );
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('rejects execution, identity, and network overrides outside exact Compose keys', () => {
    for (const key of [
      'command',
      'entrypoint',
      'user',
      'extends',
      'extra_hosts',
      'dns',
      'configs',
      'secrets',
    ]) {
      expect(() =>
        validateApplicationCompose(
          mutatedApplication((value) => {
            value.services.api[key] = ['unexpected'];
          }),
          target,
        ),
      ).toThrow('application_escape');
    }
    const ingress = parse(ingressCompose) as {
      services: { caddy: Record<string, unknown> };
    };
    ingress.services.caddy.command = ['caddy', 'file-server'];
    expect(() => validateIngressCompose(stringify(ingress), target)).toThrow('ingress_escape');
  });

  it('pins the deployment-contract setup action to a full commit SHA', () => {
    const document = parse(workflow) as unknown as PullRequestWorkflow;
    const setup = document.jobs['deployment-contract']?.steps?.find(({ uses }) =>
      uses?.startsWith('actions/setup-node@'),
    );
    expect(setup?.uses).toMatch(/^actions\/setup-node@[0-9a-f]{40}$/u);
  });

  it('39. requires synthetic Compose config without resource creation', () => {
    expect(workflow).toContain(
      'docker compose -f deploy/timeweb/compose.ingress.yaml config --quiet',
    );
    expect(workflow).toMatch(
      /docker compose -f deploy\/timeweb\/compose\.beta\.yaml[\s\\]*--profile background --profile migration[\s\\]*config --quiet/u,
    );
    expect(workflow).toContain('SYNTHETIC_NON_SECRET');
  });

  it('40. contains no Timeweb Compose activation command', () => {
    for (const source of [runbook, workflow]) {
      expect(source).not.toMatch(
        /docker(?:\s+--context\s+\S+)?\s+compose\s+[^\n]*(?:up|create|run)\b/iu,
      );
    }
  });

  it('rejects duplicate JSON and YAML keys', () => {
    expect(() => parseStrictJson('{"schema":"a","schema":"b"}')).toThrow('duplicate_key');
    expect(() =>
      validateIngressCompose(`${ingressCompose}\nservices:\n  other: {}\n`, target),
    ).toThrow('ingress_yaml');
  });

  it('keeps API/provider key sets out of worker and access/refresh keys out of realtime', () => {
    const workerInput = syntheticEnvironments();
    workerInput.worker!.VIVA_API_KEY = 'synthetic';
    expect(() => validateRuntimeEnvironments(workerInput, runtime, target)).toThrow(
      'env_worker_forbidden_key',
    );
    const realtimeInput = syntheticEnvironments();
    realtimeInput.realtime!.JWT_ACCESS_SECRET = 'synthetic';
    expect(() => validateRuntimeEnvironments(realtimeInput, runtime, target)).toThrow(
      'env_realtime_forbidden_key',
    );
  });

  it('keeps worker command flags disabled in the initial contour', () => {
    const input = syntheticEnvironments();
    input.worker!.GAMES_COMMANDS_ENABLED = 'true';
    expect(() => validateRuntimeEnvironments(input, runtime, target)).toThrow('env_worker_flag');
  });

  it('rejects unknown enabled flags, duplicate env keys, and empty required values', () => {
    const unknown = syntheticEnvironments();
    unknown.worker!.UNDECLARED_ENABLED = 'true';
    expect(() => validateRuntimeEnvironments(unknown, runtime, target)).toThrow(
      'env_worker_unknown_enabled_flag',
    );
    expect(() => parseEnvironment('APP_ENV=staging\nAPP_ENV=production\n')).toThrow(
      'env_duplicate',
    );
    expect(() => parseEnvironment('APP_ENV=\n')).toThrow('env_empty_value');
  });

  it('accepts a complete synthetic non-secret environment contour', () => {
    expect(() =>
      validateRuntimeEnvironments(syntheticEnvironments(), runtime, target),
    ).not.toThrow();
  });

  it('does not construct arbitrary shell commands from target strings', () => {
    expect(verifierSource).not.toMatch(/node:child_process|execSync|spawnSync|\beval\s*\(/u);
  });

  it('checks out the exact event head in every source-consuming PR job', () => {
    const document = parse(workflow) as unknown as PullRequestWorkflow;
    const expectedRef =
      "${{ github.event_name == 'pull_request' && github.event.pull_request.head.sha || github.sha }}";
    for (const jobName of [
      'quality',
      'dependency-security',
      'secret-scan',
      'deployment-contract',
      'docker-selection',
      'docker-image',
    ]) {
      const checkout = document.jobs[jobName]?.steps?.find(({ uses }) =>
        uses?.startsWith('actions/checkout@'),
      );
      expect(checkout?.with?.ref, jobName).toBe(expectedRef);
    }
  });
});
