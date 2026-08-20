/*
 * Panel entry point -- loaded last (see index.html), after every
 * window.Auphonic.* module has published itself via its own <script> tag.
 * require("premierepro")/require("uxp") are the only require() calls left
 * anywhere in this codebase -- those are host-injected globals, confirmed
 * working directly in any script context by the spike plugin. Local
 * require() between our own files was NOT reliable in this UXP host (it
 * resolves relative paths against the plugin root rather than the requiring
 * file's own folder for a script-tag-loaded entry point) -- see the note at
 * the top of lib/secureStorage.js.
 */
window.Auphonic.panel.init().catch((err) => {
  console.error("Auphonic panel failed to initialize:", err);
});
