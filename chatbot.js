document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('chat-form');
  const input = document.getElementById('user-input');
  const messages = document.getElementById('messages');
  const micBtn = document.getElementById('mic-btn');

  // === State ===
  let thread_id = null;
  let mediaStream = null;
  let mediaRecorder = null;
  let chunks = [];
  let isRecording = false;
  let hasStopped = false;

  // === Endpoints ===
  const transcribeEndpoint = "/.netlify/functions/transcribe";
  const ttsEndpoint = "/.netlify/functions/tts";

  // === Debug overlay ===
  const debugOverlay = document.createElement('div');
  debugOverlay.className = "debug-overlay";
  debugOverlay.innerText = "🔍 Debug ready";
  document.body.appendChild(debugOverlay);
  const updateDebug = (msg) => (debugOverlay.innerText = msg);

  // === Stop Talking button (in the .button-group) ===
  const stopTalkBtn = document.createElement('button');
  stopTalkBtn.textContent = "🛑";
  stopTalkBtn.className = "stop-talk-btn";
  stopTalkBtn.title = "Stop playback";
  stopTalkBtn.setAttribute('aria-label', 'Stop playback');
  stopTalkBtn.onclick = () => {
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    updateDebug("Speech stopped");
  };
  document.querySelector('.button-group').appendChild(stopTalkBtn);

  // === One AudioContext (mobile friendly) ===
  let audioCtx;
  function getAudioContext() {
    try {
      if (!audioCtx) {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (Ctx) audioCtx = new Ctx();
      }
      return audioCtx;
    } catch (e) {
      console.warn("AudioContext error:", e);
      return null;
    }
  }

  // === Autoplay/speech unlocks ===
  async function unlockAutoplay() {
    try {
      const ctx = getAudioContext();
      if (!ctx) return;
      const source = ctx.createBufferSource();
      const buffer = ctx.createBuffer(1, 1, 22050);
      source.buffer = buffer;
      source.connect(ctx.destination);
      source.start(0);
      await ctx.resume();
      updateDebug("Autoplay unlocked");
    } catch (e) {
      console.warn("Autoplay unlock failed", e);
      updateDebug("Autoplay unlock failed: " + e.message);
    }
  }

  function unlockSpeech() {
    try {
      if (!("speechSynthesis" in window)) return;
      const u = new SpeechSynthesisUtterance(".");
      u.volume = 0;
      window.speechSynthesis.speak(u);
      updateDebug("Speech unlocked");
    } catch (e) {
      console.warn("Speech unlock failed", e);
      updateDebug("Speech unlock failed: " + e.message);
    }
  }

  // Unlock on any first user gesture (helps mobile)
  let unlocked = false;
  function globalUnlockOnce() {
    if (unlocked) return;
    unlocked = true;
    unlockSpeech();
    unlockAutoplay();
  }
  ['click', 'touchstart'].forEach(evt =>
    document.addEventListener(evt, globalUnlockOnce, { once: true, passive: true })
  );

  // === Mic permission preflight (if supported) ===
  async function checkMicPermission() {
    try {
      if (!navigator.permissions || !navigator.permissions.query) {
        updateDebug("Permissions API not available");
        return;
      }
      const status = await navigator.permissions.query({ name: "microphone" });
      updateDebug(`Mic permission: ${status.state}`);
      status.onchange = () => updateDebug(`Mic permission: ${status.state}`);
    } catch (e) {
      // Not supported on all browsers
    }
  }
  checkMicPermission();

  // === Strip HTML before TTS ===
  function stripHtmlTags(html) {
    const div = document.createElement("div");
    div.innerHTML = html;
    return div.textContent || div.innerText || "";
  }

  // === Speech queue ===
  let speechQueue = Promise.resolve();
  const enqueueSpeech = (fn) => {
    speechQueue = speechQueue.then(fn).catch((err) => {
      console.error("🔇 Speech error:", err);
      updateDebug("Speech error: " + err.message);
    });
  };

  const speakBrowser = (text) => {
    const plainText = stripHtmlTags(text);
    if (!plainText.trim()) return;
    enqueueSpeech(() => new Promise((resolve) => {
      if (!("speechSynthesis" in window)) return resolve();
      try { window.speechSynthesis.cancel(); } catch {}
      const u = new SpeechSynthesisUtterance(plainText);
      u.lang = "en-US";
      u.onend = resolve;
      u.onerror = (err) => { console.error("SpeechSynthesis error:", err); resolve(); };
      window.speechSynthesis.speak(u);
    }));
  };

  const generateServerTTS = async (text) => {
    try {
      const res = await fetch(ttsEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, voice: "alloy", format: "mp3" }),
      });
      if (!res.ok) throw new Error(await res.text());
      const { audioBase64, mimeType } = await res.json();
      return `data:${mimeType};base64,${audioBase64}`;
    } catch (e) {
      console.error("TTS error:", e);
      updateDebug("TTS error: " + e.message);
      return null;
    }
  };

  // === Recording helpers ===
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;

  // Prefer types per platform
  function pickAudioMime() {
    try {
      if (window.MediaRecorder) {
        // Safari/iOS often supports mp4 better than webm
        if (MediaRecorder.isTypeSupported("audio/mp4")) return "audio/mp4";
        if (MediaRecorder.isTypeSupported("audio/webm;codecs=opus")) return "audio/webm;codecs=opus";
        if (MediaRecorder.isTypeSupported("audio/webm")) return "audio/webm";
      }
    } catch {}
    return ""; // let the browser decide
  }

  async function startRecording() {
    try {
      hasStopped = false;
      globalUnlockOnce();

      // Explicit audio only (helps some Android/iOS prompts)
      mediaStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      const mimeType = pickAudioMime();
      mediaRecorder = new MediaRecorder(mediaStream, mimeType ? { mimeType } : undefined);

      chunks = [];
      mediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };

      mediaRecorder.onstop = async () => {
        try {
          if (!chunks.length) return;
          updateDebug("Recording stopped, sending for transcription…");
          const type = mediaRecorder.mimeType || (isIOS ? "audio/mp4" : "audio/webm");
          const blob = new Blob(chunks, { type });
          await sendAudioForTranscription(blob);
        } finally {
          try { mediaStream.getTracks().forEach(t => t.stop()); } catch {}
          mediaStream = null;
        }
      };

      // 🔊 Silence detection (RMS)
      const ctx = getAudioContext();
      const source = ctx ? ctx.createMediaStreamSource(mediaStream) : null;
      const analyser = ctx ? ctx.createAnalyser() : null;
      if (ctx && source && analyser) {
        analyser.fftSize = 256;
        source.connect(analyser);
        const data = new Uint8Array(analyser.fftSize);

        let silenceStart = null;
        const maxSilence = 2000;

        function checkSilence() {
          if (hasStopped || !isRecording) return;
          analyser.getByteTimeDomainData(data);
          const rms = Math.sqrt(
            data.reduce((sum, v) => {
              const norm = (v - 128) / 128;
              return sum + norm * norm;
            }, 0) / data.length
          );
          const volume = rms * 100;
          updateDebug(`🎙️ Rec: ${isRecording} | Vol: ${volume.toFixed(2)}`);
          if (volume < 5) {
            if (!silenceStart) silenceStart = Date.now();
            else if (Date.now() - silenceStart > maxSilence) {
              stopRecording();
              updateDebug("Stopped by silence");
              return;
            }
          } else {
            silenceStart = null;
          }
          requestAnimationFrame(checkSilence);
        }
        checkSilence();
      } else {
        updateDebug("Analyser unavailable; skipping silence detection");
      }

      mediaRecorder.start();
      isRecording = true;
      micBtn.textContent = "🛑 Finished Talking";
      micBtn.setAttribute('aria-label', 'Stop recording');
      updateDebug("Recording started…");
    } catch (err) {
      console.error("getUserMedia error:", err);
      updateDebug("Mic error: " + (err && err.message ? err.message : String(err)));
      createBubble("⚠️ I can't access your microphone. Please allow mic access in your browser **and** operating system settings, then try again.", "bot");
    }
  }

  function stopRecording() {
    if (hasStopped) return;
    hasStopped = true;
    try { if (isRecording && mediaRecorder) mediaRecorder.stop(); } catch {}
    isRecording = false;
    micBtn.textContent = "🎙️Voice Chat";
    micBtn.setAttribute('aria-label', 'Start recording');
    updateDebug("Recording stopped");
  }

  async function sendAudioForTranscription(blob) {
    updateDebug("Sending audio for transcription…");
    try {
      const ab = await blob.arrayBuffer();
      const base64 = btoa(String.fromCharCode(...new Uint8Array(ab)));
      const res = await fetch(transcribeEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          audioBase64: base64,
          mimeType: blob.type || (isIOS ? "audio/mp4" : "audio/webm"),
          fileName: (blob.type && blob.type.includes("mp4")) || isIOS ? "recording.mp4" : "recording.webm",
        }),
      });
      if (!res.ok) {
        updateDebug("Transcribe HTTP " + res.status);
        createBubble("🤖 I couldn't transcribe that audio. Can we try again?", "bot");
        return;
      }
      const { text } = await res.json();
      if (!text) {
        createBubble("🤖 I didn’t catch that — could you try again?", "bot");
        return;
      }
      input.value = text;
      form.requestSubmit();
    } catch (err) {
      console.error("sendAudioForTranscription error:", err);
      updateDebug("Transcription error: " + (err && err.message ? err.message : String(err)));
      createBubble("⚠️ Something went wrong with transcription. Please try again.", "bot");
    }
  }

  // === UI events ===
  micBtn.addEventListener("click", async () => {
    globalUnlockOnce();
    if (!isRecording) {
      await startRecording();
    } else {
      stopRecording();
    }
  });

  // Enter-to-send
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      form.requestSubmit();
    }
  });

  // Auto-resize textarea
  input.addEventListener("input", () => {
    input.style.height = "auto";
    input.style.height = input.scrollHeight + "px";
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    globalUnlockOnce();
    const message = input.value.trim();
    if (!message) return;

    createBubble(message, 'user');
    input.value = '';
    input.style.height = 'auto';
    const thinkingBubble = showSpinner();
    updateDebug("Message sent, waiting for reply…");

    try {
      const startRes = await fetch('https://resilient-palmier-22bdf1.netlify.app/.netlify/functions/start-run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, thread_id }),
      });
      const { thread_id: newThreadId, run_id } = await startRes.json();
      thread_id = newThreadId;

      let reply = '';
      let completed = false;
      while (!completed) {
        const checkRes = await fetch('https://resilient-palmier-22bdf1.netlify.app/.netlify/functions/check-run', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ thread_id, run_id }),
        });
        if (checkRes.status === 202) {
          updateDebug("Bot thinking…");
          await new Promise(r => setTimeout(r, 1000));
        } else if (checkRes.ok) {
          const data = await checkRes.json();
          reply = data.reply || '(No response)';
          completed = true;
        } else {
          throw new Error('Check-run failed with status: ' + checkRes.status);
        }
      }

      thinkingBubble.remove();
      updateDebug("Reply received");
      createBubble(reply, 'bot');
    } catch (err) {
      console.error('Chat error:', err);
      updateDebug("Chat error: " + (err && err.message ? err.message : String(err)));
      thinkingBubble.remove();
      createBubble('🤖 My circuits got tangled for a second. Can we try that again?', 'bot');
    }
  });

  // === Chat helpers ===
  const formatMarkdown = (text) => {
    return text
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/^(\d+)\.\s+(.*)$/gm, '<p><strong>$1.</strong> $2</p>')
      .replace(/\n{2,}/g, '<br><br>')
      .replace(/\n/g, '<br>');
  };

  const stripCitations = (text) => {
    return text.replace(/【\d+:\d+†[^†【】]+(?:†[^【】]*)?】/g, '');
  };

  const createBubble = (content, sender, narrate = true) => {
    const div = document.createElement('div');
    const cleaned = stripCitations(content);
    const formatted = formatMarkdown(cleaned);

    if (sender === 'bot') {
      const wrapper = document.createElement('div');
      wrapper.className = 'bot-message';

      const avatar = document.createElement('img');
      avatar.src = 'https://resilient-palmier-22bdf1.netlify.app/Toby-Avatar.svg';
      avatar.alt = 'Toby';
      avatar.className = 'avatar';

      div.className = 'bubble bot';
      div.innerHTML = formatted;

      const replayBtn = document.createElement("button");
      replayBtn.textContent = "🔊";
      replayBtn.className = "replay-btn";
      replayBtn.title = "Replay audio";
      replayBtn.setAttribute('aria-label', 'Replay audio');
      replayBtn.onclick = async () => {
        globalUnlockOnce();
        if (div.dataset.hqAudio) {
          const audio = new Audio(div.dataset.hqAudio);
          try { await audio.play(); }
          catch (err) {
            console.error("Replay error:", err);
            speakBrowser(cleaned); // fallback
          }
        } else {
          speakBrowser(cleaned);
        }
      };

      wrapper.appendChild(avatar);
      wrapper.appendChild(div);
      wrapper.appendChild(replayBtn);
      messages.appendChild(wrapper);

      if (narrate) speakBrowser(cleaned);
      generateServerTTS(cleaned).then((url) => {
        if (url) div.dataset.hqAudio = url;
      });
    } else {
      div.className = 'bubble user';
      div.innerHTML = content;
      messages.appendChild(div);
    }
    messages.scrollTop = messages.scrollHeight;
    return div;
  };

  const showSpinner = () => {
    // spinner is not narrated
    return createBubble('<span class="spinner"></span> Toby is thinking...', 'bot', false);
  };

  // === Optional: service worker (safe registration) ===
  if ("serviceWorker" in navigator) {
    try {
      navigator.serviceWorker.register("/service-worker.js").catch(() => {});
    } catch {}
  }
});
