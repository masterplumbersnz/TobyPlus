document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('chat-form');
  const input = document.getElementById('user-input');
  const messages = document.getElementById('messages');
  const micBtn = document.getElementById('mic-btn');
  let thread_id = null;

  // --- 🎤 Speech Recognition Setup ---
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  let recognition;
  let listening = false;

  if (SpeechRecognition) {
    recognition = new SpeechRecognition();
    recognition.lang = "en-US";
    recognition.continuous = false;
    recognition.interimResults = false;

    recognition.onstart = () => {
      console.log("🎤 Mic started, listening...");
    };

    recognition.onresult = (event) => {
      const transcript = event.results[0][0].transcript;
      console.log("🗣️ Heard:", transcript);
      input.value = transcript;
      form.requestSubmit(); // auto-submit
    };

    recognition.onerror = (event) => {
      console.error("❌ Speech recognition error:", event.error);
    };

    recognition.onend = () => {
      listening = false;
      micBtn.textContent = "🎤";
      console.log("🎤 Mic stopped.");
    };
  } else {
    console.error("🚫 SpeechRecognition not supported in this browser.");
    micBtn.disabled = true;
  }

  // Toggle mic on button click
  micBtn.addEventListener('click', () => {
    if (!recognition) return;
    if (!listening) {
      recognition.start();
      listening = true;
      micBtn.textContent = "🛑";
    } else {
      recognition.stop();
      listening = false;
      micBtn.textContent = "🎤";
    }
  });

  // --- 🔊 Speech Synthesis ---
  const speak = (text) => {
    if (!("speechSynthesis" in window)) return;
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "en-US";
    window.speechSynthesis.speak(utterance);
  };

  // Auto-expand textarea
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = input.scrollHeight + 'px';
  });

  // Send on Enter (Shift+Enter = newline)
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      form.requestSubmit();
    }
  });

  const formatMarkdown = (text) => {
    return text
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/^(\d+)\.\s+(.*)$/gm, '<p><strong>$1.</strong> $2</p>')
      .replace(/\n{2,}/g, '<br><br>')
      .replace(/\n/g, '<br>');
  };

  const repairInlineCitations = (text) => {
    return text
      .replace(/\[Source:\s*(.*?)】】【(\d+):(\d+)]/g, '【$2:$3†$1†lines】')
      .replace(/\[Source:\s*(.*?)】【(\d+):(\d+)]/g, '【$2:$3†$1†lines】');
  };

  const stripCitations = (text) => {
    return text.replace(/【\d+:\d+†[^†【】]+(?:†[^【】]*)?】/g, '');
  };

  const createBubble = (content, sender) => {
    const div = document.createElement('div');

    const cleaned = stripCitations(content);
    const repaired = repairInlineCitations(cleaned);
    const formatted = formatMarkdown(repaired);

    if (sender === 'bot') {
      const wrapper = document.createElement('div');
      wrapper.className = 'bot-message';

      const avatar = document.createElement('img');
      avatar.src = 'https://capable-brioche-99db20.netlify.app/Toby-Avatar.svg';
      avatar.alt = 'Toby';
      avatar.className = 'avatar';

      div.className = 'bubble bot';
      div.innerHTML = formatted;

      wrapper.appendChild(avatar);
      wrapper.appendChild(div);
      messages.appendChild(wrapper);

      // 🔊 Speak Toby's reply
      speak(cleaned);
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

  // --- Chat Submit Handler ---
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const message = input.value.trim();
    if (!message) return;

    createBubble(message, 'user');
    input.value = '';
    input.style.height = 'auto';
    const thinkingBubble = showSpinner();

    try {
      const startRes = await fetch('https://capable-brioche-99db20.netlify.app/.netlify/functions/start-run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, thread_id }),
      });

      const { thread_id: newThreadId, run_id } = await startRes.json();
      thread_id = newThreadId;

      let reply = '';
      let completed = false;

      while (!completed) {
        const checkRes = await fetch('https://capable-brioche-99db20.netlify.app/.netlify/functions/check-run', {
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
    recognition.onerror = (event) => {
  console.error("❌ Speech recognition error:", event.error);
  alert("Speech recognition error: " + event.error + 
        "\n\nTip: Check microphone permissions in your browser settings.");
};

  });
});
