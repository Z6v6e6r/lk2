export const PADEL_LEVEL_ASSESSMENT_VERSION = 'padel-self-assessment-v1' as const;

export interface LevelAssessmentOption {
  readonly id: string;
  readonly label: string;
}

export interface LevelAssessmentQuestion {
  readonly id: string;
  readonly text: string;
  readonly type: 'single' | 'multi';
  readonly options: readonly LevelAssessmentOption[];
}

export interface LevelAssessmentDefinition {
  readonly version: typeof PADEL_LEVEL_ASSESSMENT_VERSION;
  readonly sportCode: 'PADEL';
  readonly baseQuestionId: 'q1_1';
  readonly questions: readonly LevelAssessmentQuestion[];
  readonly branches: Readonly<Record<string, readonly string[]>>;
}

export type LevelAssessmentAnswers = Readonly<Record<string, readonly string[]>>;

export type LevelAssessmentResult =
  | {
      readonly outcome: 'completed';
      readonly version: typeof PADEL_LEVEL_ASSESSMENT_VERSION;
      readonly numericScore: number;
      readonly levelCode: 'D' | 'D+' | 'C' | 'C+' | 'B' | 'B+' | 'A';
    }
  | {
      readonly outcome: 'invalid';
      readonly reason: 'VERSION_UNSUPPORTED' | 'ANSWER_SET_INVALID';
    };

type ScoreOperation =
  | { readonly type: 'add'; readonly value: number }
  | { readonly type: 'multiply'; readonly value: number };

interface ScoredOption extends LevelAssessmentOption {
  readonly base?: number;
  readonly operation?: ScoreOperation;
  readonly cap?: number;
}

interface ScoredQuestion extends Omit<LevelAssessmentQuestion, 'options'> {
  readonly options: readonly ScoredOption[];
}

const q = (
  id: string,
  text: string,
  type: 'single' | 'multi',
  options: readonly ScoredOption[],
): ScoredQuestion => ({ id, text, type, options });

const add = (id: string, label: string, value: number, cap?: number): ScoredOption => ({
  id,
  label,
  operation: { type: 'add', value },
  ...(cap === undefined ? {} : { cap }),
});
const multiply = (id: string, label: string, value: number): ScoredOption => ({
  id,
  label,
  operation: { type: 'multiply', value },
});

