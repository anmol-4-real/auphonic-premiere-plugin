/*
 * Wraps uxp.storage.secureStorage for the one value Phase 1 needs: the
 * Auphonic API key. TextDecoder does not exist in this UXP host (confirmed
 * live during the spike phase) -- decodeUtf8 below is the manual fallback,
 * carried over unchanged from the spike since it was already proven correct.
 */
const uxp = require("uxp");

const API_KEY_STORAGE_KEY = "auphonic_api_key";

function decodeUtf8(bytes) {
  if (typeof TextDecoder !== "undefined") {
    return new TextDecoder().decode(bytes);
  }
  let result = "";
  let i = 0;
  while (i < bytes.length) {
    const b1 = bytes[i];
    if (b1 < 0x80) {
      result += String.fromCharCode(b1);
      i += 1;
    } else if ((b1 & 0xe0) === 0xc0) {
      result += String.fromCharCode(((b1 & 0x1f) << 6) | (bytes[i + 1] & 0x3f));
      i += 2;
    } else if ((b1 & 0xf0) === 0xe0) {
      result += String.fromCharCode(
        ((b1 & 0x0f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f)
      );
      i += 3;
    } else if ((b1 & 0xf8) === 0xf0) {
      const codepoint =
        ((b1 & 0x07) << 18) |
        ((bytes[i + 1] & 0x3f) << 12) |
        ((bytes[i + 2] & 0x3f) << 6) |
        (bytes[i + 3] & 0x3f);
      result += String.fromCodePoint(codepoint);
      i += 4;
    } else {
      result += String.fromCharCode(b1);
      i += 1;
    }
  }
  return result;
}

async function saveApiKey(apiKey) {
  await uxp.storage.secureStorage.setItem(API_KEY_STORAGE_KEY, apiKey);
}

async function loadApiKey() {
  const raw = await uxp.storage.secureStorage.getItem(API_KEY_STORAGE_KEY);
  if (!raw) return null;
  return raw instanceof Uint8Array ? decodeUtf8(raw) : String(raw);
}

async function clearApiKey() {
  await uxp.storage.secureStorage.removeItem(API_KEY_STORAGE_KEY);
}

module.exports = { saveApiKey, loadApiKey, clearApiKey, decodeUtf8 };
