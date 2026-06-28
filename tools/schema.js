import { runSF, FriendlyError } from "../utils/sf.js"

export const schemaTools = [
  {
    name: "describe_object",
    description:
      "Get full schema details of a Salesforce object — all fields, types, labels, picklist values, and relationships",
    inputSchema: {
      type: "object",
      properties: {
        object_name: {
          type: "string",
          description: "API name of the object. Example: Account, Contact, Opportunity, My_Object__c",
        },
        target_org: { type: "string", description: "Optional: alias of the org to query" },
        fields_only: {
          type: "boolean",
          description: "Optional: if true, return a compact field list only (recommended for large objects)",
        },
      },
      required: ["object_name"],
    },
  },
  {
    name: "list_objects",
    description: "List all available Salesforce objects in the org — both standard and custom",
    inputSchema: {
      type: "object",
      properties: {
        target_org: { type: "string", description: "Optional: alias of the org to query" },
        filter: { type: "string", description: "Optional: case-insensitive substring filter on object name" },
      },
    },
  },
  {
    name: "find_field",
    description: "Search for a field across a Salesforce object by API name or label",
    inputSchema: {
      type: "object",
      properties: {
        object_name: { type: "string", description: "API name of the object" },
        field_search: { type: "string", description: "Field name or label to search for" },
        target_org: { type: "string", description: "Optional: alias of the org to query" },
      },
      required: ["object_name", "field_search"],
    },
  },
]

function orgArgs(target_org) {
  return target_org ? ["--target-org", String(target_org)] : []
}

// Salesforce object API names are alphanumeric + underscores only.
// Reject anything else up front with a clear message.
function validateObjectName(name) {
  if (!name || !/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) {
    throw new FriendlyError(
      `'${name}' is not a valid Salesforce object API name. ` +
        "API names are letters, numbers and underscores (custom objects end in '__c')."
    )
  }
  return name
}

function compactField(f) {
  return {
    apiName: f.name,
    label: f.label,
    type: f.type,
    length: f.length || undefined,
    required: f.nillable === false && f.defaultedOnCreate === false,
    unique: f.unique || undefined,
    referenceTo: f.referenceTo && f.referenceTo.length ? f.referenceTo : undefined,
    picklistValues:
      f.picklistValues && f.picklistValues.length
        ? f.picklistValues.filter((p) => p.active).map((p) => p.value)
        : undefined,
  }
}

export async function handleSchema(toolName, args) {
  if (toolName === "describe_object") {
    const obj = validateObjectName(args.object_name)
    const result = await runSF(["sobject", "describe", "--sobject", obj, ...orgArgs(args.target_org)])
    const fields = (result.fields || []).map(compactField)

    if (args.fields_only) {
      return { objectName: result.name, fieldCount: fields.length, fields }
    }
    return {
      objectName: result.name,
      label: result.label,
      custom: result.custom,
      createable: result.createable,
      updateable: result.updateable,
      deletable: result.deletable,
      queryable: result.queryable,
      fieldCount: fields.length,
      fields,
    }
  }

  if (toolName === "list_objects") {
    const result = await runSF(["sobject", "list", ...orgArgs(args.target_org)])
    // `sf sobject list` returns an array of API name strings.
    let objects = Array.isArray(result) ? result : []
    if (args.filter) {
      const f = String(args.filter).toLowerCase()
      objects = objects.filter((o) => String(o).toLowerCase().includes(f))
    }
    objects.sort()
    return { count: objects.length, objects }
  }

  if (toolName === "find_field") {
    const obj = validateObjectName(args.object_name)
    if (!args.field_search) throw new FriendlyError("'field_search' is required.")
    const result = await runSF(["sobject", "describe", "--sobject", obj, ...orgArgs(args.target_org)])
    const search = String(args.field_search).toLowerCase()
    const matches = (result.fields || [])
      .filter((f) => f.name.toLowerCase().includes(search) || (f.label || "").toLowerCase().includes(search))
      .map(compactField)
    return {
      objectName: obj,
      searchTerm: args.field_search,
      matchCount: matches.length,
      ...(matches.length === 0 && {
        hint: "No matching field. Run describe_object to see all available fields, or check spelling.",
      }),
      fields: matches,
    }
  }
}
