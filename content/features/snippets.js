/**
 * Dynamics 365 Power Pane Next - feature: FetchXML / JS snippets.
 *
 * Snippet library stored in chrome.storage.local (key PP.LOCAL.SNIPPETS):
 * create / edit / run FetchXML or JavaScript snippets, import / export the
 * library as JSON. Runs snippets on top of the shared modal and result
 * renderers.
 *
 * Shared surface: window.PPPane (content/core.js). Globals: window.PP,
 * window.PPUtil. Loaded by the manifest after content/core.js and before
 * content/boot.js.
 */
(function (Pane) {
  "use strict";
  const PP = window.PP;
  const PPUtil = window.PPUtil;
  const downloadTextFile = PPUtil.downloadTextFile;
  const {
    state,
    send,
    openModal,
    showOutput,
    showTable,
    toast,
    localSet,
    registerLocal
  } = Pane;

  function openSnippets() {
    openModal(function (box, close) {
      function render() {
        box.textContent = "";
        const heading = document.createElement("h3");
        heading.textContent = "Snippets (FetchXML/JS)";
        box.appendChild(heading);
        const description = document.createElement("p");
        description.className = "desc";
        description.textContent = "Save and reuse FetchXML queries and JavaScript snippets.";
        box.appendChild(description);
        const storageNote = document.createElement("p");
        storageNote.className = "desc";
        storageNote.title = "chrome.storage.local (key: " + PP.LOCAL.SNIPPETS + ")";
        storageNote.textContent = "Stored in this browser only (chrome.storage.local) - snippets are not synced across devices.";
        box.appendChild(storageNote);

        if (!state.snippets.length) {
          const empty = document.createElement("div");
          empty.className = "empty";
          empty.textContent = "No snippets yet.";
          box.appendChild(empty);
        }

        state.snippets.forEach(function (snippet, index) {
          const row = document.createElement("div");
          row.className = "srow";
          const name = document.createElement("span");
          name.className = "nm";
          name.textContent = snippet.name;
          row.appendChild(name);
          const typeTag = document.createElement("span");
          typeTag.className = "mini";
          typeTag.style.opacity = ".6";
          typeTag.style.flex = "none";
          typeTag.textContent = snippet.type === "js" ? "JS" : "XML";
          row.appendChild(typeTag);

          const runButton = document.createElement("button");
          runButton.className = "mini";
          runButton.textContent = "Run";
          runButton.addEventListener("click", function () {
            // Keep the dialog open with a running state until the result
            // dialog is ready to show.
            runButton.classList.add("running");
            runButton.textContent = "Running...";
            runButton.disabled = true;
            // The snippet is already saved, so its result dialog offers no
            // "Save to Snippets" button for either type.
            const request =
              snippet.type === "js"
                ? send("runScript", { code: snippet.xml })
                : send("executeFetchXml", { xml: snippet.xml, mode: "fetchxml" });
            const resultOptions = { pinned: true };
            request
              .then(function (result) {
                close();
                if (result && result.output) showOutput(result.output, resultOptions);
                if (result && result.table) showTable(result.table, resultOptions);
                if (result && result.message) toast(result.message, result.level);
              })
              .catch(function (err) {
                runButton.classList.remove("running");
                runButton.textContent = "Run";
                runButton.disabled = false;
                toast(err.message, "error");
              });
          });
          const editButton = document.createElement("button");
          editButton.className = "mini";
          editButton.textContent = "Edit";
          editButton.addEventListener("click", function () {
            form(snippet, index);
          });
          const deleteButton = document.createElement("button");
          deleteButton.className = "mini";
          deleteButton.textContent = "Del";
          deleteButton.addEventListener("click", function () {
            state.snippets.splice(index, 1);
            localSet(PP.LOCAL.SNIPPETS, state.snippets).then(render);
          });

          row.appendChild(runButton);
          row.appendChild(editButton);
          row.appendChild(deleteButton);
          box.appendChild(row);
        });

        const foot = document.createElement("div");
        foot.className = "foot";
        const importButton = document.createElement("button");
        importButton.className = "mini";
        importButton.textContent = "Import";
        importButton.addEventListener("click", pickSnippetFile);
        const exportButton = document.createElement("button");
        exportButton.className = "mini";
        exportButton.textContent = "Export";
        exportButton.addEventListener("click", exportSnippets);
        const addButton = document.createElement("button");
        addButton.className = "primary";
        addButton.textContent = "New";
        addButton.addEventListener("click", function () {
          form(null, -1);
        });
        const closeButton = document.createElement("button");
        closeButton.textContent = "Close";
        closeButton.addEventListener("click", close);
        foot.appendChild(importButton);
        foot.appendChild(exportButton);
        foot.appendChild(addButton);
        foot.appendChild(closeButton);
        box.appendChild(foot);
      }

      /** Open a JSON file picker and merge valid snippets from it. */
      function pickSnippetFile() {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = ".json,application/json";
        input.style.display = "none";
        input.addEventListener("change", function () {
          const file = input.files && input.files[0];
          input.remove();
          if (!file) return;
          const reader = new FileReader();
          reader.onload = function () {
            importSnippets(String(reader.result));
          };
          reader.onerror = function () {
            toast("Could not read the file.", "error");
          };
          reader.readAsText(file);
        });
        box.appendChild(input);
        input.click();
      }

      function importSnippets(text) {
        let parsed;
        try {
          parsed = JSON.parse(text);
        } catch (e) {
          toast("Import failed: not a valid JSON file.", "error");
          return;
        }
        // Accept either a snippets export ({ snippets: [...] }) or a bare array.
        const items = Array.isArray(parsed)
          ? parsed
          : parsed && Array.isArray(parsed.snippets)
          ? parsed.snippets
          : null;
        if (!items) {
          toast("Import failed: no snippets found in the file.", "error");
          return;
        }
        // Validate + normalize via the shared helper (options import uses the
        // same shape rules).
        const incoming = window.PPUtil.normalizeSnippets(items);
        if (!incoming.length) {
          toast("Import failed: the file contains no valid snippets.", "error");
          return;
        }
        // JavaScript snippets run with the user's own privileges in the page
        // when executed - importing one from an untrusted file must be an
        // informed decision.
        const jsCount = incoming.filter(function (snippet) {
          return snippet.type === "js";
        }).length;
        if (
          jsCount &&
          !window.confirm(
            "The file contains " +
              jsCount +
              " JavaScript snippet(s). They run with your privileges in the page when executed. Import anyway?"
          )
        ) {
          toast("Import cancelled.", "warning");
          return;
        }
        let added = 0;
        incoming.forEach(function (snippet) {
          const duplicate = state.snippets.some(function (existing) {
            return existing.name === snippet.name && existing.xml === snippet.xml && existing.type === snippet.type;
          });
          if (duplicate) return;
          state.snippets.push(snippet);
          added++;
        });
        if (!added) {
          toast("Nothing imported: the file was empty or all snippets already exist.", "warning");
          render();
          return;
        }
        localSet(PP.LOCAL.SNIPPETS, state.snippets).then(function () {
          toast("Imported " + added + " snippet(s).", "success");
          render();
        });
      }

      function exportSnippets() {
        if (!state.snippets.length) {
          toast("No snippets to export yet.", "warning");
          return;
        }
        const payload = {
          type: "power-pane-snippets",
          version: 1,
          exportedAt: new Date().toISOString(),
          snippets: state.snippets
        };
        downloadTextFile("power-pane-snippets.json", JSON.stringify(payload, null, 2), "application/json");
        toast("Exported " + state.snippets.length + " snippet(s).", "success");
      }

      function form(snippet, index) {
        box.textContent = "";
        const heading = document.createElement("h3");
        heading.textContent = index >= 0 ? "Edit Snippet" : "New Snippet";
        box.appendChild(heading);

        const typeField = PPUtil.snippetTypeField();
        typeField.select.value = snippet ? (snippet.type === "fetchxml" ? "fetchxml" : "js") : "js";
        box.appendChild(typeField.root);
        const typeSelect = typeField.select;

        const nameField = document.createElement("div");
        nameField.className = "field";
        const nameLabel = document.createElement("label");
        nameLabel.textContent = "Name";
        const nameInput = document.createElement("input");
        nameInput.type = "text";
        nameInput.value = snippet ? snippet.name : "";
        nameField.appendChild(nameLabel);
        nameField.appendChild(nameInput);
        box.appendChild(nameField);

        const xmlField = document.createElement("div");
        xmlField.className = "field";
        const xmlLabel = document.createElement("label");
        xmlLabel.textContent = "Source";
        const xmlArea = document.createElement("textarea");
        const placeholders = {
          fetchxml: "<fetch>...</fetch>",
          js: "// JavaScript runs in the page world.\n// Use `return` to produce output. `xrm` is in scope."
        };
        const syncPlaceholder = function () {
          xmlLabel.textContent = typeSelect.value === "js" ? "JavaScript" : "FetchXML";
          xmlArea.placeholder = placeholders[typeSelect.value] || "";
        };
        syncPlaceholder();
        typeSelect.addEventListener("change", syncPlaceholder);
        xmlArea.value = snippet ? snippet.xml : "";
        xmlField.appendChild(xmlLabel);
        xmlField.appendChild(xmlArea);
        box.appendChild(xmlField);

        const foot = document.createElement("div");
        foot.className = "foot";
        const backButton = document.createElement("button");
        backButton.textContent = "Back";
        backButton.addEventListener("click", render);
        const saveButton = document.createElement("button");
        saveButton.className = "primary";
        saveButton.textContent = "Save";
        saveButton.addEventListener("click", function () {
          const name = nameInput.value.trim() || "Untitled";
          const body = { name: name, xml: xmlArea.value, type: typeSelect.value };
          if (index >= 0) state.snippets[index] = body;
          else state.snippets.push(body);
          localSet(PP.LOCAL.SNIPPETS, state.snippets).then(render);
        });
        foot.appendChild(backButton);
        foot.appendChild(saveButton);
        box.appendChild(foot);
        nameInput.focus();
      }

      render();
    });
  }

  registerLocal("snippets", openSnippets);

})(window.PPPane);
