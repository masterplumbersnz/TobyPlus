document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('chat-form');
  const input = document.getElementById('user-input');
  const messages = document.getElementById('messages');
  const micBtn = document.getElementById('mic-btn');

  // === Add Stop Talking button ===
  const stopTalkBtn = document.createElement('button');
  stopTalkBtn.textContent = "🛑 Stop Talking";
  stopTalkBtn.style.marginLeft = "8px";
  stopTalkBtn.onclick = () => {
    window.speechSynthesis.cancel();
    console.log("🛑 Speech stopped by user");
    updateDebug("Speech stopped");
  };
  form.appendChild(stopTalkBtn);

  let thread_id = null;

  // === Endpoints ===
  const transcribeEndpoint = "/.netlify/functions/transcribe";
  const ttsEndpoint = "/.netlify/functions/tts";

  // === Recording state ===
  let mediaStream = null;
  let mediaRecorder = null;
  let chunks = [];
  let isRecording = false;
  let hasStopped = false;

  // === Debug overlay ===
  const debugOverlay = document.createElement('div');
  debugOverlay.style.position = 'fixed';
  debugOverlay.style.bottom = '10px';
  debugOverlay.style.right = '10px';
  debugOverlay.style.background = 'rgba(0,0,0,0.7)';
  debugOverlay.style.color = 'white';
  debugOverlay.style.padding = '8px 12px';
  debugOverlay.style.borderRadius = '6px';
  debugOverlay.style.fontSize = '12px';
  debugOverlay.style.zIndex = '9999';
  debugOverlay.style.maxWidth = '240px';
  debugOverlay.style.fontFamily = 'monospace';
  debugOverlay.innerText = "🔍 Debug ready";
  document.body.appendChild(debugOverlay);

  const updateDebug = (msg) => {
    debugOverlay.innerText = msg;
  };

  // === Speech queue ===
  let speechQueue = Promise.resolve();
  const enqueueSpeech = (fn) => {
    speechQueue = speechQueue.then(fn).catch((err) => {
      console.error("🔇 Speech error:", err);
      updateDebug("Speech error: " + err.message);
    });
  };

  // === Autoplay unlock ===
  async function unlockAutoplay() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const source = ctx.createBufferSource();
      const buffer = ctx.createBuffer(1, 1, 22050);
      source.buffer = buffer;
      source.connect(ctx.destination);
      source.start(0);
      await ctx.resume();
      console.log("🔓 Autoplay unlocked");
      updateDebug("Autoplay unlocked");
    } catch (e) {
      console.warn("Autoplay unlock failed", e);
      updateDebug("Autoplay unlock failed: " + e.message);
    }
  }

  // === Speech unlock for mobile ===
  function unlockSpeech() {
    try {
      if (!("speechSynthesis" in window)) return;
      const utterance = new SpeechSynthesisUtterance(".");
      utterance.volume = 0;
      window.speechSynthesis.speak(utterance);
      console.log("🔓 Speech synthesis unlocked");
      updateDebug("Speech unlocked");
    } catch (e) {
      console.warn("Speech unlock failed", e);
      updateDebug("Speech unlock failed: " + e.message);
    }
  }

  // === Strip HTML for speech ===
  function stripHtmlTags(html) {
    let div = document.createElement("div");
    div.innerHTML = html;
    return div.textContent || div.innerText || "";
  }

  // === Speech methods ===
  const speakBrowser = (text) => {
    const plainText = stripHtmlTags(text); // ✅ strip HTML before speaking
    if (!plainText.trim()) return; // don't read empty text
    enqueueSpeech(() => new Promise((resolve) => {
      if (!("speechSynthesis" in window)) return resolve();
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(plainText);
      utterance.lang = "en-US";
      utterance.onend = resolve;
      utterance.onerror = (err) => {
        console.error("SpeechSynthesis error:", err);
        updateDebug("Speech synthesis error: " + err.message);
        resolve();
      };
      window.speechSynthesis.speak(utterance);
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

  // === Recording ===
  const pickAudioMime = () => {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported("audio/webm;codecs=opus"))
      return "audio/webm;codecs=opus";
    if (window.MediaRecorder && MediaRecorder.isTypeSupported("audio/webm"))
      return "audio/webm";
    if (window.MediaRecorder && MediaRecorder.isTypeSupported("audio/mp4"))
      return "audio/mp4";
    return "";
  };

  async function startRecording() {
    try {
      hasStopped = false;

      mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = pickAudioMime();
      mediaRecorder = new MediaRecorder(mediaStream, mimeType ? { mimeType } : undefined);

      chunks = [];
      mediaRecorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunks.push(e.data);
      };

      mediaRecorder.onstop = async () => {
        if (!chunks.length) return;
        updateDebug("Recording stopped, sending for transcription…");
        const blob = new Blob(chunks, { type: mediaRecorder.mimeType || "audio/webm" });
        await sendAudioForTranscription(blob);
        mediaStream.getTracks().forEach(t => t.stop());
        mediaStream = null;
      };

      // 🔊 Silence detection with RMS
      const audioContext = new AudioContext();
      const source = audioContext.createMediaStreamSource(mediaStream);
      const analyser = audioContext.createAnalyser();
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

      mediaRecorder.start();
      isRecording = true;
      micBtn.textContent = "🛑";
      updateDebug("Recording started…");
    } catch (err) {
      console.error("getUserMedia error:", err);
      updateDebug("Mic error: " + err.message);
      createBubble("⚠️ I can't access your microphone. Please allow mic access in your browser **and** operating system settings, then try again.", "bot");
    }
  }

  function stopRecording() {
    if (hasStopped) return;
    hasStopped = true;
    if (isRecording && mediaRecorder) {
      mediaRecorder.stop();
    }
    isRecording = false;
    micBtn.textContent = "🎤";
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
          mimeType: blob.type || "audio/webm",
          fileName: blob.type.includes("mp4") ? "recording.mp4" : "recording.webm",
        }),
      });
      if (!res.ok) {
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
      updateDebug("Transcription error: " + err.message);
      createBubble("⚠️ Something went wrong with transcription. Please try again.", "bot");
    }
  }

  // === Event handlers with unlocks ===
  micBtn.addEventListener("click", async () => {
    unlockSpeech();
    await unlockAutoplay();
    if (!isRecording) {
      await startRecording();
    } else {
      stopRecording();
    }
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    unlockSpeech();
    await unlockAutoplay();
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
      updateDebug("Chat error: " + err.message);
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

  // narrate flag (default true)
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
      replayBtn.style.marginLeft = "8px";
      replayBtn.onclick = async () => {
        if (div.dataset.hqAudio) {
          const audio = new Audio(div.dataset.hqAudio);
          audio.play().catch(err => {
            console.error("Replay error:", err);
            speakBrowser(cleaned);
          });
        } else {
          speakBrowser(cleaned);
        }
      };
      wrapper.appendChild(avatar);
      wrapper.appendChild(div);
      wrapper.appendChild(replayBtn);
      messages.appendChild(wrapper);
      if (narrate) speakBrowser(cleaned); // ✅ only narrate if allowed
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
    // ✅ Spinner bubble is created but not narrated
    return createBubble('<span class="spinner"></span> Toby is thinking...', 'bot', false);
  };
});
