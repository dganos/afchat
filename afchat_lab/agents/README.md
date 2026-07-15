# Per-model candidate agent configurations

One folder per candidate model. Each `package.json` **extends the PRODUCTION
package in the Aristo folder** (`packages/gemma4-qa` — the configuration Aristo
actually ships with) and declares ONLY its model block (id, context_length,
think). System prompt, tool contracts, and runtime knobs are inherited from
production, so every candidate is measured under exactly the production agent
contract and cannot silently drift from it.

- Tuning a CANDIDATE (its ctx, think, or an experimental prompt): edit that
  candidate's folder here.
- Tuning the AGENT (prompt, tools, steps, caps): edit the production package —
  the change applies to Aristo and to every candidate at once (SAME AGENT rule,
  see ../README.md).
- Promoting a candidate to production: fold its model block into
  `packages/gemma4-qa/package.json`.
