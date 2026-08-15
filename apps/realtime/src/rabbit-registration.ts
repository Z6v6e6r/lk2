export class RabbitRegistrationInvalidatedError extends Error {
  constructor() {
    super('RABBITMQ_CONSUMER_INVALIDATED_DURING_REGISTRATION');
    this.name = 'RabbitRegistrationInvalidatedError';
  }
}

export async function registerRabbitConsumersAtomically(options: {
  readonly registerMessaging: () => Promise<unknown>;
  readonly registerCommunity?: () => Promise<unknown>;
  readonly isGenerationActive: () => boolean;
  readonly markReady: () => void;
}): Promise<void> {
  await options.registerMessaging();
  if (!options.isGenerationActive()) throw new RabbitRegistrationInvalidatedError();
  if (options.registerCommunity) {
    await options.registerCommunity();
    if (!options.isGenerationActive()) throw new RabbitRegistrationInvalidatedError();
  }
  options.markReady();
}
