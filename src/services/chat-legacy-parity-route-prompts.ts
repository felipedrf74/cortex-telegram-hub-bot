// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

export type ChatV2LegacyParityRoutePromptTag =
  | 'ambiguous_cancel'
  | 'confirmation_cancel'
  | 'current_events'
  | 'decision_action'
  | 'destructive_write'
  | 'duplicate_title'
  | 'factual_lookup'
  | 'health_adjacent'
  | 'hypothetical'
  | 'product_comparison'
  | 'public_finance'
  | 'public_law'
  | 'negation'
  | 'recipe_generation'
  | 'research_safe_query'
  | 'science_research'
  | 'sports_stats'
  | 'task_create'
  | 'task_with_subtasks'
  | 'training_no_active_plan'
  | 'travel_weather'
  | 'domain_content'
  | 'domain_cooking'
  | 'domain_finance'
  | 'domain_secretary'
  | 'domain_training'
  | 'low_confidence_clarification'
  | 'write_read_collision';

export type ChatV2LegacyParitySupportedLanguage =
  | 'en'
  | 'pt-BR'
  | 'pt-PT'
  | 'pt-AO'
  | 'mixed';

export type ChatV2LegacyParityHistoricalLanguage =
  | ChatV2LegacyParitySupportedLanguage
  | 'es'
  | 'es-419';

type ChatV2LegacyParityRoutePromptForLanguage<Language extends string> = {
  routeId: string;
  oldOwner: string;
  replacement: string;
  evidenceTrack: 'preview_answer_parity' | 'write_firewall_bundle' | 'answer_quality_research';
  stateContract: 'shared_read_only_snapshot' | 'fresh_isolated_user_per_prompt';
  runtimeCoupling?: 'independent_read_route' | 'global_write_firewall' | 'classifier_domain_owner';
  minSamplesPerSubcase?: Record<string, number>;
  prompts: Array<{
    language: Language;
    text: string;
    tags?: ChatV2LegacyParityRoutePromptTag[];
  }>;
};

export type ChatV2LegacyParityRoutePrompt =
  Omit<
    ChatV2LegacyParityHistoricalRoutePrompt,
    'prompts'
  > & {
    prompts: Array<
      Omit<
        ChatV2LegacyParityHistoricalRoutePrompt['prompts'][number],
        'language'
      > & {
        /** Supported assistant response language used by parity scoring. */
        language: ChatV2LegacyParitySupportedLanguage;
        /** Supported language of the active authored user request. */
        requestLanguage: ChatV2LegacyParitySupportedLanguage;
      }
    >;
  };

export type ChatV2LegacyParityHistoricalRoutePrompt =
  ChatV2LegacyParityRoutePromptForLanguage<ChatV2LegacyParityHistoricalLanguage>;

export type ChatV2LegacyParityRetirementRoutePrompt =
  ChatV2LegacyParityRoutePromptForLanguage<'en' | 'pt-BR' | 'pt-PT'>;

export type ChatV2Phase7TargetRouteId =
  | 'classifier_route_skill_orchestration'
  | 'domain_handler_execution';

export type ChatV2Phase7PromptOwner =
  | 'deterministic_read'
  | 'local_chat_classifier'
  | 'low_confidence_clarification';

export type ChatV2Phase7DomainHandlerDomain =
  | 'cooking'
  | 'content'
  | 'training'
  | 'finance'
  | 'secretary';

export interface ChatV2Phase7PerDomainParityFloor {
  replacement: string;
  minSamples: number;
  minParity: number;
  answerQualityReviewRequired: true;
}

export interface ChatV2Phase7ClassifierRouteReadiness {
  routeId: 'classifier_route_skill_orchestration';
  answerQualityReviewRequired: true;
  recallAt8LanguageThresholds: Record<'en' | 'pt-BR' | 'pt-PT' | 'mixed', number>;
  promptOwnership: Array<{
    promptText: string;
    owner: ChatV2Phase7PromptOwner;
    expectedOutcome: 'read_model_answer' | 'answer_only' | 'clarification';
    notes: string;
  }>;
  requiredMissingCoverage: Array<'read_write_collision' | 'low_confidence_clarification' | 'owner_boundary_review'>;
  blockers: string[];
}

export interface ChatV2Phase7DomainHandlerReadiness {
  routeId: 'domain_handler_execution';
  answerQualityReviewRequired: true;
  replacementOrder: ChatV2Phase7DomainHandlerDomain[];
  perDomainParityFloors: Record<ChatV2Phase7DomainHandlerDomain, ChatV2Phase7PerDomainParityFloor>;
  cookingGenericityRule: string;
  blockers: string[];
}

export const CHAT_V2_LEGACY_PARITY_ROUTE_PROMPT_VERSION_V1_HISTORICAL =
  'chat_v2_legacy_parity_route_prompts@1.4.0';

export const CHAT_V2_LEGACY_PARITY_ROUTE_CORPUS_META_V1_HISTORICAL = {
  schemaVersion: 'chat_v2_legacy_parity_route_corpus_meta.v1',
  corpusId: 'chatv2_phase7_route_replacement_heldout',
  version: CHAT_V2_LEGACY_PARITY_ROUTE_PROMPT_VERSION_V1_HISTORICAL,
  frozenAt: '2026-06-02T00:00:00.000Z',
  frozenBeforeImplementation: true,
  mutationPolicy: 'claude_or_manual_signoff_required_before_runtime_replacement',
  reviewRubricVersion: 'chat_v2_legacy_parity_review_rubric.v2',
  notes: [
    'Route prompts are a held-out evidence corpus for replacement decisions, not implementation fixtures.',
    'Do not add happy-path-only prompts after implementation work without a separately signed corpus-change review.',
    'Write routes are coupled by the global action-gateway enforce switch and must use fresh isolated seeded users.',
    'answer_quality_research routes require distinct public-query prompts for runtime evidence; repeated prompt padding is not valid retirement evidence.',
    'independent_read_route prompts must be large enough for route-scoped >=50-row parity packages without prompt repetition.',
    'write_firewall_bundle route prompts must be large enough for coupled >=50-row write-gateway packages without prompt repetition.',
    'classifier/domain-handler prompts are coverage inputs only; they do not import labels or prove replaceability.',
  ],
} as const;

