document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('chat-form');
  const input = document.getElementById('user-input');
  const messages = document.getElementById('messages');
  let thread_id = null;

  // Make textarea auto-expand
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = input.scrollHeight + 'px';
  });

  // ✅ NEW: Send message on Enter, newline on Shift+Enter
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      form.requestSubmit(); // triggers the form submit handler below
    }
  });

  const formatMarkdown = (text) => {
    return text
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/^(\d+)\.\s+(.*)$/gm, '<p><strong>$1.</strong> $2</p>')
      .replace(/\n{2,}/g, '<br><br>')
      .replace(/\n/g, '<br>');
  };

  const formatCitations = (text) => {
    let formatted = text.replace(/【\d+:\d+†([^†]+)†?(.*?)?】/g, (_, sourceName) => {
      return `<em>[Source: ${sourceName}]</em>`;
    });

    formatted = formatted.replace(/\[Source:\s*(.*?)\]/g, (_, sourceName) => {
      return `<em>[Source: ${sourceName}]</em>`;
    });

    return formatted;
  };

  const repairInlineCitations = (text) => {
    return text
      .replace(/\[Source:\s*(.*?)】】【(\d+):(\d+)]/g, '【$2:$3†$1†lines】')
      .replace(/\[Source:\s*(.*?)】【(\d+):(\d+)]/g, '【$2:$3†$1†lines】');
  };

  // ✅ NEW: Strip numbered citations like  
  const stripCitations = (text) => {
  return text.replace(/【\d+:\d+†[^†【】]+(?:†[^【】]*)?】/g, '');
};

  const createBubble = (content, sender) => {
    const div = document.createElement('div');

    const cleaned = stripCitations(content);
    const repaired = repairInlineCitations(cleaned);
    const formatted = formatMarkdown(repaired); // No formatCitations anymore

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

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const message = input.value.trim();
    if (!message) return;

    createBubble(message, 'user');
    input.value = '';
    input.style.height = 'auto'; // Reset height after sending
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
  });
});
