// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { Lang } from '../utils/i18n';
import type { QuestionnaireDefinition, QuestionStep } from './onboarding';

export type LocalizedOnboardingStep = QuestionStep & { optionLabels?: string[] };
export type LocalizedOnboardingQuestionnaire = Omit<QuestionnaireDefinition, 'steps'> & {
  steps: LocalizedOnboardingStep[];
};

type CopyPack = {
  titles: Record<string, { title: string; description: string }>;
  questions: Record<string, Record<string, string>>;
  options: Record<string, string>;
};

const PT_PT: CopyPack = {
  titles: {
    fitness: { title: '🏋️ Perfil fitness', description: 'Configura o teu perfil de treino para coaching personalizado' },
    'triathlon-gym': { title: '🏋️ Perfil de força', description: 'Conta ao coach de ginásio qual é a tua experiência com treino de força' },
    'triathlon-running': { title: '🏃 Perfil de corrida', description: 'Conta ao coach de corrida qual é a tua experiência atual' },
    'triathlon-cycling': { title: '🚴 Perfil de ciclismo', description: 'Conta ao coach de ciclismo qual é a tua experiência em cima da bicicleta' },
    'triathlon-swim': { title: '🏊 Perfil de natação', description: 'Conta ao coach de natação qual é a tua experiência na água' },
  },
  questions: {
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
  },
  options: {},
};

const PT_BR: CopyPack = {
  titles: {
    fitness: { title: '🏋️ Perfil fitness', description: 'Configure seu perfil de treino para receber orientação personalizada' },
    'triathlon-gym': { title: '🏋️ Perfil de força', description: 'Conte ao coach de academia sobre sua experiência com treino de força' },
    'triathlon-running': { title: '🏃 Perfil de corrida', description: 'Conte ao coach de corrida sobre sua experiência atual' },
    'triathlon-cycling': { title: '🚴 Perfil de ciclismo', description: 'Conte ao coach de ciclismo sobre sua experiência na bicicleta' },
    'triathlon-swim': { title: '🏊 Perfil de natação', description: 'Conte ao coach de natação sobre sua experiência na água' },
  },
  questions: {
    fitness: {
      experience_level: 'Qual é o seu nível de experiência com treino?',
      weekly_frequency: 'Quantos dias por semana você treina?',
      preferred_training_days: 'Em quais dias você prefere treinar? (por exemplo: segunda, quarta e sábado)',
      blocked_days: 'Há algum dia que o coach deve evitar? (digite “nenhum” se não houver)',
      training_goals: 'Quais são seus principais objetivos de treino?',
      injuries: 'Você tem alguma lesão ou limitação atual? (digite “nenhuma” se não houver)',
      available_equipment: 'A quais equipamentos você tem acesso?',
    },
    'triathlon-gym': {
      training_age: 'Há quanto tempo você treina força de forma consistente?',
      current_split: 'Qual divisão de treino você prefere?',
      primary_goal: 'Qual é seu principal objetivo na academia agora?',
      squat_1rm_kg: 'Qual é seu 1RM aproximado no agachamento em kg? (faça uma estimativa; digite 0 se estiver começando)',
      bench_1rm_kg: 'Qual é seu 1RM aproximado no supino em kg? (faça uma estimativa; digite 0 se estiver começando)',
      deadlift_1rm_kg: 'Qual é seu 1RM aproximado no levantamento terra em kg? (faça uma estimativa; digite 0 se estiver começando)',
      sessions_per_week: 'Quantas sessões de academia você consegue fazer por semana?',
      preferred_training_days: 'Em quais dias você prefere treinar força? (por exemplo: segunda, quarta e sexta)',
      blocked_days: 'Há algum dia que o coach de força deve evitar? (digite “nenhum” se não houver)',
      equipment_access: 'A quais equipamentos de academia você tem acesso?',
      session_duration_minutes: 'Quantos minutos você normalmente pode dedicar a cada sessão de academia?',
    },
    'triathlon-running': {
      weekly_mileage_km: 'Qual é sua quilometragem semanal atual? (digite 0 se estiver começando)',
      longest_recent_run_km: 'Qual foi sua corrida mais longa no último mês, em km?',
      easy_pace_min_per_km: 'Qual é seu ritmo confortável em min/km? (por exemplo: 6:00)',
      target_race: 'Qual é sua próxima prova-alvo?',
      target_race_date: 'Qual é a data da prova-alvo? (AAAA-MM-DD ou “nenhuma”)',
      preferred_workouts: 'Quais tipos de treino você mais gosta de fazer?',
      injury_history: 'Você teve alguma lesão relacionada à corrida nos últimos 12 meses? (digite “nenhuma” se não)',
      weekly_availability_days: 'Quantos dias por semana você pode correr?',
      preferred_training_days: 'Em quais dias você prefere correr? (por exemplo: terça, quinta e domingo)',
      blocked_days: 'Há algum dia que o coach de corrida deve evitar? (digite “nenhum” se não houver)',
    },
    'triathlon-cycling': {
      ftp_watts: 'Qual é seu FTP atual em watts? (digite 0 se não souber; podemos estimar)',
      weekly_hours: 'Quantas horas por semana você costuma pedalar?',
      primary_discipline: 'Qual tipo de ciclismo você pratica mais?',
      target_event: 'Qual é seu próximo evento-alvo?',
      power_meter: 'Você treina com medidor de potência?',
      terrain_preference: 'Qual tipo de terreno você prefere?',
      weekly_availability_days: 'Quantos dias por semana você pode pedalar?',
      preferred_training_days: 'Em quais dias você prefere pedalar? (por exemplo: quarta, sábado e domingo)',
      blocked_days: 'Há algum dia que o coach de ciclismo deve evitar? (digite “nenhum” se não houver)',
    },
    'triathlon-swim': {
      experience: 'Qual é sua experiência com natação?',
      primary_stroke: 'Em qual estilo você se sente mais confortável?',
      time_400m_freestyle_min: 'Qual é seu tempo aproximado nos 400 m livre? (mm:ss ou “desconhecido”)',
      pool_access: 'A qual tipo de piscina você tem acesso?',
      goal: 'Qual é seu principal objetivo na natação?',
      sessions_per_week: 'Quantas sessões de natação você consegue fazer por semana?',
      preferred_training_days: 'Em quais dias você prefere nadar? (por exemplo: segunda e sexta)',
      blocked_days: 'Há algum dia que o coach de natação deve evitar? (digite “nenhum” se não houver)',
      equipment_access: 'A quais equipamentos de natação você tem acesso?',
    },
  },
  options: {},
};

