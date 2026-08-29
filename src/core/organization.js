/*
 * Bin and label-color organization (PRD 9.5 step 3, Phase 3's "Auphonic
 * Processed Audio" bin). None of createBinAction/createMoveItemAction/
 * createSetColorLabelAction has ever been touched in this project before --
 * all three are ported from Adobe's own reference sample
 * (sample-panels/premiere-api/src/projectPanel.ts), not derived from
 * anything confirmed live on this build yet. Every call here is wrapped so a
 * failure is non-fatal to the caller -- organization is a bonus on top of
 * the working export/upload/place pipeline, never a blocker for it.
 *
 * Loaded as a plain <script> tag -- see the note at the top of
 * lib/secureStorage.js for why. Depends on window.Auphonic.errors, which
 * must be loaded first. Published on window.Auphonic.organization.
 */
(function () {
  const ppro = require("premierepro");

  const DEFAULT_BIN_NAME = "Auphonic Processed Audio";

  /* Read live instead of hardcoding the reference sample's 15 names
   * (VIOLET, BLUE, GREEN, ...) -- that list was observed on the sample's
   * build, not confirmed on this one. This way the dropdown is always
   * correct for whatever this exact build exposes. */
  function listColorLabelNames() {
    try {
      return Object.keys(ppro.Constants.ProjectItemColorLabel || {});
    } catch (e) {
      return [];
    }
  }

  async function findBinByName(rootItem, binName) {
    const items = (await rootItem.getItems()) || [];
    return items.find((item) => item.name === binName && item.type === ppro.ProjectItem.TYPE_BIN) || null;
  }

  async function getOrCreateBin(project, binName) {
    try {
      const rootItem = await project.getRootItem();
      const existing = await findBinByName(rootItem, binName);
      if (existing) return existing;

      let created = false;
      project.lockedAccess(() => {
        created = project.executeTransaction((compoundAction) => {
          compoundAction.addAction(rootItem.createBinAction(binName, true));
        }, "Create Auphonic bin");
      });
      if (!created) return null;

      return await findBinByName(rootItem, binName);
    } catch (e) {
      console.log("Auphonic: getOrCreateBin failed -- " + (e.message || e));
      return null;
    }
  }

  async function moveItemToBin(project, item, bin) {
    if (!item || !bin) return false;
    try {
      const rootItem = await project.getRootItem();
      let moved = false;
      project.lockedAccess(() => {
        moved = project.executeTransaction((compoundAction) => {
          compoundAction.addAction(rootItem.createMoveItemAction(item, ppro.FolderItem.cast(bin)));
        }, "Move Auphonic result into bin");
      });
      return Boolean(moved);
    } catch (e) {
      console.log("Auphonic: moveItemToBin failed -- " + (e.message || e));
      return false;
    }
  }

  async function applyLabelColor(project, item, colorLabelName) {
    if (!item || !colorLabelName || colorLabelName === "none") return false;
    const colorEnum = (ppro.Constants.ProjectItemColorLabel || {})[colorLabelName];
    if (colorEnum === undefined) return false;
    try {
      let applied = false;
      project.lockedAccess(() => {
        applied = project.executeTransaction((compoundAction) => {
          compoundAction.addAction(item.createSetColorLabelAction(colorEnum));
        }, "Apply Auphonic label color");
      });
      return Boolean(applied);
    } catch (e) {
      console.log("Auphonic: applyLabelColor failed -- " + (e.message || e));
      return false;
    }
  }

  window.Auphonic = window.Auphonic || {};
  window.Auphonic.organization = {
    DEFAULT_BIN_NAME,
    listColorLabelNames,
    getOrCreateBin,
    moveItemToBin,
    applyLabelColor,
  };
})();
