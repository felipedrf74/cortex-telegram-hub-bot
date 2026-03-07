import { DomainResponse } from './types';
import { handleSimpleDomain } from './domain-handler';

export async function handleContent(message: string): Promise<DomainResponse> {
  return handleSimpleDomain('content', message);
}
