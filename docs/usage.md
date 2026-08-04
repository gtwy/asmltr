# Usage & cost accounting

The dashboard's **Usage** tab answers three questions: how many tokens flow through each surface, **who**
they're attributed to, and **what it costs**. This page explains the two dollar figures, how attribution
works, and how to adjust the price table.

## Two dollar figures: Billed vs Equivalent value

Every recorded turn (and every metered side-call) gets priced. There are two numbers, and they mean
different things:

- **Billed** — what actually hits a card. Only surfaces backed by a **metered API key** contribute:
  text-to-speech, transcription, and the moderation/labeler model calls, plus any reasoning engine you
  run in API-key mode. Claude on a Max/Pro subscription contributes **$0** here.
- **Equivalent value** — what the same usage *would* cost at public API list prices, computed for
  **everything** — including subscription engines. This lets you see the value you're getting from a flat
  subscription even though you aren't charged per token for it.

So a box that runs Claude on a subscription and uses OpenAI only for voice will show a large Equivalent
value and a small Billed total (just the voice + moderation spend).

The split is driven by a `billed` flag decided at record time from the engine/provider's auth mode
(`subscription` → not billed; `api_key` → billed). Both numbers ride the shared event contract
(`cost_usd` = equivalent, `billed_cost_usd` = billed) into the collector and the Usage view.

## Attribution: by user, not by raw handle

The per-user table groups by the **trust principal**, not the raw channel identity. A person with several
linked handles in the **Access** tab — a Discord id, an email, a GitHub login, an MCP client id — folds
into a single row. The resolution happens at display time against the trust store's identifier map, so it
respects Access-tab edits live (link two handles and their history merges on the next refresh, with no
re-processing). Unlinked identities fall back to a case-normalized key, so casing variants (e.g.
`moneo`/`Moneo`) still merge before you formally link them.

Under the hood the token-usage event is attributed to the **raw sender** (matching the inbound message),
and also carries the resolved `principal` in its payload — so the raw fidelity is preserved while the view
folds up to the person.

### Token estimation fallback

Some engines don't report token counts (e.g. a Gemini turn whose stream omits the usage line). Rather than
log zero tokens for a real turn, asmltr estimates from text length (~4 chars/token) and flags the event
`estimated`. The input estimate is a floor (it counts the user's text, not the full system prompt/history),
so treat estimated rows as a lower bound.

## Metered spend breakdown

The **Metered spend · by feature & provider** panel breaks the Billed total down into the side-surfaces
that generate it:

| Feature | Priced by | Typical provider |
|---|---|---|
| Text-to-speech | characters synthesized | OpenAI, ElevenLabs |
| Transcription (STT) | seconds of audio | OpenAI |
| Moderation | model tokens | OpenAI (or Anthropic) |

These are emitted as `token-usage` events tagged with a `feature` in their payload (via
`shared/usage.js` `auxUsage()`), then rolled up per `(feature, provider, model, units)` in the collector's
`usage_aux` table and returned on `GET /api/usage` as `aux[]`.

!!! note "STT duration is estimated"
    Most transcription models don't return an audio `duration`, so seconds are estimated from the encoded
    clip size using a nominal bitrate per container (see `estimateAudioSeconds`). STT is cheap ($/min), so
    a ballpark keeps the Billed total honest without decoding the media.

## The price table & overrides

Prices live in `shared/pricing.js` as a best-effort snapshot of public list prices:

- `models` — USD per **1,000,000** tokens, `{ in, out }`. Matched by **longest prefix** on the model id, so
  `gpt-4o-mini-2026-…` resolves to `gpt-4o-mini` (not `gpt-4o`), and a trailing date suffix is ignored.
- `tts` — USD per **1,000 characters**. Any unknown `eleven_*` model falls back to a generic ElevenLabs rate.
- `stt` — USD per **minute** of audio.

List prices drift, so the whole table is overridable — drop a JSON file at `~/.asmltr/pricing.json` (or point
`ASMLTR_PRICING_FILE` at one) and it's deep-merged over the defaults:

```json
{
  "models": { "opus": { "in": 15, "out": 75 } },
  "tts":    { "eleven_turbo_v2_5": 0.15 },
  "stt":    { "gpt-4o-transcribe": 0.006 }
}
```

Changes apply on the next process start (or call `pricing.reload()`).

## Data model (reference)

- `events.cost_usd` / `events.billed_cost_usd` — per-event equivalent + billed value (append-only spine).
- `usage_rollup` — per `(bucket_hour, surface, identity)` token + cost rollup (the per-user table).
- `usage_aux` — per `(bucket_hour, surface, feature, provider, model, units)` metered-spend rollup (the
  breakdown panel).
- `GET /api/usage?since=<ms>` → `{ usage: [...], aux: [...] }`.
