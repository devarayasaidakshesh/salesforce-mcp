# Salesforce MCP

> An MCP server that connects any MCP-compatible AI assistant directly to your Salesforce org — query data, explore schema, run Apex, check org health, generate test classes, and build deployment manifests. All without leaving your conversation.

---

## Is It Safe? (Read This First)

This is the most important section for anyone evaluating this tool for company or team use.

### It runs 100% on your machine

This server is a local process that runs on **your own computer** (or CI runner). It does not have its own backend, does not phone home, does not send data to any third-party service, and does not store anything. The only network calls it makes are directly from **your machine to your Salesforce org** — the same calls the Salesforce CLI (`sf`) already makes when you use it from a terminal.

### Your credentials never touch this server

Authentication is handled entirely by the **Salesforce CLI** (`sf`). You log in once with `sf org login web` — the CLI stores a session token in your OS keychain or local credential store (exactly like it always has). This server reads that existing session. There are no new passwords, API keys, or secrets to manage or share.

### No shell injection is possible

Every Salesforce CLI call this server makes uses **argument arrays** — never string-interpolated shell commands. That means a malicious SOQL query like `'; rm -rf /` cannot escape into a shell command. Inputs are passed as literals to the CLI, not evaluated by a shell.

### The query tool is strictly read-only

The `soql_query` and `soql_query_all` tools reject any string that does not begin with `SELECT`. You cannot accidentally write, update, or delete records through the query tool. DML (insert/update/delete) can only happen through `run_apex`, which requires explicit Apex code — the AI must actively write a DML statement, and you see the code before it runs.

### Object and class names are validated

Before any schema or Apex tool talks to the org, it validates that the object or class name is a legal Salesforce API identifier (`[A-Za-z][A-Za-z0-9_]*`). Unusual characters that could be used for injection are rejected with a plain error message.

### You control what the AI can do

Because this server uses your CLI session, everything it does is bounded by **your Salesforce user's permissions**. If your user cannot delete records, neither can the AI. Using a read-only integration user with the server further restricts what is possible. Your org's permission sets, field-level security, and sharing rules all apply normally.

### Result sets are size-capped

Queries are capped at 200 records by default (configurable). Large results are truncated with a note rather than flooding the AI's context window.

### The source code is fully open

Everything is in this repository. There are no compiled binaries, no obfuscated code, and no runtime dependencies that phone home. You can read every line before running it.

### What this server cannot do

- It cannot install packages or create orgs.
- It cannot bypass Salesforce field-level security or sharing rules.
- It cannot persist data or credentials between sessions.
- It cannot communicate with any service other than your Salesforce org.

**Bottom line:** Deploying this server carries the same risk profile as giving a developer the Salesforce CLI on their laptop. If you trust your developers with `sf` access to the org, you can trust this server.

---

## What Is This?

The Salesforce MCP server is a bridge between an AI assistant (Claude, Copilot, Cursor, or any MCP-compatible client) and your Salesforce org. Instead of switching between your AI chat and the Salesforce UI or terminal, you can ask your assistant to:

- Query records with SOQL
- Explore and describe any object's schema
- Read, list, and execute Apex code
- Check org health and API limits
- Analyze Apex classes for security issues and generate rule-following test scaffolds
- Build `package.xml` deployment manifests

It speaks the **Model Context Protocol (MCP)**, an open standard from Anthropic, so it works with any client that supports MCP — not just Claude.

---

## Requirements

- **Node.js 18+**
- **Salesforce CLI:** `npm install -g @salesforce/cli`
- **An authenticated org:** `sf org login web --alias myorg`

---

## Installation

**Just want to install and use it?** Clone directly from this repo:

```bash
git clone https://github.com/devarayasaidakshesh/salesforce-mcp.git
cd salesforce-mcp
npm install
```

**Want to fork and host your own copy?** Fork it on GitHub first, then:

```bash
git clone https://github.com/your-username/salesforce-mcp.git
cd salesforce-mcp
npm install
```

---

## Connect to Your AI Client

Add this block to your MCP client's config file (replace the path with the absolute path on your machine):

