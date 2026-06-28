import { runSF, FriendlyError } from "../utils/sf.js"

export const packageTools = [
  {
    name: "build_package_xml",
    description:
      "Generate a valid package.xml manifest from a simple list of components. " +
      "Handles friendly type names (e.g. 'flow', 'lwc', 'apex class'), wildcards ('*'), " +
      "XML escaping, de-duplication, and sorting. Returns the manifest plus ready-to-run " +
      "retrieve/deploy commands. Example component: { type: 'Flow', members: ['My_Flow'] }.",
    inputSchema: {
      type: "object",
      properties: {
        components: {
          type: "array",
          description: "List of metadata groups to include in the manifest.",
          items: {
            type: "object",
            properties: {
              type: {
                type: "string",
                description:
                  "Metadata type. Accepts API names (Flow, ApexClass, CustomObject) or friendly aliases (flow, class, object, lwc, aura, field, trigger, layout, permission set, validation rule, etc.).",
              },
              members: {
                type: "array",
                items: { type: "string" },
                description:
                  "Component API names (fullNames). Use ['*'] for a wildcard (all of that type). " +
                  "For fields/record types use 'Object.Member' form, e.g. 'Account.My_Field__c'.",
              },
            },
            required: ["type", "members"],
          },
        },
        api_version: {
          type: "string",
          description: "Optional API version (e.g. '59.0'). Defaults to the org's version if target_org is given, else 59.0.",
        },
        target_org: {
          type: "string",
          description: "Optional: org alias used only to default the API version.",
        },
      },
      required: ["components"],
    },
  },
  {
    name: "list_metadata_components",
    description:
      "List the exact component fullNames of a metadata type in the org — use this to get the " +
      "precise names to put in a package.xml. Example: type 'Flow' returns every flow's API name.",
    inputSchema: {
      type: "object",
      properties: {
        metadata_type: { type: "string", description: "Metadata type or alias, e.g. Flow, ApexClass, lwc" },
        target_org: { type: "string", description: "Optional: org alias" },
        folder: {
          type: "string",
          description: "Required for folder-based types (Report, Dashboard, Document, EmailTemplate): the folder name.",
        },
      },
      required: ["metadata_type"],
    },
  },
]

// Friendly aliases -> official metadata API type names.
const TYPE_ALIASES = {
  flow: "Flow",
  flows: "Flow",
  apexclass: "ApexClass",
  class: "ApexClass",
  classes: "ApexClass",
  apextrigger: "ApexTrigger",
  trigger: "ApexTrigger",
  triggers: "ApexTrigger",
  apexpage: "ApexPage",
  visualforcepage: "ApexPage",
  vf: "ApexPage",
  apexcomponent: "ApexComponent",
  customobject: "CustomObject",
  object: "CustomObject",
  objects: "CustomObject",
  customfield: "CustomField",
  field: "CustomField",
  fields: "CustomField",
  recordtype: "RecordType",
  validationrule: "ValidationRule",
  layout: "Layout",
  layouts: "Layout",
  flexipage: "FlexiPage",
  lightningpage: "FlexiPage",
  lightningcomponentbundle: "LightningComponentBundle",
  lwc: "LightningComponentBundle",
  auradefinitionbundle: "AuraDefinitionBundle",
  aura: "AuraDefinitionBundle",
  staticresource: "StaticResource",
  customtab: "CustomTab",
  tab: "CustomTab",
  customapplication: "CustomApplication",
  app: "CustomApplication",
  permissionset: "PermissionSet",
  permissionsets: "PermissionSet",
  "permission set": "PermissionSet",
  profile: "Profile",
  profiles: "Profile",
  // Individual labels use the SINGULAR type 'CustomLabel'.
  customlabel: "CustomLabel",
  "custom label": "CustomLabel",
  label: "CustomLabel",
  labels: "CustomLabel",
  // The plural 'CustomLabels' is the single container file holding ALL labels.
  customlabels: "CustomLabels",
  "custom labels": "CustomLabels",
  emailtemplate: "EmailTemplate",
  report: "Report",
  dashboard: "Dashboard",
  document: "Document",
  quickaction: "QuickAction",
  action: "QuickAction",
  workflow: "Workflow",
  approvalprocess: "ApprovalProcess",
  connectedapp: "ConnectedApp",
  namedcredential: "NamedCredential",
  remotesitesetting: "RemoteSiteSetting",
  remotesite: "RemoteSiteSetting",
  custommetadata: "CustomMetadata",
  customsetting: "CustomObject",
  group: "Group",
  role: "Role",
  queue: "Queue",
}