export const CHAT_V2_LEGACY_PARITY_ROUTE_PROMPTS_V1_HISTORICAL:
  ChatV2LegacyParityHistoricalRoutePrompt[] = [
  {
    routeId: 'general_action_planner',
    oldOwner: 'chat-action-planner.ts',
    replacement: 'ChatV2 command preview/write gateway',
    evidenceTrack: 'write_firewall_bundle',
    stateContract: 'fresh_isolated_user_per_prompt',
    runtimeCoupling: 'global_write_firewall',
    minSamplesPerSubcase: {
      task_create: 8,
      duplicate_title: 8,
      write_read_collision: 4,
    },
    prompts: [
      { language: 'en', text: 'Create a task called parity planner check', tags: ['task_create'] },
      { language: 'pt-BR', text: 'Crie uma tarefa chamada verificação de planejador' },
      { language: 'pt-PT', text: 'Cria uma tarefa chamada verificação de planeador' },
      { language: 'pt-AO', text: 'Cria uma tarefa chamada verificação do plano' },
      { language: 'es', text: 'Crea una tarea llamada verificación del planificador' },
      { language: 'es-419', text: 'Crea una tarea llamada revisión del planificador' },
      { language: 'mixed', text: 'Create uma tarefa chamada parity planner check' },
      { language: 'en', text: 'Mark duplicate title audit task as done', tags: ['duplicate_title'] },
      { language: 'pt-BR', text: 'Marque a tarefa duplicate title audit como concluída', tags: ['duplicate_title'] },
      { language: 'pt-PT', text: 'Marca a tarefa duplicate title audit como concluída', tags: ['duplicate_title'] },
      { language: 'es', text: 'Marca la tarea duplicate title audit como completada', tags: ['duplicate_title'] },
      { language: 'en', text: 'Add a task named confirm docs evidence packet', tags: ['task_create'] },
      { language: 'en', text: 'Create a task for reviewing the write firewall rollout', tags: ['task_create'] },
      { language: 'en', text: 'Make a new todo called verify tenant rollback switch', tags: ['task_create'] },
      { language: 'en', text: 'Add new task capture parity review notes', tags: ['task_create'] },
      { language: 'en', text: 'Create task to check action card copy tomorrow', tags: ['task_create'] },
      { language: 'pt-BR', text: 'Adiciona uma tarefa chamada revisar pacote de evidências', tags: ['task_create'] },
      { language: 'pt-BR', text: 'Crie tarefa para validar o firewall de escrita', tags: ['task_create'] },
      { language: 'pt-PT', text: 'Adiciona uma tarefa chamada rever evidência de paridade', tags: ['task_create'] },
      { language: 'pt-PT', text: 'Cria tarefa para confirmar o rollback do inquilino', tags: ['task_create'] },
      { language: 'pt-AO', text: 'Cria uma tarefa para rever o pacote de evidências', tags: ['task_create'] },
      { language: 'es', text: 'Crea una tarea llamada revisar evidencia de paridad', tags: ['task_create'] },
      { language: 'es', text: 'Crea una tarea para comprobar el firewall de escritura', tags: ['task_create'] },
      { language: 'es-419', text: 'Crear una tarea llamada revisar paquete de evidencia', tags: ['task_create'] },
      { language: 'mixed', text: 'Create tarefa para revisar rollback tenant', tags: ['task_create'] },
      { language: 'mixed', text: 'Add task chamada check write gateway logs', tags: ['task_create'] },
      { language: 'en', text: 'Mark parity planner duplicate review as complete', tags: ['duplicate_title'] },
      { language: 'en', text: 'Complete the duplicate title follow up task', tags: ['duplicate_title'] },
      { language: 'en', text: 'Check off the task named duplicate title audit', tags: ['duplicate_title'] },
      { language: 'en', text: 'Finish the task duplicate title audit before the review', tags: ['duplicate_title'] },
      { language: 'pt-BR', text: 'Conclua a tarefa revisão de título duplicado', tags: ['duplicate_title'] },
      { language: 'pt-BR', text: 'Marque a tarefa duplicate title follow up como concluída', tags: ['duplicate_title'] },
      { language: 'pt-PT', text: 'Conclui a tarefa revisão de título duplicado', tags: ['duplicate_title'] },
      { language: 'pt-AO', text: 'Marca a tarefa duplicate title audit como feita', tags: ['duplicate_title'] },
      { language: 'es', text: 'Completar la tarea revisión de título duplicado', tags: ['duplicate_title'] },
      { language: 'es-419', text: 'Completar la tarea duplicate title follow up', tags: ['duplicate_title'] },
      { language: 'mixed', text: 'Mark tarefa duplicate title audit como done', tags: ['duplicate_title'] },
      { language: 'en', text: 'Create a task after checking whether rollout review exists', tags: ['write_read_collision', 'task_create'] },
      { language: 'en', text: 'Add a todo if there is no parity review task yet', tags: ['write_read_collision', 'task_create'] },
      { language: 'en', text: 'Check my tasks and create one called missing write evidence if absent', tags: ['write_read_collision', 'task_create'] },
      { language: 'pt-BR', text: 'Verifique minhas tarefas e crie uma chamada evidência pendente se faltar', tags: ['write_read_collision', 'task_create'] },
      { language: 'pt-PT', text: 'Verifica as minhas tarefas e cria uma chamada evidência pendente se faltar', tags: ['write_read_collision', 'task_create'] },
      { language: 'es', text: 'Revisa mis tareas y crea una llamada evidencia pendiente si falta', tags: ['write_read_collision', 'task_create'] },
      { language: 'es-419', text: 'Comprueba mis tareas y agrega una llamada evidencia faltante si no existe', tags: ['write_read_collision', 'task_create'] },
      { language: 'mixed', text: 'Check minhas tasks e create uma chamada parity gap se faltar', tags: ['write_read_collision', 'task_create'] },
      { language: 'en', text: 'Rename the task parity planner check to parity planner reviewed' },
      { language: 'en', text: 'Update the task write firewall rollout with note waiting on review' },
      { language: 'pt-BR', text: 'Renomear a tarefa verificação de planejador para planejador revisado' },
      { language: 'pt-PT', text: 'Alterar a tarefa verificação de planeador para planeador revisto' },
      { language: 'es', text: 'Cambiar la tarea verificación del planificador a planificador revisado' },
    ],
  },
  {
    routeId: 'chat_reasoning_engine_v1',
    oldOwner: 'chat-reasoning-engine',
    replacement: 'ChatV2 Class A preview/confirmed write path',
    evidenceTrack: 'write_firewall_bundle',
    stateContract: 'fresh_isolated_user_per_prompt',
    runtimeCoupling: 'global_write_firewall',
    minSamplesPerSubcase: {
      task_with_subtasks: 12,
    },
    prompts: [
      { language: 'en', text: 'Create task parity reasoning check with subtasks alpha beta gamma', tags: ['task_with_subtasks'] },
      { language: 'pt-BR', text: 'Crie uma tarefa parity reasoning com subtarefas alfa beta gama', tags: ['task_with_subtasks'] },
      { language: 'pt-PT', text: 'Cria uma tarefa parity reasoning com subtarefas alfa beta gama', tags: ['task_with_subtasks'] },
      { language: 'es', text: 'Crea una tarea parity reasoning con subtareas alfa beta gamma', tags: ['task_with_subtasks'] },
      { language: 'en', text: 'Create a task launch checklist with subtasks seed review, shadow run, and rollback drill', tags: ['task_with_subtasks'] },
      { language: 'en', text: 'Add a task evidence bundle prep with checklist prompts, observations, labels', tags: ['task_with_subtasks'] },
      { language: 'en', text: 'Make a todo canary rehearsal with subtasks enable, monitor, revert', tags: ['task_with_subtasks'] },
      { language: 'en', text: 'Create task write safety audit with subtasks preview copy, confirm gate, fallback block', tags: ['task_with_subtasks'] },
      { language: 'en', text: 'Add a task parity review handoff with checklist manifest, raw review, signoff', tags: ['task_with_subtasks'] },
      { language: 'en', text: 'Create task route retirement rehearsal with subtasks seed tenant, run replay, compare labels', tags: ['task_with_subtasks'] },
      { language: 'en', text: 'Make new task answer contract check with subtasks locale, citations, safety', tags: ['task_with_subtasks'] },
      { language: 'en', text: 'Add a task telemetry audit with checklist route id, fallback reason, degraded flag', tags: ['task_with_subtasks'] },
      { language: 'pt-BR', text: 'Crie uma tarefa ensaio de canário com subtarefas ativar monitorar reverter', tags: ['task_with_subtasks'] },
      { language: 'pt-BR', text: 'Adiciona tarefa pacote de evidências com checklist prompts observações rótulos', tags: ['task_with_subtasks'] },
      { language: 'pt-BR', text: 'Crie tarefa auditoria de escrita com subtarefas prévia confirmação bloqueio', tags: ['task_with_subtasks'] },
      { language: 'pt-BR', text: 'Crie uma tarefa revisão de paridade com subtarefas manifesto revisão assinatura', tags: ['task_with_subtasks'] },
      { language: 'pt-BR', text: 'Crie tarefa checagem de contrato com subtarefas idioma fontes segurança', tags: ['task_with_subtasks'] },
      { language: 'pt-BR', text: 'Adiciona tarefa ensaio de rollback com checklist preparar rodar validar', tags: ['task_with_subtasks'] },
      { language: 'pt-PT', text: 'Cria uma tarefa ensaio de canário com subtarefas ativar monitorizar reverter', tags: ['task_with_subtasks'] },
      { language: 'pt-PT', text: 'Adiciona tarefa pacote de evidência com checklist prompts observações rótulos', tags: ['task_with_subtasks'] },
      { language: 'pt-PT', text: 'Cria tarefa auditoria de escrita com subtarefas prévia confirmação bloqueio', tags: ['task_with_subtasks'] },
      { language: 'pt-PT', text: 'Cria uma tarefa revisão de paridade com subtarefas manifesto revisão assinatura', tags: ['task_with_subtasks'] },
      { language: 'pt-PT', text: 'Cria tarefa verificação de contrato com subtarefas idioma fontes segurança', tags: ['task_with_subtasks'] },
      { language: 'pt-AO', text: 'Cria tarefa ensaio de canário com subtarefas ativar acompanhar reverter', tags: ['task_with_subtasks'] },
      { language: 'pt-AO', text: 'Adiciona tarefa pacote de evidências local com checklist prompts observações rótulos', tags: ['task_with_subtasks'] },
      { language: 'pt-AO', text: 'Cria tarefa auditoria de escrita com subtarefas prévia confirmação bloqueio legado', tags: ['task_with_subtasks'] },
      { language: 'es', text: 'Crea una tarea ensayo canario con subtareas activar monitorear revertir', tags: ['task_with_subtasks'] },
      { language: 'es', text: 'Crea tarea paquete de evidencia con checklist prompts observaciones etiquetas', tags: ['task_with_subtasks'] },
      { language: 'es', text: 'Crea tarea auditoría de escritura con subtareas vista previa confirmación bloqueo', tags: ['task_with_subtasks'] },
      { language: 'es', text: 'Crea una tarea revisión de paridad con subtareas manifiesto revisión firma', tags: ['task_with_subtasks'] },
      { language: 'es', text: 'Crea tarea verificación de contrato con subtareas idioma fuentes seguridad', tags: ['task_with_subtasks'] },
      { language: 'es-419', text: 'Crea una tarea ensayo de reversión con subtareas preparar ejecutar validar', tags: ['task_with_subtasks'] },
      { language: 'es-419', text: 'Crear tarea monitoreo de canario con checklist métricas alertas reversión', tags: ['task_with_subtasks'] },
      { language: 'es-419', text: 'Crea tarea revisión de respuestas con subtareas idioma citas seguridad', tags: ['task_with_subtasks'] },
      { language: 'mixed', text: 'Create tarefa launch checklist com subtasks seed review rollback', tags: ['task_with_subtasks'] },
      { language: 'mixed', text: 'Add todo pacote de evidência with checklist prompts labels signoff', tags: ['task_with_subtasks'] },
      { language: 'mixed', text: 'Crie task canary rehearsal com subtarefas enable monitor revert', tags: ['task_with_subtasks'] },
      { language: 'mixed', text: 'Crea tarea write audit com subtasks preview confirm block', tags: ['task_with_subtasks'] },
      { language: 'en', text: 'Create a task compare legacy and v2 with subtasks collect rows, review pairs, import labels', tags: ['task_with_subtasks'] },
      { language: 'en', text: 'Add task seed fixture validation with checklist active user, empty state, duplicate names', tags: ['task_with_subtasks'] },
      { language: 'pt-BR', text: 'Crie tarefa validação de fixture com subtarefas usuário ativo estado vazio nomes duplicados', tags: ['task_with_subtasks'] },
      { language: 'pt-PT', text: 'Cria tarefa validação de fixture com subtarefas utilizador ativo estado vazio nomes duplicados', tags: ['task_with_subtasks'] },
      { language: 'es', text: 'Crea tarea validación de fixture con subtareas usuario activo estado vacío nombres duplicados', tags: ['task_with_subtasks'] },
      { language: 'es-419', text: 'Crea tarea comparar legado y v2 con checklist recopilar revisar importar', tags: ['task_with_subtasks'] },
      { language: 'mixed', text: 'Create task comparar legado e v2 with subtasks rows review labels', tags: ['task_with_subtasks'] },
      { language: 'en', text: 'Make a task fallback monitor with subtasks route rate, error rate, leak check', tags: ['task_with_subtasks'] },
      { language: 'pt-BR', text: 'Crie uma tarefa monitor de fallback com subtarefas taxa de rota taxa de erro vazamento', tags: ['task_with_subtasks'] },
      { language: 'pt-PT', text: 'Cria tarefa monitor de fallback com subtarefas taxa de rota taxa de erro fuga', tags: ['task_with_subtasks'] },
      { language: 'es', text: 'Crea tarea monitor de fallback con subtareas tasa de ruta tasa de error fuga', tags: ['task_with_subtasks'] },
      { language: 'mixed', text: 'Add task fallback monitor com subtasks route rate error leak', tags: ['task_with_subtasks'] },
    ],
  },
  {
    routeId: 'training_plan_shortcut',
    oldOwner: 'local response shortcut',
    replacement: 'ChatV2 training preview/open-surface response',
    evidenceTrack: 'preview_answer_parity',
    stateContract: 'shared_read_only_snapshot',
    runtimeCoupling: 'independent_read_route',
    minSamplesPerSubcase: {
      training_no_active_plan: 6,
      health_adjacent: 4,
    },
    prompts: [
      { language: 'en', text: 'What is my training today?' },
      { language: 'en', text: 'What training sessions do I have this week?' },
      { language: 'en', text: 'Show my current training plan.' },
      { language: 'en', text: 'What week of my training plan am I on?' },
      { language: 'en', text: 'Which training sessions are still pending?' },
      { language: 'en', text: 'Which training sessions are completed this week?' },
      { language: 'en', text: 'What is the focus of my current training week?' },
      { language: 'en', text: 'How many training sessions are in my active plan this week?' },
      { language: 'en', text: 'Show key details for today\'s workout.' },
      { language: 'en', text: 'Do I have any scheduled workouts today?' },
      { language: 'en', text: 'What is the intensity for this week\'s training?' },
      { language: 'en', text: 'List my upcoming training sessions.' },
      { language: 'en', text: 'Show my training adherence this week.' },
      { language: 'en', text: 'Which active plan session is marked easy after soreness?', tags: ['health_adjacent'] },
      { language: 'en', text: 'Does my current plan include any recovery session after a sore week?', tags: ['health_adjacent'] },
      { language: 'en', text: 'Do I have an active training plan right now?', tags: ['training_no_active_plan'] },
      { language: 'en', text: 'Is there any active training plan for me?', tags: ['training_no_active_plan'] },
      { language: 'pt-BR', text: 'Qual é meu treino hoje?' },
      { language: 'pt-BR', text: 'Quais sessões de treino tenho esta semana?' },
      { language: 'pt-BR', text: 'Mostre meu plano de treino atual.' },
      { language: 'pt-BR', text: 'Em que semana do plano de treino eu estou?' },
      { language: 'pt-BR', text: 'Quais sessões de treino ainda estão pendentes?' },
      { language: 'pt-BR', text: 'Quais sessões de treino foram concluídas esta semana?' },
      { language: 'pt-BR', text: 'Qual é o foco da minha semana de treino atual?' },
      { language: 'pt-BR', text: 'Quantas sessões existem no meu plano ativo esta semana?' },
      { language: 'pt-BR', text: 'Mostre os detalhes principais do treino de hoje.' },
      { language: 'pt-BR', text: 'Tenho algum treino agendado hoje?' },
      { language: 'pt-BR', text: 'Qual é a intensidade do treino desta semana?' },
      { language: 'pt-BR', text: 'Liste minhas próximas sessões de treino.' },
      { language: 'pt-BR', text: 'Mostre minha adesão ao treino nesta semana.' },
      { language: 'pt-BR', text: 'Alguma sessão do plano ativo está marcada como leve depois de dor muscular?', tags: ['health_adjacent'] },
      { language: 'pt-BR', text: 'Meu plano atual inclui sessão de recuperação depois de semana dolorida?', tags: ['health_adjacent'] },
      { language: 'pt-PT', text: 'Qual é o meu treino hoje?' },
      { language: 'pt-PT', text: 'Que sessões de treino tenho esta semana?' },
      { language: 'pt-PT', text: 'Mostra o meu plano de treino atual.' },
      { language: 'pt-PT', text: 'Em que semana do plano de treino estou?' },
      { language: 'pt-PT', text: 'Que sessões de treino ainda estão pendentes?' },
      { language: 'pt-PT', text: 'Que sessões de treino foram concluídas esta semana?' },
      { language: 'pt-PT', text: 'Qual é o objetivo da minha semana de treino atual?' },
      { language: 'pt-PT', text: 'Quantas sessões há no meu plano ativo esta semana?' },
      { language: 'pt-PT', text: 'Mostra os detalhes principais do treino de hoje.' },
      { language: 'pt-PT', text: 'Há algum treino marcado para hoje?' },
      { language: 'pt-PT', text: 'Que intensidade está prevista no treino desta semana?' },
      { language: 'pt-PT', text: 'Lista as minhas próximas sessões de treino.' },
      { language: 'pt-PT', text: 'Mostra a minha adesão ao treino esta semana.' },
      { language: 'pt-AO', text: 'Qual é o meu treino de hoje?' },
      { language: 'pt-AO', text: 'Que sessões de treino tenho nesta semana?' },
      { language: 'pt-AO', text: 'Mostra o meu plano de treino ativo.' },
      { language: 'pt-AO', text: 'Tenho plano de treino ativo agora?', tags: ['training_no_active_plan'] },
      { language: 'es', text: 'Qué entrenamiento tengo hoy?' },
      { language: 'es', text: 'Qué sesiones de entrenamiento tengo esta semana?' },
      { language: 'es', text: 'Muestra mi plan de entrenamiento actual.' },
      { language: 'es', text: 'En qué semana de mi plan de entrenamiento estoy?' },
      { language: 'es', text: 'Qué sesiones de entrenamiento siguen pendientes?' },
      { language: 'es', text: 'Qué sesiones de entrenamiento completé esta semana?' },
      { language: 'es', text: 'Cuál es el enfoque de mi semana de entrenamiento actual?' },
      { language: 'es', text: 'Cuántas sesiones hay en mi plan activo esta semana?' },
      { language: 'es', text: 'Tengo entrenamiento programado hoy?' },
      { language: 'es', text: 'Tengo algún plan de entrenamiento activo ahora?', tags: ['training_no_active_plan'] },
      { language: 'es-419', text: 'Muéstrame los detalles del entrenamiento de hoy.' },
      { language: 'es-419', text: 'Lista mis próximas sesiones de entrenamiento.' },
      { language: 'es-419', text: 'Hay un plan de entrenamiento activo para mí?', tags: ['training_no_active_plan'] },
      { language: 'mixed', text: 'Show meu treino de hoje.' },
      { language: 'mixed', text: 'Tenho active training plan agora?', tags: ['training_no_active_plan'] },
      { language: 'pt-BR', text: 'Tenho algum plano de treino ativo agora?', tags: ['training_no_active_plan'] },
    ],
  },
  {
    routeId: 'selective_internet_research',
    oldOwner: 'research router',
    replacement: 'ChatV2 read/answer planner + evidence policy',
    evidenceTrack: 'answer_quality_research',
    stateContract: 'shared_read_only_snapshot',
    runtimeCoupling: 'classifier_domain_owner',
	    minSamplesPerSubcase: {
	      current_events: 6,
	      factual_lookup: 6,
	      product_comparison: 6,
	      public_finance: 6,
	      public_law: 4,
	      science_research: 6,
	      sports_stats: 6,
	      travel_weather: 6,
	      health_adjacent: 4,
	      research_safe_query: 50,
	    },
	    prompts: [
	      { language: 'en', text: 'Search current sources for the main EU AI Act obligations that start applying in 2026.', tags: ['public_law', 'research_safe_query'] },
	      { language: 'en', text: 'Find recent sources comparing iPhone 17 Pro and Pixel camera performance for low light video.', tags: ['product_comparison', 'research_safe_query'] },
	      { language: 'en', text: 'What are today’s weather and wind forecast sources for Lisbon airport?', tags: ['travel_weather', 'research_safe_query'] },
	      { language: 'en', text: 'Search latest news sources about OpenAI model releases this week.', tags: ['current_events', 'research_safe_query'] },
	      { language: 'en', text: 'Find current sources for Portugal public holiday dates in June 2026.', tags: ['factual_lookup', 'research_safe_query'] },
	      { language: 'en', text: 'What is the latest score source for the Portugal national football team match?', tags: ['sports_stats', 'research_safe_query'] },
	      { language: 'en', text: 'Search medical sources for general warning signs after knee pain during running.', tags: ['health_adjacent', 'research_safe_query'] },
	      { language: 'en', text: 'Find recent science sources on creatine monohydrate safety for healthy adults.', tags: ['science_research', 'health_adjacent', 'research_safe_query'] },
	      { language: 'pt-BR', text: 'Pesquise fontes atuais sobre as obrigações públicas da Lei de IA da União Europeia em 2026.', tags: ['public_law', 'research_safe_query'] },
	      { language: 'pt-BR', text: 'Procure notícias recentes sobre lançamentos de modelos de IA esta semana.', tags: ['current_events', 'research_safe_query'] },
	      { language: 'pt-BR', text: 'Compare fontes atuais sobre preço e autonomia de bicicletas elétricas urbanas em Portugal.', tags: ['product_comparison', 'research_safe_query'] },
	      { language: 'pt-BR', text: 'Qual é a previsão do tempo atual para o aeroporto de Lisboa segundo fontes meteorológicas?', tags: ['travel_weather', 'research_safe_query'] },
	      { language: 'pt-BR', text: 'Busque fontes atuais sobre feriados públicos em Portugal em junho de 2026.', tags: ['factual_lookup', 'research_safe_query'] },
	      { language: 'pt-BR', text: 'Procure o placar recente da seleção portuguesa de futebol em fontes esportivas.', tags: ['sports_stats', 'research_safe_query'] },
	      { language: 'pt-BR', text: 'Pesquise fontes médicas públicas sobre sinais de alerta para dor no joelho ao correr.', tags: ['health_adjacent', 'research_safe_query'] },
	      { language: 'pt-BR', text: 'Pesquise fontes científicas recentes sobre creatina monohidratada em adultos saudáveis.', tags: ['science_research', 'health_adjacent', 'research_safe_query'] },
	      { language: 'pt-PT', text: 'Pesquisa fontes atuais sobre as obrigações públicas do Regulamento de IA da União Europeia em 2026.', tags: ['public_law', 'research_safe_query'] },
	      { language: 'pt-PT', text: 'Procura notícias recentes sobre lançamentos de modelos de IA esta semana.', tags: ['current_events', 'research_safe_query'] },
	      { language: 'pt-PT', text: 'Compara fontes atuais sobre preço e autonomia de bicicletas elétricas urbanas em Portugal.', tags: ['product_comparison', 'research_safe_query'] },
	      { language: 'pt-PT', text: 'Qual é a previsão do tempo atual para o aeroporto de Lisboa em fontes meteorológicas?', tags: ['travel_weather', 'research_safe_query'] },
	      { language: 'pt-PT', text: 'Procura fontes atuais sobre feriados públicos em Portugal em junho de 2026.', tags: ['factual_lookup', 'research_safe_query'] },
	      { language: 'pt-PT', text: 'Procura o placar recente da seleção portuguesa de futebol em fontes desportivas.', tags: ['sports_stats', 'research_safe_query'] },
	      { language: 'pt-PT', text: 'Pesquisa fontes médicas públicas sobre sinais de alerta para dor no joelho durante corrida.', tags: ['health_adjacent', 'research_safe_query'] },
	      { language: 'pt-PT', text: 'Pesquisa fontes científicas recentes sobre segurança da creatina em adultos saudáveis.', tags: ['science_research', 'health_adjacent', 'research_safe_query'] },
	      { language: 'pt-AO', text: 'Pesquisa notícias recentes sobre tecnologia financeira em Angola esta semana.', tags: ['current_events', 'research_safe_query'] },
	      { language: 'pt-AO', text: 'Procura fontes atuais sobre o preço de energia solar residencial em Luanda.', tags: ['product_comparison', 'research_safe_query'] },
	      { language: 'pt-AO', text: 'Qual é a previsão do tempo atual para Luanda em fontes meteorológicas?', tags: ['travel_weather', 'research_safe_query'] },
	      { language: 'pt-AO', text: 'Pesquisa fontes públicas sobre regras de visto de turismo para Portugal em 2026.', tags: ['public_law', 'factual_lookup', 'research_safe_query'] },
	      { language: 'pt-AO', text: 'Procura fontes atuais sobre estatísticas de futebol do Girabola desta época.', tags: ['sports_stats', 'research_safe_query'] },
	      { language: 'pt-AO', text: 'Pesquisa fontes científicas recentes sobre hidratação em treinos de calor.', tags: ['science_research', 'research_safe_query'] },
	      { language: 'es', text: 'Search noticias recientes sobre avances de inteligencia artificial generativa esta semana.', tags: ['current_events', 'research_safe_query'] },
	      { language: 'es', text: 'Search fuentes actuales sobre precio y batería de bicicletas eléctricas urbanas en Europa.', tags: ['product_comparison', 'research_safe_query'] },
	      { language: 'es', text: 'Search weather forecast actual para el aeropuerto de Madrid Barajas.', tags: ['travel_weather', 'research_safe_query'] },
	      { language: 'es', text: 'Search fuentes públicas sobre requisitos de entrada a Portugal para turistas en 2026.', tags: ['public_law', 'factual_lookup', 'research_safe_query'] },
	      { language: 'es', text: 'Search score reciente de la selección española de fútbol en fuentes deportivas.', tags: ['sports_stats', 'research_safe_query'] },
	      { language: 'es', text: 'Search medical sources sobre señales de alerta por dolor de rodilla al correr.', tags: ['health_adjacent', 'research_safe_query'] },
	      { language: 'es-419', text: 'Search noticias recientes sobre inflación en América Latina esta semana.', tags: ['current_events', 'research_safe_query'] },
	      { language: 'es-419', text: 'Search fuentes actuales sobre precio de paneles solares residenciales en México.', tags: ['product_comparison', 'research_safe_query'] },
	      { language: 'es-419', text: 'Search weather forecast actual para Ciudad de México durante el fin de semana.', tags: ['travel_weather', 'research_safe_query'] },
	      { language: 'es-419', text: 'Search fuentes públicas sobre requisitos de visa Schengen para mexicanos en 2026.', tags: ['public_law', 'factual_lookup', 'research_safe_query'] },
	      { language: 'es-419', text: 'Search score reciente de la final de la Copa Libertadores en fuentes deportivas.', tags: ['sports_stats', 'research_safe_query'] },
	      { language: 'es-419', text: 'Search science sources sobre seguridad de creatina monohidratada en adultos sanos.', tags: ['science_research', 'health_adjacent', 'research_safe_query'] },
	      { language: 'mixed', text: 'Pesquisa current sources sobre lithium battery recycling rules in the EU.', tags: ['public_law', 'science_research', 'research_safe_query'] },
	      { language: 'mixed', text: 'Search fontes atuais about SaaS pricing benchmarks for solo founders.', tags: ['product_comparison', 'public_finance', 'research_safe_query'] },
	      { language: 'mixed', text: 'Pesquisa latest news about climate tech funding in Europe.', tags: ['current_events', 'public_finance', 'research_safe_query'] },
	      { language: 'mixed', text: 'Search fontes científicas sobre zone 2 training benefits for endurance athletes.', tags: ['science_research', 'research_safe_query'] },
	      { language: 'mixed', text: 'Pesquisa score recente and match report for Benfica in European competition.', tags: ['sports_stats', 'research_safe_query'] },
	      { language: 'mixed', text: 'Search current flight disruption sources for flights from Lisbon to London.', tags: ['travel_weather', 'research_safe_query'] },
	      { language: 'en', text: 'Find current stock market sources summarizing NVIDIA share movement today.', tags: ['public_finance', 'research_safe_query'] },
	      { language: 'pt-BR', text: 'Pesquise fontes atuais sobre cotação do euro frente ao real hoje.', tags: ['public_finance', 'research_safe_query'] },
	      { language: 'pt-PT', text: 'Pesquisa fontes atuais sobre a cotação do euro face ao dólar hoje.', tags: ['public_finance', 'research_safe_query'] },
	      { language: 'es', text: 'Search fuentes actuales sobre cotización del euro frente al dólar hoy.', tags: ['public_finance', 'research_safe_query'] },
	    ],
	  },
  {
    routeId: 'decision_confirmation_shortcut',
    oldOwner: 'Decision Center',
    replacement: 'ChatV2 confirmation/action gateway adapter',
    evidenceTrack: 'write_firewall_bundle',
    stateContract: 'fresh_isolated_user_per_prompt',
    runtimeCoupling: 'global_write_firewall',
    minSamplesPerSubcase: {
      decision_action: 8,
      confirmation_cancel: 4,
    },
    prompts: [
      { language: 'en', text: 'Dismiss decision dec_123', tags: ['decision_action'] },
      { language: 'en', text: 'Snooze decision dec_123 until tomorrow', tags: ['decision_action'] },
      { language: 'es', text: 'Descarta la decisión dec_123', tags: ['decision_action', 'confirmation_cancel'] },
      { language: 'mixed', text: 'Dismiss decisão dec_123', tags: ['decision_action'] },
      { language: 'en', text: 'Cancel decision dec_123 confirmation', tags: ['decision_action', 'confirmation_cancel'] },
      { language: 'en', text: 'Dismiss decision dec_launch_review', tags: ['decision_action'] },
      { language: 'en', text: 'Snooze decision dec_launch_review until Friday', tags: ['decision_action'] },
      { language: 'en', text: 'Cancel decision dec_launch_review confirmation', tags: ['decision_action', 'confirmation_cancel'] },
      { language: 'en', text: 'Dismiss decision dec_budget_hold after review', tags: ['decision_action'] },
      { language: 'en', text: 'Snooze decision dec_budget_hold for two days', tags: ['decision_action'] },
      { language: 'en', text: 'Cancel decision dec_budget_hold confirmation for now', tags: ['decision_action', 'confirmation_cancel'] },
      { language: 'en', text: 'Dismiss decision dec_route_gate', tags: ['decision_action'] },
      { language: 'en', text: 'Snooze decision dec_route_gate until next Monday', tags: ['decision_action'] },
      { language: 'en', text: 'Cancel decision dec_route_gate confirmation', tags: ['decision_action', 'confirmation_cancel'] },
      { language: 'pt-BR', text: 'Descartar decisão dec_123', tags: ['decision_action'] },
      { language: 'pt-BR', text: 'Adiar decisão dec_123 até amanhã', tags: ['decision_action'] },
      { language: 'pt-BR', text: 'Cancelar confirmação da decisão dec_123', tags: ['decision_action', 'confirmation_cancel'] },
      { language: 'pt-BR', text: 'Descartar decisão dec_launch_review', tags: ['decision_action'] },
      { language: 'pt-BR', text: 'Adiar decisão dec_launch_review até sexta', tags: ['decision_action'] },
      { language: 'pt-BR', text: 'Cancelar confirmação da decisão dec_launch_review', tags: ['decision_action', 'confirmation_cancel'] },
      { language: 'pt-BR', text: 'Descartar decisão dec_budget_hold depois da revisão', tags: ['decision_action'] },
      { language: 'pt-BR', text: 'Adiar decisão dec_budget_hold por dois dias', tags: ['decision_action'] },
      { language: 'pt-PT', text: 'Descarta decisão dec_123', tags: ['decision_action'] },
      { language: 'pt-PT', text: 'Adia decisão dec_123 até amanhã', tags: ['decision_action'] },
      { language: 'pt-PT', text: 'Cancela confirmação da decisão dec_123', tags: ['decision_action', 'confirmation_cancel'] },
      { language: 'pt-PT', text: 'Descarta decisão dec_launch_review', tags: ['decision_action'] },
      { language: 'pt-PT', text: 'Adia decisão dec_launch_review até sexta', tags: ['decision_action'] },
      { language: 'pt-PT', text: 'Cancela confirmação da decisão dec_launch_review', tags: ['decision_action', 'confirmation_cancel'] },
      { language: 'pt-AO', text: 'Descarta decisão dec_123 depois da revisão', tags: ['decision_action'] },
      { language: 'pt-AO', text: 'Adia decisão dec_route_gate até segunda', tags: ['decision_action'] },
      { language: 'pt-AO', text: 'Cancela confirmação da decisão dec_route_gate', tags: ['decision_action', 'confirmation_cancel'] },
      { language: 'es', text: 'Descarta la decisión dec_123 después de confirmar', tags: ['decision_action'] },
      { language: 'es', text: 'Cancela la confirmación de la decisión dec_123', tags: ['decision_action', 'confirmation_cancel'] },
      { language: 'es', text: 'Descarta la decisión dec_launch_review', tags: ['decision_action'] },
      { language: 'es', text: 'Descarta la decisión dec_launch_review hasta nueva revisión', tags: ['decision_action'] },
      { language: 'es', text: 'Cancela la confirmación de la decisión dec_launch_review', tags: ['decision_action', 'confirmation_cancel'] },
      { language: 'es', text: 'Descarta la decisión dec_budget_hold después de revisar', tags: ['decision_action'] },
      { language: 'es-419', text: 'Descarta la decisión dec_route_gate', tags: ['decision_action'] },
      { language: 'es-419', text: 'Descarta la decisión dec_route_gate hasta el lunes', tags: ['decision_action'] },
      { language: 'es-419', text: 'Cancela la confirmación de la decisión dec_route_gate', tags: ['decision_action', 'confirmation_cancel'] },
      { language: 'es-419', text: 'Descarta la decisión dec_budget_hold por ahora', tags: ['decision_action'] },
      { language: 'mixed', text: 'Snooze decisão dec_launch_review until Friday', tags: ['decision_action'] },
      { language: 'mixed', text: 'Cancel confirmação da decisão dec_launch_review', tags: ['decision_action', 'confirmation_cancel'] },
      { language: 'mixed', text: 'Dismiss decisão dec_budget_hold after review', tags: ['decision_action'] },
      { language: 'mixed', text: 'Adia decision dec_route_gate until Monday', tags: ['decision_action'] },
      { language: 'mixed', text: 'Cancela decision dec_route_gate confirmation', tags: ['decision_action', 'confirmation_cancel'] },
      { language: 'en', text: 'Dismiss decision dec_security_review and keep the note', tags: ['decision_action'] },
      { language: 'pt-BR', text: 'Descartar decisão dec_security_review e manter a nota', tags: ['decision_action'] },
      { language: 'es', text: 'Descarta la decisión dec_security_review y conserva la nota', tags: ['decision_action'] },
      { language: 'mixed', text: 'Dismiss decision dec_security_review e mantém a nota', tags: ['decision_action'] },
    ],
  },
  {
    routeId: 'destructive_confirmation_hold',
    oldOwner: 'skill orchestrator',
    replacement: 'ChatV2 write-intent firewall clarification/preview',
    evidenceTrack: 'write_firewall_bundle',
    stateContract: 'fresh_isolated_user_per_prompt',
    runtimeCoupling: 'global_write_firewall',
    minSamplesPerSubcase: {
      destructive_write: 8,
      negation: 8,
      ambiguous_cancel: 8,
    },
    prompts: [
      { language: 'en', text: 'Delete all my tasks', tags: ['destructive_write'] },
      { language: 'en', text: "Don't delete all my tasks", tags: ['negation'] },
      { language: 'en', text: 'How do I cancel that without deleting anything?', tags: ['hypothetical'] },
      { language: 'en', text: 'Cancel that', tags: ['ambiguous_cancel'] },
      { language: 'pt-BR', text: 'Apague todas as minhas tarefas', tags: ['destructive_write'] },
      { language: 'pt-BR', text: 'Não apague todas as minhas tarefas', tags: ['negation'] },
      { language: 'pt-BR', text: 'Como eu cancelo isso sem apagar nada?', tags: ['hypothetical'] },
      { language: 'pt-BR', text: 'Cancela isso', tags: ['ambiguous_cancel'] },
      { language: 'pt-PT', text: 'Apaga todas as minhas tarefas', tags: ['destructive_write'] },
      { language: 'pt-PT', text: 'Cancela essa ação', tags: ['ambiguous_cancel'] },
      { language: 'es', text: 'Cómo cancelo eso sin borrar nada?', tags: ['hypothetical'] },
      { language: 'es', text: 'Cancela eso', tags: ['ambiguous_cancel'] },
      { language: 'es-419', text: 'Eliminar todas mis tareas', tags: ['destructive_write'] },
      { language: 'en', text: 'Remove every task in my list', tags: ['destructive_write'] },
      { language: 'en', text: 'Delete the whole task list', tags: ['destructive_write'] },
      { language: 'en', text: 'Wipe all tasks from my account', tags: ['destructive_write'] },
      { language: 'en', text: 'Remove all todos for this user', tags: ['destructive_write'] },
      { language: 'pt-BR', text: 'Remova todas as minhas tarefas', tags: ['destructive_write'] },
      { language: 'pt-BR', text: 'Delete todas as tarefas da minha lista', tags: ['destructive_write'] },
      { language: 'pt-PT', text: 'Remove todas as minhas tarefas', tags: ['destructive_write'] },
      { language: 'pt-AO', text: 'Apagar todas as tarefas da minha lista', tags: ['destructive_write'] },
      { language: 'es', text: 'Borrar todas mis tareas', tags: ['destructive_write'] },
      { language: 'es', text: 'Elimina toda mi lista de tareas', tags: ['destructive_write'] },
      { language: 'mixed', text: 'Delete todas as minhas tasks', tags: ['destructive_write'] },
      { language: 'mixed', text: 'Remove todas las tareas now', tags: ['destructive_write'] },
      { language: 'en', text: 'Do not remove every task in my list', tags: ['negation'] },
      { language: 'en', text: 'Never delete the whole task list', tags: ['negation'] },
      { language: 'en', text: 'Please do not wipe all tasks from my account', tags: ['negation'] },
      { language: 'pt-BR', text: 'Não remova todas as minhas tarefas', tags: ['negation'] },
      { language: 'pt-BR', text: 'Nunca delete todas as tarefas da minha lista', tags: ['negation'] },
      { language: 'pt-PT', text: 'Não removas todas as minhas tarefas', tags: ['negation'] },
      { language: 'pt-AO', text: 'Não apagues todas as tarefas da minha lista', tags: ['negation'] },
      { language: 'es', text: 'No borres todas mis tareas', tags: ['negation'] },
      { language: 'es-419', text: 'No elimines toda mi lista de tareas', tags: ['negation'] },
      { language: 'mixed', text: 'Do not apagar todas minhas tasks', tags: ['negation'] },
      { language: 'en', text: 'Cancel the previous action', tags: ['ambiguous_cancel'] },
      { language: 'en', text: 'Cancel my last request', tags: ['ambiguous_cancel'] },
      { language: 'en', text: 'Delete that pending action', tags: ['ambiguous_cancel'] },
      { language: 'pt-BR', text: 'Cancele a ação anterior', tags: ['ambiguous_cancel'] },
      { language: 'pt-BR', text: 'Apague aquela ação pendente', tags: ['ambiguous_cancel'] },
      { language: 'pt-PT', text: 'Cancela o pedido anterior', tags: ['ambiguous_cancel'] },
      { language: 'pt-AO', text: 'Cancela a ação pendente', tags: ['ambiguous_cancel'] },
      { language: 'es', text: 'Cancela la acción anterior', tags: ['ambiguous_cancel'] },
      { language: 'es-419', text: 'Cancela esa acción pendiente', tags: ['ambiguous_cancel'] },
      { language: 'mixed', text: 'Cancel isso por agora', tags: ['ambiguous_cancel'] },
      { language: 'en', text: 'How do I delete a task safely without removing all tasks?', tags: ['hypothetical'] },
      { language: 'pt-BR', text: 'Como removo uma tarefa sem apagar a lista inteira?', tags: ['hypothetical'] },
      { language: 'pt-PT', text: 'Como apago uma tarefa sem remover a lista toda?', tags: ['hypothetical'] },
      { language: 'es', text: 'Cómo borro una tarea sin eliminar toda la lista?', tags: ['hypothetical'] },
      { language: 'mixed', text: 'How do I apagar one task sem deletar tudo?', tags: ['hypothetical'] },
    ],
  },
  {
    routeId: 'classifier_route_skill_orchestration',
    oldOwner: 'router + skill orchestrator',
    replacement: 'ChatV2 planner route decision',
    evidenceTrack: 'preview_answer_parity',
    stateContract: 'shared_read_only_snapshot',
    runtimeCoupling: 'classifier_domain_owner',
    minSamplesPerSubcase: {
      write_read_collision: 8,
      recipe_generation: 6,
    },
    prompts: [
      { language: 'en', text: 'What should I cook for dinner?', tags: ['recipe_generation', 'domain_cooking'] },
      { language: 'pt-BR', text: 'O que devo cozinhar para jantar?', tags: ['recipe_generation', 'domain_cooking'] },
      { language: 'pt-PT', text: 'O que devo cozinhar para o jantar?', tags: ['recipe_generation', 'domain_cooking'] },
      { language: 'es', text: 'Qué puedo cocinar para cenar?', tags: ['recipe_generation', 'domain_cooking'] },
      { language: 'mixed', text: 'What recipe posso fazer hoje?', tags: ['recipe_generation', 'domain_cooking'] },
      { language: 'en', text: 'Do I have tasks to complete today?', tags: ['write_read_collision'] },
      { language: 'pt-BR', text: 'Tenho tarefas para concluir hoje?', tags: ['write_read_collision'] },
      { language: 'pt-PT', text: 'Tenho tarefas para terminar hoje?', tags: ['write_read_collision'] },
      { language: 'es', text: 'Tengo tareas para completar hoy?', tags: ['write_read_collision'] },
      { language: 'en', text: 'Can you suggest something simple to cook with pantry staples?', tags: ['recipe_generation', 'domain_cooking'] },
      { language: 'en', text: 'Give me a generic dinner idea for a busy night', tags: ['recipe_generation', 'domain_cooking'] },
      { language: 'pt-BR', text: 'Sugira uma ideia genérica de jantar para hoje', tags: ['recipe_generation', 'domain_cooking'] },
      { language: 'pt-PT', text: 'Sugere uma ideia genérica de jantar para hoje', tags: ['recipe_generation', 'domain_cooking'] },
      { language: 'es-419', text: 'Dame una idea general para cenar hoy', tags: ['recipe_generation', 'domain_cooking'] },
      { language: 'mixed', text: 'Me dá a generic meal idea for tonight', tags: ['recipe_generation', 'domain_cooking'] },
      { language: 'en', text: 'What is ready on my content desk today?', tags: ['domain_content'] },
      { language: 'en', text: 'Which content pillar should I review next?', tags: ['domain_content'] },
      { language: 'pt-BR', text: 'Qual pilar de conteúdo devo revisar agora?', tags: ['domain_content'] },
      { language: 'pt-PT', text: 'Que pilar de conteúdo devo rever agora?', tags: ['domain_content'] },
      { language: 'es', text: 'Qué pilar de contenido debería revisar ahora?', tags: ['domain_content'] },
      { language: 'mixed', text: 'What conteúdo is ready para revisar?', tags: ['domain_content'] },
      { language: 'en', text: 'What training plan details should I look at first?', tags: ['domain_training'] },
      { language: 'en', text: 'Which workout status should I review today?', tags: ['domain_training'] },
      { language: 'pt-BR', text: 'Que detalhe do treino devo revisar primeiro?', tags: ['domain_training'] },
      { language: 'pt-PT', text: 'Que detalhe do treino devo rever primeiro?', tags: ['domain_training'] },
      { language: 'es', text: 'Qué detalle del entrenamiento debería revisar primero?', tags: ['domain_training'] },
      { language: 'mixed', text: 'What treino status should I review hoje?', tags: ['domain_training'] },
      { language: 'en', text: 'What bills are missing this month?', tags: ['domain_finance'] },
      { language: 'en', text: 'Which subscription renewal should I check next?', tags: ['domain_finance'] },
      { language: 'pt-BR', text: 'Quais contas faltam este mês?', tags: ['domain_finance'] },
      { language: 'pt-PT', text: 'Que faturas faltam este mês?', tags: ['domain_finance'] },
      { language: 'es', text: 'Qué facturas faltan este mes?', tags: ['domain_finance'] },
      { language: 'mixed', text: 'Which contas are missing este mês?', tags: ['domain_finance'] },
      { language: 'en', text: 'What is on my calendar today?', tags: ['domain_secretary', 'write_read_collision'] },
      { language: 'en', text: 'Do I have any reminders due today?', tags: ['domain_secretary', 'write_read_collision'] },
      { language: 'pt-BR', text: 'O que tenho na agenda hoje?', tags: ['domain_secretary', 'write_read_collision'] },
      { language: 'pt-PT', text: 'O que há na minha agenda hoje?', tags: ['domain_secretary', 'write_read_collision'] },
      { language: 'es-419', text: 'Qué hay en mi agenda hoy?', tags: ['domain_secretary', 'write_read_collision'] },
      { language: 'mixed', text: 'What tenho na calendar hoje?', tags: ['domain_secretary', 'write_read_collision'] },
      { language: 'en', text: 'I need help with the thing from earlier', tags: ['low_confidence_clarification'] },
      { language: 'pt-BR', text: 'Preciso de ajuda com aquilo de antes', tags: ['low_confidence_clarification'] },
      { language: 'pt-PT', text: 'Preciso de ajuda com aquilo de há pouco', tags: ['low_confidence_clarification'] },
      { language: 'es', text: 'Necesito ayuda con eso de antes', tags: ['low_confidence_clarification'] },
      { language: 'mixed', text: 'Help me with aquilo from earlier', tags: ['low_confidence_clarification'] },
      { language: 'en', text: 'Should I update the task or just tell me its status?', tags: ['write_read_collision', 'low_confidence_clarification'] },
      { language: 'pt-BR', text: 'Devo atualizar a tarefa ou só ver o status?', tags: ['write_read_collision', 'low_confidence_clarification'] },
      { language: 'es', text: 'Debo actualizar la tarea o solo ver su estado?', tags: ['write_read_collision', 'low_confidence_clarification'] },
      { language: 'mixed', text: 'Update task ou just show status?', tags: ['write_read_collision', 'low_confidence_clarification'] },
      { language: 'es-419', text: 'Qué puedo revisar primero si no sé el dominio?', tags: ['low_confidence_clarification'] },
      { language: 'pt-AO', text: 'Ajuda-me com aquilo de antes sem saber o domínio', tags: ['low_confidence_clarification'] },
    ],
  },
  {
    routeId: 'chat_message_shortcut_after_route',
    oldOwner: 'chat-message-shortcuts.ts',
    replacement: 'ChatV2 deterministic read adapter',
    evidenceTrack: 'preview_answer_parity',
    stateContract: 'shared_read_only_snapshot',
    runtimeCoupling: 'independent_read_route',
    prompts: [
      { language: 'en', text: 'what content is already ready on my desk' },
      { language: 'en', text: 'what is already on my desk' },
      { language: 'en', text: 'what s ready on my desk' },
      { language: 'en', text: 'what is ready on my desk' },
      { language: 'en', text: 'which pillars am i tracking' },
      { language: 'en', text: 'what pillars am i tracking' },
      { language: 'en', text: 'how should i schedule filming around my week' },
      { language: 'en', text: 'what should i film this week' },
      { language: 'en', text: 'what should i publish next' },
      { language: 'en', text: 'what should i work on next for content' },
      { language: 'en', text: 'what is the next content priority' },
      { language: 'en', text: 'what performed best' },
      { language: 'en', text: 'what is performing best' },
      { language: 'en', text: 'which video performed best' },
      { language: 'en', text: 'what content performed best' },
      { language: 'en', text: 'what are we learning' },
      { language: 'en', text: 'what are we learning this week' },
      { language: 'en', text: 'what are the biggest learnings' },
      { language: 'en', text: 'what hook is working' },
      { language: 'en', text: 'what hooks are working' },
      { language: 'en', text: 'what format is winning' },
      { language: 'en', text: 'what format is working' },
      { language: 'pt-BR', text: 'o que está pronto na minha mesa de conteúdo' },
      { language: 'pt-BR', text: 'o que ja esta pronto na minha mesa' },
      { language: 'pt-BR', text: 'quais pilares estou acompanhando' },
      { language: 'pt-BR', text: 'como devo agendar as filmagens na semana' },
      { language: 'pt-BR', text: 'como devo agendar as filmagens na minha semana' },
      { language: 'pt-BR', text: 'o que devo filmar esta semana' },
      { language: 'pt-BR', text: 'qual conteudo devo publicar a seguir' },
      { language: 'pt-BR', text: 'qual video devo publicar a seguir' },
      { language: 'pt-BR', text: 'qual e a proxima prioridade de conteudo' },
      { language: 'pt-BR', text: 'no que devo trabalhar a seguir em conteudo' },
      { language: 'pt-BR', text: 'o que performou melhor' },
      { language: 'pt-BR', text: 'qual video performou melhor' },
      { language: 'pt-BR', text: 'qual conteudo performou melhor' },
      { language: 'pt-BR', text: 'o que estamos aprendendo' },
      { language: 'pt-BR', text: 'qual hook esta funcionando' },
      { language: 'pt-BR', text: 'quais hooks estao funcionando' },
      { language: 'pt-BR', text: 'qual formato esta vencendo' },
      { language: 'pt-BR', text: 'qual formato esta funcionando' },
      { language: 'pt-PT', text: 'o que ja esta pronto na minha mesa de conteudo' },
      { language: 'pt-PT', text: 'o que esta pronto na minha mesa' },
      { language: 'pt-PT', text: 'quais pilares estou a acompanhar' },
      { language: 'pt-PT', text: 'o que estamos a aprender' },
      { language: 'en', text: 'what bills are still missing this month' },
      { language: 'en', text: 'which bills are still missing this month' },
      { language: 'en', text: 'what invoices are still missing this month' },
      { language: 'en', text: 'what subscriptions renew soon' },
      { language: 'en', text: 'which subscriptions renew soon' },
      { language: 'pt-BR', text: 'que contas faltam este mes' },
      { language: 'pt-BR', text: 'que faturas faltam este mes' },
      { language: 'pt-PT', text: 'quais contas faltam este mes' },
      { language: 'pt-PT', text: 'quais faturas faltam este mes' },
    ],
  },
  {
    routeId: 'domain_handler_execution',
    oldOwner: 'domain handlers',
    replacement: 'domain adapters + command bus',
    evidenceTrack: 'preview_answer_parity',
    stateContract: 'shared_read_only_snapshot',
    runtimeCoupling: 'classifier_domain_owner',
    minSamplesPerSubcase: {
      recipe_generation: 10,
    },
    prompts: [
      { language: 'en', text: 'Give me a quick meal idea for two people', tags: ['recipe_generation', 'domain_cooking'] },
      { language: 'pt-BR', text: 'Me dê uma ideia simples de receita para duas pessoas', tags: ['recipe_generation', 'domain_cooking'] },
      { language: 'pt-PT', text: 'Dá-me uma ideia simples de receita para duas pessoas', tags: ['recipe_generation', 'domain_cooking'] },
      { language: 'es-419', text: 'Dame una idea simple de receta para dos personas', tags: ['recipe_generation', 'domain_cooking'] },
      { language: 'mixed', text: 'Give me uma receita simples para duas pessoas', tags: ['recipe_generation', 'domain_cooking'] },
      { language: 'en', text: 'Suggest a low-effort dinner approach for a tired weeknight', tags: ['recipe_generation', 'domain_cooking'] },
      { language: 'pt-BR', text: 'Sugira uma abordagem simples de jantar para uma noite corrida', tags: ['recipe_generation', 'domain_cooking'] },
      { language: 'pt-PT', text: 'Sugere uma abordagem simples de jantar para uma noite ocupada', tags: ['recipe_generation', 'domain_cooking'] },
      { language: 'es', text: 'Sugiere una idea general de cena para una noche ocupada', tags: ['recipe_generation', 'domain_cooking'] },
      { language: 'mixed', text: 'Suggest uma ideia geral de jantar sem escolher prato específico', tags: ['recipe_generation', 'domain_cooking'] },
      { language: 'en', text: 'What content is ready for review on my desk?', tags: ['domain_content'] },
      { language: 'en', text: 'Which content pillar looks most ready right now?', tags: ['domain_content'] },
      { language: 'en', text: 'What should I publish next from the ready content list?', tags: ['domain_content'] },
      { language: 'pt-BR', text: 'Que conteúdo está pronto para revisão na minha mesa?', tags: ['domain_content'] },
      { language: 'pt-BR', text: 'Qual pilar de conteúdo parece mais pronto agora?', tags: ['domain_content'] },
      { language: 'pt-PT', text: 'Que conteúdo está pronto para rever na minha mesa?', tags: ['domain_content'] },
      { language: 'pt-PT', text: 'Que pilar de conteúdo parece mais pronto agora?', tags: ['domain_content'] },
      { language: 'es', text: 'Qué contenido está listo para revisar en mi mesa?', tags: ['domain_content'] },
      { language: 'es-419', text: 'Qué pilar de contenido parece más listo ahora?', tags: ['domain_content'] },
      { language: 'mixed', text: 'What content está pronto para review?', tags: ['domain_content'] },
      { language: 'en', text: 'What training session should I look at today?', tags: ['domain_training'] },
      { language: 'en', text: 'Show the next training item that needs attention', tags: ['domain_training'] },
      { language: 'en', text: 'What is the current training focus I should know?', tags: ['domain_training'] },
      { language: 'pt-BR', text: 'Qual sessão de treino devo olhar hoje?', tags: ['domain_training'] },
      { language: 'pt-BR', text: 'Mostre o próximo item de treino que precisa de atenção', tags: ['domain_training'] },
      { language: 'pt-PT', text: 'Que sessão de treino devo ver hoje?', tags: ['domain_training'] },
      { language: 'pt-PT', text: 'Mostra o próximo item de treino que precisa de atenção', tags: ['domain_training'] },
      { language: 'es', text: 'Qué sesión de entrenamiento debería revisar hoy?', tags: ['domain_training'] },
      { language: 'es-419', text: 'Muestra el próximo punto de entrenamiento que necesita atención', tags: ['domain_training'] },
      { language: 'mixed', text: 'Show next treino item that needs attention', tags: ['domain_training'] },
      { language: 'en', text: 'Which bills are still missing this month?', tags: ['domain_finance'] },
      { language: 'en', text: 'What subscription renewals should I check soon?', tags: ['domain_finance'] },
      { language: 'en', text: 'Summarize the finance items that need review', tags: ['domain_finance'] },
      { language: 'pt-BR', text: 'Quais contas ainda faltam este mês?', tags: ['domain_finance'] },
      { language: 'pt-BR', text: 'Que renovações de assinatura devo verificar em breve?', tags: ['domain_finance'] },
      { language: 'pt-PT', text: 'Que contas ainda faltam este mês?', tags: ['domain_finance'] },
      { language: 'pt-PT', text: 'Que renovações de subscrição devo verificar em breve?', tags: ['domain_finance'] },
      { language: 'es', text: 'Qué facturas siguen faltando este mes?', tags: ['domain_finance'] },
      { language: 'es-419', text: 'Qué renovaciones de suscripción debería revisar pronto?', tags: ['domain_finance'] },
      { language: 'mixed', text: 'Which finance items precisam review soon?', tags: ['domain_finance'] },
      { language: 'en', text: 'What meetings are on my calendar today?', tags: ['domain_secretary'] },
      { language: 'en', text: 'Which reminders need attention this morning?', tags: ['domain_secretary'] },
      { language: 'en', text: 'Summarize the schedule items I should notice', tags: ['domain_secretary'] },
      { language: 'pt-BR', text: 'Que reuniões estão na minha agenda hoje?', tags: ['domain_secretary'] },
      { language: 'pt-BR', text: 'Quais lembretes precisam de atenção esta manhã?', tags: ['domain_secretary'] },
      { language: 'pt-PT', text: 'Que reuniões tenho na minha agenda hoje?', tags: ['domain_secretary'] },
      { language: 'pt-PT', text: 'Que lembretes precisam de atenção esta manhã?', tags: ['domain_secretary'] },
      { language: 'es', text: 'Qué reuniones hay en mi agenda hoy?', tags: ['domain_secretary'] },
      { language: 'es-419', text: 'Qué recordatorios necesitan atención esta mañana?', tags: ['domain_secretary'] },
      { language: 'mixed', text: 'What meetings estão na agenda today?', tags: ['domain_secretary'] },
    ],
  },
];

