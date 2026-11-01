import type {
  VivaExerciseRecommendationSourceAdapter,
  VivaExerciseRecommendation,
} from '@phub/viva-adapter';

export interface TrainingCatalogueActor {
  readonly tenantKey: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly sessionId: string;
  readonly correlationId: string;
}
export interface TrainingCatalogueSource {
  read(input: TrainingCatalogueActor & { readonly dates: readonly string[] }): Promise<{
    readonly activities: readonly VivaExerciseRecommendation[];
    readonly completedDates: readonly string[];
  }>;
}

/** One bounded complete-day consumer; credentials and private IDs never enter catalogue DTOs. */
export function createTrainingCatalogueSource(options: {
  readonly access: (actor: TrainingCatalogueActor) => Promise<{
    readonly accessToken: string;
    readonly providerTenantKey: string;
  }>;
  readonly adapter: (
    providerTenantKey: string,
  ) => Pick<VivaExerciseRecommendationSourceAdapter, 'readCompleteTrainingDate'>;
  readonly budgetMs?: number;
}): TrainingCatalogueSource {
  return {
    async read(input) {
      const signal = AbortSignal.timeout(options.budgetMs ?? 12_000);
      const abort = new Promise<never>((_, reject) => {
        signal.addEventListener(
          'abort',
          () => reject(new Error('TRAINING_CATALOGUE_UNAVAILABLE')),
          { once: true },
        );
      });
      const work = async () => {
        const access = await options.access(input);
        signal.throwIfAborted();
        const adapter = options.adapter(access.providerTenantKey);
        const pages = await Promise.allSettled(
          input.dates.map(async (date) => ({
            date,
            activities: await adapter.readCompleteTrainingDate({
              date,
              accessToken: access.accessToken,
              correlationId: input.correlationId,
              signal,
            }),
          })),
        );
        signal.throwIfAborted();
        const complete = pages.flatMap((page) => (page.status === 'fulfilled' ? [page.value] : []));
        if (complete.length === 0) throw new Error('TRAINING_CATALOGUE_UNAVAILABLE');
        return {
          activities: complete.flatMap((page) => page.activities),
          completedDates: complete.map((page) => page.date),
        };
      };
      return await Promise.race([work(), abort]);
    },
  };
}
