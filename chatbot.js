document.addEventListener("DOMContentLoaded", () => {
  const form = document.getElementById("chat-form");
  const input = document.getElementById("user-input");
  const messages = document.getElementById("messages");
  const micBtn = document.getElementById("mic-btn");

  // === Stop Talking button ===
  const stopTalkBtn = document.createElement("button");
  stopTalkBtn.textContent = "🛑 Stop Playback";
  stopTalkBtn.className = "stop-talk-btn";
  stopTalkBtn.title = "Stop playback";
  stopTalkBtn.onclick = () => {
    window.speechSynthesis.cancel();
    updateDebug("Speech stopped by user");
  };
  document.querySelector(".button-group").appendChild(stopTalkBtn);

  let thread_id = null;

  // === Endpoints ===
  const transcribeEndpoint = "/.netlify/functions/transcribe";
  const ttsEndpoint = "/.netlify/functions/tts";
  const startRunEndpoint = "/.netlify/functions/start-run";
  const checkRunEndpoint = "/.netlify/functions/check-run";

  // === Recording state ===
  let mediaStream = null;
  let mediaRecorder = null;
  let chunks = [];
  let isRecording = false;
  let hasStopped = false;
  let isTranscribing = false;

  // === Debug overlay ===
  const debugOverlay = document.createElement("div");
  debugOverlay.className = "debug-overlay";
  debugOverlay.innerText = "🔍 Debug ready";
  document.body.appendChild(debugOverlay);

  const updateDebug = (msg) => {
    debugOverlay.innerText = msg;
  };

  // === Safe Base64 Encoder ===
  function arrayBufferToBase64(buffer) {
    let binary = "";
    const bytes = new Uint8Array(buffer);
    const chunkSize = 0x8000; // 32KB chunks
    for (let i = 0; i < bytes.length; i += chunkSize) {
      const chunk = bytes.subarray(i, i + chunkSize);
      binary += String.fromCharCode.apply(null, chunk);
    }
    return btoa(binary);
  }

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
      updateDebug("Autoplay unlocked");
    } catch (e) {
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
      updateDebug("Speech unlocked");
    } catch (e) {
      updateDebug("Speech unlock failed: " + e.message);
    }
  }

  // === Strip HTML for speech ===
  function stripHtmlTags(html) {
    let div = document.createElement("div");
    div.innerHTML = html;
    return div.textContent || div.innerText || "";
  }

  // === Pick the best available natural voice ===
  let preferredVoice = null;
  function pickBestVoice() {
    const voices = window.speechSynthesis.getVoices();
    if (!voices.length) return null;

    // Priorities
    const priorities = ["Siri", "Neural", "Google", "Natural"];

    for (const keyword of priorities) {
      const match = voices.find((v) => v.name.includes(keyword));
      if (match) return match;
    }

    return voices[0]; // fallback
  }

  // ensure voices are loaded
  window.speechSynthesis.onvoiceschanged = () => {
    preferredVoice = pickBestVoice();
    if (preferredVoice) {
      updateDebug(`Using voice: ${preferredVoice.name}`);
    }
  };

  // === Speech methods ===
  const speakBrowser = (text) => {
    const plainText = stripHtmlTags(text);
    if (!plainText.trim()) return;
    enqueueSpeech(
      () =>
        new Promise((resolve) => {
          if (!("speechSynthesis" in window)) return resolve();
          window.speechSynthesis.cancel();
          const utterance = new SpeechSynthesisUtterance(plainText);
          utterance.lang = "en-US";
          if (preferredVoice) utterance.voice = preferredVoice;
          utterance.onend = resolve;
          utterance.onerror = (err) => {
            updateDebug("Speech synthesis error: " + err.message);
            resolve();
          };
          window.speechSynthesis.speak(utterance);
        })
    );
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
      updateDebug("TTS error: " + e.message);
      return null;
    }
  };

  // === Recording ===
  const pickAudioMime = () => {
    if (MediaRecorder.isTypeSupported("audio/webm;codecs=opus"))
      return "audio/webm;codecs=opus";
    if (MediaRecorder.isTypeSupported("audio/webm")) return "audio/webm";
    if (MediaRecorder.isTypeSupported("audio/mp4")) return "audio/mp4";
    return "";
  };

  async function startRecording() {
    try {
      hasStopped = false;
      chunks = [];

      mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = pickAudioMime();
      mediaRecorder = new MediaRecorder(
        mediaStream,
        mimeType ? { mimeType } : undefined
      );

      mediaRecorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunks.push(e.data);
      };

      mediaRecorder.onstop = async () => {
        if (hasStopped) return;
        hasStopped = true;

        if (!chunks.length) return;
        updateDebug("Recording stopped, sending for transcription…");

        const blob = new Blob(chunks, {
          type: mediaRecorder.mimeType || "audio/webm",
        });

        if (!isTranscribing) {
          await sendAudioForTranscription(blob);
        }

        if (mediaStream) {
          mediaStream.getTracks().forEach((t) => t.stop());
          mediaStream = null;
        }
      };

      // 🔊 Silence detection
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
      updateDebug("Mic error: " + err.message);
      createBubble(
        "⚠️ I can't access your microphone. Please allow mic access in your browser and OS settings.",
        "bot"
      );
    }
  }

  function stopRecording() {
    if (!isRecording || !mediaRecorder) return;
    isRecording = false;
    micBtn.textContent = "🎙️";
    updateDebug("Stopping recording...");
    mediaRecorder.stop(); // triggers onstop once
  }

  async function sendAudioForTranscription(blob) {
    if (isTranscribing) return;
    isTranscribing = true;

    try {
      const ab = await blob.arrayBuffer();
      const base64 = arrayBufferToBase64(ab);

      const res = await fetch(transcribeEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          audioBase64: base64,
          mimeType: blob.type || "audio/webm",
          fileName: blob.type.includes("mp4")
            ? "recording.mp4"
            : "recording.webm",
        }),
      });

      if (!res.ok) {
        createBubble("🤖 I couldn't transcribe that audio. Can we try again?", "bot");
        return;
      }
      const { text } = await res.json();
      if (text) {
        input.value = text;
        form.requestSubmit();
      }
    } catch (err) {
      updateDebug("Transcription error: " + err.message);
      createBubble("⚠️ Something went wrong with transcription. Please try again.", "bot");
    } finally {
      isTranscribing = false;
    }
  }

  // === Event handlers ===
  micBtn.addEventListener("click", async () => {
    unlockSpeech();
    await unlockAutoplay();
    if (!isRecording) {
      await startRecording();
    } else {
      stopRecording();
    }
  });

  // ✅ Enter-to-send
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      form.requestSubmit();
    }
  });

  // ✅ Auto-resize textarea
  input.addEventListener("input", () => {
    input.style.height = "auto";
    input.style.height = input.scrollHeight + "px";
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    unlockSpeech();
    await unlockAutoplay();

    const message = input.value.trim();
    if (!message) return;

    createBubble(message, "user");
    input.value = "";
    input.style.height = "auto";
    const thinkingBubble = showSpinner();
    updateDebug("Message sent, waiting for reply…");

    try {
      const startRes = await fetch(startRunEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, thread_id }),
      });
      if (!startRes.ok) throw new Error("start-run failed");
      const { thread_id: newThreadId, run_id } = await startRes.json();

      thread_id = newThreadId;
      let reply = "";
      let completed = false;

      while (!completed) {
        const checkRes = await fetch(checkRunEndpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ thread_id, run_id }),
        });

        if (checkRes.status === 202) {
          updateDebug("Bot thinking…");
          await new Promise((r) => setTimeout(r, 1000));
        } else if (checkRes.ok) {
          const data = await checkRes.json();
          reply = data.reply || "(No response)";
          completed = true;
        } else {
          throw new Error("check-run failed");
        }
      }

      thinkingBubble.remove();
      updateDebug("Reply received");
      createBubble(reply, "bot");
    } catch (err) {
      updateDebug("Chat error: " + err.message);
      thinkingBubble.remove();
      createBubble("🤖 My circuits got tangled. Can we try that again?", "bot");
    }
  });

  // === Chat helpers ===
  const formatMarkdown = (text) => {
    return text
      .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
      .replace(/^(\d+)\.\s+(.*)$/gm, "<p><strong>$1.</strong> $2</p>")
      .replace(/\n{2,}/g, "<br><br>")
      .replace(/\n/g, "<br>");
  };

  const stripCitations = (text) => {
    return text.replace(/【\d+:\d+†[^†【】]+(?:†[^【】]*)?】/g, "");
  };

  const createBubble = (content, sender, narrate = true) => {
    const div = document.createElement("div");
    const cleaned = stripCitations(content);
    const formatted = formatMarkdown(cleaned);

    if (sender === "bot") {
      const wrapper = document.createElement("div");
      wrapper.className = "bot-message";
      const avatar = document.createElement("img");
      avatar.src = "https://resilient-palmier-22bdf1.netlify.app/Toby-Avatar.svg";
      avatar.alt = "Toby";
      avatar.className = "avatar";

      div.className = "bubble bot";
      div.innerHTML = formatted;

      const replayBtn = document.createElement("button");
      replayBtn.textContent = "🔊";
      replayBtn.className = "replay-btn";
      replayBtn.onclick = async () => {
        if (div.dataset.hqAudio) {
          const audio = new Audio(div.dataset.hqAudio);
          audio.play().catch(() => speakBrowser(cleaned));
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
      div.className = "bubble user";
      div.innerHTML = content;
      messages.appendChild(div);
    }

    messages.scrollTop = messages.scrollHeight;
    return div;
  };

  const showSpinner = () => {
    return createBubble('<span class="spinner"></span> Toby is thinking...', "bot", false);
  };

  // Register service worker
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/service-worker.js");
  }
});
