/*
 * Named error categories (PRD 9.10). Every failure surfaced to the user
 * carries one of these so the panel can show something specific instead of
 * a generic "something went wrong" -- and so a failed job's record file
 * (jobModel.js) always has a category to diagnose from later.
 */
const CATEGORY = {
  SELECTION: "Premiere selection error",
  UNSUPPORTED_CLIP: "Unsupported clip type",
  AME_UNAVAILABLE: "AME not installed or not running",
  EXPORT_FAILED: "Export failed",
  AUTH_FAILED: "Auphonic authentication failed",
  UPLOAD_FAILED: "Auphonic upload failed",
  PROCESSING_FAILED: "Auphonic processing failed",
  DOWNLOAD_FAILED: "Download failed",
  IMPORT_FAILED: "Premiere import failed",
  INSERTION_COLLISION: "Timeline insertion collision",
};

class AuphonicPluginError extends Error {
  constructor(category, message, details) {
    super(message || category);
    this.name = "AuphonicPluginError";
    this.category = category;
    this.details = details || null;
  }
}

function wrap(category, err, extraMessage) {
  if (err instanceof AuphonicPluginError) return err;
  const baseMessage = err && err.message ? err.message : String(err);
  return new AuphonicPluginError(
    category,
    extraMessage ? `${extraMessage}: ${baseMessage}` : baseMessage,
    { originalError: baseMessage }
  );
}

module.exports = { CATEGORY, AuphonicPluginError, wrap };
