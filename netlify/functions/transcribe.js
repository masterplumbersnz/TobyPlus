// netlify/functions/transcribe.js
const fetch = require("node-fetch");
const FormData = require("form-data");

// ✅ List all allowed origins (add your own test domains)
const allowedOrigins = [
  "https://masterplumbers.org.nz",
  "https://resilient-palmier-22bdf1.netlify.app",
  "https://caitskinz.github.io/tobytest/",
];

exports.handler = async (event) => {
  const origin = event.headers.origin;
  const corsOrigin = allowedOrigins.includes(origin) ? origin : allowedOrigins[0];

  // Preflight
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
        body: JSON.stringify({ error: "Server missing OPENAI_API_KEY" }),
      };
    }

    // Decode base64 -> Buffer
    const buffer = Buffer.from(audioBase64, "base64");

    // Build multipart form for OpenAI Audio Transcriptions
    // Models: "whisper-1" works widely; newer snapshots like "gpt-4o-mini-transcribe" are also available.
    const form = new FormData();
    form.append("file", buffer, { filename: fileName, contentType: mimeType });
    form.append("model", "whisper-1"); // or "gpt-4o-mini-transcribe"

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