const FOLDER_BASED = new Set(["Report", "Dashboard", "Document", "EmailTemplate"])
const DEFAULT_API = "59.0"

// Types whose members must be COMPOUND (parent + child). The wrong separator
// (or a missing one) is the #1 cause of failed deployments to higher orgs.
const MEMBER_FORMAT = {
  // Dot-separated: Object.Member
  CustomField: { sep: ".", shape: "Object.Field", example: "Account.Region__c" },
  ValidationRule: { sep: ".", shape: "Object.Rule", example: "Account.Require_Region" },
  RecordType: { sep: ".", shape: "Object.RecordType", example: "Account.Partner" },
  BusinessProcess: { sep: ".", shape: "Object.Process", example: "Case.Support_Process" },
  CompactLayout: { sep: ".", shape: "Object.CompactLayout", example: "Account.Summary" },
  WebLink: { sep: ".", shape: "Object.Button", example: "Account.View_Map" },
  FieldSet: { sep: ".", shape: "Object.FieldSet", example: "Account.Key_Fields" },
  ListView: { sep: ".", shape: "Object.ListView", example: "Account.My_Accounts" },
  SharingReason: { sep: ".", shape: "Object.Reason", example: "Job__c.Manager_Access" },
  // Hyphen-separated: Object-Layout Name (the label may contain spaces)
  Layout: { sep: "-", shape: "Object-Layout Name", example: "Account-Account Layout" },
}

// Validate members against a type's required compound format. Returns an array
// of human-readable warnings (never throws — we still emit the manifest).
function checkMemberFormat(type, members) {
  const rule = MEMBER_FORMAT[type]
  if (!rule) return []
  const warnings = []
  for (const m of members) {
    if (m === "*") continue
    if (!m.includes(rule.sep)) {
      warnings.push(
        `${type} member '${m}' looks wrong — it must use '${rule.shape}' ` +
          `(separator '${rule.sep}'), e.g. '${rule.example}'. As written, the deploy will fail.`
      )
    }
  }
  return warnings
}

function normalizeType(raw) {
  if (!raw || typeof raw !== "string") {
    throw new FriendlyError("Each component needs a 'type'.")
  }
  const key = raw.trim().toLowerCase()
  if (TYPE_ALIASES[key]) return TYPE_ALIASES[key]
  // Already a valid-looking API name (PascalCase, letters only) — pass through.
  if (/^[A-Za-z][A-Za-z0-9]*$/.test(raw.trim())) return raw.trim()
  throw new FriendlyError(
    `'${raw}' is not a recognized metadata type. Use an API name like 'Flow' or 'ApexClass', ` +
      "or a known alias (flow, class, object, field, lwc, aura, layout, permission set, ...)."
  )
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
}

function normalizeApiVersion(v) {
  const n = Number(v)
  if (!Number.isFinite(n)) return null
  return n.toFixed(1) // 59 -> "59.0"
}

function orgArgs(target_org) {
  return target_org ? ["--target-org", String(target_org)] : []
}

