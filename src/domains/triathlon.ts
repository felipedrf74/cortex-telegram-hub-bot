import { DomainResponse } from './types';
import { handleSimpleDomain } from './domain-handler';

export async function handleTriathlon(message: string, userId?: number): Promise<DomainResponse> {
  return handleSimpleDomain('triathlon', message, 5, userId);
}
