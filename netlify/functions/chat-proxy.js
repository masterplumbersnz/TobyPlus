const fetch = require('node-fetch');

const ALLOWED_ORIGIN = 'https://masterplumbers.org.nz';

exports.handler = async (event) => {
  console.log('Incoming Event:', JSON.stringify(event, null, 2));

  // Handle CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      },
      body: '',
    };
  }

  try {
    // Validate and parse incoming JSON
    let message, thread_id;
    try {
      const parsed = JSON.parse(event.body || '{}');
      message = parsed.message;
      thread_id = parsed.thread_id;
    } catch (e) {
      console.error('Invalid JSON in request:', e);
      return {
        statusCode: 400,
        headers: {
          'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ error: 'Invalid JSON in request body.' }),
      };
    }

    if (!message) {
      return {
        statusCode: 400,
        headers: {
          'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ error: 'Missing message in request body.' }),
      };
    }

    // Get env vars
    const assistantId = process.env.OPENAI_ASSISTANT_ID;
    const apiKey = process.env.OPENAI_API_KEY;

    if (!apiKey || !assistantId) {
      console.error('Missing environment variables');
      return {
        statusCode: 500,
        headers: {
          'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          error: 'Server misconfiguration: Missing API key or Assistant ID',
        }),
      };
    }

    // Create thread if needed
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
    console.log('Using thread ID:', threadId);

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
    console.log('Run started:', runId);

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

    console.log('Reply:', reply);

    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ reply, thread_id: threadId }),
    };
  } catch (error) {
    console.error('Unhandled Error in chat-proxy.js:', error);
    return {
      statusCode: 500,
      headers: {
        'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ error: 'Internal server error' }),
    };
  }
};