**Claude Desktop** (`~/Library/Application Support/Claude/claude_desktop_config.json` on Mac):

```json
{
  "mcpServers": {
    "salesforce": {
      "command": "node",
      "args": ["/absolute/path/to/salesforce-mcp/index.js"]
    }
  }
}
```

**VS Code (`.vscode/mcp.json` in your project):**

```json
{
  "servers": {
    "salesforce": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/salesforce-mcp/index.js"]
    }
  }
}
```

Restart your client after saving the config. The server will appear as a connected tool source.

---

## Tools (17)

### Query

---

#### `soql_query`

Run a SOQL `SELECT` query against your org and return structured results.

**Use cases:**

1. **Find accounts by industry** — `SELECT Id, Name, Industry FROM Account WHERE Industry = 'Technology' LIMIT 50` — instantly pull a list without opening the Salesforce UI.
2. **Debug a support backlog** — `SELECT Id, Subject, Status, CreatedDate FROM Case WHERE Status = 'New' ORDER BY CreatedDate ASC` — see the oldest open cases at a glance.
3. **Check which users have a permission set** — `SELECT Assignee.Name FROM PermissionSetAssignment WHERE PermissionSet.Name = 'Sales_Manager'` — audit access without navigating Setup menus.
4. **Validate data before a migration** — `SELECT COUNT(Id), BillingCountry FROM Account GROUP BY BillingCountry` — spot missing or inconsistent country values before a data load.

---

#### `soql_query_all`

Same as `soql_query` but includes soft-deleted and archived records (`queryAll` mode).

**Use cases:**

1. **Recover a recently deleted contact** — `SELECT Id, Name, Email FROM Contact WHERE IsDeleted = true AND Name LIKE '%Smith%'` — find records in the recycle bin before they are purged.
2. **Audit who deleted accounts last month** — combine with a history query to see what was deleted and when.
3. **Restore orphaned related records** — find deleted parent records whose children still exist.
4. **Compliance reporting** — include deleted records in a full audit trail export as required by data retention policies.

---

### Schema

---

#### `describe_object`

Return the full schema of any Salesforce object: all fields, types, labels, picklist values, and relationships.

**Use cases:**

1. **Explore a custom object before writing SOQL** — describe `Opportunity` to see every field API name and type so your query is correct the first time.
2. **Check which fields are required** — filter the field list by `required: true` to understand what must be populated when creating records.
3. **Map relationships for a report** — see all lookup/master-detail relationship fields and what objects they point to.
4. **Audit picklist values** — retrieve the active picklist values for `Stage` or `Status` fields without opening the object manager in Setup.

---

#### `list_objects`

List all standard and custom objects in the org, with optional name filtering.

**Use cases:**

1. **Discover custom objects in an unfamiliar org** — filter by `__c` to see only custom objects and understand what the team has built.
2. **Find an object when you only remember part of its name** — filter by `"Invoice"` to find `Invoice__c`, `InvoiceLine__c`, etc.
3. **Count total objects for a compliance report** — get the full list and count as a snapshot of org complexity.
4. **Verify a deployment** — after deploying a new custom object, confirm it appears in the live org object list.

---

#### `find_field`

Search for a specific field on an object by API name or label.

**Use cases:**

1. **Find the right field name before writing SOQL** — search `"region"` on `Account` to discover `BillingState`, `Region__c`, or whatever the org uses.
2. **Resolve field label vs. API name confusion** — the UI shows "Close Date" but SOQL needs `CloseDate` — find it instantly.
3. **Check field type before mapping** — confirm whether a field is a `Lookup`, `Text`, or `Currency` before writing an integration.
4. **Discover deprecated fields** — search for an old field name to confirm it still exists or has been replaced.

---

### Apex

---

#### `run_apex`

Execute anonymous Apex code in the org and return output, debug logs, and compile status.

**Use cases:**

