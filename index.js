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

// ---------- REACT TO A MESSAGE WITH AN EMOJI VIA WHAPI ----------
async function reactToMessage(messageId, emoji) {
  await fetch(`https://gate.whapi.cloud/messages/${messageId}/reaction`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.WHAPI_TOKEN}`,
    },
    body: JSON.stringify({ emoji }),
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
      "This is a Moroccan WhatsApp order, often written as separate lines with no labels. " +
      "A neighborhood, street name, or area name (even if you don't recognize it) almost always belongs in \"address\", not \"city\" — " +
      "prefer extracting an uncertain line as \"address\" rather than leaving it out entirely. " +
      "Here is a reference list of common Moroccan cities: Casablanca, Rabat, Sale, Fes, Marrakech, Tanger, Agadir, Meknes, " +
      "Oujda, Kenitra, Tetouan, Safi, Mohammedia, Khouribga, El Jadida, Beni Mellal, Nador, Taza, Settat, Larache, " +
      "Ksar El Kebir, Khemisset, Guelmim, Berrechid, Wazzan, Taourirt, Berkane, Sidi Slimane, Errachidia, Sidi Kacem, " +
      "Essaouira, Khenifra, Tiznit, Ouarzazate, Ifrane, Al Hoceima, Taroudant, Chefchaouen, Fquih Ben Salah, Youssoufia, Azrou. " +
      "If a line matches (even loosely/misspelled) one of these cities, use it as \"city\". " +
      "If a line does NOT match one of these cities but still looks like a place (neighborhood, street, landmark, \"7da\", \"quartier\", etc.), use it as \"address\" instead of discarding it. " +
      'Return ONLY strict JSON, no explanation, no markdown, with exactly these keys: ' +
      '"name", "number", "address", "city", "products", "quantity", "price". ' +
      '"quantity" is the number of items ordered (a plain number like 1, 2, 3). ' +
      '"price" must be digits ONLY, with no currency text like "dh", "DH", "dhs", or "MAD" and no spaces (e.g. "350", not "350dh"). ' +
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

      // If the message mentions "change", reply with the special notice
      // and don't process it as an order.
      if (text && /change/i.test(text)) {
        console.log('Detected "change" keyword, sending SAISIW CHANGE reply.');
        await replyToMessage(message.chat_id, "SAISIW CHANGE");
        continue;
      }

      if (!looksLikeOrder(text)) {
        console.log("Skipped: doesn't look like an order (too short or no number).");
        continue;
      }

      const order = await extractOrder(text);
      if (!order) {
        await reactToMessage(message.id, "❌");
        continue;
      }
      console.log("Extracted:", JSON.stringify(order));

      // Safety net: strip anything that isn't a digit from the price,
      // in case "dh"/"DH"/spaces etc slipped through.
      if (order.price) {
        order.price = String(order.price).replace(/\D/g, "");
      }

      const { valid, missing } = validate(order);

      await appendToSheet({
        name: order.name || "",
        number: order.number || "",
        address: order.address || "",
        city: order.city || "",
        products: order.products || "",
        quantity: order.quantity || "",
        price: order.price || "",
        status: valid ? "✅" : "❌",
      });

      if (valid) {
        await reactToMessage(message.id, "✅");
      } else {
        await reactToMessage(message.id, "❌");
        console.log(`Missing fields: ${missing.join(", ")}`);
      }
    }
  } catch (err) {
    console.error("Error handling webhook:", err.message);
  }
});

app.get("/", (req, res) => res.send("WhatsApp order agent is running."));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Agent listening on port ${PORT}`));