/**
 * Qualifying retirement evidence is a deterministic projection of the
 * immutable, pre-implementation v1.4 corpus. No prompt is added, translated,
 * relabelled, or rewritten here: unsupported response locales are excluded.
 * This preserves the held-out provenance while preventing Spanish, mixed, or
 * pt-AO rows from inflating the EN/PT retirement floors.
 */
export const CHAT_V2_LEGACY_PARITY_RETIREMENT_ROUTE_CORPUS_META = {
  schemaVersion: 'chat_v2_legacy_parity_route_corpus_projection_meta.v1',
  corpusId: 'chatv2_phase7_route_replacement_heldout_supported_locale_projection_v1',
  version: CHAT_V2_LEGACY_PARITY_ROUTE_PROMPT_VERSION_V1_HISTORICAL,
  baseCorpusId: CHAT_V2_LEGACY_PARITY_ROUTE_CORPUS_META_V1_HISTORICAL.corpusId,
  baseCorpusSha256: '1481be040b73f482f5213d2b6b005abfaa86afa4bd5f879e694f5ce15fbca0da',
  frozenAt: CHAT_V2_LEGACY_PARITY_ROUTE_CORPUS_META_V1_HISTORICAL.frozenAt,
  frozenBeforeImplementation: true,
  projectionPolicy: 'immutable_v1_4_en_pt_br_pt_pt_only',
  mutationPolicy: CHAT_V2_LEGACY_PARITY_ROUTE_CORPUS_META_V1_HISTORICAL.mutationPolicy,
  reviewRubricVersion: CHAT_V2_LEGACY_PARITY_ROUTE_CORPUS_META_V1_HISTORICAL.reviewRubricVersion,
  notes: [
    'Qualifying retirement evidence uses only exact en, pt-BR, and pt-PT prompts from immutable v1.4.',
    'Spanish, es-419, mixed, and pt-AO prompts remain historical audit/input-compatibility evidence and never count toward EN/PT retirement floors.',
    'The projection does not add, translate, relabel, or rewrite prompts.',
    'Per-route sample counts may remain below the >=50 retirement floor; repeated prompt padding is forbidden.',
  ],
} as const;

