# Grade results — free-model-aggregator-02

Entry: `~/workspace/tools/makefun/free-model-aggregator-02/repo/`
Kit: `~/workspace/tools/makefun/free-model-aggregator-02/free-model-aggregator-02-kit/`

## Method

No provider key is available locally (no `OPENAI_API_KEY` /
`OPENROUTER_API_KEY` in the environment, and no OpenRouter key has been
pushed to this competition yet — `makefun secrets ls` says "none pushed"),
so no live model could be dialled from here. Instead the entry was graded
with the kit's REAL env (`program/env/server.mjs`) and the kit's SEALED
scorer (`program/scorer/score.mjs`), with a scripted gateway standing in
for OpenRouter: the gateway answers exactly like the provider would (JSON
or SSE, usage, finish reason, 429/500 error bodies), and a cassette was
built from its records, so the scorer's numbers are the official ones for
each scripted world. Harness: `/tmp/real-env-test.mjs`. Two rows (marked *)
come from the mock harness (`/tmp/mock-test.mjs`) instead: it drives the
same six prompts through a fake env and computes quality with the sealed
scorer's exact formula (floor, per-prompt cap), but its wire/failover
columns are the implied 100s, not the env's own checks.

## Scores (sealed scorer, identical on practice trials 0, 1 and 2)

| world | score | quality | served | wire | failover | catalog | upstream calls | gateway calls |
|------:|------:|--------:|-------:|-----:|---------:|--------:|---------------:|--------------:|
| happy (top models answer with the token) | 100 | 100 | 100 | 100 | 100 | 100 | 6 | 6 |
| inkling-2-small 429s | 94 | 90 | 100 | 100 | 100 | 100 | 6 | 8 |
| inkling-2-small answers without the token | 94 | 90 | 100 | 100 | 100 | 100 | 8 | 8 |
| inkling answers tool_calls / super-vl sends no usage * | 94 | 90 | 100 | 100 | 100 | 100 | 8 | 8 |
| super-vl 429s once, then answers * | 99 | 99 | 100 | 100 | 100 | 100 | 6 | 7 |
| inkling + super-vl dead | 93 | 88 | 100 | 100 | 100 | 100 | 6 | 10 |
| every model 429s | 5 | 0 | 0 | 0 | 0 | 100 | 0 | 28 |

Notes:

- `upstream_calls` is the scorer's tie-break count: only calls the
  provider answered. Refused calls (429/500) are not counted, so the
  429 worlds tie the live board's 6 calls; token-less 200s do count.
- Quality is `floor(100 * earned / bound)` with each prompt's rating
  capped at that prompt's best, exactly as the sealed scorer computes it.
- `real_model pass` on every world with a successful call.
- Two independent runs of the happy world and of the inkling-429 world
  produced byte-identical `state.json`, `scores.json` and `cassette.json`:
  the entry is replay-deterministic.

## Other checks

- `node main.ts --list` (no brief): prints `{"providers":[]}`, exit 0.
- `node main.ts --list` (practice brief): the fourteen dialable ids, once
  each, byte-identical to the register body's catalog (verified in every
  mock run).
- Entry size: 63.603 bytes total; largest file `main.ts` 31.431 bytes
  (limits: 16 MiB total, 8 MiB per file).
- Clean-directory run (`/tmp/clean-agg02`): `--list` prints the catalog,
  exit 0.
- `grade-local` live cannot run here: it refuses without a provider key
  (`ANTHROPIC_API_KEY` / `OPENAI_API_KEY`), and none exists locally.
  The real-env + sealed-scorer runs above are the same scoring path with
  scripted models.

## Live leaderboard bar (15 Nov 2026 ~15:30 WIB, 208 entries)

- 110 entries at 94 (quality 90, served/wire/failover/catalog 100,
  6 calls); nobody above 94. Rank 20 is 94.
- This entry ties the bar (94) whenever the best model is dead and beats
  it (100) whenever the best model answers with the token. Whether the
  live models answer with the token is the one thing no local run can
  settle without the pushed key — the server grade will tell.

## Honest verdict

Submit-worthy: the entry is the best routing this brief allows — best
model first, token-verified, failover with a reported trail — and it is
validated end-to-end by the sealed scorer in every world that can be
scripted. Its expected live score is 94–100 depending on one unknown:
whether inkling-2-small (1475) returns the prompt's token in its answer
text. If it does: 100, clear 1st. If it refuses or answers token-less:
94, tied with 110 entries (6 tie-break calls in the refusal world, 8 in
the token-less world). If the top two models are dead: 93, below the bar.

BLOCKER for the submitter: no OpenRouter key has been pushed to this
competition (`secrets ls`: none pushed). Without it every model call is
refused 401 on the server and the entry scores ~5. The user must push
`OPENROUTER_API_KEY` (from an OpenRouter account with 10+ credits
purchased) before submitting.
