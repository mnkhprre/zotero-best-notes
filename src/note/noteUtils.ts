/*
 * This file realizes note tools.
 */

import TreeModel = require("tree-model");
import BetterNotes from "../addon";
import AddonBase from "../module";

class NoteUtils extends AddonBase {
  public currentLine: any;
  constructor(parent: BetterNotes) {
    super(parent);
    this.currentLine = {};
  }

  public getLinesInNote(note: Zotero.Item): string[] {
    if (!note) {
      return [];
    }
    let noteText: string = note.getNote();
    return this._Addon.NoteParse.parseHTMLLines(noteText);
  }

  public async setLinesToNote(note: Zotero.Item, noteLines: string[]) {
    if (!note) {
      return [];
    }
    let noteText: string = note.getNote();
    let containerIndex = noteText.search(/data-schema-version="[0-9]*/g);
    if (containerIndex === -1) {
      note.setNote(
        `<div data-schema-version="8">${noteLines.join("\n")}</div>`
      );
    } else {
      let noteHead = noteText.substring(0, containerIndex);
      note.setNote(
        `${noteHead}data-schema-version="8">${noteLines.join("\n")}</div>`
      );
    }

    await note.saveTx();
  }

  public async addLineToNote(
    note: Zotero.Item,
    text: string,
    lineIndex: number,
    forceMetadata: boolean = false,
    position: "before" | "after" = "after"
  ) {
    if (!note) {
      return;
    }
    let noteLines = this.getLinesInNote(note);
    let autoLineIndex = false;
    if (lineIndex < 0) {
      autoLineIndex = true;
      lineIndex = this.currentLine[note.id];
      lineIndex = lineIndex && lineIndex >= 0 ? lineIndex : noteLines.length;
    } else if (lineIndex >= noteLines.length) {
      lineIndex = noteLines.length;
    }
    Zotero.debug(
      `insert to ${lineIndex}, it used to be ${noteLines[lineIndex]}`
    );
    this._Addon.toolkit.Tool.log(text);

    const editorInstance = this._Addon.WorkspaceWindow.getEditorInstance(note);
    if (editorInstance && !forceMetadata) {
      // The note is opened. Add line via note editor
      this._Addon.toolkit.Tool.log("Add note line via note editor");
      const _document = editorInstance._iframeWindow.document;
      const currentElement = this._Addon.NoteParse.parseHTMLLineElement(
        this._Addon.EditorViews.getEditorElement(_document) as HTMLElement,
        lineIndex
      );
      const frag = _document.createDocumentFragment();
      const temp = this._Addon.toolkit.UI.createElement(
        _document,
        "div",
        "html",
        false
      ) as HTMLDivElement;
      temp.innerHTML = text;
      while (temp.firstChild) {
        frag.appendChild(temp.firstChild);
      }
      const defer = Zotero.Promise.defer();
      const notifyName = `addLineToNote-${note.id}`;
      this._Addon.ZoteroNotifies.registerNotifyListener(
        notifyName,
        (
          event: string,
          type: string,
          ids: Array<number | string>,
          extraData: object
        ) => {
          if (event === "modify" && type === "item" && ids.includes(note.id)) {
            this._Addon.ZoteroNotifies.unregisterNotifyListener(notifyName);
            defer.resolve();
          }
        }
      );
      position === "after"
        ? currentElement.after(frag)
        : currentElement.before(frag);

      await defer.promise;

      this._Addon.EditorViews.scrollToPosition(
        editorInstance,
        currentElement.offsetTop
      );
    } else {
      // The note editor does not exits yet. Fall back to modify the metadata
      this._Addon.toolkit.Tool.log("Add note line via note metadata");

      // insert after/before current line
      if (position === "after") {
        lineIndex += 1;
      }
      noteLines.splice(lineIndex, 0, text);
      await this.setLinesToNote(note, noteLines);
      if (this._Addon.WorkspaceWindow.getWorkspaceNote().id === note.id) {
        await this.scrollWithRefresh(lineIndex);
      }
    }

    if (autoLineIndex) {
      // Compute annotation lines length
      const temp = this._Addon.toolkit.UI.createElement(
        document,
        "div"
      ) as HTMLDivElement;
      temp.innerHTML = text;
      const elementList = this._Addon.NoteParse.parseHTMLElements(temp);
      // Move cursor foward
      this._Addon.NoteUtils.currentLine[note.id] += elementList.length;
    }
  }

  private _dataURLtoBlob(dataurl: string) {
    let parts = dataurl.split(",");
    let matches = parts[0]?.match(/:(.*?);/);
    if (!matches || !matches[1]) {
      return;
    }
    let mime = matches[1];
    if (parts[0].indexOf("base64") !== -1) {
      let bstr = atob(parts[1]);
      let n = bstr.length;
      let u8arr = new Uint8Array(n);
      while (n--) {
        u8arr[n] = bstr.charCodeAt(n);
      }

      return new (this._Addon.toolkit.Compat.getGlobal("Blob") as typeof Blob)(
        [u8arr],
        {
          type: mime,
        }
      );
    }
    return null;
  }

  public async importImageToNote(
    note: Zotero.Item,
    src: string,
    type: "b64" | "url" | "file" = "b64"
  ): Promise<string | void> {
    if (!note || !note.isNote()) {
      return "";
    }
    let blob: Blob;
    if (src.startsWith("data:")) {
      blob = this._dataURLtoBlob(src);
    } else if (type === "url") {
      let res;
      try {
        res = await Zotero.HTTP.request("GET", src, { responseType: "blob" });
      } catch (e) {
        return;
      }
      blob = res.response;
    } else if (type === "file") {
      src = Zotero.File.normalizeToUnix(src);
      const noteAttachmentKeys = Zotero.Items.get(note.getAttachments()).map(
        (_i) => _i.key
      );
      const filename = src.split("/").pop().split(".").shift();
      // The exported image is KEY.png by default.
      // If it is already an attachment, just keep it.
      if (noteAttachmentKeys.includes(filename)) {
        return filename;
      }
      const imageData = await Zotero.File.getBinaryContentsAsync(src);
      const array = new Uint8Array(imageData.length);
      for (let i = 0; i < imageData.length; i++) {
        array[i] = imageData.charCodeAt(i);
      }
      blob = new Blob([array], { type: "image/png" });
    } else {
      return;
    }

    let attachment = await Zotero.Attachments.importEmbeddedImage({
      blob,
      parentItemID: note.id,
      saveOptions: {},
    });

    return attachment.key;
  }

  public async importAnnotationImagesToNote(
    note: Zotero.Item,
    annotations: AnnotationJson[]
  ) {
    for (let annotation of annotations) {
      if (annotation.image) {
        annotation.imageAttachmentKey =
          (await this.importImageToNote(note, annotation.image)) || "";
      }
      delete annotation.image;
    }
  }

  public async addAnnotationsToNote(
    note: Zotero.Item,
    annotations: Zotero.Item[],
    lineIndex: number,
    showMsg: boolean = false
  ) {
    if (!note) {
      return;
    }
    const html = await this._Addon.NoteParse.parseAnnotationHTML(
      note,
      annotations
    );
    await this.addLineToNote(note, html, lineIndex, showMsg);
    const noteTitle = note.getNoteTitle();
    this._Addon.ZoteroViews.showProgressWindow(
      "Better Notes",
      `Insert lines into ${
        lineIndex >= 0 ? `line ${lineIndex} in` : "end of"
      } note ${
        noteTitle.length > 15 ? noteTitle.slice(0, 12) + "..." : noteTitle
      }`
    );
    return html;
  }

  public async addLinkToNote(
    targetNote: Zotero.Item,
    linkedNote: Zotero.Item,
    lineIndex: number,
    sectionName: string
  ) {
    if (!targetNote) {
      return;
    }
    if (!linkedNote.isNote()) {
      this._Addon.ZoteroViews.showProgressWindow(
        "Better Notes",
        "Not a note item"
      );
      return;
    }
    const link = this.getNoteLink(linkedNote);
    const linkText = linkedNote.getNoteTitle().trim();

    const linkTemplate =
      await this._Addon.TemplateController.renderTemplateAsync(
        "[QuickInsert]",
        "link, subNoteItem, noteItem, sectionName, lineIndex",
        [link, linkedNote, targetNote, sectionName, lineIndex]
      );

    this.addLineToNote(targetNote, linkTemplate, lineIndex);

    const backLinkTemplate =
      await this._Addon.TemplateController.renderTemplateAsync(
        "[QuickBackLink]",
        "subNoteItem, noteItem, sectionName, lineIndex",
        [linkedNote, targetNote, sectionName, lineIndex],
        false
      );

    if (backLinkTemplate) {
      this.addLineToNote(linkedNote, backLinkTemplate, -1);
    }

    this._Addon.ZoteroViews.showProgressWindow(
      "Better Notes",
      `Link is added to ${lineIndex >= 0 ? ` line ${lineIndex}` : ""}`
    );
  }

  public getNoteLink(
    note: Zotero.Item,
    options: {
      ignore?: boolean;
      withLine?: boolean;
    } = { ignore: false, withLine: false }
  ) {
    let libraryID = note.libraryID;
    let library = Zotero.Libraries.get(libraryID);
    let groupID: string;
    if (library.libraryType === "user") {
      groupID = "u";
    } else if (library.libraryType === "group") {
      groupID = `${library.id}`;
    } else {
      return "";
    }
    let noteKey = note.key;
    let link = `zotero://note/${groupID}/${noteKey}/`;
    const addParam = (link: string, param: string): string => {
      const lastChar = link[link.length - 1];
      if (lastChar === "/") {
        link += "?";
      } else if (lastChar !== "?" && lastChar !== "&") {
        link += "&";
      }
      return `${link}${param}`;
    };
    if (options.ignore || options.withLine) {
      if (options.ignore) {
        link = addParam(link, "ignore=1");
      }
      if (options.withLine) {
        if (!this.currentLine[note.id]) {
          this.currentLine[note.id] = 0;
        }
        link = addParam(link, `line=${this.currentLine[note.id]}`);
      }
    }
    return link;
  }

  public getAnnotationLink(annotation: Zotero.Item) {
    let position = JSON.parse(annotation.annotationPosition);
    let openURI: string;

    const attachment = annotation.parentItem;
    let libraryID = attachment.libraryID;
    let library = Zotero.Libraries.get(libraryID);
    if (library.libraryType === "user") {
      openURI = `zotero://open-pdf/library/items/${attachment.key}`;
    } else if (library.libraryType === "group") {
      openURI = `zotero://open-pdf/groups/${library.id}/items/${attachment.key}`;
    } else {
      openURI = "";
    }

    openURI +=
      "?page=" +
      (position.pageIndex + 1) +
      (annotation.key ? "&annotation=" + annotation.key : "");

    return openURI;
  }

  async modifyLineInNote(
    note: Zotero.Item,
    text: string | Function,
    lineIndex: number,
    forceMetadata: boolean = false
  ) {
    if (!note) {
      return;
    }
    let noteLines = this.getLinesInNote(note);
    if (lineIndex < 0 || lineIndex >= noteLines.length) {
      return;
    }
    if (typeof text === "string") {
      noteLines[lineIndex] = text;
    } else if (typeof text === "function") {
      noteLines[lineIndex] = text(noteLines[lineIndex]);
    }
    const editorInstance = this._Addon.WorkspaceWindow.getEditorInstance(note);
    if (editorInstance && !forceMetadata) {
      // The note is opened. Add line via note editor
      this._Addon.toolkit.Tool.log("Modify note line via note editor");
      const _document = editorInstance._iframeWindow.document;
      const currentElement: HTMLElement =
        this._Addon.NoteParse.parseHTMLLineElement(
          this._Addon.EditorViews.getEditorElement(_document) as HTMLElement,
          lineIndex
        );
      const frag = _document.createDocumentFragment();
      const temp = this._Addon.toolkit.UI.createElement(
        _document,
        "div",
        "html",
        false
      ) as HTMLDivElement;
      temp.innerHTML = noteLines[lineIndex];
      while (temp.firstChild) {
        frag.appendChild(temp.firstChild);
      }
      const defer = Zotero.Promise.defer();
      const notifyName = `modifyLineInNote-${note.id}`;
      this._Addon.ZoteroNotifies.registerNotifyListener(
        notifyName,
        (
          event: string,
          type: string,
          ids: Array<number | string>,
          extraData: object
        ) => {
          if (event === "modify" && type === "item" && ids.includes(note.id)) {
            this._Addon.ZoteroNotifies.unregisterNotifyListener(notifyName);
            defer.resolve();
          }
        }
      );
      currentElement.replaceWith(frag);
      await defer.promise;
      this._Addon.EditorViews.scrollToPosition(
        editorInstance,
        currentElement.offsetTop
      );
    } else {
      await this.setLinesToNote(note, noteLines);
      await this.scrollWithRefresh(lineIndex);
    }
  }

  async moveHeaderLineInNote(
    note: Zotero.Item,
    currentNode: TreeModel.Node<object>,
    targetNode: TreeModel.Node<object>,
    as: "child" | "before" | "after"
  ) {
    if (!note || targetNode.getPath().indexOf(currentNode) >= 0) {
      return;
    }

    let targetIndex = 0;
    let targetRank = 1;

    let lines = this.getLinesInNote(note);

    if (as === "child") {
      targetIndex = targetNode.model.endIndex;
      targetRank = targetNode.model.rank === 6 ? 6 : targetNode.model.rank + 1;
    } else if (as === "before") {
      targetIndex = targetNode.model.lineIndex - 1;
      targetRank =
        targetNode.model.rank === 7
          ? targetNode.parent.model.rank === 6
            ? 6
            : targetNode.parent.model.rank + 1
          : targetNode.model.rank;
    } else if (as === "after") {
      targetIndex = targetNode.model.endIndex;
      targetRank =
        targetNode.model.rank === 7
          ? targetNode.parent.model.rank === 6
            ? 6
            : targetNode.parent.model.rank + 1
          : targetNode.model.rank;
    }

    let rankChange = targetRank - currentNode.model.rank;

    let movedLines = lines.splice(
      currentNode.model.lineIndex,
      currentNode.model.endIndex - currentNode.model.lineIndex + 1
    );

    let headerReg = /<\/?h[1-6]/g;
    for (const i in movedLines) {
      movedLines[i] = movedLines[i].replace(headerReg, (e) => {
        let rank = parseInt(e.slice(-1));
        rank += rankChange;
        if (rank > 6) {
          rank = 6;
        }
        if (rank < 1) {
          rank = 1;
        }
        return `${e.slice(0, -1)}${rank}`;
      });
    }

    // If the moved lines is before the insert index
    // the slice index -= lines length.
    if (currentNode.model.endIndex <= targetIndex) {
      targetIndex -= movedLines.length;
    }
    this._Addon.toolkit.Tool.log(`move to ${targetIndex}`);

    let newLines = lines
      .slice(0, targetIndex + 1)
      .concat(movedLines, lines.slice(targetIndex + 1));
    this._Addon.toolkit.Tool.log("new lines", newLines);
    this._Addon.toolkit.Tool.log("moved", movedLines);
    this._Addon.toolkit.Tool.log("insert after", lines[targetIndex]);
    this._Addon.toolkit.Tool.log("next line", lines[targetIndex + 1]);
    await this.setLinesToNote(note, newLines);
  }

  getNoteTree(note: Zotero.Item): TreeModel.Node<object> {
    // See http://jnuno.com/tree-model-js
    if (!note) {
      return undefined;
    }
    return this._Addon.NoteParse.parseNoteTree(note);
  }

  getNoteTreeAsList(
    note: Zotero.Item,
    filterRoot: boolean = true,
    filterLink: boolean = true
  ): TreeModel.Node<object>[] {
    if (!note) {
      return;
    }
    return this.getNoteTree(note).all(
      (node) =>
        (!filterRoot || node.model.lineIndex >= 0) &&
        (!filterLink || node.model.rank <= 6)
    );
  }

  getNoteTreeNodeById(
    note: Zotero.Item,
    id: number,
    root: TreeModel.Node<object> = undefined
  ) {
    root = root || this.getNoteTree(note);
    return root.first(function (node) {
      return node.model.id === id;
    });
  }

  getNoteTreeNodesByRank(
    note: Zotero.Item,
    rank: number,
    root: TreeModel.Node<object> = undefined
  ) {
    root = root || this.getNoteTree(note);
    return root.all(function (node) {
      return node.model.rank === rank;
    });
  }

  getLineParentNode(
    note: Zotero.Item,
    lineIndex: number = -1
  ): TreeModel.Node<object> {
    if (lineIndex < 0) {
      lineIndex = this.currentLine[note.id];
      lineIndex =
        lineIndex && lineIndex >= 0
          ? lineIndex
          : this.getLinesInNote(note).length;
    }
    let nodes = this.getNoteTreeAsList(note);
    if (!nodes.length || nodes[0].model.lineIndex > lineIndex) {
      // There is no parent node
      return undefined;
    } else if (nodes[nodes.length - 1].model.lineIndex <= lineIndex) {
      return nodes[nodes.length - 1];
    } else {
      for (let i = 0; i < nodes.length - 1; i++) {
        if (
          nodes[i].model.lineIndex <= lineIndex &&
          nodes[i + 1].model.lineIndex > lineIndex
        ) {
          return nodes[i];
        }
      }
    }
  }

  async moveNode(fromID: number, toID: number, moveType: "before" | "child") {
    const workspaceNote = this._Addon.WorkspaceWindow.getWorkspaceNote();
    let tree = this.getNoteTree(workspaceNote);
    let fromNode = this.getNoteTreeNodeById(workspaceNote, fromID, tree);
    let toNode = this._Addon.NoteUtils.getNoteTreeNodeById(
      workspaceNote,
      toID,
      tree
    );
    this._Addon.toolkit.Tool.log(toNode.model, fromNode.model, moveType);
    this.moveHeaderLineInNote(
      this._Addon.WorkspaceWindow.getWorkspaceNote(),
      fromNode,
      toNode,
      moveType
    );
  }

  async scrollWithRefresh(lineIndex: number) {
    await Zotero.Promise.delay(500);
    let editorInstance =
      await this._Addon.WorkspaceWindow.getWorkspaceEditorInstance();
    if (!editorInstance) {
      return;
    }
    this._Addon.EditorViews.scrollToLine(editorInstance, lineIndex);
  }

  async convertNoteLines(
    currentNote: Zotero.Item,
    rootNoteIds: number[],
    convertNoteLinks: boolean = true
  ): Promise<{ lines: string[]; subNotes: Zotero.Item[] }> {
    this._Addon.toolkit.Tool.log(`convert note ${currentNote.id}`);

    let subNotes: Zotero.Item[] = [];
    const [..._rootNoteIds] = rootNoteIds;
    _rootNoteIds.push(currentNote.id);

    let newLines: string[] = [];
    const noteLines = this.getLinesInNote(currentNote);
    for (let i in noteLines) {
      newLines.push(noteLines[i]);
      // Convert Link
      if (convertNoteLinks) {
        let link = this._Addon.NoteParse.parseLinkInText(noteLines[i]);
        while (link) {
          const linkIndex = noteLines[i].indexOf(link);
          const params = this._Addon.NoteParse.parseParamsFromLink(link);
          if (
            params.ignore ||
            // Ignore links that are not in <a>
            !noteLines[i].slice(linkIndex - 8, linkIndex).includes("href")
          ) {
            this._Addon.toolkit.Tool.log("ignore link");
            noteLines[i] = noteLines[i].substring(
              noteLines[i].search(/zotero:\/\/note\//g)
            );
            noteLines[i] = noteLines[i].substring(
              noteLines[i].search(/<\/a>/g) + "</a>".length
            );
            link = this._Addon.NoteParse.parseLinkInText(noteLines[i]);
            continue;
          }
          this._Addon.toolkit.Tool.log("convert link");
          let res = await this.getNoteFromLink(link);
          const subNote = res.item;
          if (subNote && _rootNoteIds.indexOf(subNote.id) === -1) {
            this._Addon.toolkit.Tool.log(
              `Knowledge4Zotero: Exporting sub-note ${link}`
            );
            const convertResult = await this.convertNoteLines(
              subNote,
              _rootNoteIds,
              convertNoteLinks
            );
            const subNoteLines = convertResult.lines;

            const templateText =
              await this._Addon.TemplateController.renderTemplateAsync(
                "[QuickImport]",
                "subNoteLines, subNoteItem, noteItem",
                [subNoteLines, subNote, currentNote]
              );
            newLines.push(templateText);
            subNotes.push(subNote);
            subNotes = subNotes.concat(convertResult.subNotes);
          }
          noteLines[i] = noteLines[i].substring(
            noteLines[i].search(/zotero:\/\/note\//g)
          );
          noteLines[i] = noteLines[i].substring(
            noteLines[i].search(/<\/a>/g) + "</a>".length
          );
          link = this._Addon.NoteParse.parseLinkInText(noteLines[i]);
        }
      }
    }
    this._Addon.toolkit.Tool.log(subNotes);
    return { lines: newLines, subNotes: subNotes };
  }

  async getNoteFromLink(uri: string) {
    const params = this._Addon.NoteParse.parseParamsFromLink(uri);
    if (!params.libraryID) {
      return {
        item: undefined,
        args: {},
        infoText: "Library does not exist or access denied.",
      };
    }
    this._Addon.toolkit.Tool.log(params);
    let item: Zotero.Item = await Zotero.Items.getByLibraryAndKeyAsync(
      params.libraryID,
      params.noteKey
    );
    if (!item || !item.isNote()) {
      return {
        item: undefined,
        args: params,
        infoText: "Note does not exist or is not a note.",
      };
    }
    return {
      item: item,
      args: params,
      infoText: "OK",
    };
  }

  public async onSelectionChange(
    editor: Zotero.EditorInstance,
    itemID: number
  ) {
    // Update current line index
    const _window = editor._iframeWindow;
    const selection = _window.document.getSelection();
    if (!selection || !selection.focusNode) {
      return;
    }
    const realElement = selection.focusNode.parentElement;
    let focusNode = selection.focusNode as XUL.Element;
    if (!focusNode || !realElement) {
      return;
    }

    function getChildIndex(node) {
      return Array.prototype.indexOf.call(node.parentNode.childNodes, node);
    }

    // Make sure this is a direct child node of editor
    try {
      while (
        focusNode.parentElement &&
        (!focusNode.parentElement.className ||
          focusNode.parentElement.className.indexOf("primary-editor") === -1)
      ) {
        focusNode = focusNode.parentNode as XUL.Element;
      }
    } catch (e) {
      return;
    }

    if (!focusNode.parentElement) {
      return;
    }

    let currentLineIndex = getChildIndex(focusNode);

    // Parse list
    const diveTagNames = ["OL", "UL", "LI"];

    // Find list elements before current line
    const listElements = Array.prototype.filter.call(
      Array.prototype.slice.call(
        focusNode.parentElement.childNodes,
        0,
        currentLineIndex
      ),
      (e) => diveTagNames.includes(e.tagName)
    );

    for (const e of listElements) {
      currentLineIndex += this._Addon.NoteParse.parseListElements(e).length - 1;
    }

    // Find list index if current line is inside a list
    if (diveTagNames.includes(focusNode.tagName)) {
      const eleList = this._Addon.NoteParse.parseListElements(focusNode);
      for (const i in eleList) {
        if (realElement.parentElement === eleList[i]) {
          currentLineIndex += Number(i);
          break;
        }
      }
    }
    this._Addon.toolkit.Tool.log(`line ${currentLineIndex} of item ${itemID} selected.`);
    // Don't use the instance._item.id, as it might not be updated.
    this.currentLine[itemID] = currentLineIndex;
    if (realElement.tagName === "A") {
      let link = (realElement as HTMLLinkElement).href;
      let linkedNote = (await this.getNoteFromLink(link)).item;
      if (linkedNote) {
        let t = 0;
        let linkPopup = _window.document.querySelector(".link-popup");
        while (
          !(
            linkPopup &&
            (linkPopup.querySelector("a") as unknown as HTMLLinkElement)
              ?.href === link
          ) &&
          t < 100
        ) {
          t += 1;
          linkPopup = _window.document.querySelector(".link-popup");
          await Zotero.Promise.delay(30);
        }
        await this._Addon.EditorViews.updateEditorLinkPopup(editor, link);
      } else {
        await this._Addon.EditorViews.updateEditorLinkPopup(editor, undefined);
      }
    }
    if (_window.document.querySelector(".regular-image.selected")) {
      let t = 0;
      let imagePopup = _window.document.querySelector(".image-popup");
      while (!imagePopup && t < 100) {
        t += 1;
        imagePopup = _window.document.querySelector(".image-popup");
        await Zotero.Promise.delay(30);
      }
      if (imagePopup) {
        this._Addon.EditorViews.updateEditorImagePopup(editor);
      }
    }
  }

  public formatPath(path: string) {
    if (Zotero.isWin) {
      path = path.replace(/\\/g, "/");
      path = OS.Path.join(...path.split(/\//));
    }
    if (Zotero.isMac && path.charAt(0) !== "/") {
      path = "/" + path;
    }
    return path;
  }
}

export default NoteUtils;
