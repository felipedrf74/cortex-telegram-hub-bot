import { DomainResponse } from './types';
import { handleSimpleDomain } from './domain-handler';

export async function handleContent(message: string, _userId?: number): Promise<DomainResponse> {
  return handleSimpleDomain('content', message, 5);
}
