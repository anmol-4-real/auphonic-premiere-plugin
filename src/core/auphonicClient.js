/*
 * Auphonic API client. Every shape and quirk here was confirmed live during
 * the spike phase (see HANDOFF.md) -- nothing in this file is a guess:
 *   - Auth header is "Authorization: bearer <key>" (lowercase "bearer").
 *   - FormData + Blob does NOT reliably upload in this UXP host (confirmed:
 *     Auphonic rejected every attempt with "File type is not supported" even
 *     though the file's bytes were independently verified intact). The fix
 *     is to build the multipart/form-data body by hand, byte for byte.
 *   - Downloads must use responseType "arraybuffer" and read xhr.response,
 *     never xhr.responseText, or binary data gets corrupted the same way an
 *     unflagged local file read corrupts binary WAV bytes.
 *   - XHR (not fetch) throughout, so upload progress events are available
 *     (PRD 9.2 -- a long silent upload reads as a frozen panel).
 */
const { CATEGORY, AuphonicPluginError, wrap } = require("./errors.js");

const AUPHONIC = "https://auphonic.com";

function xhrRequest(opts) {
  const { method, url, apiKey, body, contentType, responseType, timeoutMs, onUploadProgress } = opts;
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, url, true);
    if (apiKey) xhr.setRequestHeader("Authorization", "bearer " + apiKey);
    if (contentType) xhr.setRequestHeader("Content-Type", contentType);
    if (responseType) xhr.responseType = responseType;
    if (onUploadProgress && xhr.upload) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onUploadProgress(e.loaded, e.total);
      };
    }
    xhr.onload = () =>
      resolve({ status: xhr.status, body: responseType ? xhr.response : xhr.responseText });
    xhr.onerror = () => reject(new Error("Network/CORS failure -- no HTTP status returned"));
    xhr.ontimeout = () => reject(new Error("Request timed out"));
    xhr.timeout = timeoutMs || 30000;
    if (body) xhr.send(body);
    else xhr.send();
  });
}

function encodeAsciiBytes(str) {
  const bytes = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) bytes[i] = str.charCodeAt(i) & 0xff;
  return bytes;
}

function concatBytes(chunks) {
  const parts = chunks.map((c) => (c instanceof Uint8Array ? c : new Uint8Array(c)));
  let total = 0;
  for (const p of parts) total += p.length;
  const result = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    result.set(p, offset);
    offset += p.length;
  }
  return result;
}