const COMMON_PT_OPTION_LABELS: Record<string, string> = {
  'Beginner (< 1 year)': 'Iniciante (< 1 ano)',
  'Intermediate (1-3 years)': 'Intermédio (1-3 anos)',
  'Advanced (3+ years)': 'Avançado (3+ anos)',
  '2-3 days': '2-3 dias', '4-5 days': '4-5 dias', '6+ days': '6+ dias',
  Strength: 'Força', Hypertrophy: 'Hipertrofia', Endurance: 'Resistência',
  'Weight loss': 'Perda de peso', 'General fitness': 'Condição física geral',
  'Full gym': 'Ginásio completo', 'Home gym (basic)': 'Ginásio em casa (básico)',
  'Bodyweight only': 'Só peso corporal', 'Resistance bands': 'Bandas elásticas',
  '< 1 year': '< 1 ano', '1-3 years': '1-3 anos', '3-5 years': '3-5 anos', '5+ years': '5+ anos',
  'Full body': 'Corpo inteiro', 'Upper/Lower': 'Superior/Inferior',
  'Push-Pull-Legs': 'Empurrar-Puxar-Pernas', 'Body part split': 'Divisão por grupo muscular',
  'No preference': 'Sem preferência', 'Strength (1RM)': 'Força (1RM)',
  'Support other sports': 'Apoiar outros desportos',
  'Full commercial gym': 'Ginásio comercial completo',
  'Garage gym (barbell + rack)': 'Ginásio na garagem (barra + rack)',
  'None — general fitness': 'Nenhuma — condição física geral',
  'Easy runs': 'Corridas fáceis', Tempo: 'Ritmo sustentado', Intervals: 'Intervalos',
  'Long runs': 'Corridas longas', Hills: 'Subidas',
  '< 3 hours': '< 3 horas', '3-6 hours': '3-6 horas', '6-10 hours': '6-10 horas', '10+ hours': '10+ horas',
  Road: 'Estrada', 'Indoor trainer': 'Rolo de treino interior', Commute: 'Deslocações', Mixed: 'Misto',
  'Road race': 'Corrida de estrada', 'Time trial': 'Contrarrelógio', 'Gravel event': 'Prova de gravel',
  'Triathlon bike leg': 'Segmento de ciclismo de triatlo', None: 'Nenhum',
  'Yes — outdoor + indoor': 'Sim — exterior e interior',
  'Indoor only (smart trainer)': 'Apenas interior (rolo inteligente)', 'No — HR + RPE': 'Não — FC + RPE',
  Flat: 'Plano', 'Rolling hills': 'Ondulado', Mountains: 'Montanha',
  'Total beginner': 'Principiante total', Recreational: 'Recreativo', 'Fitness swimmer': 'Nadador de fitness',
  'Competitive (past or current)': 'Competitivo (no passado ou atualmente)',
  Freestyle: 'Livres', Backstroke: 'Costas', Breaststroke: 'Bruços', Butterfly: 'Mariposa',
  'Equally comfortable': 'Igualmente à vontade em todos',
  '25m indoor': 'Piscina interior de 25 m', '50m indoor': 'Piscina interior de 50 m',
  '25m outdoor': 'Piscina exterior de 25 m', '50m outdoor': 'Piscina exterior de 50 m',
  'Open water': 'Águas abertas', 'Limited/none': 'Acesso limitado ou inexistente',
  Fitness: 'Forma física', 'Technique improvement': 'Melhorar a técnica',
  'Distance event': 'Prova de distância', 'Triathlon swim leg': 'Segmento de natação de triatlo',
  Competition: 'Competição', 'Pull buoy': 'Flutuador de pernas', Paddles: 'Palas',
  Fins: 'Barbatanas', Snorkel: 'Tubo frontal', Kickboard: 'Prancha',
  'Tempo trainer': 'Metrónomo de natação', 'None yet': 'Ainda nenhum',
};

