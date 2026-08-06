# Voice capability build — make the 'planned' engines 'ready' + wire features (epic #113)

Continuation plan for the voice-engine capability pass. The role/resolver core + GUI + config-bridge are
DONE (`shared/speech/voice-engines.js`, `/v2/voice/engines*`, Settings→Voice Engines). What remains: build
the engine *adapters* so `planned` → `ready`, and consume their capabilities in the surfaces.

`IMPLEMENTED` set (in voice-engines.js) is the gate — add an engine id there once its adapter is wired +
tested, so the GUI stops showing it as "(planned)".

## Already landed this arc
- `stt.transcribeDiarized(buffer, opts)` — OpenAI `gpt-4o-transcribe-diarize` + `response_format=diarized_json`
  → `{ text, segments:[{speaker,start,end,text}], model }`. Supports `opts.known=[{name,audio,mime}]` (≤4)
  → `known_speaker_references` for named speakers. **This is the keystone.** Not yet wired into the recorder.

## Build order (do in this sequence, test each)

### 1. openai-transcribe-diarize → ready  (flagship, file diarization)
- Wire `transcribeDiarized` into the recorder path. `shared/speech/transcribe-long.js` chunks past 25MB, so:
  when the resolved **transcribe** engine has `caps.diarization`, run the diarized call per chunk and stitch.
  **Cross-chunk speaker consistency**: chunk N's "Speaker 1" ≠ chunk N+1's. Fix by, after chunk 0, extracting
  a short reference clip per speaker and passing them as `known` to later chunks (or a light re-cluster on
  embeddings). MVP acceptable: per-chunk labels + a note; proper stitching is the polish.
- Store `segments` on the recording record (`shared/recordings.js` meta) + `speakers[]`.
- Render a **speaker-grouped transcript** in `insights/dashboard/src/views/Recordings.vue` (and later the app).
- Add `openai-transcribe-diarize` to `IMPLEMENTED`. **Test:** re-transcribe the meeting recording
  (`rec_...` in the Self silo) → verify speaker-labeled segments.
- Add a core route to trigger a diarized re-transcribe of an existing recording (e.g. `POST /v2/recordings/:id/diarize`).

### 2. People records + linking (#95/#111)
- A people store (`shared/people.js`): `{id,name,voiceprint_ref?}`. Link a recording's speakers → people
  (name-attribution reasoning pass over the diarized transcript, like the enrichment labeler).
- Search recordings by person. Owner always identifiable.

### 3. Voiceprinting + consent read-aloud (#112) — GATED per docs/research/VOICE-PRINTING-LEGAL.md
- Store a per-person reference clip (encrypted, in a silo) = the "voiceprint"; feed as `known_speaker_references`
  so future recordings auto-label them. Owner default; third parties require explicit opt-in.
- **Consent read-aloud**: a button that speaks a scripted consent request via `asmltr notify` / device TTS
  ("May I keep a voiceprint so I can recognize you next time? You can say no."). Log consent + who/when.

### 4. openai-live-transcribe → ready  (realtime diarized meeting mode, §B8)
- `stt.realtimeToken` already passes the model. Build the live diarized-segment consumption (segment events
  with speaker) in the recorder/app; add live meeting mode (highlight→ask + wake-word). Test a real session.
- Add to `IMPLEMENTED` after a live test.

### 5. deepgram → ready
- Vault the key as `deepgram_api_key` (currently BWS `3dprintpgh_deepgram_api_key` — DECIDE whether to reuse
  the client key or a separate one). Build a Deepgram STT adapter (file + streaming diarization). Add to IMPLEMENTED.

### 6. local-whisper → ready (or gate on detection)
- Install whisper (RAM-capped — see feedback_check_resources_before_heavy_jobs) + wire a local adapter, or
  keep it out of `IMPLEMENTED` and gate availability on binary detection so it never shows falsely "ready".

### 7. Surfaces consume resolve(role).capabilities
- Recorder transcript view + live mode render speaker labels only when `caps.diarization`; known-speaker
  enrollment only when `caps.known_speakers`; word-level anchoring only when `caps.word_timestamps`.
- **Android app**: STT/TTS already follow the server config via `/gw/transcribe` + `/gw/tts` (no APK change for
  provider/model). Speaker-label *rendering* in the app needs UI + an APK rebuild (memory-capped gradle).

## Test checklist
- Diarized re-transcribe of the meeting → sensible speaker turns.
- Bind each engine in Settings→Voice Engines → chips + status correct; `ready` ones selectable.
- Config bridge: binding an engine updates `/v2/voice/config` (verified) → surfaces follow.
- Cost: diarize ~$0.006/min (same as transcribe).

## ⚠️ BLOCKER found (2026-08-06): OpenAI project lacks diarize-model access
The diarize adapter (`stt.transcribeDiarized` + `POST /v2/recordings/:id/diarize`) is built and VERIFIED
correct — the request is well-formed. But the OpenAI project returns:
`403 Project proj_… does not have access to model gpt-4o-transcribe-diarize`.
**Action (Jareth):** enable `gpt-4o-transcribe-diarize` for the project in the OpenAI dashboard
(Project → model access, and/or complete org verification). Then add `openai-transcribe-diarize` to the
`IMPLEMENTED` set in `shared/speech/voice-engines.js` → it's instantly 'ready' and the recorder diarize
path works (test: `POST /v2/recordings/<meeting-id>/diarize`). Same likely applies to `gpt-live-transcribe`.
