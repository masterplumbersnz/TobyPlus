document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('chat-form');
  const input = document.getElementById('user-input');
  const messages = document.getElementById('messages');
  const micBtn = document.getElementById('mic-btn');
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
  let transcriptionInProgress = false;

  // === Speech queue ===
  let speechQueue = Promise.resolve();
  const enqueueSpeech = (fn) => {
    speechQueue = speechQueue.then(fn).catch((err) => {
      console.error("🔇 Speech error:", err);
    });
  };

  // === Speech methods ===
  const speakBrowser = (text) => {
    enqueueSpeech(() => new Promise((resolve) => {
      if (!("speechSynthesis" in window)) return resolve();
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = "en-US";
      utterance.onend = resolve;
      utterance.onerror = (err) => {
        console.error("SpeechSynthesis error:", err);
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
      transcriptionInProgress = false;

      mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = pickAudioMime();
      mediaRecorder = new MediaRecorder(mediaStream, mimeType ? { mimeType } : undefined);

      chunks = [];
      mediaRecorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunks.push(e.data);
      };
      mediaRecorder.onstop = async () => {
        mediaRecorder.onstop = null;
        if (!chunks.length) return;

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
        analyser.getByteTimeDomainData(data);
        const rms = Math.sqrt(
          data.reduce((sum, v) => {
            const norm = (v - 128) / 128;
            return sum + norm * norm;
          }, 0) / data.length
        );
        const volume = rms * 100;

        if (volume < 5) {
          if (!silenceStart) silenceStart = Date.now();
          else if (Date.now() - silenceStart > maxSilence) {
            console.log("⏹️ Auto-stopping due to silence");
            stopRecording();
            return;
          }
        } else {
          silenceStart = null;
        }

        if (isRecording) requestAnimationFrame(checkSilence);
      }
      checkSilence();

      mediaRecorder.start();
      isRecording = true;
      micBtn.textContent = "🛑";
      console.log("🎙️ Recording started with silence detection");
    } catch (err) {
      console.error("getUserMedia error:", err);
      createBubble(
        "⚠️ I can't access your microphone. Please allow mic access in your browser **and** operating system settings, then try again.",
        "bot"
      );
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
  }

  async function sendAudioForTranscription(blob) {
    if (transcriptionInProgress) return;
    transcriptionInProgress = true;

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
        const detail = await res.text();
        console.error("Transcribe failed:", detail);
        createBubble("🤖 I couldn't transcribe that audio. Can we try again?", "bot");
        return;
      }

      const { text } = await res.json();
      if (!text) {
        createBubble("🤖 I didn't catch that—could you try again?", "bot");
        return;
      }

      input.value = text;
      form.requestSubmit();
    } catch (err) {
      console.error("sendAudioForTranscription error:", err);
      createBubble("⚠️ Something went wrong with transcription. Please try again.", "bot");
    } finally {
      transcriptionInProgress = false;
    }
  }

  micBtn.addEventListener("click", async () => {
    if (!isRecording) {
      await startRecording();
    } else {
      stopRecording();
    }
  });

  // === Chat UI helpers ===
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

  const createBubble = (content, sender) => {
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

      // 🔊 Replay button
      const replayBtn = document.createElement("button");
      replayBtn.textContent = "🔊";
      replayBtn.style.marginLeft = "8px";

      // Default to browser replay; if HQ audio ready, use that
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

      // 🟢 Speak instantly with browser TTS
      speakBrowser(cleaned);

      // 🎵 Also request HQ OpenAI TTS in background
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
    return createBubble('<span class="spinner"></span> Toby is thinking...', 'bot');
  };

  // === Chat submit ===
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const message = input.value.trim();
    if (!message) return;

    createBubble(message, 'user');
    input.value = '';
    input.style.height = 'auto';
    const thinkingBubble = showSpinner();

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
      createBubble(reply, 'bot');
    } catch (err) {
      console.error('Chat error:', err);
      thinkingBubble.remove();
      createBubble('🤖 My circuits got tangled for a second. Can we try that again?', 'bot');
    }
  });
});
