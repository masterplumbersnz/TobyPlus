const fetch = require('node-fetch');
const ALLOWED_ORIGIN = 'https://masterplumbers.org.nz';

// 🛠️ Helper: Fix broken citations before sending to frontend
function repairCitations(text) {
  return text
    .replace(/\[Source:\s*(.*?)】】【(\d+):(\d+)]/g, '【$2:$3†$1†lines】')
    .replace(/\[Source:\s*(.*?)】【(\d+):(\d+)]/g, '【$2:$3†$1†lines】')
    .replace(/\[Source:\s*(.*?)】/g, '')
    .replace(/】【(\d+):(\d+)]/g, '');
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
      },
      body: '',
    };
  }

  try {
    const { thread_id, run_id } = JSON.parse(event.body || '{}');
    const apiKey = process.env.OPENAI_API_KEY;

    if (!thread_id || !run_id || !apiKey) {
      return {
        statusCode: 400,
        headers: { 'Access-Control-Allow-Origin': ALLOWED_ORIGIN },
        body: JSON.stringify({ error: 'Missing thread_id, run_id, or API key.' }),
      };
    }

    const runRes = await fetch(`https://api.openai.com/v1/threads/${thread_id}/runs/${run_id}`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'OpenAI-Beta': 'assistants=v2',
      },
    });

    if (!runRes.ok) {
      const text = await runRes.text();
      throw new Error(`Run status fetch failed: ${text}`);
    }

    const runStatus = await runRes.json();

    if (runStatus.status !== 'completed') {
      return {
        statusCode: 202,
        headers: { 'Access-Control-Allow-Origin': ALLOWED_ORIGIN },
        body: JSON.stringify({ status: runStatus.status }),
      };
    }

    const msgRes = await fetch(`https://api.openai.com/v1/threads/${thread_id}/messages`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'OpenAI-Beta': 'assistants=v2',
      },
    });

    if (!msgRes.ok) {
      const text = await msgRes.text();
      throw new Error(`Message fetch failed: ${text}`);
    }

    const messages = await msgRes.json();
    const lastMessage = messages.data
      .filter((m) => m.role === 'assistant')
      .sort((a, b) => (b.created_at || 0) - (a.created_at || 0))[0];

    const rawReply = lastMessage?.content?.[0]?.text?.value || '(No reply)';
    const fixedReply = repairCitations(rawReply); // ✅ Fix citations here

    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        reply: fixedReply,
        thread_id,
      }),
    };
  } catch (error) {
    console.error('check-run error:', error);
    return {
      statusCode: 500,
      headers: { 'Access-Control-Allow-Origin': ALLOWED_ORIGIN },
      body: JSON.stringify({ error: error.message || 'Internal server error' }),
    };
  }
};