const RETIREMENT_RESPONSE_LANGUAGES = new Set(['en', 'pt-BR', 'pt-PT']);

export const CHAT_V2_LEGACY_PARITY_RETIREMENT_ROUTE_PROMPTS:
  ChatV2LegacyParityRetirementRoutePrompt[] =
  CHAT_V2_LEGACY_PARITY_ROUTE_PROMPTS_V1_HISTORICAL.map((route) => ({
    ...route,
    prompts: route.prompts.filter((prompt): prompt is typeof prompt & {
      language: 'en' | 'pt-BR' | 'pt-PT';
    } => RETIREMENT_RESPONSE_LANGUAGES.has(prompt.language)),
  }));

export const CHAT_V2_LEGACY_PARITY_ROUTE_PROMPT_VERSION =
  'chat_v2_legacy_parity_route_prompts@1.5.0';

export const CHAT_V2_LEGACY_PARITY_ROUTE_CORPUS_META = {
  schemaVersion: 'chat_v2_legacy_parity_route_corpus_meta.v1',
  corpusId: 'chatv2_phase7_route_replacement_supported_locales_v2',
  version: CHAT_V2_LEGACY_PARITY_ROUTE_PROMPT_VERSION,
  frozenAt: '2026-07-29T00:00:00.000Z',
  frozenBeforeImplementation: false,
  mutationPolicy: 'claude_or_manual_signoff_required_before_runtime_replacement',
  reviewRubricVersion: 'chat_v2_legacy_parity_review_rubric.v2',
  notes: [
    'The active corpus uses explicit newly authored English and Portuguese semantic replacements for retired Spanish and selected mixed prompts.',
    'The historical v1 corpus remains separately exported and immutable for audit of already-issued evidence.',
    'This active corpus was authored during the locale-retirement implementation, is diagnostic and coverage-only, and must never support legacy retirement evidence.',
    'Do not add happy-path-only prompts after replacement work without a separately signed corpus-change review.',
    'Write routes are coupled by the global action-gateway enforce switch and must use fresh isolated seeded users.',
    'answer_quality_research routes require distinct public-query prompts for runtime evidence; repeated prompt padding is not valid retirement evidence.',
    'independent_read_route prompts must be large enough for route-scoped >=50-row parity packages without prompt repetition.',
    'write_firewall_bundle route prompts must be large enough for coupled >=50-row write-gateway packages without prompt repetition.',
    'classifier/domain-handler prompts are coverage inputs only; they do not import labels or prove replaceability.',
  ],
} as const;

