require("dotenv").config();

const express = require("express");
const Anthropic = require("@anthropic-ai/sdk");

const app = express();

app.use(express.json());

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// ============================================================
// GOOGLE SHEETS
// ============================================================

async function sheetRequest(payload) {
  const response = await fetch(process.env.APPS_SCRIPT_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const responseText = await response.text();

  if (!response.ok) {
    throw new Error(
      `Apps Script error ${response.status}: ${responseText}`
    );
  }

  try {
    return JSON.parse(responseText);
  } catch (error) {
    throw new Error(
      `Apps Script did not return JSON: ${responseText.slice(0, 300)}`
    );
  }
}

async function appendToSheet(row) {
  const result = await sheetRequest({
    action: "append",
    sheet: "WTSP ORDERS",
    row,
  });

  if (!result.success) {
    throw new Error(
      result.error || "Could not write order to WTSP ORDERS"
    );
  }
}

async function findLastOrderByNumber(number) {
  return sheetRequest({
    action: "findLastOrder",
    sheet: "FINAL ORDERS",
    number,
  });
}

// ============================================================
// WHAPI REACTION
// ============================================================

async function reactToMessage(messageId, emoji) {
  const response = await fetch(
    `https://gate.whapi.cloud/messages/${messageId}/reaction`,
    {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.WHAPI_TOKEN}`,
      },
      body: JSON.stringify({ emoji }),
    }
  );

  if (!response.ok) {
    console.error(
      "Failed to react:",
      response.status,
      await response.text()
    );
  }
}

// ============================================================
// PHONE
// ============================================================

function normalizePhone(value) {
  let number = String(value || "").replace(/\D/g, "");

  if (number.startsWith("00")) {
    number = number.slice(2);
  }

  if (number.startsWith("212")) {
    number = `0${number.slice(3)}`;
  }

  if (/^[567]\d{8}$/.test(number)) {
    number = `0${number}`;
  }

  return /^0[567]\d{8}$/.test(number)
    ? number
    : "";
}

function extractPhoneFromText(text) {
  const value = String(text || "");

  const international = value.match(
    /(?:\+212|212)\s*([567][\d\s-]{8,})/i
  );

  if (international) {
    return normalizePhone(`0${international[1]}`);
  }

  const local = value.match(/0[567][\d\s-]{8,}/i);

  if (local) {
    return normalizePhone(local[0]);
  }

  return "";
}

// ============================================================
// HELPERS
// ============================================================

function cleanText(value) {
  if (value === null || value === undefined) {
    return "";
  }

  return String(value).trim();
}

function looksLikeOrder(text) {
  if (!text || text.length < 10) {
    return false;
  }

  return /\d{5,}/.test(
    String(text).replace(/[\s-]/g, "")
  );
}

// ============================================================
// ORDER EXTRACTION WITH CLAUDE
// ============================================================

async function extractOrder(text) {
  const msg = await anthropic.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 300,

    system:
      "You extract order details from a Moroccan WhatsApp message. " +

      "Fields can appear in ANY order. They can be on separate lines, in one sentence, missing, or misspelled. " +

      "Return ONLY strict JSON with exactly these keys: " +
      '"name", "number", "address", "city", "products", "quantity", "price". ' +

      "Do not decide what a field means from its position in the message. Use the meaning of the words. " +

      "A neighborhood, street, area, quartier, residence, or landmark belongs in address, not city. " +

      "Common Moroccan cities include Casablanca, Rabat, Sale, Fes, Marrakech, Tanger, Agadir, Meknes, " +
      "Oujda, Kenitra, Tetouan, Safi, Mohammedia, Khouribga, El Jadida, Beni Mellal, Nador, Taza, Settat, " +
      "Larache, Ksar El Kebir, Khemisset, Guelmim, Berrechid, Wazzan, Taourirt, Berkane, Sidi Slimane, " +
      "Errachidia, Sidi Kacem, Essaouira, Khenifra, Tiznit, Ouarzazate, Ifrane, Al Hoceima, Taroudant, " +
      "Chefchaouen, Fquih Ben Salah, Youssoufia, Azrou. " +

      "If a place is one of these cities, even if misspelled, use it as city. " +

      "CRITICAL RULE: any text containing the word ENZO is ALWAYS a product. " +
      "Put ENZO or ENZO MACADAMIA in products, never in name, regardless of where it appears in the message. " +

      "If products are present but quantity is not written, set quantity to 1. " +

      "quantity must be a plain number like 1, 2, or 3. " +

      "price must contain digits only, without dh, DH, DHS, MAD, or spaces. " +

      "number must contain digits only, without +212, spaces, or dashes. " +
      "If number starts with +212, replace +212 with a leading 0. " +

      "If a field is not present, set it to null. " +
      "Do not invent information.",

    messages: [
      {
        role: "user",
        content: text,
      },
    ],
  });

  let raw = msg.content[0].text.trim();

  raw = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();

  try {
    const order = JSON.parse(raw);

    if (order.number) {
      order.number = normalizePhone(order.number);
    }

    if (order.price) {
      order.price = String(order.price).replace(/\D/g, "");
    }

    if (order.products && !order.quantity) {
      order.quantity = "1";
    }

    return order;
  } catch (error) {
    console.error("Could not parse Claude response:", raw);
    return null;
  }
}

// ============================================================
// NORMAL ORDER VALIDATION
// ============================================================

function validateNormalOrder(order) {
  if (!order) {
    return false;
  }

  const requiredFields = [
    "name",
    "number",
    "address",
    "city",
    "products",
    "quantity",
    "price",
  ];

  for (const field of requiredFields) {
    if (!cleanText(order[field])) {
      return false;
    }
  }

  if (!normalizePhone(order.number)) {
    return false;
  }

  if (
    !/^\d+$/.test(String(order.quantity)) ||
    Number(order.quantity) <= 0
  ) {
    return false;
  }

  if (
    !/^\d+$/.test(String(order.price)) ||
    Number(order.price) <= 0
  ) {
    return false;
  }

  return true;
}

// ============================================================
// CHANGE ORDER
// ============================================================

async function processChange(message) {
  const text = message.text?.body || "";

  const newOrder = await extractOrder(text);

  if (!newOrder) {
    await reactToMessage(message.id, "❌");
    return;
  }

  const number =
    extractPhoneFromText(text) ||
    normalizePhone(newOrder.number) ||
    normalizePhone(message.from);

  if (!number) {
    await reactToMessage(message.id, "❌");
    return;
  }

  const result = await findLastOrderByNumber(number);

  if (!result || !result.found || !result.order) {
    await reactToMessage(message.id, "❌");
    return;
  }

  const oldOrder = result.order;

  if (
    !oldOrder.ma ||
    !oldOrder.address ||
    !oldOrder.city ||
    !newOrder.products ||
    !newOrder.quantity ||
    !newOrder.price
  ) {
    await reactToMessage(message.id, "❌");
    return;
  }

  await appendToSheet({
    name: `CHANGE (${oldOrder.ma})`,
    number,
    address: oldOrder.address,
    city: oldOrder.city,
    products: newOrder.products,
    quantity: newOrder.quantity,
    price: newOrder.price,
  });

  await reactToMessage(message.id, "✅");
}

// ============================================================
// WEBHOOK
// ============================================================

app.post("/webhook", (req, res) => {
  res.sendStatus(200);

  void (async () => {
    const messages = req.body.messages || [];

    console.log(
      `Webhook hit. ${messages.length} message(s) in payload.`
    );

    for (const message of messages) {
      const text = message.text?.body || "";

      if (message.from_me) {
        continue;
      }

      if (
        message.chat_id !== process.env.WHATSAPP_GROUP_ID
      ) {
        continue;
      }

      try {
        if (/\bchange\b/i.test(text)) {
          await processChange(message);
          continue;
        }

        if (!looksLikeOrder(text)) {
          continue;
        }

        const order = await extractOrder(text);

        console.log(
          "Extracted order:",
          JSON.stringify(order)
        );

        if (!validateNormalOrder(order)) {
          console.log("Invalid order:", order);

          await reactToMessage(message.id, "❌");
          continue;
        }

        await appendToSheet({
          name: order.name,
          number: order.number,
          address: order.address,
          city: order.city,
          products: order.products,
          quantity: order.quantity,
          price: order.price,
        });

        await reactToMessage(message.id, "✅");
      } catch (error) {
        console.error("Order processing failed:", error);

        await reactToMessage(message.id, "❌");
      }
    }
  })();
});

// ============================================================
// HEALTH CHECK
// ============================================================

app.get("/", (_req, res) => {
  res.send("WhatsApp order agent is running.");
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Agent listening on port ${PORT}`);
});