PT_PT.options = COMMON_PT_OPTION_LABELS;
PT_BR.options = {
  ...COMMON_PT_OPTION_LABELS,
  'Intermediate (1-3 years)': 'Intermediário (1-3 anos)',
  'Full gym': 'Academia completa',
  'Home gym (basic)': 'Academia em casa (básica)',
  'Full commercial gym': 'Academia comercial completa',
  'Garage gym (barbell + rack)': 'Academia na garagem (barra + rack)',
  'Support other sports': 'Dar suporte a outros esportes',
  'Indoor trainer': 'Rolo de treino indoor',
  'Total beginner': 'Iniciante total',
  Freestyle: 'Livre', Breaststroke: 'Peito', Butterfly: 'Borboleta',
  Fins: 'Nadadeiras', Paddles: 'Palmares',
  'Tempo trainer': 'Metrônomo de natação', 'None yet': 'Nenhum ainda',
};

/** Localize display copy while preserving every canonical option value. */
export function localizeOnboardingQuestionnaire(
  questionnaire: QuestionnaireDefinition,
  language: Lang,
): LocalizedOnboardingQuestionnaire {
  if (language === 'en-US') return questionnaire;
  const copy = language === 'pt-PT' ? PT_PT : PT_BR;
  const header = copy.titles[questionnaire.id];
  const questions = copy.questions[questionnaire.id] ?? {};
  return {
    ...questionnaire,
    title: header?.title ?? questionnaire.title,
    description: header?.description ?? questionnaire.description,
    steps: questionnaire.steps.map((step) => ({
      ...step,
      prompt: questions[step.key] ?? step.prompt,
      optionLabels: step.options?.map((option) => copy.options[option] ?? option),
    })),
  };
}
