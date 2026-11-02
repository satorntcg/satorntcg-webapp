# SatornTCG

Internal inventory, listing, and sales-management platform for a trading card
game reselling business, covering Sorcery: Contested Realm and Riftbound.
Built as a client-side React SPA on top of Supabase (Postgres, Auth,
Realtime, and Edge Functions) — no separate backend.

## Features

- Inventory tracking with live market pricing (TCGPlayer + eBay sold data)
- Two-channel listing management (eBay and TCGPlayer) with fee/profit math
- Automated price-move and stale-listing alerts
- Sealed box/pack purchase P&L and expected-value analytics
- AI-assisted lot grouping for listing creation (Anthropic API)
- Retrieval-augmented rules chatbot (OpenAI embeddings + Anthropic)
- Multi-game support with per-game vocabulary (rarities, sets, card types)

## Related

- Live site: [satorntcg.com](https://satorntcg.com)
- [satorntcg-mcpserver](https://github.com/satorntcg/satorntcg-mcpserver): an MCP server that exposes this platform's data as tools for AI assistants, with OpenTelemetry tracing, tests, and LLM evals

## Stack

React 18 · Vite · react-router-dom · Supabase · Recharts

## License

All rights reserved. This repository is shared publicly as a portfolio
sample only — see [LICENSE](LICENSE) for terms.

## Author

Christopher Rogers ([satorntcg](https://github.com/satorntcg)) · [crogers.dev](https://www.crogers.dev)