const QUESTIONS: readonly ScoredQuestion[] = [
  q('q1_1', 'Опыт игры', 'single', [
    { id: 'less_month', label: 'Меньше месяца', base: 1 },
    { id: 'less_year', label: 'Меньше года', base: 2 },
    { id: 'one_two_years', label: '1–2 года', base: 2.5 },
    { id: 'more_three_years', label: 'Больше 3-х лет', base: 3.5 },
  ]),
  q('q1_2', 'Был ли опыт в теннисе, сквоше, бадминтоне?', 'single', [
    add('no', 'Нет', 0),
    add('less_year', 'Меньше года', 0.3),
    add('more_year', 'Больше года', 1),
    add('prize', 'Был призером', 2),
  ]),
  q('q1_3', 'Какова ваша основная цель? (можно выбрать несколько)', 'multi', [
    add('try_new', 'Попробовать новое', 0),
    add('fitness', 'Улучшить физ. подготовку', 0.1),
    add('community', 'Найти новое сообщество/общение', 0),
    add('progress', 'В перспективе тренироваться и прогрессировать', 0.2),
  ]),
  q('q1_4', 'Насколько уверенно вы чувствуете себя в координационных видах спорта?', 'single', [
    add('hard', 'Обычно сложно дается', 0),
    add('middle', 'Средне', 0.1),
    add('fast', 'Быстро осваиваю', 0.25),
  ]),
  q('q1_5', 'Оцените свою физическую форму', 'single', [
    add('rest', 'Сидеть и отдыхать', 0),
    add('sometimes', 'Иногда активен', 0.15),
    add('regular', 'Регулярно тренируюсь', 0.25),
  ]),
  q('q2_2', 'Тренировались ли с тренером?', 'single', [
    multiply('no', 'Нет', 1),
    multiply('few', 'Пару раз', 1.1),
    multiply('regular', 'Да, на постоянной основе', 1.2),
  ]),
  q('q2_3', 'Ваши основные удары (бандэха, вибора)?', 'single', [
    multiply('learn', 'Осваиваю, часто ошибаюсь', 0.95),
    multiply('ok', 'Выполняю, но без точности', 1),
    multiply('stable', 'Стабильно попадаю в игру', 1.1),
  ]),
  q('q2_4', 'Как часто играете у сетки?', 'single', [
    multiply('back', 'Предпочитаю играть с задней линии', 0.95),
    multiply('sometimes', 'Иногда выхожу', 1),
    multiply('net', 'Стараюсь занимать сетку при возможности', 1.1),
  ]),
  q('q2_5', 'Сколько игр в месяц?', 'single', [
    multiply('1_3', '1–3', 0.9),
    multiply('4_8', '4–8', 1),
    multiply('8_plus', '>8', 1.1),
  ]),
  q('q3_1', 'Как оцениваете свой уровень?', 'single', [
    add('2_3', '2–3', 0, 3),
    add('3_4', '3–4', 0.5, 4),
    add('4_5', '4–5', 1.5, 5),
    add('5_6', '5–6', 2.5, 6),
  ]),
  q('q3_2', 'Есть опыт участия в турнирах?', 'single', [
    multiply('yes', 'Да', 1.1),
    multiply('no', 'Нет', 1),
  ]),
  q('q3_3', 'Используете ли вы свечу (лоб) как тактическое оружие?', 'single', [
    multiply('rare', 'Редко', 0.95),
    multiply('sometimes', 'Иногда, чтобы выиграть время', 1),
    multiply('regular', 'Регулярно, чтобы сместить соперников с сетки', 1.1),
  ]),
  q('q3_4', 'Владеете ударом с задней стенки (contrapared)?', 'single', [
    multiply('no', 'Нет', 0.95),
    multiply('unstable', 'Пробую, но нестабильно', 1),
    multiply('yes', 'Да, уверенно', 1.1),
  ]),
  q('q3_5', 'Сколько игр в месяц?', 'single', [
    multiply('1_4', '1–4', 0.85),
    multiply('4_8', '4–8', 1),
    multiply('8_plus', '>8', 1.1),
  ]),
  q('q3_6', 'Сколько турниров в месяц?', 'single', [
    multiply('0', '0', 0.9),
    multiply('1_3', '1–3', 1),
    multiply('3_plus', '>3', 1.1),
  ]),
  q('q4_1', 'Как оцениваете свой уровень игры?', 'single', [
    add('2_3', '2–3', -1, 3),
    add('3_4', '3–4', 0, 4),
    add('4_5', '4–5', 1, 5),
    add('5_6', '5–6', 2, 6),
  ]),
  q('q4_2', 'Ваш коронный удар / тактическая схема?', 'single', [
    multiply('none', 'Нет явного коронного', 1),
    multiply('net', 'Игра от сетки (бандэха, вибора)', 1.05),
    multiply('attack', 'Атакующая игра (смэш, х3)', 1.05),
    multiply('tactical', 'Тактическая игра (свечи, низкие отскоки)', 1.1),
  ]),
  q('q4_3', 'Как вы работаете в паре?', 'single', [
    multiply('solo', 'Каждый сам за себя', 0.95),
    multiply('cover', 'Стараемся подстраховывать', 1),
    multiply('schemes', 'Используем простые схемы (смена позиций)', 1.05),
    multiply('combos', 'Имеем отработанные комбинации', 1.1),
  ]),
  q('q4_4', 'Насколько ваша игра вариативна?', 'single', [
    multiply('style', 'Играю в своем стиле', 1),
    multiply('tempo', 'Могу менять темп и тактику по ходу матча', 1.1),
  ]),
  q('q4_5', 'Сколько игр в месяц?', 'single', [
    multiply('1_4', '1–4', 0.9),
    multiply('4_8', '4–8', 1),
    multiply('8_plus', '>8', 1.1),
  ]),
  q('q4_6', 'Сколько турниров в месяц?', 'single', [
    multiply('0', '0', 0.9),
    multiply('1_3', '1–3', 1),
    multiply('3_plus', '>3', 1.1),
  ]),
] as const;

