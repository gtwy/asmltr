# Wake-word keyword models (.ppn)

Porcupine keyword files for the phone app's wake word. These are **licensed binaries** generated per
phrase at https://console.picovoice.ai (free) — not committed (gitignored).

To add a phrase:
1. Console → Porcupine → type the phrase (e.g. "hey eve") → platform **Android** → matching Porcupine
   version → download the `.ppn`.
2. Drop it here named after the phrase's slug: lowercase, non-alphanumerics → `-`.
   e.g. "hey eve" → `hey-eve.ppn`,  "computer" → `computer.ppn`.
3. Set the same phrase in Settings → Voice → Wake phrase. The app downloads it via `/gw/wake-model`.

The runtime access key comes from the `porcupine_access_key` secret (served via `/gw/wake`).
