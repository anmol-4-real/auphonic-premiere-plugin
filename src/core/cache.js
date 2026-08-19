/*
 * Cache folder housekeeping (PRD 9.8) + tiny settings persistence
 * (plugin-data:/AuphonicCache/settings.json, called out in the PRD's own
 * cache layout). uxp.shell.openPath() for "reveal cache" has not been
 * exercised live in this project -- guarded so a missing/renamed API
 * degrades to showing the path instead of throwing.
 */
const uxp = require("uxp");
const paths = require("./../lib/paths.js");

async function getSettings() {
  const root = await paths.getCacheRoot();
  return (await paths.readJson(root, "settings.json")) || {};
}

async function saveSettings(partial) {
  const root = await paths.getCacheRoot();
  const current = (await paths.readJson(root, "settings.json")) || {};
  const next = Object.assign({}, current, partial);
  await paths.writeJson(root, "settings.json", next);
  return next;
}

async function revealCacheFolder() {
  const root = await paths.getCacheRoot();
  if (uxp.shell && typeof uxp.shell.openPath === "function") {
    try {
      await uxp.shell.openPath(root.nativePath);
      return { opened: true, path: root.nativePath };
    } catch (e) {
      // Fall through to just returning the path.
    }
  }
  return { opened: false, path: root.nativePath };
}

async function listJobRecords(project) {
  const projectsFolder = await paths.getProjectsFolder();
  const projectHash = paths.shortHash(project && (project.path || project.name));
  let projectFolder;
  try {
    projectFolder = await projectsFolder.getEntry(projectHash);
  } catch (e) {
    return [];
  }
  const jobFolders = (await projectFolder.getEntries()) || [];
  const records = [];
  for (const jobFolder of jobFolders) {
    if (!jobFolder.isFolder) continue;
    const job = await paths.readJson(jobFolder, "job.json");
    if (job) records.push({ folder: jobFolder, job });
  }
  return records;
}

async function deleteEntryIfExists(folder, name) {
  try {
    const entry = await folder.getEntry(name);
    await entry.delete();
    return true;
  } catch (e) {
    return false;
  }
}

/* PRD: "Delete input temp files after a successful job." */
async function deleteCompletedInputTemps(project) {
  const records = await listJobRecords(project);
  let deleted = 0;
  for (const { folder, job } of records) {
    if (job.status === "inserted" && (await deleteEntryIfExists(folder, "input.wav"))) {
      deleted += 1;
    }
  }
  return deleted;
}

/* PRD: "clean failed temp exports." */
async function cleanFailedTempExports(project) {
  const records = await listJobRecords(project);
  let deleted = 0;
  for (const { folder, job } of records) {
    if (job.status === "failed") {
      if (await deleteEntryIfExists(folder, "input.wav")) deleted += 1;
      if (await deleteEntryIfExists(folder, "output.wav")) deleted += 1;
    }
  }
  return deleted;
}

module.exports = {
  getSettings,
  saveSettings,
  revealCacheFolder,
  listJobRecords,
  deleteCompletedInputTemps,
  cleanFailedTempExports,
};
