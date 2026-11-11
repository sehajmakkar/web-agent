import type { Config } from "../lib/config.js";
import { GeminiClient } from "./gemini.js";
import type { ModelClient } from "./types.js";

/** The only place that decides which provider runs (constraint C-0: Gemini now, Anthropic preferred). */
export function createChatModel(config: Config): ModelClient {
  switch (config.LLM_PROVIDER) {
    case "gemini":
      if (!config.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is required for LLM_PROVIDER=gemini");
      return new GeminiClient({
        apiKey: config.GEMINI_API_KEY,
        model: config.GEMINI_MODEL,
        fallbackModels: config.GEMINI_FALLBACK_MODELS,
        thinkingLevel: config.GEMINI_THINKING_LEVEL,
      });
  }
}

export * from "./types.js";
