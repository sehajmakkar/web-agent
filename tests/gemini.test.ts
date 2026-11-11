import { describe, expect, it } from "vitest";
import { compactParts, toGeminiContents } from "../src/llm/gemini.js";

describe("toGeminiContents", () => {
  it("round-trips raw model parts (thoughtSignature) unchanged", () => {
    const raw = [{ functionCall: { name: "web_search", args: { queries: ["a"] } }, thoughtSignature: "SIG" }];
    const contents = toGeminiContents([
      { role: "user", text: "hi" },
      { role: "assistant", text: "", toolCalls: [{ id: "local_0", name: "web_search", args: {} }], providerData: { geminiParts: raw } },
      { role: "tool", results: [{ callId: "local_0", name: "web_search", content: "results" }] },
    ]);
    expect(contents[1]).toEqual({ role: "model", parts: raw });
    // locally-invented ids are not sent back; real ids are
    expect(contents[2]!.parts![0]!.functionResponse).toEqual({ name: "web_search", response: { output: "results" } });
  });

  it("sends real call ids and error results", () => {
    const [c] = toGeminiContents([{ role: "tool", results: [{ callId: "abc", name: "web_search", content: "boom", isError: true }] }]);
    expect(c!.parts![0]!.functionResponse).toEqual({ id: "abc", name: "web_search", response: { error: "boom" } });
  });

  it("skips empty assistant messages (Gemini rejects empty parts)", () => {
    expect(toGeminiContents([{ role: "assistant", text: "" }])).toEqual([]);
  });
});

describe("compactParts", () => {
  it("merges adjacent plain text but keeps signed parts separate", () => {
    const out = compactParts([{ text: "Hel" }, { text: "lo" }, { text: "", thoughtSignature: "S" }, { text: "!" }]);
    expect(out).toEqual([{ text: "Hello" }, { text: "", thoughtSignature: "S" }, { text: "!" }]);
  });
});
