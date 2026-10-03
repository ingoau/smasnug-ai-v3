import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { env } from './config.js';

export const openrouter = createOpenRouter({ apiKey: env.OPENROUTER_KEY });

/** Model ids per role (design doc: Luna for gate/front/children, Sol for children's harder tasks). */
export const MODELS = {
  gate: env.MODEL_LUNA, // reasoning off
  front: env.MODEL_LUNA, // reasoning low
  child: env.MODEL_LUNA,
  childHard: env.MODEL_SOL,
} as const;