export async function handlePackage(toolName, args) {
  if (toolName === "build_package_xml") {
    if (!Array.isArray(args.components) || args.components.length === 0) {
      throw new FriendlyError("Provide a non-empty 'components' array, e.g. [{ type: 'Flow', members: ['My_Flow'] }].")
    }

    // Merge components of the same type, normalize, dedupe, sort.
    const byType = new Map()
    const aliasNotes = []
    for (const comp of args.components) {
      const type = normalizeType(comp.type)
      if (type !== comp.type) aliasNotes.push(`'${comp.type}' → ${type}`)
      let members = comp.members
      if (!Array.isArray(members) || members.length === 0) {
        throw new FriendlyError(`Component '${type}' needs a non-empty 'members' array (use ['*'] for all).`)
      }
      const existing = byType.get(type) || new Set()
      for (const m of members) {
        if (typeof m !== "string" || m.trim() === "") continue
        existing.add(m.trim())
      }
      byType.set(type, existing)
    }

    // Resolve API version.
    let apiVersion = normalizeApiVersion(args.api_version)
    if (!apiVersion && args.target_org) {
      try {
        const org = await runSF(["org", "display", ...orgArgs(args.target_org)])
        apiVersion = normalizeApiVersion(org.apiVersion) || DEFAULT_API
      } catch {
        apiVersion = DEFAULT_API
      }
    }
    if (!apiVersion) apiVersion = DEFAULT_API

    // Build XML. Sort types and members for clean, diff-friendly output.
    const types = [...byType.keys()].sort()
    const blocks = []
    const summary = []
    for (const type of types) {
      const members = [...byType.get(type)].sort((a, b) => {
        if (a === "*") return -1
        if (b === "*") return 1
        return a.localeCompare(b)
      })
      const hasWildcard = members.includes("*")
      const memberLines = members.map((m) => `        <members>${escapeXml(m)}</members>`).join("\n")
      blocks.push(`    <types>\n${memberLines}\n        <name>${type}</name>\n    </types>`)
      summary.push({ type, memberCount: members.length, wildcard: hasWildcard })
    }

    const packageXml =
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<Package xmlns="http://soap.sforce.com/2006/04/metadata">\n` +
      blocks.join("\n") +
      `\n    <version>${apiVersion}</version>\n` +
      `</Package>\n`

    const warnings = []
    for (const type of types) {
      const members = [...byType.get(type)]
      // Compound-name validation (CustomField dot, Layout hyphen, etc.)
      warnings.push(...checkMemberFormat(type, members))
      // Folder-based wildcard caveat
      if (FOLDER_BASED.has(type) && members.includes("*")) {
        warnings.push(
          `${type} is folder-based; a top-level '*' does not retrieve its contents — list folders/members explicitly or use list_metadata_components.`
        )
      }
      // Common label mix-up: plural container vs singular individual labels
      if (type === "CustomLabels" && !members.includes("CustomLabels") && !members.includes("*")) {
        warnings.push(
          "CustomLabels is the single container file for ALL labels (member should be 'CustomLabels' or '*'). " +
            "To deploy specific labels by name, use type 'CustomLabel' (singular) instead."
        )
      }
    }

    return {
      packageXml,
      apiVersion,
      summary,
      ...(aliasNotes.length && { normalizedTypes: aliasNotes }),
      ...(warnings.length && { warnings }),
      usage: {
        saveAs: "manifest/package.xml",
        retrieve: "sf project retrieve start --manifest manifest/package.xml" + (args.target_org ? ` --target-org ${args.target_org}` : ""),
        deploy: "sf project deploy start --manifest manifest/package.xml" + (args.target_org ? ` --target-org ${args.target_org}` : ""),
        validateOnly: "sf project deploy validate --manifest manifest/package.xml" + (args.target_org ? ` --target-org ${args.target_org}` : ""),
      },
    }
  }

  if (toolName === "list_metadata_components") {
    const type = normalizeType(args.metadata_type)
    if (FOLDER_BASED.has(type) && !args.folder) {
      throw new FriendlyError(
        `${type} is folder-based — pass a 'folder' to list its components (e.g. folder: 'Unfiled Public Reports').`
      )
    }
    const cmd = ["org", "list", "metadata", "--metadata-type", type, ...orgArgs(args.target_org)]
    if (args.folder) cmd.push("--folder", String(args.folder))

    const result = await runSF(cmd)
    const arr = Array.isArray(result) ? result : []
    const members = arr
      .map((m) => m.fullName)
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b))

    return {
      metadataType: type,
      count: members.length,
      ...(members.length === 0 && {
        note: `No '${type}' components found in this org.`,
      }),
      members,
      tip: `Pass these into build_package_xml as { type: '${type}', members: [...] }.`,
    }
  }
}