const RETIRED_SPANISH_MIXED_PROMPTS = new Set([
  'Crea tarea write audit com subtasks preview confirm block',
  'Cancela decision dec_route_gate confirmation',
  'Remove todas las tareas now',
]);

type SupportedLocaleReplacementPrompt = {
  readonly language: 'en' | 'pt-BR' | 'pt-PT';
  readonly text: string;
};

const SUPPORTED_LOCALE_REPLACEMENT_PROMPTS = {
  general_action_planner: {
    4: { language: 'en', text: 'Create a task named planner verification' },
    5: { language: 'pt-BR', text: 'Crie uma tarefa chamada revisão do planejador' },
    10: { language: 'pt-PT', text: 'Conclui a tarefa duplicate title audit agora' },
    21: { language: 'en', text: 'Create a task named review parity evidence' },
    22: { language: 'pt-BR', text: 'Crie uma tarefa para verificar o firewall de escrita' },
    23: { language: 'pt-PT', text: 'Cria uma tarefa chamada rever o pacote de evidências' },
    34: { language: 'en', text: 'Complete the task titled duplicate title review' },
    35: { language: 'pt-BR', text: 'Conclua a tarefa duplicate title follow up' },
    42: { language: 'pt-PT', text: 'Verifica as minhas tarefas e cria a tarefa evidência pendente se não existir' },
    43: { language: 'en', text: 'Check my tasks and add one named missing evidence if it does not exist' },
    49: { language: 'pt-BR', text: 'Renomeie a tarefa verificação do planejador para planejador revisado' },
  },
  chat_reasoning_engine_v1: {
    3: { language: 'en', text: 'Create a parity reasoning task with subtasks alpha, beta, and gamma' },
    26: { language: 'pt-BR', text: 'Crie a tarefa ensaio canário e inclua ativar, monitorar e reverter como subtarefas' },
    27: { language: 'pt-PT', text: 'Cria a tarefa pacote de evidência com uma checklist de prompts, observações e etiquetas' },
    28: { language: 'en', text: 'Create a write audit task with preview, confirmation, and blocking subtasks' },
    29: { language: 'pt-BR', text: 'Crie a tarefa revisão de paridade, incluindo manifesto, revisão e assinatura como subtarefas' },
    30: { language: 'pt-PT', text: 'Cria a tarefa verificação do contrato com subtarefas de idioma, fontes e segurança' },
    31: { language: 'en', text: 'Create a rollback rehearsal task with prepare, execute, and validate subtasks' },
    32: { language: 'pt-BR', text: 'Crie uma tarefa de monitoramento do canário com checklist de métricas, alertas e reversão' },
    33: { language: 'pt-PT', text: 'Cria uma tarefa de revisão de respostas com subtarefas de idioma, citações e segurança' },
    37: { language: 'en', text: 'Create a write audit task with subtasks preview, confirm, and block' },
    42: { language: 'pt-BR', text: 'Crie a tarefa validação de fixture com subtarefas usuário ativo, estado vazio e nomes duplicados' },
    43: { language: 'en', text: 'Create a legacy-versus-v2 comparison task with checklist collect, review, and import' },
    48: { language: 'pt-PT', text: 'Cria uma tarefa de monitorização de fallback com subtarefas taxa da rota, taxa de erro e fuga' },
  },
  training_plan_shortcut: {
    49: { language: 'en', text: 'Which training session is scheduled for me today?' },
    50: { language: 'pt-BR', text: 'Que treinos estão previstos no meu plano nesta semana?' },
    51: { language: 'pt-PT', text: 'Apresenta o plano de treino que tenho ativo.' },
    52: { language: 'en', text: 'Which week am I currently in on my training plan?' },
    53: { language: 'pt-BR', text: 'Quais treinos do plano ainda preciso concluir?' },
    54: { language: 'pt-PT', text: 'Que treinos já concluí durante esta semana?' },
    55: { language: 'en', text: 'What is the focus this week in my active training plan?' },
    56: { language: 'pt-BR', text: 'Quantos treinos estão programados no meu plano ativo para esta semana?' },
    57: { language: 'pt-PT', text: 'Tenho algum treino planeado para hoje?' },
    58: { language: 'en', text: 'Is a training plan currently active for my account?' },
    59: { language: 'pt-BR', text: 'Exiba os detalhes da sessão de treino marcada para hoje.' },
    60: { language: 'pt-PT', text: 'Mostra uma lista das minhas próximas sessões de treino.' },
    61: { language: 'en', text: 'Is there currently an active training plan assigned to me?' },
  },
  selective_internet_research: {
    30: { language: 'en', text: 'Search recent sources for advances in generative artificial intelligence reported this week.' },
    31: { language: 'pt-PT', text: 'Pesquisa fontes atuais sobre preços e autonomia de bicicletas elétricas urbanas na Europa.' },
    32: { language: 'en', text: 'Find the current weather forecast for Madrid Barajas Airport.' },
    33: { language: 'pt-BR', text: 'Pesquise fontes públicas sobre os requisitos de entrada em Portugal para turistas em 2026.' },
    34: { language: 'en', text: 'Find recent sports sources for the latest score of the Spain national football team.' },
    35: { language: 'pt-PT', text: 'Pesquisa fontes médicas atuais sobre sinais de alarme associados a dor no joelho ao correr.' },
    36: { language: 'en', text: 'Search recent sources about inflation in Latin America this week.' },
    37: { language: 'pt-BR', text: 'Pesquise fontes atuais sobre o preço de painéis solares residenciais no México.' },
    38: { language: 'pt-PT', text: 'Pesquisa a previsão meteorológica atual para a Cidade do México durante o fim de semana.' },
    39: { language: 'en', text: 'Search public sources for Schengen visa requirements for Mexican citizens in 2026.' },
    40: { language: 'pt-BR', text: 'Procure fontes esportivas sobre o resultado recente da final da Copa Libertadores.' },
    41: { language: 'pt-PT', text: 'Procura estudos científicos atuais sobre a segurança da creatina monohidratada em adultos saudáveis.' },
    51: { language: 'en', text: 'Search current sources for the euro-to-dollar exchange rate today.' },
  },
  decision_confirmation_shortcut: {
    2: { language: 'pt-BR', text: 'Descarte a decisão dec_123' },
    31: { language: 'en', text: 'Dismiss decision dec_123 after confirmation' },
    32: { language: 'pt-PT', text: 'Cancela a confirmação pendente da decisão dec_123' },
    33: { language: 'en', text: 'Dismiss the decision dec_launch_review' },
    34: { language: 'pt-BR', text: 'Descarte a decisão dec_launch_review até uma nova revisão' },
    35: { language: 'pt-PT', text: 'Cancela a confirmação pendente da decisão dec_launch_review' },
    36: { language: 'en', text: 'Dismiss decision dec_budget_hold once the review is complete' },
    37: { language: 'pt-BR', text: 'Descarte a decisão dec_route_gate' },
    38: { language: 'pt-PT', text: 'Descarta a decisão dec_route_gate até segunda-feira' },
    39: { language: 'en', text: 'Cancel the confirmation for decision dec_route_gate' },
    40: { language: 'pt-BR', text: 'Descarte a decisão dec_budget_hold por enquanto' },
    45: { language: 'pt-PT', text: 'Cancela a confirmação da decisão dec_route_gate agora' },
    48: { language: 'en', text: 'Dismiss decision dec_security_review while keeping its note' },
  },
  destructive_confirmation_hold: {
    10: { language: 'en', text: 'How can I cancel that without deleting anything?' },
    11: { language: 'pt-BR', text: 'Cancele isso' },
    12: { language: 'pt-PT', text: 'Elimina todas as tarefas da minha lista' },
    21: { language: 'en', text: 'Delete every task I have' },
    22: { language: 'pt-BR', text: 'Apague a minha lista inteira de tarefas' },
    24: { language: 'pt-PT', text: 'Remove já todas as tarefas' },
    32: { language: 'en', text: 'Do not erase all of my tasks' },
    33: { language: 'pt-BR', text: 'Não exclua a minha lista inteira de tarefas' },
    42: { language: 'pt-PT', text: 'Cancela a ação anterior' },
    43: { language: 'en', text: 'Cancel that pending action' },
    48: { language: 'pt-BR', text: 'Como apago uma tarefa sem remover a lista inteira?' },
  },
  classifier_route_skill_orchestration: {
    3: { language: 'en', text: 'What could I cook for dinner tonight?' },
    8: { language: 'pt-BR', text: 'Há alguma tarefa que eu precise concluir hoje?' },
    13: { language: 'pt-PT', text: 'Dá-me uma sugestão geral para o jantar de hoje.' },
    19: { language: 'en', text: 'Which content pillar would be best to review now?' },
    25: { language: 'pt-BR', text: 'Qual detalhe do meu treino devo examinar primeiro?' },
    31: { language: 'pt-PT', text: 'Que contas estão em falta este mês?' },
    37: { language: 'en', text: 'What events are on my calendar today?' },
    42: { language: 'pt-BR', text: 'Preciso de ajuda com o assunto mencionado antes' },
    46: { language: 'pt-PT', text: 'Devo atualizar a tarefa ou apenas consultar o estado dela?' },
    48: { language: 'en', text: 'What should I review first if I am unsure of the domain?' },
  },
  domain_handler_execution: {
    3: { language: 'en', text: 'Suggest a simple recipe for a meal for two people.' },
    8: { language: 'pt-BR', text: 'Sugira uma ideia geral de jantar para uma noite atarefada.' },
    17: { language: 'pt-PT', text: 'Que conteúdo da minha mesa está pronto para ser revisto?' },
    18: { language: 'en', text: 'Which content pillar appears most ready right now?' },
    27: { language: 'pt-BR', text: 'Que sessão de treino devo revisar durante o dia de hoje?' },
    28: { language: 'pt-PT', text: 'Mostra o próximo ponto de treino que requer atenção.' },
    37: { language: 'en', text: 'Which invoices remain missing this month?' },
    38: { language: 'pt-BR', text: 'Quais renovações de assinatura devo analisar em breve?' },
    47: { language: 'pt-PT', text: 'Que reuniões estão marcadas na minha agenda para hoje?' },
    48: { language: 'en', text: 'Which reminders require attention this morning?' },
  },
} satisfies Record<string, Record<number, SupportedLocaleReplacementPrompt>>;