function buildMultipartBody(fieldName, filename, mimeType, fileArrayBuffer) {
  const boundary = "----AuphonicPremiereBoundary" + Math.floor(Math.random() * 1e9);
  const header =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\n` +
    `Content-Type: ${mimeType}\r\n\r\n`;
  const footer = `\r\n--${boundary}--\r\n`;
  const combined = concatBytes([
    encodeAsciiBytes(header),
    new Uint8Array(fileArrayBuffer),
    encodeAsciiBytes(footer),
  ]);
  return { body: combined.buffer, contentType: `multipart/form-data; boundary=${boundary}` };
}

function checkAuthStatus(res) {
  if (res.status === 401 || res.status === 403) {
    throw new AuphonicPluginError(
      CATEGORY.AUTH_FAILED,
      "Auphonic rejected the API key (HTTP " + res.status + ")."
    );
  }
}

async function getUser(apiKey) {
  let res;
  try {
    res = await xhrRequest({ method: "GET", url: AUPHONIC + "/api/user.json", apiKey });
  } catch (err) {
    throw wrap(CATEGORY.AUTH_FAILED, err, "Could not reach Auphonic");
  }
  checkAuthStatus(res);
  if (res.status !== 200) {
    throw new AuphonicPluginError(CATEGORY.AUTH_FAILED, "HTTP " + res.status + " from /api/user.json");
  }
  return JSON.parse(res.body).data;
}

async function getPresets(apiKey) {
  let res;
  try {
    res = await xhrRequest({
      method: "GET",
      url: AUPHONIC + "/api/presets.json?minimal_data=1&preset_type=all_presets",
      apiKey,
    });
  } catch (err) {
    throw wrap(CATEGORY.AUTH_FAILED, err, "Could not reach Auphonic");
  }
  checkAuthStatus(res);
  if (res.status !== 200) {
    throw new AuphonicPluginError(CATEGORY.AUTH_FAILED, "HTTP " + res.status + " from /api/presets.json");
  }
  return JSON.parse(res.body).data || [];
}

/* output_files is passed explicitly -- omitting it silently returns the
 * preset's own default output (an MP3 in testing), not the WAV Phase 1
 * requires (confirmed live, see HANDOFF.md). */
async function createProduction(apiKey, { presetUuid, title, outputBasename }) {
  let res;
  try {
    res = await xhrRequest({
      method: "POST",
      url: AUPHONIC + "/api/productions.json",
      apiKey,
      body: JSON.stringify({
        preset: presetUuid,
        metadata: { title },
        output_basename: outputBasename,
        output_files: [{ format: "wav" }],
      }),
      contentType: "application/json",
    });
  } catch (err) {
    throw wrap(CATEGORY.UPLOAD_FAILED, err, "Could not create Auphonic production");
  }
  checkAuthStatus(res);
  if (res.status !== 200) {
    throw new AuphonicPluginError(
      CATEGORY.UPLOAD_FAILED,
      "Failed to create production (HTTP " + res.status + "): " + String(res.body).slice(0, 300)
    );
  }
  return JSON.parse(res.body).data.uuid;
}

async function uploadInputFile(apiKey, productionUuid, arrayBuffer, filename, onUploadProgress) {
  const { body, contentType } = buildMultipartBody("input_file", filename, "audio/wav", arrayBuffer);
  let res;
  try {
    res = await xhrRequest({
      method: "POST",
      url: AUPHONIC + `/api/production/${productionUuid}/upload.json`,
      apiKey,
      body,
      contentType,
      timeoutMs: 120000,
      onUploadProgress,
    });
  } catch (err) {
    throw wrap(CATEGORY.UPLOAD_FAILED, err, "Upload failed");
  }
  checkAuthStatus(res);
  if (res.status !== 200) {
    throw new AuphonicPluginError(
      CATEGORY.UPLOAD_FAILED,
      "Upload rejected (HTTP " + res.status + "): " + String(res.body).slice(0, 300)
    );
  }
  return JSON.parse(res.body).data;
}

async function startProduction(apiKey, productionUuid) {
  let res;
  try {
    res = await xhrRequest({
      method: "POST",
      url: AUPHONIC + `/api/production/${productionUuid}/start.json`,
      apiKey,
    });
  } catch (err) {
    throw wrap(CATEGORY.PROCESSING_FAILED, err, "Could not start production");
  }
  checkAuthStatus(res);
  if (res.status !== 200) {
    throw new AuphonicPluginError(
      CATEGORY.PROCESSING_FAILED,
      "Failed to start production (HTTP " + res.status + "): " + String(res.body).slice(0, 300)
    );
  }
  return JSON.parse(res.body).data;
}

async function getStatus(apiKey, productionUuid) {
  let res;
  try {
    res = await xhrRequest({
      method: "GET",
      url: AUPHONIC + `/api/production/${productionUuid}/status.json`,
      apiKey,
    });
  } catch (err) {
    throw wrap(CATEGORY.PROCESSING_FAILED, err, "Status check failed");
  }
  checkAuthStatus(res);
  if (res.status !== 200) {
    throw new AuphonicPluginError(
      CATEGORY.PROCESSING_FAILED,
      "Status check failed (HTTP " + res.status + ")"
    );
  }
  return JSON.parse(res.body).data;
}

async function getProductionDetail(apiKey, productionUuid) {
  let res;
  try {
    res = await xhrRequest({
      method: "GET",
      url: AUPHONIC + `/api/production/${productionUuid}.json`,
      apiKey,
    });
  } catch (err) {
    throw wrap(CATEGORY.PROCESSING_FAILED, err, "Could not fetch production detail");
  }
  checkAuthStatus(res);
  if (res.status !== 200) {
    throw new AuphonicPluginError(
      CATEGORY.PROCESSING_FAILED,
      "Could not fetch production detail (HTTP " + res.status + ")"
    );
  }
  return JSON.parse(res.body).data;
}

/*
 * Polls with backoff (PRD 9.4: ~10s initially, then 20-30s). Resolves with
 * the final status payload on success (status 3), throws on Auphonic-side
 * error (status 2) or on giving up after maxAttempts.
 */
async function pollUntilDone(apiKey, productionUuid, { onPoll, maxAttempts = 60 } = {}) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const delayMs = attempt === 0 ? 8000 : attempt < 4 ? 10000 : 25000;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    const statusData = await getStatus(apiKey, productionUuid);
    if (onPoll) onPoll(statusData, attempt);
    if (statusData.status === 3) return statusData;
    if (statusData.status === 2) {
      throw new AuphonicPluginError(
        CATEGORY.PROCESSING_FAILED,
        statusData.error_message || "Auphonic reported a processing error."
      );
    }
  }
  throw new AuphonicPluginError(
    CATEGORY.PROCESSING_FAILED,
    "Gave up waiting for Auphonic to finish processing."
  );
}

async function downloadOutputFile(apiKey, downloadUrl) {
  let res;
  try {
    res = await xhrRequest({
      method: "GET",
      url: downloadUrl + `?bearer_token=${encodeURIComponent(apiKey)}`,
      responseType: "arraybuffer",
      timeoutMs: 120000,
    });
  } catch (err) {
    throw wrap(CATEGORY.DOWNLOAD_FAILED, err, "Download failed");
  }
  if (res.status !== 200) {
    throw new AuphonicPluginError(CATEGORY.DOWNLOAD_FAILED, "Download failed (HTTP " + res.status + ")");
  }
  return res.body;
}

module.exports = {
  getUser,
  getPresets,
  createProduction,
  uploadInputFile,
  startProduction,
  getStatus,
  getProductionDetail,
  pollUntilDone,
  downloadOutputFile,
};