1. **Debug a formula or utility method** — `System.debug(MyUtil.calculateTax(500));` — see the result in the log without writing a test or deploying anything.
2. **Backfill a field on existing records** — write a small Apex loop to populate a new field on a batch of records as a one-off data fix.
3. **Trigger a scheduled job manually** — instantiate a Schedulable class and call `execute()` directly to test it outside its schedule.
4. **Inspect governor limits mid-execution** — `System.debug(Limits.getCpuTime());` at strategic points to diagnose slow transactions.

---

#### `get_apex_class`

Retrieve the full source code of an Apex class from the org.

**Use cases:**

1. **Review a class before modifying it** — read `AccountTriggerHandler` directly from the org to understand current logic before making a change.
2. **Compare org source to a local file** — check whether what is deployed matches what is in your repo.
3. **Understand a class you did not write** — pull a utility class written by a former developer to understand its API.
4. **Verify a deployment landed correctly** — after deploying, retrieve the class to confirm the new version is live.

---

#### `list_apex_classes`

List Apex classes in the org with name, status, and last-modified date (no source bodies, stays compact).

**Use cases:**

1. **Find all classes related to a feature** — filter by `"Order"` to find `OrderService`, `OrderTriggerHandler`, `OrderHelper`, etc.
2. **Identify stale classes** — sort by `LastModifiedDate` to find classes untouched for years that may be candidates for cleanup.
3. **Audit test class coverage** — get a list of all classes, then cross-reference with coverage data.
4. **Validate a deployment** — confirm new classes appear (and have `Active` status) after deploying to a sandbox.

---

### Org

---

#### `org_info`

Get details about a connected org: username, instance URL, org ID, and connection status.

**Use cases:**

1. **Confirm you are talking to the right org** — before running anything, verify the alias resolves to the org ID and instance URL you expect.
2. **Check session expiry** — see if a scratch org's expiration date is approaching before starting a long task.
3. **Document org details for a handover** — pull the org ID and instance URL for a client handover document.
4. **Multi-org workflows** — when working with multiple aliases, confirm which org each alias resolves to without opening a browser.

---

#### `org_limits`

Check API usage limits and remaining capacity. Flags any limit above 80% used.

**Use cases:**

1. **Pre-deployment check** — before a large data load, confirm API call, Apex CPU, and daily workflow email limits have headroom.
2. **Diagnose a "limit exceeded" error** — check `DailyApiRequests` and `DailyAsyncApexExecutions` to find the culprit.
3. **Capacity planning** — review limits weekly to spot a team that is creeping toward the edge before hitting a wall.
4. **Validate after a bulk operation** — confirm how many API calls a large batch actually consumed.

---

#### `list_orgs`

List all Salesforce orgs authenticated with the Salesforce CLI on this machine.

**Use cases:**

1. **See which orgs are available** — quickly review all authenticated aliases (production, sandbox, scratch orgs) in one call.
2. **Find the right alias** — look up the correct alias to use in `--target-org` before running other tools.
3. **Spot expired sessions** — identify orgs with `connectedStatus: expired` that need re-authentication.
4. **Onboard a new developer** — verify their machine is authenticated to all required orgs before they start work.

---

#### `current_user`

Get the name, email, profile, and role of the currently connected Salesforce user.

**Use cases:**

1. **Confirm your identity before making changes** — verify you are logged in as the right user, not a shared integration account.
2. **Check your profile in a new sandbox** — confirm your profile and role were set up correctly after a refresh.
3. **Audit automated pipelines** — confirm a CI/CD job is running as the expected service account, not a personal user.
4. **Troubleshoot permission issues** — check your profile name to understand why a field or object is not accessible.

---

### Testing

---

#### `analyze_apex_class`

Deep-analyze an Apex class: extracts methods, signatures, DML operations, SOQL objects, HTTP callouts, async patterns, and sharing model. Runs a **security scan** (CRUD/FLS enforcement, SOQL injection, sharing declaration, hardcoded secrets) and returns a **rule-following test scaffold** — valid-input positive tests, exception-path negative tests (only for methods that actually validate), a 200-record bulk test, and a `System.runAs()` permission test. Every generated test makes a real `Assert.*` call (never `System.assert(true)`) and no test uses `SeeAllData`.

