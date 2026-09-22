/**
 * Dynamics 365 Power Pane Next - feature: User Permissions (view / edit).
 *
 * Search a user, inspect their roles / teams / business unit, change the
 * business unit (stand-alone apply), stage role & team changes and copy the
 * whole permission set from another user (strictly ordered: BU first, then
 * roles / teams under the new BU).
 *
 * Shared surface: window.PPPane (content/core.js). Globals: window.PPUtil.
 * Loaded by the manifest after content/core.js and before content/boot.js.
 */
(function (Pane) {
  "use strict";
  const matches = window.PPUtil.matches;
  const {
    send,
    openModal,
    toast,
    registerLocal,
    MIN_USER_SEARCH_LENGTH,
    USER_SEARCH_DEBOUNCE_MS,
    USER_SEARCH_RESULT_LIMIT,
    TEAM_LIST_LIMIT
  } = Pane;
  /* ------------------------------------------------------------------ *
   * Feature: user permissions
   * ------------------------------------------------------------------ */

   // Role / team filter notes: single term matches fuzzily ("contains");
   // multiple comma-separated terms must equal the whole name (PPUtil.matches).

  function openUserAccess() {
    openModal(
      function (box, close) {
        const heading = document.createElement("h3");
        heading.textContent = "User Permissions";
        box.appendChild(heading);
        const description = document.createElement("p");
        description.className = "desc";
        description.textContent = "View and modify a user's roles, teams and business unit. Changes apply immediately.";
        box.appendChild(description);

        const search = document.createElement("input");
        search.className = "filter";
        search.placeholder = "Search user by name or email (min 2 chars)";
        box.appendChild(search);
        const results = document.createElement("div");
        box.appendChild(results);
        const detail = document.createElement("div");
        box.appendChild(detail);

        let allRoles = [];
        let allTeams = [];
        let allBusinessUnits = [];

        const metaReady = Promise.all([
          send("getAllRoles", {}),
          send("getAllTeams", {}),
          send("getBusinessUnits", {})
        ])
          .then(function (data) {
            allRoles = (data[0] && data[0].items) || [];
            allTeams = (data[1] && data[1].items) || [];
            allBusinessUnits = (data[2] && data[2].items) || [];
          })
          .catch(function (error) {
            /* metadata unavailable; the editor degrades gracefully */
            window.PPUtil.debugLog("userAccess.metaLoad", error);
          });

        /**
         * Load a user's full access profile and render the editor.
         * Already-open results and stale bindings are replaced wholesale;
         * the shared metadata preload (allRoles / allTeams / business units)
         * is awaited in the same step so the editor renders complete.
         * @param {{systemuserid?: string, id?: string, fullname?: string,
         *     internalemailaddress?: string}} user - both a search row
         *     (`systemuserid`) and a saved access profile (`id`) are accepted,
         *     so save flows can re-render the same user.
         */
        function loadUser(user) {
          // Accept both user rows from search (`systemuserid`) and access
          // profiles (`id`) so save flows can re-render the same user.
          const userId = String(user.systemuserid || user.id || "").replace(/[{}]/g, "");
          detail.textContent = "";
          const loading = document.createElement("div");
          loading.className = "muted";
          loading.textContent = "Loading access...";
          detail.appendChild(loading);
          Promise.all([send("getUserAccess", { userid: userId }), metaReady])
            .then(function (data) {
              detail.textContent = "";
              renderUser(data[0]);
            })
            .catch(function (err) {
              detail.textContent = "";
              const error = document.createElement("div");
              error.className = "empty";
              error.textContent = err.message;
              detail.appendChild(error);
            });
        }

        /**
         * Build the full permissions editor for an access profile fetched by
         * loadUser(): header, business unit (stand-alone apply), roles and
         * teams columns, paged pickers and the save / copy-from footer.
         * @param {ReturnType<typeof getUserAccessShape>} access - the
         *     `{ user, businessUnit, roles, teams }` profile from
         *     `getUserAccess` (see content/main-world.js for the shape).
         */
        function renderUser(access) {
          const roleNameMap = {};
          allRoles.forEach(function (role) {
            roleNameMap[role.id.toLowerCase()] = role.name;
          });
          access.roles.forEach(function (role) {
            roleNameMap[role.id.toLowerCase()] = role.name;
          });
          const teamNameMap = {};
          allTeams.forEach(function (team) {
            teamNameMap[team.id.toLowerCase()] = team.name;
          });
          access.teams.forEach(function (team) {
            teamNameMap[team.id.toLowerCase()] = team.name;
          });

          const originalRoles = {};
          access.roles.forEach(function (role) {
            originalRoles[role.id.toLowerCase()] = true;
          });
          const currentRoles = Object.assign({}, originalRoles);
          const originalTeams = {};
          access.teams.forEach(function (team) {
            originalTeams[team.id.toLowerCase()] = true;
          });
          const currentTeams = Object.assign({}, originalTeams);
          const originalBusinessUnit = access.businessUnit ? access.businessUnit.id.toLowerCase() : "";
          let currentBusinessUnit = originalBusinessUnit;

          // Header: user name + email.
          const head = document.createElement("div");
          head.className = "ua-head";
          const nameEl = document.createElement("b");
          nameEl.textContent = access.user.name;
          const emailEl = document.createElement("div");
          emailEl.className = "muted";
          emailEl.textContent = access.user.email || "";
          head.appendChild(nameEl);
          head.appendChild(emailEl);
          detail.appendChild(head);

          // Business unit selector. Changing the BU is a standalone, immediate
          // operation: apply it right away so the role list reloads with the
          // roles of the new business unit (they are not part of the overall
          // save).
          const buRow = document.createElement("div");
          buRow.className = "ua-row";
          const buLabel = document.createElement("div");
          buLabel.className = "ua-k";
          buLabel.textContent = "Business Unit";
          const buValue = document.createElement("div");
          buValue.className = "ua-v";
          const buSelect = document.createElement("select");
          allBusinessUnits.forEach(function (businessUnit) {
            const option = document.createElement("option");
            option.value = businessUnit.id;
            option.textContent = businessUnit.name;
            if (businessUnit.id.toLowerCase() === currentBusinessUnit) option.selected = true;
            buSelect.appendChild(option);
          });
          const buApply = document.createElement("button");
          buApply.className = "mini";
          buApply.textContent = "Change BU";
          buApply.disabled = true;
          function refreshBuControls() {
            const pendingBu = currentBusinessUnit !== originalBusinessUnit;
            buApply.disabled = !pendingBu || buApply.classList.contains("running");
          }
          buSelect.addEventListener("change", function () {
            currentBusinessUnit = buSelect.value.toLowerCase();
            refreshBuControls();
            updateDirty();
          });
          buApply.addEventListener("click", function () {
            if (currentBusinessUnit === originalBusinessUnit) return;
            const targetName = buSelect.options[buSelect.selectedIndex].textContent;
            if (
              !window.confirm(
                'Change the business unit of "' +
                  access.user.name +
                  '" to "' +
                  targetName +
                  '"?\nThe role / team lists reload for the new business unit afterwards.'
              )
            ) {
              return;
            }
            buApply.classList.add("running");
            buApply.textContent = "Changing...";
            buApply.disabled = true;
            buSelect.disabled = true;
            send("setBusinessUnit", { userid: access.user.id, buid: currentBusinessUnit })
              .then(function () {
                toast("Business unit changed.", "success");
                return loadUser({
                  systemuserid: access.user.id,
                  fullname: access.user.name,
                  internalemailaddress: access.user.email
                });
              })
              .catch(function (err) {
                toast(err.message, "error");
                buApply.classList.remove("running");
                buApply.textContent = "Change BU";
                buApply.disabled = false;
                buSelect.disabled = false;
              });
          });
          buValue.appendChild(buSelect);
          buValue.appendChild(buApply);
          buRow.appendChild(buLabel);
          buRow.appendChild(buValue);
          detail.appendChild(buRow);

          // Roles / teams editors side by side; the sticky footer below
          // covers both columns.
          const uaColumns = document.createElement("div");
          uaColumns.className = "ua-cols";
          const rolesColumn = document.createElement("div");
          rolesColumn.className = "ua-col";
          const teamsColumn = document.createElement("div");
          teamsColumn.className = "ua-col";
          uaColumns.appendChild(rolesColumn);
          uaColumns.appendChild(teamsColumn);
          detail.appendChild(uaColumns);

          // Assigned roles chips.
          const assignedRolesTitle = document.createElement("div");
          assignedRolesTitle.className = "sect";
          rolesColumn.appendChild(assignedRolesTitle);
          const assignedRolesChips = document.createElement("div");
          assignedRolesChips.className = "ua-chips";
          rolesColumn.appendChild(assignedRolesChips);
          function renderAssignedRoles() {
            assignedRolesChips.textContent = "";
            const ids = Object.keys(currentRoles);
            assignedRolesTitle.textContent = "Assigned Roles (" + ids.length + ")";
            ids.sort().forEach(function (id) {
              const chip = document.createElement("span");
              chip.className = "chip";
              chip.appendChild(document.createTextNode((roleNameMap[id] || id) + " "));
              const remove = document.createElement("span");
              remove.textContent = "\u00d7";
              remove.style.cssText = "cursor:pointer;opacity:.7";
              remove.addEventListener("click", function () {
                delete currentRoles[id];
                renderAssignedRoles();
                renderRoles();
                updateDirty();
              });
              chip.appendChild(remove);
              assignedRolesChips.appendChild(chip);
            });
            if (!ids.length) {
              const none = document.createElement("span");
              none.className = "muted";
              none.textContent = "None";
              assignedRolesChips.appendChild(none);
            }
          }

          // All roles list with filter.
          const rolesTitle = document.createElement("div");
          rolesTitle.className = "sect";
          rolesTitle.textContent = "All Roles";
          rolesColumn.appendChild(rolesTitle);
          const roleSearch = document.createElement("input");
          roleSearch.className = "filter";
          roleSearch.placeholder = "Filter roles (comma = exact names)";
          rolesColumn.appendChild(roleSearch);
          const rolesList = document.createElement("div");
          rolesList.className = "ua-list";
          rolesColumn.appendChild(rolesList);

          const roleSourceMap = {};
          allRoles
            // Strictly the user's CURRENT business unit: the platform refuses
            // cross-BU role associations outright (HTTP 400 / 0x80041409),
            // so an unknown-buId role is treated as not offered, and there is
            // no "no BU known" permissive mode - the Change BU flow is the
            // only way another BU's roles become pickable.
            .filter(function (role) {
              return !!role.buId && String(role.buId).toLowerCase() === currentBusinessUnit;
            })
            .forEach(function (role) {
              roleSourceMap[role.id.toLowerCase()] = role;
            });
          access.roles.forEach(function (role) {
            if (!roleSourceMap[role.id.toLowerCase()]) roleSourceMap[role.id.toLowerCase()] = role;
          });
          const roleSource = Object.keys(roleSourceMap).map(function (key) {
            return roleSourceMap[key];
          });

          function renderRoles() {
            rolesList.textContent = "";
            roleSource
              .filter(function (role) {
                return matches(role.name, roleSearch.value);
              })
              .sort(function (a, b) {
                return a.name.localeCompare(b.name);
              })
              .forEach(function (role) {
                const label = document.createElement("label");
                label.className = "ua-item";
                const checkbox = document.createElement("input");
                checkbox.type = "checkbox";
                checkbox.checked = !!currentRoles[role.id.toLowerCase()];
                checkbox.addEventListener("change", function () {
                  if (checkbox.checked) currentRoles[role.id.toLowerCase()] = true;
                  else delete currentRoles[role.id.toLowerCase()];
                  renderAssignedRoles();
                  updateDirty();
                });
                label.appendChild(checkbox);
                label.appendChild(document.createTextNode(role.name));
                rolesList.appendChild(label);
              });
          }
          roleSearch.addEventListener("input", renderRoles);

          // Assigned teams chips.
          const assignedTeamsTitle = document.createElement("div");
          assignedTeamsTitle.className = "sect";
          teamsColumn.appendChild(assignedTeamsTitle);
          const assignedTeamsChips = document.createElement("div");
          assignedTeamsChips.className = "ua-chips";
          teamsColumn.appendChild(assignedTeamsChips);
          function renderAssignedTeams() {
            assignedTeamsChips.textContent = "";
            const ids = Object.keys(currentTeams);
            assignedTeamsTitle.textContent = "Teams (" + ids.length + ")";
            ids.sort().forEach(function (id) {
              const chip = document.createElement("span");
              chip.className = "chip";
              chip.appendChild(document.createTextNode((teamNameMap[id] || id) + " "));
              const remove = document.createElement("span");
              remove.textContent = "\u00d7";
              remove.style.cssText = "cursor:pointer;opacity:.7";
              remove.addEventListener("click", function () {
                delete currentTeams[id];
                renderAssignedTeams();
                renderTeams();
                updateDirty();
              });
              chip.appendChild(remove);
              assignedTeamsChips.appendChild(chip);
            });
            if (!ids.length) {
              const none = document.createElement("span");
              none.className = "muted";
              none.textContent = "None";
              assignedTeamsChips.appendChild(none);
            }
          }

          // Team picker (search + add); the section title mirrors the roles
          // column so both list areas start at the same height (alignment).
          const allTeamsTitle = document.createElement("div");
          allTeamsTitle.className = "sect";
          allTeamsTitle.textContent = "All Teams";
          teamsColumn.appendChild(allTeamsTitle);
          const teamSearch = document.createElement("input");
          teamSearch.className = "filter";
          teamSearch.placeholder = "Search teams to add (comma = exact names)";
          teamsColumn.appendChild(teamSearch);
          const teamsList = document.createElement("div");
          teamsList.className = "ua-list";
          teamsColumn.appendChild(teamsList);
          function renderTeams() {
            teamsList.textContent = "";
            allTeams
              .filter(function (team) {
                return !currentTeams[team.id.toLowerCase()];
              })
              .filter(function (team) {
                return matches(team.name, teamSearch.value);
              })
              .sort(function (a, b) {
                return a.name.localeCompare(b.name);
              })
              .slice(0, TEAM_LIST_LIMIT)
              .forEach(function (team) {
                const row = document.createElement("div");
                row.className = "ua-item";
                const name = document.createElement("span");
                name.style.flex = "1";
                name.textContent = team.name;
                const add = document.createElement("button");
                add.className = "mini";
                add.textContent = "Add";
                add.addEventListener("click", function () {
                  currentTeams[team.id.toLowerCase()] = true;
                  teamNameMap[team.id.toLowerCase()] = team.name;
                  renderAssignedTeams();
                  renderTeams();
                  updateDirty();
                });
                row.appendChild(name);
                row.appendChild(add);
                teamsList.appendChild(row);
              });
          }
          teamSearch.addEventListener("input", renderTeams);

          // Save footer with staged diff; pinned to the dialog bottom so it
          // stays reachable without scrolling past the long lists. Close
          // lives here too instead of a lone full-width row below.
          const saveRow = document.createElement("div");
          saveRow.className = "foot split ua-foot";
          detail.appendChild(saveRow);
          const info = document.createElement("span");
          info.className = "muted";
          saveRow.appendChild(info);
          const footerButtons = document.createElement("div");
          footerButtons.className = "actions-buttons";
          const saveButton = document.createElement("button");
          saveButton.className = "primary";
          saveButton.textContent = "Save";
          footerButtons.appendChild(saveButton);
          const copyButton = document.createElement("button");
          copyButton.className = "mini";
          copyButton.textContent = "Copy From User";
          copyButton.addEventListener("click", openCopyDialog);
          footerButtons.appendChild(copyButton);
          const closeButton = document.createElement("button");
          closeButton.textContent = "Close";
          closeButton.addEventListener("click", close);
          footerButtons.appendChild(closeButton);
          saveRow.appendChild(footerButtons);

          function diff() {
            //BU changes apply immediately via "Change BU" and are excluded
            // from the overall save.
            const operations = [];
            Object.keys(currentRoles).forEach(function (id) {
              if (!originalRoles[id]) operations.push({ type: "assignRole", id: id });
            });
            Object.keys(originalRoles).forEach(function (id) {
              if (!currentRoles[id]) operations.push({ type: "removeRole", id: id });
            });
            Object.keys(currentTeams).forEach(function (id) {
              if (!originalTeams[id]) operations.push({ type: "addTeam", id: id });
            });
            Object.keys(originalTeams).forEach(function (id) {
              if (!currentTeams[id]) operations.push({ type: "removeTeam", id: id });
            });
            return operations;
          }

          function updateDirty() {
            const count = diff().length;
            info.textContent = count ? count + " pending change(s)" : "No changes";
            saveButton.disabled = !count;
          }

          saveButton.addEventListener("click", function () {
            const operations = diff();
            if (!operations.length) return;
            saveButton.disabled = true;
            const calls = operations.map(function (operation) {
              if (operation.type === "assignRole") {
                return send("assignRole", { userid: access.user.id, roleid: operation.id });
              }
              if (operation.type === "removeRole") {
                return send("removeRole", { userid: access.user.id, roleid: operation.id });
              }
              if (operation.type === "addTeam") {
                return send("addTeam", { userid: access.user.id, teamid: operation.id });
              }
              if (operation.type === "removeTeam") {
                return send("removeTeam", { userid: access.user.id, teamid: operation.id });
              }
              return Promise.resolve();
            });
            Promise.all(calls)
              .then(function () {
                toast("Saved " + operations.length + " change(s).", "success");
                // Re-render the user's current permissions (and leave the
                // search page) so the latest state is visible right away.
                search.value = "";
                results.textContent = "";
                return loadUser({
                  systemuserid: access.user.id,
                  fullname: access.user.name,
                  internalemailaddress: access.user.email
                });
              })
              .catch(function (err) {
                toast(err.message, "error");
                saveButton.disabled = false;
              });
          });

          /**
           * Copy another user's permissions (business unit, roles, teams)
           * onto this user. Strictly ordered: apply the business unit change
           * first and wait for it, then apply roles / teams derived from the
           * post-change state.
           * @param {Object} sourceUser row from searchUsers
           * @param {function} subClose closes the picker dialog
           */
          async function runCopySequence(sourceUser, subClose) {
            saveButton.disabled = true;
            copyButton.disabled = true;
            info.textContent = "Copying permissions...";
            try {
              const sourceId = String(sourceUser.systemuserid || sourceUser.id || "").replace(/[{}]/g, "");
              const sourceAccess = await send("getUserAccess", { userid: sourceId });
              // Step 1: business unit.
              const before = await send("getUserAccess", { userid: access.user.id });
              const sourceBuId = sourceAccess.businessUnit ? String(sourceAccess.businessUnit.id).toLowerCase() : "";
              const targetBuId = before.businessUnit ? String(before.businessUnit.id).toLowerCase() : "";
              if (sourceBuId && targetBuId !== sourceBuId) {
                await send("setBusinessUnit", { userid: access.user.id, buid: sourceAccess.businessUnit.id });
              }
              // Step 2: re-read rights under the (possibly new) business unit.
              const refreshed = await send("getUserAccess", { userid: access.user.id });
              // Step 3: roles / teams diff against the source profile.
              const targetRoleIds = {};
              refreshed.roles.forEach(function (role) {
                targetRoleIds[role.id.toLowerCase()] = true;
              });
              const targetTeamIds = {};
              refreshed.teams.forEach(function (team) {
                targetTeamIds[team.id.toLowerCase()] = true;
              });
              const calls = [];
              sourceAccess.roles.forEach(function (role) {
                if (!targetRoleIds[String(role.id).toLowerCase()]) {
                  calls.push(send("assignRole", { userid: access.user.id, roleid: role.id }));
                }
              });
              refreshed.roles.forEach(function (role) {
                if (!sourceAccess.roles.some(function (candidate) {
                  return String(candidate.id).toLowerCase() === String(role.id).toLowerCase();
                })) {
                  calls.push(send("removeRole", { userid: access.user.id, roleid: role.id }));
                }
              });
              sourceAccess.teams.forEach(function (team) {
                if (!targetTeamIds[String(team.id).toLowerCase()]) {
                  calls.push(send("addTeam", { userid: access.user.id, teamid: team.id }));
                }
              });
              refreshed.teams.forEach(function (team) {
                if (!sourceAccess.teams.some(function (candidate) {
                  return String(candidate.id).toLowerCase() === String(team.id).toLowerCase();
                })) {
                  calls.push(send("removeTeam", { userid: access.user.id, teamid: team.id }));
                }
              });
              await Promise.all(calls);
              if (subClose) subClose();
              toast(
                "Permissions copied from " + (sourceUser.fullname || sourceUser.name || "user") +
                  " (" + sourceBuId + " business unit, " + calls.length + " change(s)).",
                "success"
              );
              // Show the user's current, post-copy permissions.
              search.value = "";
              results.textContent = "";
              await loadUser({
                systemuserid: access.user.id,
                fullname: access.user.name,
                internalemailaddress: access.user.email
              });
            } catch (err) {
              toast(err.message || String(err), "error");
              saveButton.disabled = false;
              copyButton.disabled = false;
            }
          }

          /** Picker dialog: search the source user to copy permissions from. */
          function openCopyDialog() {
            openModal(function (sub, subClose) {
              const heading = document.createElement("h3");
              heading.textContent = "Copy Permissions From...";
              sub.appendChild(heading);
              const description = document.createElement("p");
              description.className = "desc";
              description.textContent =
                "Copies the selected user's business unit, roles and teams. Applied strictly: business unit first, then roles / teams against the new business unit.";
              sub.appendChild(description);
              const copySearch = document.createElement("input");
              copySearch.className = "filter";
              copySearch.placeholder = "Search user by name or email (min 2 chars)";
              sub.appendChild(copySearch);
              const copyResults = document.createElement("div");
              sub.appendChild(copyResults);
              let copyTimer = null;
              copySearch.addEventListener("input", function () {
                clearTimeout(copyTimer);
                const query = copySearch.value.trim();
                if (query.length < MIN_USER_SEARCH_LENGTH) {
                  copyResults.textContent = "";
                  return;
                }
                copyTimer = setTimeout(function () {
                  send("searchUsers", { query: query })
                    .then(function (response) {
                      copyResults.textContent = "";
                      ((response && response.users) || []).slice(0, USER_SEARCH_RESULT_LIMIT).forEach(function (user) {
                        copyResults.appendChild(
                          window.PPUtil.userRow(user, [
                            {
                              label: "Copy",
                              className: "mini primary",
                              onClick: function () {
                                if (
                                  !window.confirm(
                                    'Copy ALL permissions (business unit, roles, teams) from "' +
                                      (user.fullname || "(no name)") +
                                    '" onto "' + access.user.name + '"?\n\nSequence: BU first, then roles / teams under the new BU.'
                                  )
                                ) {
                                  return;
                                }
                                copyResults.textContent = "";
                                runCopySequence(user, subClose);
                              }
                            }
                          ])
                        );
                      });
                    })
                    .catch(function (error) {
                      /* search failed; leave results empty */
                      window.PPUtil.debugLog("userAccess.copySearch", error);
                    });
                }, USER_SEARCH_DEBOUNCE_MS);
              });
              const footEl = document.createElement("div");
              footEl.className = "foot";
              const cancelBtn = document.createElement("button");
              cancelBtn.textContent = "Close";
              cancelBtn.addEventListener("click", subClose);
              footEl.appendChild(cancelBtn);
              sub.appendChild(footEl);
            }, { pinned: true });
          }

          renderAssignedRoles();
          renderRoles();
          renderAssignedTeams();
          renderTeams();
          updateDirty();
        }

        let timer = null;
        search.addEventListener("input", function () {
          clearTimeout(timer);
          const query = search.value.trim();
          if (query.length < MIN_USER_SEARCH_LENGTH) {
            results.textContent = "";
            return;
          }
          timer = setTimeout(function () {
            send("searchUsers", { query: query })
              .then(function (response) {
                results.textContent = "";
                ((response && response.users) || []).slice(0, USER_SEARCH_RESULT_LIMIT).forEach(function (user) {
                  results.appendChild(
                    window.PPUtil.userRow(user, [
                      {
                        label: "Open",
                        className: "mini primary",
                        onClick: function () {
                          results.textContent = "";
                          loadUser(user);
                        }
                      }
                    ])
                  );
                });
              })
              .catch(function (error) {
                /* search failed; leave results empty */
                window.PPUtil.debugLog("userAccess.userSearch", error);
              });
          }, USER_SEARCH_DEBOUNCE_MS);
        });
      },
      { wide: true, fixedWidth: true }
    );
  }

  registerLocal("userAccess", openUserAccess);

})(window.PPPane);
