// netlify/functions/transcribe.js

// ✅ No external requires: uses Node 18+ built-in fetch & FormData

const allowedOrigins = [
  "https://masterplumbers.org.nz",
  "https://resilient-palmier-22bdf1.netlify.app",
  "https://caitskinz.github.io/tobytest/", // replace with staging
  "https://your-test-site-2.netlify.app", // replace with staging
  "http://localhost:8888", // Netlify dev
];

exports.handler = async (event) => {
  const origin = event.headers.origin;
  const corsOrigin = allowedOrigins.includes(origin) ? origin : allowedOrigins[0];

  // Handle preflight
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 200,
      headers: {
        "Access-Control-Allow-Origin": corsOrigin,
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
      },
      body: "",
    };
  }

  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: { "Access-Control-Allow-Origin": corsOrigin },
      body: "Method Not Allowed",
    };
  }

  try {
    const { audioBase64, mimeType = "audio/webm", fileName = "recording.webm" } =
      JSON.parse(event.body || "{}");

    if (!audioBase64) {
      return {
        statusCode: 400,
        headers: {
          "Access-Control-Allow-Origin": corsOrigin,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ error: "Missing audioBase64" }),
      };
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return {
        statusCode: 500,
        headers: {
          "Access-Control-Allow-Origin": corsOrigin,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ error: "Missing OPENAI_API_KEY" }),
      };
    }

    // Decode base64 → buffer
    const buffer = Buffer.from(audioBase64, "base64");

    // Create form with Blob
    const form = new FormData();
    const blob = new Blob([buffer], { type: mimeType });
    form.append("file", blob, fileName);
    form.append("model", "whisper-1"); // or gpt-4o-mini-transcribe

    // Call OpenAI
    const resp = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      body: form,
    });

    if (!resp.ok) {
      const errText = await resp.text();
      console.error("OpenAI STT error:", errText);
      return {
        statusCode: 502,
        headers: {
          "Access-Control-Allow-Origin": corsOrigin,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ error: "OpenAI STT failed", detail: errText }),
      };
    }

    const data = await resp.json();
    const text = data.text || "";

    return {
      statusCode: 200,
      headers: {
        "Access-Control-Allow-Origin": corsOrigin,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text }),
    };
  } catch (e) {
    console.error("Transcribe function error:", e);
    return {
      statusCode: 500,
      headers: {
        "Access-Control-Allow-Origin": corsOrigin,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ error: "Internal server error" }),
    };
  }
};
