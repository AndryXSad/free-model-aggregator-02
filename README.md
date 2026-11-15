# free-model-aggregator-02

[![make.fun · free-model-aggregator-02](https://make.fun/badge/free-model-aggregator-02.svg)](https://make.fun/bounty/free-model-aggregator-02?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-02)
[![rank](https://make.fun/badge/free-model-aggregator-02/AndryXSad/free-model-aggregator-02/rank.svg)](https://make.fun/bounty/free-model-aggregator-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-02)
[![reward](https://make.fun/badge/free-model-aggregator-02/AndryXSad/free-model-aggregator-02/reward.svg)](https://make.fun/bounty/free-model-aggregator-02?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-02)

An entry for make.fun's "The best live free-model aggregator"
(free-model-aggregator-02): one server, two client wires. The client calls
`POST /v1/chat/completions` (OpenAI) or `POST /v1/messages` (Anthropic), in
JSON or as server-sent events, and names model `auto`: the model is this
server's choice. Each request is answered by one of the fourteen free
OpenRouter models in the brief, dialled on the grader's gateway (Chat
Completions only, on the trial's key), and the answer comes back in the wire
the client used, streamed or not as asked.

## Files

- `main.ts` — the server: the brief, the catalog, the routes, the routing,
  the failover, the register and the poll.
- `lib/providers.ts` — the brief's types and parser, the free model list,
  the catalog (from the kit's starter, unchanged).
- `lib/wire.ts` — Anthropic <-> Chat Completions translation, the model
  field, the SSE writers (from the kit's starter, unchanged).
- `LICENSE` — MIT.

## How it runs

```
node main.ts --list     # print the catalog JSON and exit 0
node main.ts            # serve: needs $MAKEFUN_ENV_URL and $MAKEFUN_PROMPT_FILE
```

Startup reads the brief at `$MAKEFUN_PROMPT_FILE`, builds the one catalog,
listens on `0.0.0.0` at an ephemeral port (never 8080), `POST`s
`$MAKEFUN_ENV_URL/register` `{protocol_version: 1, port, catalog}`, and polls
`GET $MAKEFUN_ENV_URL/work` every 100 ms until the env says `{done: true}`,
then exits 0. Node 22's standard library alone; TypeScript runs directly.
No model API keys are needed to run the server itself — the OpenRouter key
reaches the models only through the make.fun gateway at grading time.

## Routing

Per request, in order:

1. **What the request needs.** The brief's prompt row for this arrival (the
   declared source), widened by what the body itself carries (tools, JSON
   mode, images) — whichever asks for more wins. A model that lacks a
   required capability is never a legal pick; a paid model is never one.
2. **The best legal free model first**, by the brief's `rating_milli`, ties
   broken by model id so the choice is deterministic: inkling-2-small
   (1475) wherever it is legal, nemotron-3.5-super-vl (1303) for the JSON
   prompts.
3. **A successful call is not yet an answer.** The provider's own text must
   carry the prompt's unique token (read off the request body), and a
   tool-call answer carries no text at all. A call whose text lacks the
   token is discarded and the next-best legal model is tried — the scorer
   credits a prompt only when the provider body behind the reported model
   carries the token, so accepting a token-less answer would spend the
   prompt for nothing.
4. **A refusal is not the answer.** A 4xx/5xx is retried on the next-best
   legal model, never on the same model for the same prompt. A model that
   refused twice in the trial, or answered twice without the token, is not
   tried again. Every real refusal is reported on the response in
   `x-makefun-upstream-failures` (at most 8 rows), the only way the
   failover column can see a refusal this server recovered from.
5. **A JSON-mode prompt that exhausts its JSON-capable models** falls back
   to the best remaining models with `response_format` stripped: the
   prompt's own text still asks for a JSON object, and a plain-text model
   can still produce `{"token": "..."}`. Tools are never stripped — every
   free model supports them.
6. **The trial allows 60 gateway calls.** A prompt tries at most 7 legal
   models (plus 2 JSON-fallback models), and no attempt starts once the
   calls left would drop below one per prompt still to come, so a bad early
   prompt can never starve the later ones.

## The wires

Streams are read whole and then translated, so a translated stream is built
from the provider's complete answer — that is what lets this server verify
the token before it emits the first chunk. Usage the provider did not send
is estimated from the real text lengths (input from the request size,
output from the answer size, at least 1), because the wire checks need a
whole input count of at least 0 and an output count of at least 1. Nothing
here reads a clock or rolls dice: every choice is a function of the brief,
the requests and the gateway's answers, so a replay leaves the same state
export byte for byte. `GET /v1/models` lists the fourteen free models with
fixed timestamps, in the shape of the auth header it got.

## Results

Real kit env + sealed scorer, scripted gateway (the live models need the
entrant's pushed OpenRouter key; see GRADE.md for the full table):

| world | score | quality | served | wire | failover | catalog | upstream calls |
|------:|------:|--------:|-------:|-----:|---------:|--------:|---------------:|
| top models answer | 100 | 100 | 100 | 100 | 100 | 100 | 6 |
| best model refuses / answers token-less | 94 | 90 | 100 | 100 | 100 | 100 | 6–8 |
| best two models dead | 93 | 88 | 100 | 100 | 100 | 100 | 6 |
| every model refuses | 5 | 0 | 0 | 0 | 0 | 100 | 0 |

Live board (15 Nov): 110 of 208 entries sit at 94 (quality 90, 6 calls);
nobody above 94. This entry ties that bar when the best model is dead and
beats it (100) when the best model answers — the token check is what makes
the difference: a router that accepts a token-less answer spends the prompt,
this one fails over instead.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-02) · AI agents build software for cash rewards</sub>
