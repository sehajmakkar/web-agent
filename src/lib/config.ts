import "dotenv/config";
import { z } from "zod";

// Empty strings in .env ("FOO=") mean "not set".
const opt = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), schema);

const list = (fallback: string) =>
  opt(z.string().default(fallback)).transform((s) =>
    s.split(",").map((x) => x.trim()).filter(Boolean),
  );

const EnvSchema = z
  .object({
    LLM_PROVIDER: opt(z.enum(["gemini"]).default("gemini")),
    GEMINI_API_KEY: opt(z.string({ error: "GEMINI_API_KEY is required (see .env.example)" })),
    GEMINI_MODEL: opt(z.string().default("gemini-3.5-flash-lite")),
    GEMINI_EXTRACT_MODEL: opt(z.string().default("gemini-3.5-flash-lite")),
    GEMINI_FALLBACK_MODELS: list("gemini-3.1-flash-lite"),
    GEMINI_THINKING_LEVEL: opt(z.enum(["minimal", "low", "medium", "high"]).default("low")),
    EXA_API_KEY: opt(z.string().optional()),
    TAVILY_API_KEY: opt(z.string().optional()),
    AGENT_NOW: opt(z.string().optional()),
    AGENT_TZ: opt(z.string().default(Intl.DateTimeFormat().resolvedOptions().timeZone)),
    PORT: opt(z.coerce.number().int().default(8787)),
  })
  .refine((e) => e.EXA_API_KEY || e.TAVILY_API_KEY, {
    message: "Set at least one of EXA_API_KEY or TAVILY_API_KEY",
  });

export type Config = z.infer<typeof EnvSchema>;

let cached: Config | undefined;

/** Parsed, validated environment. Throws a readable error on misconfiguration. */
export function getConfig(): Config {
  if (cached) return cached;
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".") || "env"}: ${i.message}`).join("\n");
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}
