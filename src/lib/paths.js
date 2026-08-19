/*
 * Cache folder layout (PRD 9.8), built entirely through UXP's storage API --
 * never by concatenating path strings ourselves (PRD 9.2's explicit warning).
 * Every path we hand to Premiere's encoder or read/write ourselves comes from
 * a real Folder/File entry's own .nativePath, obtained by creating or looking
 * up that entry through uxp.storage -- the same pattern Spike E already used
 * successfully for its downloaded output file.
 *
 *   plugin-data:/AuphonicCache/
 *     projects/<project-hash>/<job-id>/
 *       job.json
 *       input.wav
 *       production.json
 *       output.wav
 */
const uxp = require("uxp");

async function getOrCreateFolder(parentFolder, name) {
  try {
    const existing = await parentFolder.getEntry(name);
    if (existing && existing.isFolder) return existing;
  } catch (e) {
    // Not found -- fall through to create it.
  }
  return parentFolder.createFolder(name);
}

async function getCacheRoot() {
  const dataFolder = await uxp.storage.localFileSystem.getDataFolder();
  return getOrCreateFolder(dataFolder, "AuphonicCache");
}

/*
 * Short, stable, non-cryptographic hash (FNV-1a) of the project's own file
 * path. Only needs to be stable and collision-unlikely for folder naming --
 * not secure -- so a well-known simple string hash is the right tool, rather
 * than assuming a crypto module exists in this UXP host.
 */
function shortHash(input) {
  let hash = 0x811c9dc5;
  const str = String(input || "");
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

async function getProjectsFolder() {
  const root = await getCacheRoot();
  return getOrCreateFolder(root, "projects");
}

async function getJobFolder(project, jobId) {
  const projectsFolder = await getProjectsFolder();
  const projectHash = shortHash(project && (project.path || project.name));
  const projectFolder = await getOrCreateFolder(projectsFolder, projectHash);
  return getOrCreateFolder(projectFolder, jobId);
}

/* Returns the File entry, created (and overwritable) up front, so its
 * .nativePath can be handed to code that needs a plain OS path string
 * (e.g. the Premiere encoder) without us ever building that string by hand. */
async function reserveFile(folder, name) {
  return folder.createFile(name, { overwrite: true });
}

async function readJson(folder, name) {
  try {
    const entry = await folder.getEntry(name);
    const text = await entry.read({ format: uxp.storage.formats.utf8 });
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
}

async function writeJson(folder, name, value) {
  const file = await reserveFile(folder, name);
  await file.write(JSON.stringify(value, null, 2), { format: uxp.storage.formats.utf8 });
  return file;
}

async function readBinary(fileEntry) {
  return fileEntry.read({ format: uxp.storage.formats.binary });
}

async function writeBinary(folder, name, arrayBuffer) {
  const file = await reserveFile(folder, name);
  await file.write(arrayBuffer, { format: uxp.storage.formats.binary });
  return file;
}

module.exports = {
  getCacheRoot,
  getProjectsFolder,
  getJobFolder,
  getOrCreateFolder,
  reserveFile,
  readJson,
  writeJson,
  readBinary,
  writeBinary,
  shortHash,
};
