require("dotenv").config();
const express = require("express");
const Anthropic = require("@anthropic-ai/sdk");

const app = express();
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ---------- WRITE TO GOOGLE SHEET VIA APPS SCRIPT ----------
async function appendToSheet(row) {
  const response = await fetch(process.env.APPS_SCRIPT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(row),
  });
  if (!response.ok) {
    console.error("Failed to write to sheet:", await response.text());
  }
}

// ---------- REPLY IN THE WHATSAPP GROUP VIA WHAPI ----------
async function replyToMessage(chatId, text) {
  await fetch("https://gate.whapi.cloud/messages/text", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.WHAPI_TOKEN}`,
    },
    body: JSON.stringify({ to: chatId, body: text }),
  });
}

// ---------- ORDER EXTRACTION WITH CLAUDE ----------
async function extractOrder(text) {
  const msg = await anthropic.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 300,
    system:
      "You extract order details from a WhatsApp message written by a customer. " +
      "Fields can appear in ANY order in the text, and some may be missing or misspelled. " +
      'Return ONLY strict JSON, no explanation, no markdown, with exactly these keys: ' +
      '"name", "number", "address", "city", "products", "price". ' +
      "If a field is not present in the message, set its value to null. " +
      "Do not invent information that is not in the text.",
    messages: [{ role: "user", content: text }],
  });

  let raw = msg.content[0].text.trim();
  // Sometimes the model wraps its answer in a ```json ... ``` code block
  // even when told not to. Strip that off before parsing.
  raw = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();

  try {
    return JSON.parse(raw);
  } catch (e) {
    console.error("Could not parse Claude's response as JSON:", raw);
    return null;
  }
}

function looksLikeOrder(text) {
  if (!text || text.length < 15) return false;
  return /\d{5,}/.test(text);
}

const REQUIRED_FIELDS = ["name", "number", "address", "city"];

function validate(order) {
  const missing = REQUIRED_FIELDS.filter(
    (field) => !order[field] || String(order[field]).trim() === ""
  );
  return { valid: missing.length === 0, missing };
}

// ---------- WEBHOOK: Whapi sends new messages here ----------
app.post("/webhook", async (req, res) => {
  res.sendStatus(200); // acknowledge immediately, process after

  try {
    const messages = req.body.messages || [];
    console.log(`Webhook hit. ${messages.length} message(s) in payload.`);

    for (const message of messages) {
      console.log(
        `Message from chat_id=${message.chat_id}, from_me=${message.from_me}, text="${message.text && message.text.body}"`
      );

      if (message.from_me) {
        console.log("Skipped: this was sent by our own connected number.");
        continue;
      }
      if (message.chat_id !== process.env.WHATSAPP_GROUP_ID) {
        console.log(`Skipped: wrong chat (expected ${process.env.WHATSAPP_GROUP_ID}).`);
        continue;
      }

      const text = message.text && message.text.body;
      if (!looksLikeOrder(text)) {
        console.log("Skipped: doesn't look like an order (too short or no number).");
        continue;
      }

      const order = await extractOrder(text);
      if (!order) {
        await replyToMessage(message.chat_id, "❌ Could not read this order, please check the format.");
        continue;
      }

      const { valid, missing } = validate(order);

      await appendToSheet({
        name: order.name || "",
        number: order.number || "",
        address: order.address || "",
        city: order.city || "",
        products: order.products || "",
        price: order.price || "",
        status: valid ? "✅" : "❌",
      });

      if (valid) {
        await replyToMessage(message.chat_id, "✅ Order saved.");
      } else {
        await replyToMessage(message.chat_id, `❌ Missing: ${missing.join(", ")}`);
      }
    }
  } catch (err) {
    console.error("Error handling webhook:", err.message);
  }
});

app.get("/", (req, res) => res.send("WhatsApp order agent is running."));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Agent listening on port ${PORT}`));
