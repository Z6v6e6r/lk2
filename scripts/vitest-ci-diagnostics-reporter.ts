import { appendFileSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

interface ReporterModuleDiagnostic {
  readonly collectDuration: number;
  readonly duration: number;
  readonly environmentSetupDuration: number;
  readonly prepareDuration: number;
  readonly setupDuration: number;
}

interface ReporterTestModule {
  readonly relativeModuleId: string;
  diagnostic(): ReporterModuleDiagnostic;
  state(): string;
}

interface ModuleDuration {
  readonly durationMillis: number;
  readonly module: string;
  readonly state: string;
}

const diagnosticsDirectory =
  process.env.CI_TEST_DIAGNOSTICS_DIR ?? '.ci-artifacts/test-and-coverage';
const eventsPath = join(diagnosticsDirectory, 'suite-events.ndjson');
const activeSuitesPath = join(diagnosticsDirectory, 'active-suites.json');
const slowestSuitesPath = join(diagnosticsDirectory, 'slowest-suites.json');
const runSummaryPath = join(diagnosticsDirectory, 'test-run-summary.json');

function writeJsonAtomic(path: string, value: unknown): void {
  const temporaryPath = `${path}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(temporaryPath, path);
}

export default class CiDiagnosticsReporter {
  private readonly activeSuites = new Map<string, string>();
  private readonly durations: ModuleDuration[] = [];

  constructor() {
    mkdirSync(diagnosticsDirectory, { recursive: true });
    writeJsonAtomic(activeSuitesPath, []);
  }

  private appendEvent(event: Record<string, unknown>): void {
    appendFileSync(
      eventsPath,
      `${JSON.stringify({ ...event, timestamp: new Date().toISOString() })}\n`,
      'utf8',
    );
  }

  private writeActiveSuites(): void {
    writeJsonAtomic(
      activeSuitesPath,
      [...this.activeSuites.entries()]
        .map(([module, startedAt]) => ({ module, startedAt }))
        .sort((left, right) => left.module.localeCompare(right.module)),
    );
  }

  onTestRunStart(specifications: ReadonlyArray<unknown>): void {
    this.appendEvent({ event: 'run-start', moduleCount: specifications.length });
  }

  onTestModuleStart(testModule: ReporterTestModule): void {
    const startedAt = new Date().toISOString();
    this.activeSuites.set(testModule.relativeModuleId, startedAt);
    this.writeActiveSuites();
    this.appendEvent({ event: 'suite-start', module: testModule.relativeModuleId });
  }

  onTestModuleEnd(testModule: ReporterTestModule): void {
    const diagnostic = testModule.diagnostic();
    this.activeSuites.delete(testModule.relativeModuleId);
    this.writeActiveSuites();
    this.durations.push({
      durationMillis: diagnostic.duration,
      module: testModule.relativeModuleId,
      state: testModule.state(),
    });
    this.appendEvent({
      diagnostic,
      event: 'suite-end',
      module: testModule.relativeModuleId,
      state: testModule.state(),
    });
  }

  onTestRunEnd(
    testModules: ReadonlyArray<ReporterTestModule>,
    unhandledErrors: ReadonlyArray<unknown>,
    reason: 'failed' | 'interrupted' | 'passed',
  ): void {
    const slowestSuites = [...this.durations]
      .sort((left, right) => right.durationMillis - left.durationMillis)
      .slice(0, 50);
    writeJsonAtomic(slowestSuitesPath, slowestSuites);
    writeJsonAtomic(runSummaryPath, {
      completedModules: this.durations.length,
      reason,
      totalModules: testModules.length,
      unhandledErrorCount: unhandledErrors.length,
    });
    this.appendEvent({
      completedModules: this.durations.length,
      event: 'run-end',
      reason,
      totalModules: testModules.length,
      unhandledErrorCount: unhandledErrors.length,
    });
  }
}