const supportedLocaleReplacementPromptsByRoute =
  SUPPORTED_LOCALE_REPLACEMENT_PROMPTS as Record<
    string,
    Record<number, SupportedLocaleReplacementPrompt>
  >;
const historicalRoutePromptsById = new Map(
  CHAT_V2_LEGACY_PARITY_ROUTE_PROMPTS_V1_HISTORICAL
    .map((route) => [route.routeId, route] as const),
);

let supportedLocaleReplacementCount = 0;
for (const [routeId, replacements] of Object.entries(
  supportedLocaleReplacementPromptsByRoute,
)) {
  const historicalRoute = historicalRoutePromptsById.get(routeId);
  if (!historicalRoute) {
    throw new Error(`Unknown supported-locale replacement route: ${routeId}`);
  }
  for (const rawIndex of Object.keys(replacements)) {
    const index = Number(rawIndex);
    if (
      !Number.isInteger(index)
      || index < 0
      || index >= historicalRoute.prompts.length
    ) {
      throw new Error(`Out-of-range supported-locale replacement: ${routeId}:${rawIndex}`);
    }
    supportedLocaleReplacementCount += 1;
  }
}
if (supportedLocaleReplacementCount !== 94) {
  throw new Error(
    `Expected exactly 94 supported-locale replacements, found ${supportedLocaleReplacementCount}`,
  );
}

