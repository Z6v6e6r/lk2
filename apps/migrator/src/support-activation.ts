import {
  readSupportPackagedMigrations,
  runSupportActivation,
  type SupportActivationBinding,
  type SupportActivationMode,
} from './support-activation-runner.js';
try {
  if (
    process.argv.length !== 3 ||
    !process.env.DATABASE_URL ||
    !process.env.PHUB_SUPPORT_ACTIVATION_BINDING
  )
    throw Error();
  const binding = JSON.parse(
    process.env.PHUB_SUPPORT_ACTIVATION_BINDING,
  ) as SupportActivationBinding;
  const result = await runSupportActivation(
    process.argv[2] as SupportActivationMode,
    binding,
    process.env.DATABASE_URL,
    await readSupportPackagedMigrations('migrations'),
  );
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch {
  // Never expose SQL/connection strings, support text or personal data through container logs.
  process.stderr.write('SUPPORT_ACTIVATION_STOP\n');
  process.exitCode = 1;
}
