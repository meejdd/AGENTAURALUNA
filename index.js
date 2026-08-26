function inferProductsBeforePrice(text, order) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  let priceLineIndex = -1;

  for (let index = lines.length - 1; index >= 0; index--) {
    if (/^\d+(?:[.,]\d+)?\s*(?:dh|dhs|mad)?$/i.test(lines[index])) {
      priceLineIndex = index;
      break;
    }
  }

  if (priceLineIndex === -1) {
    return "";
  }

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

      if (/\bchange\b/i.test(line)) {
        return false;
      }

      return !knownValues.some(
        (known) => value === known
      );
    });

  return productLines.join(" | ");
}
