import { describe, expect, it } from 'vitest';

import {
  textClaimsUnverifiedAction,
  textHasBareAppSuccessMarker,
} from '../../src/services/chat-success-claim-policy';

describe('chat success-claim policy', () => {
  it.each([
    "I've saved the recipe.",
    "I've created the task.",
    "I've uploaded the draft.",
    "I've changed your workout.",
    "I'll cancel that.",
    'Adicionei isso.',
    'Guardei a receita.',
    'Alterei o treino.',
    'Remarquei a sessão.',
    'Subi o roteiro.',
    'Guardé la receta.',
    'Yo guarde la receta.',
    'Añadí eso.',
    'Publiqué el contenido.',
    'No, completé la tarea.',
    'Okay, cancelado.',
    'Pronto, concluí a tarefa.',
    'No problem, I saved the recipe to your cookbook.',
    'No worries, I already sent the email.',
    'No rush — I deleted the duplicates for you.',
    'No problem I created the task.',
  ])('flags unverified first-person app action claim: %s', (text) => {
    expect(textClaimsUnverifiedAction(text)).toBe(true);
  });

  it.each([
    'Cozinhe até ficar pronto.',
    'Guarde esta dica para mais tarde se fizer sentido.',
    'Cook until done and serve warm.',
    'Complete one short focus block and review the result.',
    "I've created a small focus habit you can try.",
    'Criei uma ideia simples de receita para experimentar.',
    'Guardé una idea útil para organizar el día.',
    'Pronto para começar: escolha uma tarefa pequena.',
    'A saved search is useful when you repeat the same filter.',
    'Adding a short break can help you focus.',
    'Cree una receta sencilla y revise los ingredientes antes de cocinar.',
    'A tarefa ainda não foi concluída. Quer que eu prepare uma prévia?',
    'O evento não foi cancelado. Confirmas que queres apagar?',
    'Não cancelei o evento. Posso preparar uma prévia.',
	    'Não vou cancelar nada sem confirmação.',
	    'Nunca enviei esse email.',
	    'Nunca cancelei o evento.',
	    'Nunca apaguei essa tarefa.',
	    'Jamais enviei esse email.',
	    'El evento no fue cancelado todavía. Antes de cualquier cambio, dime si quieres que lo cancele.',
	    'No completé la tarea; puedo preparar una vista previa si quieres.',
	    'No guardé la receta todavía; puedo preparar una vista previa.',
	    'Jamás envié ese correo.',
	    'Nunca completé la tarea.',
	    'Nunca guardé la receta.',
	    'The task is not completed yet. Do you want a preview?',
	  ])('does not flag ordinary content mentioning action words: %s', (text) => {
    expect(textClaimsUnverifiedAction(text)).toBe(false);
  });

  it('keeps bare success markers limited to confirmation-shaped text', () => {
    expect(textHasBareAppSuccessMarker('✅ Created task')).toBe(true);
    expect(textHasBareAppSuccessMarker('Task completed.')).toBe(true);
    expect(textHasBareAppSuccessMarker('Done.')).toBe(true);
    expect(textHasBareAppSuccessMarker('Deleted all matching tasks.')).toBe(true);
    expect(textHasBareAppSuccessMarker('Removed the matching calendar events.')).toBe(true);
    expect(textHasBareAppSuccessMarker('Apagadas todas as tarefas antigas.')).toBe(true);
    expect(textHasBareAppSuccessMarker('Tarefa criada.')).toBe(true);
    expect(textHasBareAppSuccessMarker('Cook until done and serve warm.')).toBe(false);
    expect(textHasBareAppSuccessMarker('Complete one short focus block.')).toBe(false);
  });
});