**Use cases:**

1. **Generate a test class starting point** — analyze `InvoiceService` to get a scaffold with positive/negative/bulk/runAs tests for every public method, including `@TestSetup` data setup with the correct object names.
2. **Catch security gaps before review** — surfaces CRUD/FLS violations (SOQL/DML running in system mode), unescaped dynamic SOQL, missing sharing declarations, and hardcoded secrets, each with a concrete fix — the same findings a Salesforce Security Review flags.
3. **Understand a complex class before modifying it** — see at a glance what DML it does, what objects it queries, whether it makes callouts, and whether it runs `with sharing`.
4. **Identify test gaps** — the analysis shows which methods are `@AuraEnabled` or `@InvocableMethod` — the highest-priority entry points for test coverage.
5. **Plan a refactor** — see all methods, their access modifiers, and parameters in a structured format without reading every line of code.

---

#### `check_coverage`

Check the current code coverage percentage for a specific Apex class, or all classes at once.

**Use cases:**

1. **Pre-deployment gate** — check that a class meets the 75% Salesforce minimum before deploying to production.
2. **Find coverage regressions** — after adding new methods to a class, check if existing tests still cover it adequately.
3. **Full org coverage snapshot** — use `*` to get coverage for every class at once and export for a stakeholder report.
4. **After a test run** — immediately check whether the tests you just ran moved the coverage needle for a target class.

---

#### `list_untested_classes`

List all Apex classes below a coverage threshold (default 75%).

**Use cases:**

1. **Pre-release audit** — before a release, get the full list of classes below 75% so developers know exactly what to test.
2. **Technical debt triage** — use a custom threshold (e.g. 50%) to find the most critically under-tested classes first.
3. **Sprint planning** — assign the lowest-coverage classes to developers as test-writing tasks for the next sprint.
4. **New developer onboarding** — give a new hire this list as a safe, high-value starting contribution to the codebase.

---

### Deployment

---

#### `build_package_xml`

Generate a valid `package.xml` manifest from a list of components. Handles friendly type aliases, validates compound member formats (field, layout, validation rule), de-duplicates, sorts, and returns ready-to-run retrieve/deploy commands.

**Use cases:**

1. **Create a deployment manifest from a conversation** — describe what you want to deploy in plain English; the AI calls this tool to produce the exact XML.
2. **Catch format errors before they fail in production** — the tool warns you if a `CustomField` member is missing the `Object.Field` dot format before you try to deploy.
3. **Use friendly names** — pass `"flow"`, `"lwc"`, `"permission set"` instead of `Flow`, `LightningComponentBundle`, `PermissionSet` — the tool resolves them.
4. **Get deploy commands ready to paste** — the response includes the exact `sf project deploy start` and `sf project retrieve start` commands for your manifest.

---

#### `list_metadata_components`

List the exact API names (fullNames) of a metadata type in the org — the precise names needed in `package.xml`.

**Use cases:**

1. **Get all flow names before building a manifest** — call `list_metadata_components` for type `Flow` to get every flow's API name, then pass them into `build_package_xml`.
2. **Find the exact layout name** — layouts use `Object-Layout Name` format which is easy to get wrong; this tool lists them exactly.
3. **Audit all permission sets in the org** — list all `PermissionSet` components to see what exists before deciding which to include in a package.
4. **Prepare a full metadata backup** — list every component of a type to build a wildcard-free `package.xml` for a complete retrieve.

---

## Configuration

| Environment variable | Default | Purpose |
|---|---|---|
| `SF_MCP_TIMEOUT_MS` | `120000` | Milliseconds before a CLI command times out |
| `SF_MCP_BIN` | `sf` | Path to the Salesforce CLI binary (useful in CI or when `sf` is not on PATH) |

---

## Tests

No live org required — a mock `sf` CLI drives all scenarios, including the Apex
security analyzer (CRUD/FLS, sharing) and the generated test scaffold's rules.

```bash
npm test          # 65 scenario tests
npm run test:boot # boots the real server and lists all tools
```

---

## License

MIT
