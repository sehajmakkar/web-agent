import type { z } from "zod";
import { addUsage, emptyUsage, ModelError, type ModelClient, type Usage } from "./types.js";

/**
 * One structured call: the provider constrains output to `jsonSchema`, and we still validate with zod,
 * because a schema-constrained model can return a truncated or semantically wrong object.
 */
export async function generateJson<T>(
  model: ModelClient,
  input: { system: string; prompt: string; jsonSchema: Record<string, unknown>; schema: z.ZodType<T>; signal?: AbortSignal },
): Promise<{ value: T; usage: Usage; model: string }> {
  let text = "";
  let usage = emptyUsage();
  let used = model.model;
  for await (const ev of model.stream({
    system: input.system,
    messages: [{ role: "user", text: input.prompt }],
    jsonSchema: input.jsonSchema,
    signal: input.signal,
  })) {
    if (ev.type === "text") text += ev.delta;
    else if (ev.type === "done") {
      usage = addUsage(usage, ev.usage);
      used = ev.model;
    }
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ModelError("bad_request", `Model returned invalid JSON (${text.length} chars)`, undefined, used);
  }
  const parsed = input.schema.safeParse(raw);
  if (!parsed.success) {
    throw new ModelError("bad_request", `JSON failed validation: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`, undefined, used);
  }
  return { value: parsed.data, usage, model: used };
}
