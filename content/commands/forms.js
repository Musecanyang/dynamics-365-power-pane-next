/**
 * Dynamics 365 Power Pane Next - command handlers: forms.
 *
 * Form editing commands: enabled / hidden / required field toggling, logical-name overlays, dirty highlighting, lookup links and the refresh family.
 *
 * Every handler registers via PPmain.register; cross-command reads go
 * through PPmain.get(name). See content/main-world.js for the loading
 * order, the postMessage contract and the response shapes.
 */
(function (PPmain) {
  "use strict";

  const { requireForm, findContainer } = PPmain;

  /* ------------------------------------------------------------------ *
   * Form
   * ------------------------------------------------------------------ */

  PPmain.register("enableAllFields", function () {
    const xrm = requireForm();
    xrm.Page.ui.controls.forEach(function (control) {
      try {
        control.setDisabled(false);
      } catch (e) {
        /* ignore controls that cannot be enabled */
      }
    });
    return { message: "All fields are enabled.", level: "success" };
  });

  PPmain.register("showHiddenFields", function () {
    const xrm = requireForm();
    xrm.Page.ui.controls.forEach(function (control) {
      try {
        control.setVisible(true);
      } catch (e) {
        /* ignore */
      }
    });
    xrm.Page.ui.tabs.forEach(function (tab) {
      try {
        if (tab.setVisible) tab.setVisible(true);
        if (tab.sections && tab.sections.getAll) {
          tab.sections.getAll().forEach(function (section) {
            try {
              if (section && section.setVisible) section.setVisible(true);
            } catch (e) {
              /* ignore */
            }
          });
        }
      } catch (e) {
        /* ignore */
      }
    });
    return { message: "All hidden fields, tabs and sections are now visible.", level: "success" };
  });

  PPmain.register("disableRequired", function () {
    const xrm = requireForm();
    xrm.Page.ui.controls.forEach(function (control) {
      try {
        if (control && control.getAttribute && control.getAttribute().setRequiredLevel) {
          control.getAttribute().setRequiredLevel("none");
        }
      } catch (e) {
        /* ignore */
      }
    });
    return { message: "Required level of all fields set to none.", level: "success" };
  });

  PPmain.register("showFieldValue", function (args) {
    const xrm = requireForm();
    const name = (args && args.fieldname || "").trim();
    if (!name) throw new Error("Field schema name is required.");
    const control = xrm.Page.getControl(name);
    if (!control || !control.getControlType) throw new Error("Field not found on this form.");
    const type = control.getControlType();
    const items = [{ label: "Control Type", value: type }];
    if (type === "optionset") {
      items.push({ label: "Selected Text", value: control.getAttribute().getText() });
      items.push({ label: "Selected Value", value: control.getAttribute().getValue() });
    } else if (type === "lookup") {
      const value = control.getAttribute().getValue();
      const first = value && value.length ? value[0] : null;
      items.push({ label: "Name", value: first ? first.name : "" });
      items.push({ label: "Id", value: first ? first.id : "" });
      items.push({ label: "Entity Name", value: first ? first.entityType : "" });
      items.push({ label: "Entity Type Code", value: first ? first.type : "" });
    } else {
      items.push({ label: "Value", value: control.getAttribute().getValue() });
    }
    return { output: { title: "Field Value", description: name, items: items } };
  });

  PPmain.register("findField", function (args) {
    const xrm = requireForm();
    const name = (args && args.fieldname || "").trim();
    if (!name) throw new Error("Field schema name is required.");
    const control = xrm.Page.getControl(name);
    if (!control) throw new Error("Field not found on this form.");
    control.setFocus();
    let hidden = "";
    if (control.getVisible && control.getVisible() === false) {
      control.setVisible(true);
      hidden = " It was hidden and is now visible.";
    }
    const element = findContainer(name);
    if (element) element.style.background = "#FFFF00";
    return { message: "Focused field " + name + "." + hidden, level: "success" };
  });

  PPmain.register("highlightDirty", function () {
    const xrm = requireForm();
    xrm.Page.ui.controls.forEach(function (control) {
      const attribute = control && control.getAttribute ? control.getAttribute() : null;
      if (attribute && attribute.getIsDirty && attribute.getIsDirty()) {
        const element = findContainer(control.getName());
        if (element) element.style.background = "#FFFF00";
      }
    });
    return { message: "Dirty fields highlighted.", level: "success" };
  });

  PPmain.register("clearNotifications", function () {
    const xrm = requireForm();
    xrm.Page.ui.controls.forEach(function (control) {
      try {
        control.clearNotification();
      } catch (e) {
        /* ignore */
      }
    });
    return { message: "All field notifications cleared.", level: "success" };
  });

  PPmain.register("refreshForm", function () {
    const xrm = requireForm();
    xrm.Page.data.refresh(false);
    return { message: "Form refreshed.", level: "success" };
  });

  PPmain.register("refreshRibbon", function () {
    const xrm = requireForm();
    xrm.Page.ui.refreshRibbon();
    return { message: "Ribbon refreshed.", level: "success" };
  });

  PPmain.register("toggleLookupLinks", function () {
    const xrm = requireForm();
    const existing = document.querySelectorAll(".pp-lookup-link");
    if (existing.length) {
      existing.forEach(function (node) {
        node.remove();
      });
      return { message: "Lookup links removed.", level: "success" };
    }
    const icon =
      '<svg viewBox="0 0 32 32" width="14" height="14" fill="none" stroke="currentcolor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><path d="M14 9 L3 9 3 29 23 29 23 18 M18 4 L28 4 28 14 M28 4 L14 18" /></svg>';
    xrm.Page.ui.controls.forEach(function (control) {
      try {
        if (control.getControlType() !== "lookup") return;
        const holder = findContainer(control.getName());
        if (!holder) return;
        const link = document.createElement("a");
        link.className = "pp-lookup-link";
        link.title = "Open this record in a new window";
        link.style.cssText = "cursor:pointer;margin-left:5px;display:inline-block;vertical-align:middle";
        link.innerHTML = icon;
        link.addEventListener("click", function () {
          try {
            const record = control.getAttribute().getValue()[0];
            window.open(
              xrm.Page.context.getClientUrl() +
                "/main.aspx?etn=" +
                record.entityType +
                "&id=" +
                record.id +
                "&pagetype=entityrecord"
            );
          } catch (e) {
            /* ignore */
          }
        });
        holder.appendChild(link);
      } catch (e) {
        /* ignore */
      }
    });
    return { message: "Lookup links added.", level: "success" };
  });

  PPmain.register("godMode", function () {
    const xrm = requireForm();
    let count = 0;
    xrm.Page.data.entity.attributes.forEach(function (attribute) {
      try {
        if (attribute.getRequiredLevel() === "required") {
          attribute.setRequiredLevel("none");
          count++;
        }
      } catch (e) {
        /* ignore */
      }
    });
    xrm.Page.ui.controls.forEach(function (control) {
      try {
        if (control.setVisible) control.setVisible(true);
        if (control.setDisabled) control.setDisabled(false);
        count++;
      } catch (e) {
        /* ignore */
      }
    });
    xrm.Page.ui.tabs.forEach(function (tab) {
      try {
        if (tab.setVisible) tab.setVisible(true);
        if (tab.sections && tab.sections.forEach) {
          tab.sections.forEach(function (section) {
            try {
              if (section.setVisible) section.setVisible(true);
            } catch (e) {
              /* ignore */
            }
          });
        }
      } catch (e) {
        /* ignore */
      }
    });
    return { message: "God mode: " + count + " elements unlocked.", level: "success" };
  });

  PPmain.register("changedFields", function () {
    const xrm = requireForm();
    const names = [];
    try {
      const xml = xrm.Page.data.entity.getDataXml();
      const doc = new DOMParser().parseFromString(xml, "text/xml");
      const root = doc.documentElement;
      for (let i = 0; i < root.children.length; i++) names.push(root.children[i].tagName);
    } catch (e) {
      xrm.Page.data.entity.attributes.forEach(function (attribute) {
        if (attribute.getIsDirty && attribute.getIsDirty()) names.push(attribute.getName());
      });
    }
    let marked = 0;
    names.forEach(function (name) {
      const element = findContainer(name);
      if (element) {
        element.style.boxShadow = "inset 4px 0 0 #742774";
        marked++;
      }
    });
    return { message: names.length + " changed field(s), " + marked + " highlighted.", level: "success" };
  });

  PPmain.register("clearLogicalNames", function () {
    const elements = document.querySelectorAll(".pp-logical-name");
    for (let i = 0; i < elements.length; i++) {
      elements[i].classList.remove("pp-logical-name");
      elements[i].removeAttribute("title");
      elements[i].__ppBound = false;
    }
    return { message: "Logical name mode cleared.", level: "success" };
  });

  PPmain.register("refreshSubgrids", function () {
    const xrm = requireForm();
    let count = 0;
    xrm.Page.ui.controls.forEach(function (control) {
      try {
        if (control.getControlType && control.getControlType() === "subgrid" && control.refresh) {
          control.refresh();
          count++;
        }
      } catch (e) {
        /* ignore */
      }
    });
    return { message: count + " subgrid(s) refreshed.", level: "success" };
  });

  PPmain.register("refreshWithoutSave", async function () {
    const xrm = requireForm();
    await xrm.Page.data.refresh(false);
    try {
      xrm.Page.data.entity.addOnSave(function (ctx) {
        const args = ctx.getEventArgs();
        if (args.getSaveMode() === 70 || args.getSaveMode() === 2) args.preventDefault();
      });
    } catch (e) {
      /* ignore */
    }
    return { message: "Form refreshed; auto-save disabled for this session.", level: "success" };
  });

  PPmain.register("logicalNamesInline", function () {
    const xrm = requireForm();
    let action = null;
    xrm.Page.ui.controls.forEach(function (control) {
      try {
        if (!control.getName || !control.setLabel || !control.getLabel) return;
        const name = control.getName();
        if (!control.__ppOrigLabel) {
          control.__ppOrigLabel = control.getLabel();
          control.setLabel(control.__ppOrigLabel + " [" + name + "]");
          action = "update";
        } else {
          control.setLabel(control.__ppOrigLabel);
          control.__ppOrigLabel = null;
          action = "rollback";
        }
        const element = findContainer(name) || document.getElementById(name + "_c");
        const label =
          element && element.tagName === "LABEL"
            ? element
            : element && element.querySelector
            ? element.querySelector("label")
            : element;
        if (label) {
          if (action === "update") {
            label.style.cursor = "pointer";
            label.title = 'Click to copy "' + name + '"';
            if (!label.__ppBound) {
              label.__ppBound = true;
              label.addEventListener(
                "click",
                function (event) {
                  event.preventDefault();
                  event.stopPropagation();
                  try {
                    navigator.clipboard.writeText(name);
                  } catch (e) {
                    /* clipboard unavailable */
                  }
                },
                true
              );
            }
          } else {
            label.style.cursor = "";
            label.removeAttribute("title");
            label.__ppBound = false;
          }
        }
      } catch (e) {
        /* ignore */
      }
    });
    return {
      message: action === "rollback" ? "Logical name labels removed." : "Logical names appended; click a label to copy.",
      level: "success"
    };
  });

})(window.PPMain);