const BRANCHES: Readonly<Record<string, readonly string[]>> = {
  less_month: ['q1_2', 'q1_3', 'q1_4', 'q1_5'],
  less_year: ['q2_2', 'q2_3', 'q2_4', 'q2_5'],
  one_two_years: ['q3_1', 'q3_2', 'q3_3', 'q3_4', 'q3_5', 'q3_6'],
  more_three_years: ['q4_1', 'q4_2', 'q4_3', 'q4_4', 'q4_5', 'q4_6'],
};

export const PADEL_LEVEL_ASSESSMENT_DEFINITION: LevelAssessmentDefinition = {
  version: PADEL_LEVEL_ASSESSMENT_VERSION,
  sportCode: 'PADEL',
  baseQuestionId: 'q1_1',
  questions: QUESTIONS.map((question) => ({
    id: question.id,
    text: question.text,
    type: question.type,
    options: question.options.map(({ id, label }) => ({ id, label })),
  })),
  branches: BRANCHES,
};

function stringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || value.some((item: unknown) => typeof item !== 'string')) {
    return undefined;
  }
  return value as readonly string[];
}

function levelCode(score: number): LevelAssessmentResult & { readonly outcome: 'completed' } {
  const code =
    score < 2
      ? 'D'
      : score < 3
        ? 'D+'
        : score < 3.5
          ? 'C'
          : score < 4
            ? 'C+'
            : score < 4.7
              ? 'B'
              : score < 5.5
                ? 'B+'
                : 'A';
  return {
    outcome: 'completed',
    version: PADEL_LEVEL_ASSESSMENT_VERSION,
    numericScore: Number(score.toFixed(5)),
    levelCode: code,
  };
}

export function evaluatePadelLevelAssessment(
  version: string,
  answers: LevelAssessmentAnswers,
): LevelAssessmentResult {
  if (version !== PADEL_LEVEL_ASSESSMENT_VERSION) {
    return { outcome: 'invalid', reason: 'VERSION_UNSUPPORTED' };
  }
  const baseAnswers = stringArray(answers.q1_1);
  if (!baseAnswers || baseAnswers.length !== 1) {
    return { outcome: 'invalid', reason: 'ANSWER_SET_INVALID' };
  }
  const branch = BRANCHES[baseAnswers[0] ?? ''];
  if (!branch) return { outcome: 'invalid', reason: 'ANSWER_SET_INVALID' };
  const questionIds = ['q1_1', ...branch];
  if (
    Object.keys(answers).length !== questionIds.length ||
    Object.keys(answers).some((id) => !questionIds.includes(id))
  ) {
    return { outcome: 'invalid', reason: 'ANSWER_SET_INVALID' };
  }

  let score = 0;
  let cap: number | undefined;
  for (const questionId of questionIds) {
    const question = QUESTIONS.find((candidate) => candidate.id === questionId);
    const selected = stringArray(answers[questionId]);
    if (!question || !selected) {
      return { outcome: 'invalid', reason: 'ANSWER_SET_INVALID' };
    }
    if (
      selected.length === 0 ||
      (question.type === 'single' && selected.length !== 1) ||
      selected.length > question.options.length ||
      new Set(selected).size !== selected.length
    ) {
      return { outcome: 'invalid', reason: 'ANSWER_SET_INVALID' };
    }
    for (const optionId of selected) {
      const option = question.options.find((candidate) => candidate.id === optionId);
      if (!option) return { outcome: 'invalid', reason: 'ANSWER_SET_INVALID' };
      if (questionId === 'q1_1') {
        if (option.base === undefined) return { outcome: 'invalid', reason: 'ANSWER_SET_INVALID' };
        score = option.base;
        continue;
      }
      if (!option.operation) return { outcome: 'invalid', reason: 'ANSWER_SET_INVALID' };
      score =
        option.operation.type === 'add'
          ? score + option.operation.value
          : score * option.operation.value;
      if (option.cap !== undefined) cap = option.cap;
    }
  }
  if (cap !== undefined) score = Math.min(score, cap);
  return Number.isFinite(score)
    ? levelCode(score)
    : { outcome: 'invalid', reason: 'ANSWER_SET_INVALID' };
}
