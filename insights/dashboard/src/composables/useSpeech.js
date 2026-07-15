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

  // ---- realtime hands-free dictation: streaming transcript + server VAD + auto-turn detection ----
  // Connects the mic straight to OpenAI's Realtime transcription API over WebRTC (via an ephemeral
  // token minted server-side). Emits partial text as you speak (onPartial) and a final transcript
  // when the server VAD decides you've stopped (onFinal) — the caller auto-sends on final.
  const live = ref(false)       // hands-free listening session active
  const listening = ref(false)  // VAD currently detects speech
  let pc = null, dc = null, rtStream = null
  function stopLive() {
    live.value = false; listening.value = false
    try { dc && dc.close() } catch (_) {} dc = null
    try { pc && pc.close() } catch (_) {} pc = null
    if (rtStream) { for (const t of rtStream.getTracks()) { try { t.stop() } catch (_) {} } rtStream = null }
  }
  async function startLive({ onPartial, onFinal, onError } = {}) {
    if (live.value) return
    const fail = (m) => { onError && onError(m); stopLive() }
    let tok
    try { tok = await stt.realtimeToken() } catch (e) { return fail('token: ' + (e.message || e)) }
    if (!tok || !tok.value) return fail('no realtime token')
    try { rtStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }) }
    catch (e) { return fail('microphone: ' + (e.message || e)) }
    try {
      pc = new RTCPeerConnection()
      pc.addTrack(rtStream.getAudioTracks()[0], rtStream)
      dc = pc.createDataChannel('oai-events')
      let pending = ''
      dc.onmessage = (ev) => {
        let m; try { m = JSON.parse(ev.data) } catch { return }
        const t = m.type || ''
        if (t === 'input_audio_buffer.speech_started') listening.value = true
        else if (t === 'input_audio_buffer.speech_stopped') listening.value = false
        else if (t.endsWith('input_audio_transcription.delta')) { pending += (m.delta || ''); onPartial && onPartial(pending) }
        else if (t.endsWith('input_audio_transcription.completed')) { const text = (m.transcript || pending || '').trim(); pending = ''; if (text) onFinal && onFinal(text) }
        else if (t === 'error') onError && onError((m.error && m.error.message) || 'realtime error')
      }
      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)
      const r = await fetch('https://api.openai.com/v1/realtime/calls', {
        method: 'POST', body: offer.sdp,
        headers: { Authorization: 'Bearer ' + tok.value, 'Content-Type': 'application/sdp' },
      })
      if (!r.ok) return fail('connect ' + r.status + ': ' + (await r.text().catch(() => '')).slice(0, 120))
      const answer = await r.text()
      await pc.setRemoteDescription({ type: 'answer', sdp: answer })
      live.value = true
    } catch (e) { return fail('webrtc: ' + (e.message || e)) }
  }

  return { speaking, speak, stopSpeaking, recording, transcribing, startRecording, stopRecording, cancelRecording, live, listening, startLive, stopLive }
}
