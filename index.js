
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

  return JSON.parse(responseText);
}

async function appendToSheet(row) {
  const result = await sheetRequest({
    action: "append",
    sheet: "WTSP ORDERS",
    row,
  });

  if (!result.success) {
    throw new Error(
      result.error || "Could not write to WTSP ORDERS"
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
// WHAPI
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
// HELPERS
// ============================================================

function cleanText(value) {
  if (value === null || value === undefined) {
    return "";
  }

  return String(value).trim();
}

function applyRepeatedCityFallback(order, text) {   if (!order || cleanText(order.address) || !cleanText(order.city)) {     return order;   }    const city = cleanText(order.city);   const cityKey = city.toLowerCase();   const matchingLines = String(text || "")     .split(String.fromCharCode(10))     .map(cleanText)     .filter((line) => line.toLowerCase() === cityKey);    if (matchingLines.length >= 2) {     order.address = city;   }    return order; }  function normalizePhone(value) {
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

function looksLikeOrder(text) {
  if (!text || text.length < 10) {
    return false;
  }

  return /\d{5,}/.test(
    String(text).replace(/[\s-]/g, "")
  );
}

// ============================================================
// PRODUCTS AND QUANTITY
// ============================================================

function normalizeProductsAndQuantity(order) {
  let productList = [];

  if (Array.isArray(order.products)) {
    productList = order.products
      .map(cleanText)
      .filter(Boolean);
  } else if (cleanText(order.products)) {
    productList = [cleanText(order.products)];
  }

  if (productList.length > 0) {
    order.products = productList.join(" | ");
  }

  let quantityTotal = 0;

  if (Array.isArray(order.quantity)) {
    for (const quantity of order.quantity) {
      const number = Number(quantity);

      if (Number.isFinite(number) && number > 0) {
        quantityTotal += number;
      }
    }
  } else if (cleanText(order.quantity)) {
    const number = Number(order.quantity);

    if (Number.isFinite(number) && number > 0) {
      quantityTotal = number;
    }
  }

  if (quantityTotal === 0 && productList.length > 0) {
    quantityTotal = productList.length;
  }

  order.quantity = quantityTotal
    ? String(quantityTotal)
    : "";

  return order;
}

// ============================================================
// CLAUDE EXTRACTION
// ============================================================

async function extractOrder(text) {
  const msg = await anthropic.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 300,

    system:
      "You extract order details from a Moroccan WhatsApp message. " +
      "Fields can appear in ANY order. " +

      "Return ONLY strict JSON with exactly these keys: " +
      '"name", "number", "address", "city", "products", "quantity", "price". ' +

      "A neighborhood, street, area, quartier, residence, or landmark belongs in address, not city. " +       "If the same city name is written twice, use one occurrence as address and the other as city; do not reject the order for that. " +

      "Common Moroccan cities include Casablanca, Rabat, Sale, Fes, Marrakech, Tanger, Agadir, Meknes, " +
      "Oujda, Kenitra, Tetouan, Safi, Mohammedia, Khouribga, El Jadida, Beni Mellal, Nador, Taza, Settat, " +
      "Larache, Ksar El Kebir, Khemisset, Guelmim, Berrechid, Wazzan, Taourirt, Berkane, Sidi Slimane, " +
      "Errachidia, Sidi Kacem, Essaouira, Khenifra, Tiznit, Ouarzazate, Ifrane, Al Hoceima, Taroudant, " +
      "Chefchaouen, Fquih Ben Salah, Youssoufia, Azrou. " +

      "CRITICAL PRODUCT RULE: the final number is usually the total price. " +
      "Any text before that final price which is not the customer name, phone, address, or city is product information, even if you do not recognize the product name. " +

      "Any text containing ENZO is always a product, never a customer name. " +

      "If there are multiple products, return products as an array. " +
      "If there are multiple quantities, return quantity as an array in the same order. " +
      "If a product has no written quantity, use quantity 1 for that product. " +

      "price must contain digits only, without dh, DH, DHS, MAD, or spaces. " +
      "number must contain digits only; convert +212 to a leading 0. " +
      "If a field is missing, set it to null. Do not invent information.",

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

    if (!cleanText(order.products)) {
      const lines = String(text)
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);

      let priceLineIndex = -1;

      for (let index = lines.length - 1; index >= 0; index--) {
        if (
          /^\d+(?:[.,]\d+)?\s*(?:dh|dhs|mad)?$/i.test(
            lines[index]
          )
        ) {
          priceLineIndex = index;
          break;
        }
      }

      if (priceLineIndex !== -1) {
        const knownValues = [
          order.name,
          order.number,
          order.address,
          order.city,
        ]
          .map((value) => cleanText(value).toLowerCase())
          .filter(Boolean);

        const productLines = lines
          .slice(0, priceLineIndex)
          .filter((line) => {
            const value = line.toLowerCase();

            if (normalizePhone(line)) {
              return false;
            }

            if (/^\d+$/.test(line)) {
              return false;
            }

            return !knownValues.some(
              (known) => value === known
            );
          });

        order.products = productLines.join(" | ");
      }
    }

    return normalizeProductsAndQuantity(       applyRepeatedCityFallback(order, text)     );
  } catch (error) {
    console.error("Could not parse Claude response:", raw);
    return null;
  }
}

// ============================================================
// VALIDATION
// ============================================================

function validateNormalOrder(order) {
  if (!order) {
    return { valid: false, reason: "the order could not be extracted" };
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

  const missingFields = requiredFields.filter(
    (field) => !cleanText(order[field])
  );

  if (missingFields.length > 0) {
    return {
      valid: false,
      reason: `missing ${missingFields.join(", ")}`,
    };
  }

  if (!normalizePhone(order.number)) {
    return { valid: false, reason: "invalid phone number" };
  }

  if (!/^\d+$/.test(String(order.quantity)) || Number(order.quantity) <= 0) {
    return { valid: false, reason: "invalid quantity" };
  }

  if (!/^\d+$/.test(String(order.price)) || Number(order.price) < 0) {
    return { valid: false, reason: "invalid price" };
  }

  return { valid: true, reason: "" };
}

// ============================================================
// CHANGE ORDER
// ============================================================

async function processChange(message) {
  const text = message.text?.body || "";
  const newOrder = await extractOrder(text);

  if (!newOrder) {
    console.log("Change refused: new order details could not be extracted.");
    return;
  }

  const number =
    extractPhoneFromText(text) ||
    normalizePhone(newOrder.number) ||
    normalizePhone(message.from);

  if (!number) {
    console.log("Change refused: no valid phone number was found.");
    return;
  }

  const result = await findLastOrderByNumber(number);

  if (!result || !result.found || !result.order) {
    console.log("Change refused: no previous order was found for this number.");
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
    console.log("Change refused: required old or new order details are missing.");
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
    senderName: message.from_name || "",
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

        const validation = validateNormalOrder(order);

        if (!validation.valid) {
          console.log(
            `Order refused: ${validation.reason}`,
            order
          );
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
          senderName: message.from_name || "",
        });

        await reactToMessage(message.id, "✅");
      } catch (error) {
        console.error(
          "Order refused because processing failed:",
          error
        );
      }
    }
  })();
});

app.get("/", (_req, res) => {
  res.send("WhatsApp order agent is running.");
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Agent listening on port ${PORT}`);
});
