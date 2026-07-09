import OpenAI from 'openai';
import { AI_MODEL } from '../config/ai';

// Server-side only — imported by API routes, never by frontend components.
// The apiKey is read from process.env by the API route and injected here.
export function createOpenAIClient(apiKey: string): OpenAI {
  return new OpenAI({ apiKey });
}

export { AI_MODEL };
