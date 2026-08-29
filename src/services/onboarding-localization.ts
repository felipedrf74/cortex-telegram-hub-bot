// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { Lang } from '../utils/i18n';
import type { QuestionnaireDefinition, QuestionStep } from './onboarding';

type LocalizedQuestionnaire = Omit<QuestionnaireDefinition, 'steps'> & {
  steps: Array<QuestionStep & { optionLabels?: string[] }>;
};

const PT_PT_TITLES: Record<string, { title: string; description: string }> = {
  fitness: {
    title: '🏋️ Perfil fitness',
    description: 'Configura o teu perfil de treino para coaching personalizado',
  },
  'triathlon-gym': {
    title: '🏋️ Perfil de força',
    description: 'Conta ao coach de ginásio qual é a tua experiência com treino de força',
  },
  'triathlon-running': {
    title: '🏃 Perfil de corrida',
    description: 'Conta ao coach de corrida qual é a tua experiência atual',
  },
  'triathlon-cycling': {
    title: '🚴 Perfil de ciclismo',
    description: 'Conta ao coach de ciclismo qual é a tua experiência em cima da bicicleta',
  },
  'triathlon-swim': {
    title: '🏊 Perfil de natação',
    description: 'Conta ao coach de natação qual é a tua experiência na água',
  },
};

const PT_PT_QUESTIONS: Record<string, Record<string, string>> = {
  fitness: {
    experience_level: 'Qual é o teu nível de experiência com treino?',
    weekly_frequency: 'Quantos dias por semana treinas?',
    preferred_training_days: 'Em que dias preferes treinar? (por exemplo: segunda-feira, quarta-feira e sábado)',
    blocked_days: 'Há algum dia que o coach deva evitar? (escreve «nenhum» se não houver)',
    training_goals: 'Quais são os teus principais objetivos de treino?',
    injuries: 'Tens alguma lesão ou limitação atual? (escreve «nenhum» se não houver)',
    available_equipment: 'A que equipamento tens acesso?',
  },
  'triathlon-gym': {
    training_age: 'Há quanto tempo treinas força a sério?',
    current_split: 'Que divisão de treino preferes?',
    primary_goal: 'Qual é o teu principal objetivo no ginásio neste momento?',
    squat_1rm_kg: 'Qual é o teu 1RM aproximado de agachamento em kg? (faz uma estimativa; escreve 0 se fores principiante)',
    bench_1rm_kg: 'Qual é o teu 1RM aproximado de supino em kg? (faz uma estimativa; escreve 0 se fores principiante)',
    deadlift_1rm_kg: 'Qual é o teu 1RM aproximado de levantamento terra em kg? (faz uma estimativa; escreve 0 se fores principiante)',
    sessions_per_week: 'Quantas sessões de ginásio podes fazer por semana?',
    preferred_training_days: 'Em que dias preferes treinar força? (por exemplo: segunda-feira, quarta-feira e sexta-feira)',
    blocked_days: 'Há algum dia que o coach de força deva evitar? (escreve «nenhum» se não houver)',
    equipment_access: 'A que equipamento de ginásio tens acesso?',
    session_duration_minutes: 'Quantos minutos podes dedicar normalmente a cada sessão de ginásio?',
  },
  'triathlon-running': {
    weekly_mileage_km: 'Qual é a tua quilometragem semanal atual? (escreve 0 se estiveres a começar)',
    longest_recent_run_km: 'Qual foi a tua corrida mais longa no último mês, em km?',
    easy_pace_min_per_km: 'Qual é o teu ritmo confortável em min/km? (por exemplo: 6:00)',
    target_race: 'Qual é a tua próxima prova-alvo?',
    target_race_date: 'Qual é a data da prova-alvo? (AAAA-MM-DD ou «nenhum»)',
    preferred_workouts: 'Que tipos de treino gostas mais de fazer?',
    injury_history: 'Tiveste alguma lesão relacionada com corrida nos últimos 12 meses? (escreve «nenhum» se não houver)',
    weekly_availability_days: 'Quantos dias por semana podes correr?',
    preferred_training_days: 'Em que dias preferes correr? (por exemplo: terça-feira, quinta-feira e domingo)',
    blocked_days: 'Há algum dia que o coach de corrida deva evitar? (escreve «nenhum» se não houver)',
  },
  'triathlon-cycling': {
    ftp_watts: 'Qual é o teu FTP atual em watts? (escreve 0 se não souberes; podemos estimá-lo)',
    weekly_hours: 'Quantas horas por semana costumas pedalar?',
    primary_discipline: 'Que tipo de ciclismo praticas mais?',
    target_event: 'Qual é o teu próximo evento-alvo?',
    power_meter: 'Treinas com medidor de potência?',
    terrain_preference: 'Que tipo de terreno preferes?',
    weekly_availability_days: 'Quantos dias por semana podes pedalar?',
    preferred_training_days: 'Em que dias preferes pedalar? (por exemplo: quarta-feira, sábado e domingo)',
    blocked_days: 'Há algum dia que o coach de ciclismo deva evitar? (escreve «nenhum» se não houver)',
  },
  'triathlon-swim': {
    experience: 'Qual é a tua experiência na natação?',
    primary_stroke: 'Em que estilo te sentes mais confortável?',
    time_400m_freestyle_min: 'Qual é o teu tempo aproximado nos 400 m livres? (mm:ss ou «desconhecido»)',
    pool_access: 'A que tipo de piscina tens acesso?',
    goal: 'Qual é o teu principal objetivo na natação?',
    sessions_per_week: 'Quantas sessões de natação podes fazer por semana?',
    preferred_training_days: 'Em que dias preferes nadar? (por exemplo: segunda-feira e sexta-feira)',
    blocked_days: 'Há algum dia que o coach de natação deva evitar? (escreve «nenhum» se não houver)',
    equipment_access: 'A que equipamento de natação tens acesso?',
  },
};

