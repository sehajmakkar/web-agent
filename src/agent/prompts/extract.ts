/** Prompt + schema for background evidence extraction (ADR-007, Phase 4). Static text: no dates or ids. */

export const EXTRACT_SYSTEM = `You maintain the evidence ledger of a research assistant. You read ONE exchange (the user's message and the assistant's answer, with its numbered sources) and record what must be remembered so that, days later, the assistant can tell whether anything changed.

Extract:
1. title: at most 8 words naming what the conversation is about ("Managed Postgres hosting for a small SaaS"). Not a question, no trailing punctuation.
2. topics: 3-10 lowercase retrieval keywords: the subject, every product/company/vendor name, and common synonyms ("postgres", "database hosting", "neon").
3. claims: time-sensitive, checkable facts the ASSISTANT stated that could change later: prices, plan names, limits, quotas, versions, release dates, availability, who holds a role. One fact per claim:
   - entity: the product/company/thing ("Neon")
   - attribute: what about it ("Launch plan price")
   - value: exactly as stated, kept short ("$19/mo")
   - source: the [n] number the answer cited for that fact, or null if it cited none
   Skip opinions, advice, general knowledge, and anything the assistant said it could not verify. At most 20.
4. notes: decisions, shortlists, constraints or preferences the USER stated themselves (never suggestions the assistant made):
   - kind "shortlist" for a list of options they chose to consider, "decision" for a choice made, "preference" for constraints or context about them ("20-person sales team", "budget under $50/mo")
   - subject: what it is about ("CRM"); items: the list for shortlists and decisions; text: a short note.

Return empty arrays when there is nothing to record. Never invent facts that aren't in the exchange.`;

export const EXTRACT_JSON_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    topics: { type: "array", items: { type: "string" } },
    claims: {
      type: "array",
      items: {
        type: "object",
        properties: {
          entity: { type: "string" },
          attribute: { type: "string" },
          value: { type: "string" },
          source: { type: ["integer", "null"] },
        },
        required: ["entity", "attribute", "value", "source"],
      },
    },
    notes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["shortlist", "decision", "preference"] },
          subject: { type: "string" },
          items: { type: "array", items: { type: "string" } },
          text: { type: "string" },
        },
        required: ["kind", "subject"],
      },
    },
  },
  required: ["title", "topics", "claims", "notes"],
} as const;
