import { ref } from 'vue'
import { voice, stt } from '@/services/api'

// In-browser speech for the chat: TTS read-aloud (synthesize reply text → play) and push-to-talk STT
// (record mic → transcribe via the configured server model → text). Both use the real models selected
// in Settings — no browser SpeechRecognition. One instance per chat window.
export function useSpeech() {
  // ---- TTS playback ----
  const speaking = ref(false)
  let audioEl = null
  function stopSpeaking() { if (audioEl) { try { audioEl.pause() } catch (_) {} audioEl = null } speaking.value = false }
  async function speak(text, opts = {}) {
    stopSpeaking()
    const t = String(text || '').trim()
    if (!t) return
    speaking.value = true
    try {
      const { mime, b64 } = await voice.tts(t, opts)
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
      const url = URL.createObjectURL(new Blob([bytes], { type: mime || 'audio/mpeg' }))
      audioEl = new Audio(url)
      const cleanup = () => { speaking.value = false; URL.revokeObjectURL(url) }
      audioEl.onended = cleanup
      audioEl.onerror = cleanup
      await audioEl.play().catch(() => { speaking.value = false })
    } catch (e) { speaking.value = false; throw e }
  }

  // ---- STT push-to-talk ----
  const recording = ref(false)
  const transcribing = ref(false)
  let mediaRec = null
  let chunks = []
  let stream = null
  function stopTracks() { for (const t of (stream ? stream.getTracks() : [])) { try { t.stop() } catch (_) {} } stream = null }

  async function startRecording() {
    if (recording.value) return
    stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    chunks = []
    const type = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus'
      : (MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '')
    mediaRec = new MediaRecorder(stream, type ? { mimeType: type } : {})
    mediaRec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data) }
    mediaRec.start()
    recording.value = true
  }

  // Stop, transcribe the recording, return the text. Returns '' if nothing was captured.
  async function stopRecording() {
    if (!mediaRec) return ''
    const rec = mediaRec
    const stopped = new Promise((resolve) => { rec.onstop = resolve })
    try { rec.stop() } catch (_) {}
    recording.value = false
    await stopped
    stopTracks()
    const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' })
    chunks = []; mediaRec = null
    if (!blob.size) return ''
    transcribing.value = true
    try { const r = await stt.transcribe(blob); return (r.text || '').trim() }
    finally { transcribing.value = false }
  }

  function cancelRecording() {
    if (mediaRec) { try { mediaRec.onstop = null; mediaRec.stop() } catch (_) {} }
    stopTracks(); mediaRec = null; chunks = []; recording.value = false
  }

  return { speaking, speak, stopSpeaking, recording, transcribing, startRecording, stopRecording, cancelRecording }
}
