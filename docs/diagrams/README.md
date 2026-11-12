# Architecture diagrams

How the architecture grew, one phase at a time. Each diagram uses the same layout, so you can flip between them and see
exactly what moved. Open the files at [excalidraw.com](https://excalidraw.com) (File → Open) or with the VS Code Excalidraw extension.

| File | Phase | What it adds |
|---|---|---|
| `phase-1-skeleton.excalidraw` | 0–1 | Streaming chat, the agent loop, the one `web_search` tool, Exa → Tavily, plus the Phase 0 measurements that shaped it |
| `phase-2-persistence.excalidraw` | 2 | SQLite history owned by the server, the single clock + `AGENT_NOW`, demo fixtures |
| `phase-3-temporal-memory.excalidraw` | 3 | `planMemory()` + date resolver: dates, recall, search window, checklist, no-record policy; drafts discarded |
| `phase-4-evidence-ledger.excalidraw` | 4 | Background extraction into claims/notes, supersede history, pages re-read before the model runs |
| `architecture-evolution.excalidraw` | all | The four side by side |

Legend: **green outline = new in that phase**, **amber = changed in that phase**. Fill colour = layer (blue client,
purple agent core, teal memory & data, yellow model, orange search).

Regenerate after changing the spec in `build.mjs`: `npm run diagrams`.
