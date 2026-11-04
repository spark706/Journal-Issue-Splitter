/* Journal Issue Splitter: bootstrap for Zotero 7 through 10. */
var rootURI;
var menuID = null;
var PLUGIN_ID = "journal-issue-splitter@nshepard";
var DOM_MENU_ID = "journal-issue-splitter-menuitem";

function install() {}
function uninstall() {}

async function startup({ id, version, rootURI: uri }) {
  rootURI = uri;
  // Zotero 8 and later: register the item context menu through MenuManager.
  // Zotero 10 also removes these menu elements itself when the plugin shuts down.
  if (Zotero.MenuManager?.registerMenu) {
    menuID = Zotero.MenuManager.registerMenu({
      menuID: "journal-issue-splitter",
      pluginID: PLUGIN_ID,
      target: "main/library/item",
      menus: [
        {
          menuType: "menuitem",
          l10nID: "issue-splitter-menu",
          onShowing: (event, context) => {
            const items = context.items || [];
            context.setVisible(items.length === 1 && isCandidate(items[0]));
          },
          onCommand: (event, context) => {
            // Use the window the menu was opened in, not just the first main window.
            const win = event?.target?.ownerGlobal || Zotero.getMainWindow();
            win.ZoteroIssueSplitter?.splitIssue(win, context.items[0]);
          },
        },
      ],
    });
  }
  for (const win of Zotero.getMainWindows()) {
    if (win.ZoteroPane) onMainWindowLoad({ window: win });
  }
}

function isCandidate(item) {
  if (item.isAttachment()) return !!item.isPDFAttachment?.();
  return item.isRegularItem() && item.getAttachments().some((id) => Zotero.Items.get(id)?.isPDFAttachment?.());
}

function onMainWindowLoad({ window }) {
  window.MozXULElement?.insertFTLIfNeeded("issue-splitter.ftl");
  Services.scriptloader.loadSubScript(rootURI + "content/issue-splitter.js", window);

  // Zotero 7: no MenuManager, so add the menu item to the DOM directly.
  if (!menuID) {
    const doc = window.document;
    const popup = doc.getElementById("zotero-itemmenu");
    if (!popup || doc.getElementById(DOM_MENU_ID)) return;
    const mi = doc.createXULElement("menuitem");
    mi.id = DOM_MENU_ID;
    mi.setAttribute("data-l10n-id", "issue-splitter-menu");
    mi.setAttribute("label", "Split Journal Issue into Papers…");
    mi.addEventListener("command", () => {
      const items = window.ZoteroPane.getSelectedItems();
      if (items.length === 1) window.ZoteroIssueSplitter?.splitIssue(window, items[0]);
    });
    popup.appendChild(mi);
    popup.addEventListener("popupshowing", window.__issueSplitterShowing = () => {
      const items = window.ZoteroPane.getSelectedItems();
      mi.hidden = !(items.length === 1 && isCandidate(items[0]));
    });
  }
}

function onMainWindowUnload({ window }) {
  const doc = window.document;
  doc.getElementById(DOM_MENU_ID)?.remove();
  const popup = doc.getElementById("zotero-itemmenu");
  if (popup && window.__issueSplitterShowing) popup.removeEventListener("popupshowing", window.__issueSplitterShowing);
  doc.querySelector('[href="issue-splitter.ftl"]')?.remove();
  delete window.ZoteroIssueSplitter;
  delete window.__issueSplitterShowing;
}

function shutdown() {
  if (menuID) {
    Zotero.MenuManager.unregisterMenu(menuID);
    menuID = null;
  }
  for (const win of Zotero.getMainWindows()) onMainWindowUnload({ window: win });
}
