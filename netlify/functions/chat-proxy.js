const fetch = require('node-fetch');

// ✅ List all domains that should be allowed to call this function
// Replace the placeholders below with your actual Netlify staging domains
const allowedOrigins = [
  'https://masterplumbers.org.nz',              // Production
  'https://resilient-palmier-22bdf1.netlify.app', // Staging 1
  'https://caitskinz.github.io/tobytest/'                         // Local dev with Netlify CLI
];

exports.handler = async (event) => {
  const origin = event.headers.origin;
  const corsOrigin = allowedOrigins.includes(origin) ? origin : allowedOrigins[0];

  // Handle CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': corsOrigin,
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      },
      body: '',
    };
  }

  try {
    // Parse request
    let message, thread_id;
    try {
      const parsed = JSON.parse(event.body || '{}');
      message = parsed.message;
      thread_id = parsed.thread_id;
    } catch (e) {
      return {
        statusCode: 400,
        headers: {
          'Access-Control-Allow-Origin': corsOrigin,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ error: 'Invalid JSON in request body.' }),
      };
    }

    if (!message) {
      return {
        statusCode: 400,
        headers: {
          'Access-Control-Allow-Origin': corsOrigin,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ error: 'Missing message in request body.' }),
      };
    }

    // Env vars
    const assistantId = process.env.OPENAI_ASSISTANT_ID;
    const apiKey = process.env.OPENAI_API_KEY;

    if (!apiKey || !assistantId) {
      return {
        statusCode: 500,
        headers: {
          'Access-Control-Allow-Origin': corsOrigin,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          error: 'Server misconfiguration: Missing API key or Assistant ID',
        }),
      };
    }

    // Create or reuse thread
    const threadRes = thread_id
      ? { id: thread_id }
      : await fetch('https://api.openai.com/v1/threads', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'OpenAI-Beta': 'assistants=v2',
            'Content-Type': 'application/json',
          },
        }).then((res) => res.json());

    const threadId = threadRes.id;

    // Post user message
    await fetch(`https://api.openai.com/v1/threads/${threadId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'OpenAI-Beta': 'assistants=v2',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ role: 'user', content: message }),
    });

    // Run the assistant
    const runRes = await fetch(`https://api.openai.com/v1/threads/${threadId}/runs`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'OpenAI-Beta': 'assistants=v2',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ assistant_id: assistantId }),
    }).then((res) => res.json());

    const runId = runRes.id;

    // Poll until complete
    let runStatus = 'in_progress';
    while (runStatus === 'in_progress' || runStatus === 'queued') {
      await new Promise((r) => setTimeout(r, 1500));
      const statusRes = await fetch(
        `https://api.openai.com/v1/threads/${threadId}/runs/${runId}`,
        {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'OpenAI-Beta': 'assistants=v2',
          },
        }
      ).then((res) => res.json());

      runStatus = statusRes.status;
    }

    // Get messages
    const messagesRes = await fetch(
      `https://api.openai.com/v1/threads/${threadId}/messages`,
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'OpenAI-Beta': 'assistants=v2',
        },
      }
    ).then((res) => res.json());

    const lastMessage = messagesRes.data
      .filter((msg) => msg.role === 'assistant')
      .sort((a, b) => b.created_at - a.created_at)[0];

    const reply = lastMessage?.content?.[0]?.text?.value || '(No reply)';

    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': corsOrigin,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ reply, thread_id: threadId }),
    };
  } catch (error) {
    return {
      statusCode: 500,
      headers: {
        'Access-Control-Allow-Origin': corsOrigin,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ error: 'Internal server error' }),
    };
  }
};