/**
 * Build the active diagnostic corpus without mutating the frozen v1 evidence
 * set. Every retired Spanish or selected mixed slot has one index-bound
 * semantic replacement. Replacement language drives both the authored request
 * locale and the required assistant response locale.
 */
export const CHAT_V2_LEGACY_PARITY_ROUTE_PROMPTS: ChatV2LegacyParityRoutePrompt[] =
  CHAT_V2_LEGACY_PARITY_ROUTE_PROMPTS_V1_HISTORICAL.map((route) => ({
    ...route,
    prompts: route.prompts.map((prompt, index) => {
      const replacement =
        supportedLocaleReplacementPromptsByRoute[route.routeId]?.[index];
      const isRetiredPrompt =
        prompt.language === 'es'
        || prompt.language === 'es-419'
        || RETIRED_SPANISH_MIXED_PROMPTS.has(prompt.text);
      if (isRetiredPrompt !== Boolean(replacement)) {
        throw new Error(
          `${replacement ? 'Extra' : 'Missing'} supported-locale replacement: ${route.routeId}:${index}`,
        );
      }
      if (replacement) {
        return {
          ...prompt,
          ...replacement,
          requestLanguage: replacement.language,
        };
      }
      return {
        ...prompt,
        requestLanguage: prompt.language as ChatV2LegacyParitySupportedLanguage,
        language: prompt.language as ChatV2LegacyParitySupportedLanguage,
      };
    }),
  }));

