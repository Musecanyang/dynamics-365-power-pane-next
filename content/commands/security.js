/**
 * Dynamics 365 Power Pane Next - command handlers: security.
 *
 * User access data + assignments: search users, role check reports and the role / team / business-unit reads and writes.
 *
 * Every handler registers via PPmain.register; cross-command reads go
 * through PPmain.get(name). See content/main-world.js for the loading
 * order, the postMessage contract and the response shapes.
 */
(function (PPmain) {
  "use strict";

  const { webApiGet, webApiGetAll, webPatch, webAssoc, webDisassoc, MIN_USER_SEARCH_LENGTH, ROLE_CHECK_USER_LIMIT } = PPmain;


  PPmain.register("roleCheck", async function (args) {
    const raw = ((args && args.query) || "").trim();
    if (!raw) throw new Error("Enter one or more names or emails (separate with commas or new lines).");
    const terms = raw
      .split(/[,;\n\r]+/)
      .map(function (s) {
        return s.trim();
      })
      .filter(function (s) {
        return s.length >= 2;
      });
    if (!terms.length) throw new Error("Enter at least 2 characters per name/email.");
    const usersByKey = {};
    for (let t = 0; t < terms.length; t++) {
      try {
        const found = await PPmain.get("searchUsers")({ query: terms[t] });
        (found && found.users ? found.users : []).forEach(function (user) {
          if (!usersByKey[user.systemuserid]) usersByKey[user.systemuserid] = user;
        });
      } catch (e) {
        /* ignore per-term failures */
      }
    }
    const users = Object.keys(usersByKey)
      .map(function (key) {
        return usersByKey[key];
      })
      .slice(0, ROLE_CHECK_USER_LIMIT);
    if (!users.length) throw new Error("No users found for: " + terms.join(", "));
    const rows = [];
    for (let i = 0; i < users.length; i++) {
      const user = users[i];
      const row = { name: user.fullname || "", email: user.internalemailaddress || "", bu: "", roles: "", teams: "" };
      try {
        const data = await webApiGet(
          "systemusers(" +
            user.systemuserid +
            ")?$select=fullname,internalemailaddress,domainname" +
            "&$expand=businessunitid($select=name),systemuserroles_association($select=name),teammembership_association($select=name)"
        );
        row.name = data.fullname || row.name;
        row.email = data.internalemailaddress || row.email;
        row.bu = (data.businessunitid && data.businessunitid.name) || "";
        row.roles = (data.systemuserroles_association || [])
          .map(function (role) {
            return role.name;
          })
          .join(", ");
        row.teams = (data.teammembership_association || [])
          .map(function (team) {
            return team.name;
          })
          .join(", ");
      } catch (e) {
        row.roles = "(read failed: " + e.message + ")";
      }
      rows.push(row);
    }
    return {
      table: {
        title: "Role Check",
        description: rows.length + " user(s)",
        searchable: true,
        columns: [
          { key: "name", label: "Name" },
          { key: "email", label: "Email" },
          { key: "bu", label: "Business Unit" },
          { key: "roles", label: "Roles" },
          { key: "teams", label: "Teams" }
        ],
        rows: rows
      }
    };
  });
  /**
   * Search system users by name / email / domain.
   * @param {{query: string}} args
   * @returns {Promise<{users: Array}>}
   */
  PPmain.register("searchUsers", async function (args) {
    const query = ((args && args.query) || "").trim();
    if (query.length < MIN_USER_SEARCH_LENGTH) return { users: [] };
    const safe = query.replace(/'/g, "''");
    const filter =
      "isdisabled eq false and (contains(fullname,'" +
      safe +
      "') or contains(internalemailaddress,'" +
      safe +
      "') or contains(domainname,'" +
      safe +
      "'))";
    const data = await webApiGet(
      "systemusers?$select=systemuserid,fullname,internalemailaddress,domainname,azureactivedirectoryobjectid,isdisabled" +
        "&$filter=" +
        encodeURIComponent(filter) +
        "&$orderby=fullname asc&$top=25"
    );
    return { users: data.value || [] };
  });
  /** Return the current user's and organization ids (diagnostics helper). */
  PPmain.register("whoAmI", async function () {
    const data = await webApiGet("WhoAmI");
    return { userId: data.UserId, organizationId: data.OrganizationId };
  });
  /**
   * Fetch a single user's access profile (roles, teams, business unit).
   * @param {{userid: string}} args
   * @returns {Promise<{user: Object, businessUnit: Object|null, roles: Array, teams: Array}>}
   */
  PPmain.register("getUserAccess", async function (args) {
    const id = String((args && args.userid) || "").replace(/[{}]/g, "");
    if (!id) throw new Error("Missing user id.");
    const data = await webApiGet(
      "systemusers(" +
        id +
        ")?$select=fullname,internalemailaddress,domainname,isdisabled" +
        "&$expand=businessunitid($select=businessunitid,name),systemuserroles_association($select=roleid,name),teammembership_association($select=teamid,name)"
    );
    return {
      user: { id: id, name: data.fullname, email: data.internalemailaddress, domain: data.domainname, disabled: data.isdisabled },
      businessUnit: data.businessunitid
        ? { id: data.businessunitid.businessunitid, name: data.businessunitid.name }
        : null,
      roles: (data.systemuserroles_association || []).map(function (role) {
        return { id: role.roleid, name: role.name };
      }),
      teams: (data.teammembership_association || []).map(function (team) {
        return { id: team.teamid, name: team.name };
      })
    };
  });
  /** List all security roles with their business unit id. */
  PPmain.register("getAllRoles", async function () {
    const items = await webApiGetAll("roles?$select=roleid,name,_businessunitid_value&$orderby=name");
    return {
      items: items.map(function (role) {
        return { id: role.roleid, name: role.name, buId: role._businessunitid_value || "" };
      })
    };
  });
  /** List all owner teams (teamtype eq 0). */
  PPmain.register("getAllTeams", async function () {
    const items = await webApiGetAll("teams?$select=teamid,name,teamtype&$filter=teamtype eq 0&$orderby=name");
    return {
      items: items.map(function (team) {
        return { id: team.teamid, name: team.name };
      })
    };
  });
  /** List all business units. */
  PPmain.register("getBusinessUnits", async function () {
    const items = await webApiGetAll("businessunits?$select=businessunitid,name&$orderby=name");
    return {
      items: items.map(function (businessUnit) {
        return { id: businessUnit.businessunitid, name: businessUnit.name };
      })
    };
  });
  /** Change a user's business unit. */
  PPmain.register("setBusinessUnit", async function (args) {
    const userId = String(args.userid).replace(/[{}]/g, "");
    const buId = String(args.buid).replace(/[{}]/g, "");
    await webPatch("systemusers(" + userId + ")", { "businessunitid@odata.bind": "/businessunits(" + buId + ")" });
    return { message: "Business unit updated.", level: "success" };
  });
  /** Assign a security role to a user. */
  PPmain.register("assignRole", async function (args) {
    await webAssoc(args.userid, "systemuserroles_association", "roles", args.roleid);
    return { message: "Role assigned.", level: "success" };
  });
  /** Remove a security role from a user. */
  PPmain.register("removeRole", async function (args) {
    await webDisassoc(args.userid, "systemuserroles_association", "roles", args.roleid);
    return { message: "Role removed.", level: "success" };
  });
  /** Add a user to a team. */
  PPmain.register("addTeam", async function (args) {
    await webAssoc(args.userid, "teammembership_association", "teams", args.teamid);
    return { message: "Added to team.", level: "success" };
  });
  /** Remove a user from a team. */
  PPmain.register("removeTeam", async function (args) {
    await webDisassoc(args.userid, "teammembership_association", "teams", args.teamid);
    return { message: "Removed from team.", level: "success" };
  });

})(window.PPMain);
