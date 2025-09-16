// netlify/functions/tts.js

// ✅ No external requires: uses Node 18+ built-in fetch

const allowedOrigins = [
  "https://masterplumbers.org.nz",
  "https://resilient-palmier-22bdf1.netlify.app",
  "https://caitskinz.github.io/tobytest/", // replace with staging
  "https://your-test-site-2.netlify.app", // replace with staging
  "http://localhost:8888",
];

exports.handler = async (event) => {
  const origin = event.headers.origin;
  const corsOrigin = allowedOrigins.includes(origin) ? origin : allowedOrigins[0];

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
    const { text, voice = "alloy", format = "mp3" } = JSON.parse(event.body || "{}");
    if (!text) {
      return {
        statusCode: 400,
        headers: { "Access-Control-Allow-Origin": corsOrigin, "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Missing text" }),
      };
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return {
        statusCode: 500,
        headers: { "Access-Control-Allow-Origin": corsOrigin, "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Missing OPENAI_API_KEY" }),
      };
    }

    // Call OpenAI TTS
    const resp = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini-tts",
        voice,
        input: text,
        format, // mp3 or wav
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      console.error("OpenAI TTS error:", errText);
      return {
        statusCode: 502,
        headers: { "Access-Control-Allow-Origin": corsOrigin, "Content-Type": "application/json" },
        body: JSON.stringify({ error: "OpenAI TTS failed", detail: errText }),
      };
    }

    const arrayBuffer = await resp.arrayBuffer();
    const base64Audio = Buffer.from(arrayBuffer).toString("base64");

    return {
      statusCode: 200,
      headers: {
        "Access-Control-Allow-Origin": corsOrigin,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ audioBase64: base64Audio, mimeType: `audio/${format}` }),
    };
  } catch (e) {
    console.error("TTS function error:", e);
    return {
      statusCode: 500,
      headers: { "Access-Control-Allow-Origin": corsOrigin, "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Internal server error" }),
    };
  }
};