const PT_PT_OPTIONS: Record<string, string> = {
  'Beginner (< 1 year)': 'Iniciante (< 1 ano)',
  'Intermediate (1-3 years)': 'Intermédio (1-3 anos)',
  'Advanced (3+ years)': 'Avançado (3+ anos)',
  '2-3 days': '2-3 dias',
  '4-5 days': '4-5 dias',
  '6+ days': '6+ dias',
  Strength: 'Força',
  Hypertrophy: 'Hipertrofia',
  Endurance: 'Resistência',
  'Weight loss': 'Perda de peso',
  'General fitness': 'Condição física geral',
  'Full gym': 'Ginásio completo',
  'Home gym (basic)': 'Ginásio em casa (básico)',
  'Bodyweight only': 'Só peso corporal',
  'Resistance bands': 'Bandas elásticas',
  '< 1 year': '< 1 ano',
  '1-3 years': '1-3 anos',
  '3-5 years': '3-5 anos',
  '5+ years': '5+ anos',
  'Full body': 'Corpo inteiro',
  'Upper/Lower': 'Superior/Inferior',
  'Push-Pull-Legs': 'Empurrar-Puxar-Pernas',
  'Body part split': 'Divisão por grupo muscular',
  'No preference': 'Sem preferência',
  'Strength (1RM)': 'Força (1RM)',
  Powerlifting: 'Powerlifting',
  'Support other sports': 'Apoiar outros desportos',
  'Full commercial gym': 'Ginásio comercial completo',
  'Garage gym (barbell + rack)': 'Ginásio na garagem (barra + rack)',
  'None — general fitness': 'Nenhuma — condição física geral',
  'Easy runs': 'Corridas fáceis',
  Tempo: 'Ritmo sustentado',
  Intervals: 'Intervalos',
  'Long runs': 'Corridas longas',
  Hills: 'Subidas',
  Trail: 'Trail',
  '< 3 hours': '< 3 horas',
  '3-6 hours': '3-6 horas',
  '6-10 hours': '6-10 horas',
  '10+ hours': '10+ horas',
  Road: 'Estrada',
  Gravel: 'Gravel',
  MTB: 'BTT',
  'Indoor trainer': 'Rolo de treino interior',
  Commute: 'Deslocações',
  Mixed: 'Misto',
  'Road race': 'Corrida de estrada',
  'Time trial': 'Contrarrelógio',
  'Gran fondo': 'Gran fondo',
  'Gravel event': 'Prova de gravel',
  'Triathlon bike leg': 'Segmento de ciclismo de triatlo',
  None: 'Nenhum',
  'Yes — outdoor + indoor': 'Sim — exterior e interior',
  'Indoor only (smart trainer)': 'Apenas interior (rolo inteligente)',
  'No — HR + RPE': 'Não — FC + RPE',
  Flat: 'Plano',
  'Rolling hills': 'Ondulado',
  Mountains: 'Montanha',
  'Total beginner': 'Principiante total',
  Recreational: 'Recreativo',
  'Fitness swimmer': 'Nadador de fitness',
  'Competitive (past or current)': 'Competitivo (no passado ou atualmente)',
  Freestyle: 'Livres',
  Backstroke: 'Costas',
  Breaststroke: 'Bruços',
  Butterfly: 'Mariposa',
  'Equally comfortable': 'Igualmente à vontade em todos',
  '25m indoor': 'Piscina interior de 25 m',
  '50m indoor': 'Piscina interior de 50 m',
  '25m outdoor': 'Piscina exterior de 25 m',
  '50m outdoor': 'Piscina exterior de 50 m',
  'Open water': 'Águas abertas',
  'Limited/none': 'Acesso limitado ou inexistente',
  Fitness: 'Forma física',
  'Technique improvement': 'Melhorar a técnica',
  'Distance event': 'Prova de distância',
  'Triathlon swim leg': 'Segmento de natação de triatlo',
  Competition: 'Competição',
  'Pull buoy': 'Flutuador de pernas',
  Paddles: 'Palas',
  Fins: 'Barbatanas',
  Snorkel: 'Tubo frontal',
  Kickboard: 'Prancha',
  'Tempo trainer': 'Metrónomo de natação',
  'None yet': 'Ainda nenhum',
};

/** Localize display copy while preserving canonical option values for writes. */
export function localizeOnboardingQuestionnaire(
  questionnaire: QuestionnaireDefinition,
  language: Lang,
): LocalizedQuestionnaire {
  if (language !== 'pt-PT') return questionnaire;

  const questionnaireCopy = PT_PT_TITLES[questionnaire.id];
  const questions = PT_PT_QUESTIONS[questionnaire.id] ?? {};
  return {
    ...questionnaire,
    title: questionnaireCopy?.title ?? questionnaire.title,
    description: questionnaireCopy?.description ?? questionnaire.description,
    steps: questionnaire.steps.map((step) => ({
      ...step,
      prompt: questions[step.key] ?? step.prompt,
      optionLabels: step.options?.map((option) => PT_PT_OPTIONS[option] ?? option),
    })),
  };
}
