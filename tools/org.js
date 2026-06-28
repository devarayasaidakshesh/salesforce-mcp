import { runSF } from "../utils/sf.js"

export const orgTools = [
  {
    name: "org_info",
    description:
      "Get details about a connected Salesforce org — username, instance URL, org ID, connection status",
    inputSchema: {
      type: "object",
      properties: {
        target_org: { type: "string", description: "Optional: alias of the org. Uses default org if not provided." },
      },
    },
  },
  {
    name: "org_limits",
    description:
      "Check API usage limits and remaining capacity for the org. Highlights any limit above 80% used.",
    inputSchema: {
      type: "object",
      properties: { target_org: { type: "string", description: "Optional: alias of the org" } },
    },
  },
  {
    name: "list_orgs",
    description: "List all Salesforce orgs authenticated with the Salesforce CLI on this machine",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "current_user",
    description: "Get details about the currently connected Salesforce user — name, email, profile, role",
    inputSchema: {
      type: "object",
      properties: { target_org: { type: "string", description: "Optional: alias of the org" } },
    },
  },
]

function orgArgs(target_org) {
  return target_org ? ["--target-org", String(target_org)] : []
}

export async function handleOrg(toolName, args) {
  if (toolName === "org_info") {
    const r = await runSF(["org", "display", ...orgArgs(args.target_org)])
    return {
      username: r.username,
      orgId: r.id,
      instanceUrl: r.instanceUrl,
      alias: r.alias,
      connectedStatus: r.connectedStatus,
      apiVersion: r.apiVersion,
      expirationDate: r.expirationDate,
    }
  }

  if (toolName === "org_limits") {
    const r = await runSF(["org", "list", "limits", ...orgArgs(args.target_org)])
    const arr = Array.isArray(r) ? r : []
    // sf returns each limit as { name, max, remaining }. used = max - remaining.
    const limits = arr.map((l) => {
      const max = num(l.max)
      const remaining = num(l.remaining)
      const used = max != null && remaining != null ? max - remaining : null
      const percentUsed = max && max > 0 && used != null ? Math.round((used / max) * 100) : 0
      return { name: l.name, used, total: max, remaining, percentUsed }
    })
    const critical = limits.filter((l) => l.percentUsed >= 80)
    return {
      totalLimits: limits.length,
      criticalLimits: critical,
      ...(critical.length > 0 && {
        warning: `${critical.length} limit(s) are above 80% usage — review before bulk operations or deployments.`,
      }),
      allLimits: limits,
    }
  }

  if (toolName === "list_orgs") {
    const r = await runSF(["org", "list"])
    // Aggregate every category the CLI may return.
    const buckets = ["scratchOrgs", "nonScratchOrgs", "sandboxes", "devHubs", "other"]
    const seen = new Set()
    const orgs = []
    for (const b of buckets) {
      for (const o of r[b] || []) {
        const key = o.orgId || o.username
        if (key && seen.has(key)) continue
        if (key) seen.add(key)
        orgs.push({
          alias: o.alias,
          username: o.username,
          orgId: o.orgId,
          instanceUrl: o.instanceUrl,
          isDefault: o.isDefaultUsername || false,
          connectedStatus: o.connectedStatus,
          category: b,
        })
      }
    }
    return {
      count: orgs.length,
      ...(orgs.length === 0 && {
        hint: "No orgs are authenticated. Run:  sf org login web --alias myorg",
      }),
      orgs,
    }
  }

  if (toolName === "current_user") {
    const orgInfo = await runSF(["org", "display", ...orgArgs(args.target_org)])
    const username = orgInfo.username
    const r = await runSF([
      "data",
      "query",
      "--query",
      `SELECT Id, Name, Email, Profile.Name, UserRole.Name, IsActive FROM User WHERE Username = '${username}' LIMIT 1`,
      ...orgArgs(args.target_org),
    ])
    const u = (r.records || [])[0]
    if (!u) return { username, note: "Connected, but could not load the User record (limited permissions?)." }
    return {
      id: u.Id,
      name: u.Name,
      email: u.Email,
      profile: u.Profile && u.Profile.Name,
      role: u.UserRole && u.UserRole.Name,
      isActive: u.IsActive,
      username,
    }
  }
}

function num(v) {
  if (v === null || v === undefined) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
