/*
 * Panel entry point. require() for local relative files is available in this
 * same top-level script context that require("premierepro")/require("uxp")
 * already use successfully (confirmed by the spike plugin) -- no bundler,
 * no build step.
 */
const panel = require("./ui/panel.js");

panel.init().catch((err) => {
  console.error("Auphonic panel failed to initialize:", err);
});
