import { DomainResponse } from './types';
import { handleSimpleDomain } from './domain-handler';

export async function handleContent(message: string, maxTokensOverride?: number): Promise<DomainResponse> {
  return handleSimpleDomain('content', message, 5, undefined, maxTokensOverride);
}
