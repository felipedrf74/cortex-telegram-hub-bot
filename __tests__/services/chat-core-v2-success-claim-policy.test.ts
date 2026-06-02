import { describe, expect, it } from 'vitest';

import { textClaimsUnverifiedAction } from '../../src/services/chat-core-v2/success-claim-policy';

describe('ChatCoreV2 success-claim policy', () => {
  it.each([
    "I've saved the recipe.",
    "I've uploaded the draft.",
    "I've changed your workout.",
    "I'll cancel that.",
    'Adicionei isso.',
    'Guardei a receita.',
    'Alterei o treino.',
    'Remarquei a sessão.',
    'Subi o roteiro.',
    'Guardé la receta.',
    'Añadí eso.',
    'Publiqué el contenido.',
    'No, completé la tarea.',
    'Okay, cancelado.',
    'Pronto, concluí a tarefa.',
    'No problem, I saved the recipe to your cookbook.',
    'No worries, I already sent the email.',
    'No rush — I deleted the duplicates for you.',
    'No problem I created the task.',
  ])('flags unverified first-person action claim: %s', (text) => {
    expect(textClaimsUnverifiedAction(text)).toBe(true);
  });

  it.each([
    'Cozinhe até ficar pronto.',
    'Guarde esta dica para mais tarde se fizer sentido.',
    'Cook until done and serve warm.',
    'A saved search is useful when you repeat the same filter.',
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
	  ])('does not flag content that merely mentions action words: %s', (text) => {
    expect(textClaimsUnverifiedAction(text)).toBe(false);
  });
});