export const CHAT_V2_PHASE7_TARGET_ROUTE_READINESS: {
  classifier_route_skill_orchestration: ChatV2Phase7ClassifierRouteReadiness;
  domain_handler_execution: ChatV2Phase7DomainHandlerReadiness;
} = {
  classifier_route_skill_orchestration: {
    routeId: 'classifier_route_skill_orchestration',
    answerQualityReviewRequired: true,
    recallAt8LanguageThresholds: {
      en: 0.98,
      'pt-BR': 0.98,
      'pt-PT': 0.98,
      mixed: 0.9,
    },
    promptOwnership: [
      {
        promptText: 'What should I cook for dinner?',
        owner: 'local_chat_classifier',
        expectedOutcome: 'answer_only',
        notes: 'Generic cooking answer; local-chat/classifier owns the answer, not deterministic reads.',
      },
      {
        promptText: 'O que devo cozinhar para jantar?',
        owner: 'local_chat_classifier',
        expectedOutcome: 'answer_only',
        notes: 'Generic cooking answer in pt-BR; must stay non-hardcoded and answer-only.',
      },
      {
        promptText: 'O que devo cozinhar para o jantar?',
        owner: 'local_chat_classifier',
        expectedOutcome: 'answer_only',
        notes: 'Generic cooking answer in pt-PT; must stay non-hardcoded and answer-only.',
      },
      {
        promptText: 'What recipe posso fazer hoje?',
        owner: 'local_chat_classifier',
        expectedOutcome: 'answer_only',
        notes: 'Mixed-language generic cooking answer; local-chat/classifier owns locale and answer quality.',
      },
      {
        promptText: 'Do I have tasks to complete today?',
        owner: 'deterministic_read',
        expectedOutcome: 'read_model_answer',
        notes: 'Secretary/task read collision; deterministic read owns the scoped task facts.',
      },
      {
        promptText: 'Tenho tarefas para concluir hoje?',
        owner: 'deterministic_read',
        expectedOutcome: 'read_model_answer',
        notes: 'Portuguese secretary/task read collision; deterministic read owns the scoped task facts.',
      },
    ],
    requiredMissingCoverage: [
      'owner_boundary_review',
    ],
    blockers: [
      'No signed recall@8 evidence for en, pt-BR, pt-PT, and mixed at the required thresholds.',
      'Held-out prompts now include read/write collision and low-confidence clarification probes, but no reviewed labels prove the expected owner or clarification outcome.',
      'Read/write collision coverage still needs cross-domain owner review before legacy classifier ownership can be disabled.',
    ],
  },
  domain_handler_execution: {
    routeId: 'domain_handler_execution',
    answerQualityReviewRequired: true,
    replacementOrder: ['cooking', 'content', 'training', 'finance', 'secretary'],
    perDomainParityFloors: {
      cooking: {
        replacement: 'ChatV2 generic cooking answer adapter',
        minSamples: 50,
        minParity: 0.95,
        answerQualityReviewRequired: true,
      },
      content: {
        replacement: 'ChatV2 content answer adapter',
        minSamples: 50,
        minParity: 0.95,
        answerQualityReviewRequired: true,
      },
      training: {
        replacement: 'ChatV2 training answer adapter',
        minSamples: 50,
        minParity: 0.95,
        answerQualityReviewRequired: true,
      },
      finance: {
        replacement: 'ChatV2 finance answer adapter',
        minSamples: 50,
        minParity: 0.95,
        answerQualityReviewRequired: true,
      },
      secretary: {
        replacement: 'ChatV2 secretary answer adapter',
        minSamples: 50,
        minParity: 0.95,
        answerQualityReviewRequired: true,
      },
    },
    cookingGenericityRule: 'Cooking parity prompts and adapters must stay generic; no dish, recipe, ingredient, or user-specific hardcoding can be used to pass review.',
    blockers: [
      'Held-out route prompts now cover cooking, content, training, finance, and secretary, but each domain still needs its own signed >=50-row parity package.',
      'No imported Claude/manual labels prove per-domain 50-sample, >=95% parity with zero safety, quality, and degraded-not-comparable regressions.',
      'Legacy handleSimpleDomain still owns ordinary natural-language answers whenever ChatV2 local answer serving is not visible for the tenant/domain.',
    ],
  },
};

export const CHAT_V2_LEGACY_PARITY_WRITE_ROUTE_IDS = new Set([
  'general_action_planner',
  'chat_reasoning_engine_v1',
  'decision_confirmation_shortcut',
  'destructive_confirmation_hold',
]);
