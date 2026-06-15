import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import express from "express"
import multer from "multer"
import mammoth from "mammoth"
import { execSync } from "child_process"
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs"
import { join, extname, basename } from "path"
import { fileURLToPath } from "url"
import { dirname } from "path"
import { randomBytes } from "crypto"
import { z } from "zod"

const __dirname = dirname(fileURLToPath(import.meta.url))

// ── Config ────────────────────────────────────────────────────────────────────

const API_KEY       = process.env.API_KEY || "change-me"
const PORT          = process.env.PORT || 3000
const PUBLIC_URL    = process.env.PUBLIC_URL || `http://localhost:${PORT}`

const SAMPLES_DIR   = join(__dirname, "samples")
const TEMPLATES_DIR = join(__dirname, "templates")
const OUTPUT_DIR    = "/tmp/rfp_output"

for (const dir of [SAMPLES_DIR, TEMPLATES_DIR, OUTPUT_DIR]) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

// ── Auth helper ───────────────────────────────────────────────────────────────

function checkApiKey(req, res) {
  const auth = req.headers.authorization || ""
  const key  = auth.startsWith("Bearer ") ? auth.slice(7) : req.query.api_key
  if (key !== API_KEY) {
    res.status(401).json({ error: "Invalid API key" })
    return false
  }
  return true
}

// ── MCP server factory ────────────────────────────────────────────────────────
// One McpServer instance per request (stateless HTTP transport pattern)

function createMcpServer() {
  const server = new McpServer({ name: "rfp-docs", version: "1.0.0" })

  // ── Tool: list_samples ──────────────────────────────────────────────────────
  server.tool(
    "list_samples",
    "List all of the company's past proposal documents stored on the server — these are proposals the company has previously written and submitted, used as style and structure references when drafting new proposals (.docx, .pdf, .txt)",
    {},
    async () => {
      const files = readdirSync(SAMPLES_DIR)
        .filter(f => [".docx", ".pdf", ".txt", ".md"].includes(extname(f).toLowerCase()))
        .sort()

      if (files.length === 0) {
        return { content: [{ type: "text", text: "No samples uploaded yet. Use POST /upload/sample to add .docx files." }] }
      }
      return { content: [{ type: "text", text: files.join("\n") }] }
    }
  )

  // ── Tool: read_sample ───────────────────────────────────────────────────────
  server.tool(
    "read_sample",
    "Extract the full text from one of the company's past proposal documents. Use this to learn the company's writing style, tone, team/org structure presentation, and section format before drafting a new proposal. These are NOT RFP documents — they are the company's own previously submitted proposals.",
    { filename: z.string().describe("Filename from list_samples, e.g. Proposal_01_SmartMeterFirmware.docx") },
    async ({ filename }) => {
      const safeName = basename(filename)
      const path = join(SAMPLES_DIR, safeName)

      if (!existsSync(path)) {
        return { content: [{ type: "text", text: `Not found: ${safeName}. Call list_samples to see available files.` }] }
      }

      const ext = extname(safeName).toLowerCase()

      if (ext === ".docx") {
        const result = await mammoth.extractRawText({ path })
        const text = result.value.trim()
        return { content: [{ type: "text", text: text || "(document appears empty)" }] }
      }

      if (ext === ".txt" || ext === ".md") {
        const text = readFileSync(path, "utf-8")
        return { content: [{ type: "text", text }] }
      }

      return { content: [{ type: "text", text: `Cannot extract text from ${ext} files. Upload .docx or .txt samples for best results.` }] }
    }
  )

  // ── Tool: read_template ─────────────────────────────────────────────────────
  // This is what replaces the "manually upload template in chat" step.
  // Mammoth converts the .docx to HTML, which preserves structure, section order,
  // heading hierarchy, table layouts, and notes where images/logos are placed.
  // Claude reads this exactly like it would read an uploaded template in chat.
  server.tool(
    "read_template",
    "Read the company proposal template — returns its full structure including section layout, heading styles, and where the logo/images are placed. Call this before writing any proposal so the output matches the company template exactly, the same way uploading the template in Claude chat would.",
    {},
    async () => {
      const tmplPath = join(TEMPLATES_DIR, "company-template.docx")

      if (!existsSync(tmplPath)) {
        return { content: [{ type: "text", text: "No template found. Upload company-template.docx via POST /upload/template on the MCP server." }] }
      }

      // Convert to HTML — preserves section order, headings, tables, image positions
      const result = await mammoth.convertToHtml({ path: tmplPath })

      // Also get plain text for a readable summary
      const textResult = await mammoth.extractRawText({ path: tmplPath })

      const output = [
        "=== COMPANY TEMPLATE STRUCTURE ===",
        "Use this structure for all proposals. Match section order, heading levels, and layout exactly.",
        "",
        "--- HTML (section structure, heading hierarchy, table layouts, image positions) ---",
        result.value,
        "",
        "--- Plain text (readable summary) ---",
        textResult.value.trim()
      ].join("\n")

      return { content: [{ type: "text", text: output }] }
    }
  )

  // ── Tool: list_templates ────────────────────────────────────────────────────
  server.tool(
    "list_templates",
    "List available branded .docx proposal templates on the server",
    {},
    async () => {
      const files = readdirSync(TEMPLATES_DIR)
        .filter(f => extname(f).toLowerCase() === ".docx")
        .sort()

      if (files.length === 0) {
        return { content: [{ type: "text", text: "No templates uploaded yet. Use POST /upload/template to add company-template.docx." }] }
      }
      return { content: [{ type: "text", text: files.join("\n") }] }
    }
  )

  // ── Tool: generate_proposal_docx ────────────────────────────────────────────
  server.tool(
    "generate_proposal_docx",
    "Convert the final proposal markdown into a branded .docx using the company template (preserves logo, fonts, header/footer). Returns a download URL.",
    {
      markdown_content:  z.string().describe("Complete proposal content in markdown format"),
      output_filename:   z.string().default("proposal-final.docx").describe("Output filename, e.g. proposal-final.docx")
    },
    async ({ markdown_content, output_filename }) => {
      const safeName  = basename(output_filename).replace(/[^a-z0-9._-]/gi, "_")
      const mdPath    = join(OUTPUT_DIR, "proposal-draft.md")
      const outPath   = join(OUTPUT_DIR, safeName)
      const tmplPath  = join(TEMPLATES_DIR, "company-template.docx")

      writeFileSync(mdPath, markdown_content, "utf-8")

      // Check pandoc is available
      try {
        execSync("pandoc --version", { stdio: "pipe" })
      } catch {
        return { content: [{ type: "text", text: "pandoc is not installed on this server. Add 'RUN apt-get install -y pandoc' to the Dockerfile and redeploy." }] }
      }

      const cmd = existsSync(tmplPath)
        ? `pandoc "${mdPath}" -o "${outPath}" --reference-doc="${tmplPath}"`
        : `pandoc "${mdPath}" -o "${outPath}"`

      try {
        execSync(cmd, { stdio: "pipe" })
      } catch (err) {
        return { content: [{ type: "text", text: `pandoc failed: ${err.message}` }] }
      }

      const downloadUrl = `${PUBLIC_URL}/download/${safeName}`
      const usedTemplate = existsSync(tmplPath) ? "company-template.docx (branded)" : "default Word styles (no template uploaded)"

      return {
        content: [{
          type: "text",
          text: `Proposal generated.\nTemplate used: ${usedTemplate}\nDownload: ${downloadUrl}`
        }]
      }
    }
  )

  return server
}

// ── Express app ───────────────────────────────────────────────────────────────

const app    = express()
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } })

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, mcp-session-id")
  if (req.method === "OPTIONS") return res.sendStatus(204)
  next()
})

// ── OAuth 2.0 (proper flow with consent screen for Claude.ai connector) ────────

app.use(express.urlencoded({ extended: false }))

const oauthClients = new Map()  // client_id → { client_secret, redirect_uris }
const oauthCodes   = new Map()  // code → { redirect_uri, expires }

app.get("/.well-known/oauth-authorization-server", (req, res) => {
  res.json({
    issuer:                           PUBLIC_URL,
    authorization_endpoint:           `${PUBLIC_URL}/authorize`,
    token_endpoint:                   `${PUBLIC_URL}/token`,
    registration_endpoint:            `${PUBLIC_URL}/register`,
    response_types_supported:         ["code"],
    grant_types_supported:            ["authorization_code"],
    token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post", "none"],
    code_challenge_methods_supported: ["S256", "plain"]
  })
})

// Dynamic client registration
app.post("/register", express.json(), (req, res) => {
  const client_id     = randomBytes(16).toString("hex")
  const client_secret = randomBytes(32).toString("hex")
  oauthClients.set(client_id, { client_secret, redirect_uris: req.body?.redirect_uris || [] })
  res.status(201).json({
    client_id,
    client_secret,
    redirect_uris:              req.body?.redirect_uris || [],
    grant_types:                ["authorization_code"],
    response_types:             ["code"],
    token_endpoint_auth_method: "client_secret_post"
  })
})

// Authorization endpoint — shows an Allow/Deny consent page
app.get("/authorize", (req, res) => {
  const { client_id, redirect_uri, state, code_challenge, code_challenge_method } = req.query
  const params = new URLSearchParams({ client_id, redirect_uri, state: state||"", code_challenge: code_challenge||"", code_challenge_method: code_challenge_method||"" })
  res.setHeader("Content-Type", "text/html")
  res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>RFP Wizard — Connect</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #f5f5f5; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
    .card { background: white; border-radius: 12px; padding: 40px; max-width: 400px; width: 90%; box-shadow: 0 4px 20px rgba(0,0,0,0.1); text-align: center; }
    h1 { font-size: 1.4rem; margin: 0 0 8px; color: #1a1a1a; }
    p { color: #555; margin: 0 0 28px; line-height: 1.5; }
    .logo { font-size: 2.5rem; margin-bottom: 16px; }
    form { display: inline; }
    button { padding: 12px 32px; border: none; border-radius: 8px; font-size: 1rem; cursor: pointer; margin: 6px; }
    .allow { background: #2563eb; color: white; }
    .allow:hover { background: #1d4ed8; }
    .deny  { background: #e5e7eb; color: #374151; }
    .deny:hover  { background: #d1d5db; }
    .scopes { background: #f0f7ff; border-radius: 8px; padding: 12px 16px; margin: 0 0 24px; text-align: left; font-size: 0.9rem; color: #1e40af; }
    .scopes li { margin: 4px 0; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">📄</div>
    <h1>RFP Proposal Wizard</h1>
    <p>Claude is requesting access to your RFP Wizard MCP server.</p>
    <ul class="scopes">
      <li>✓ Read company proposal samples</li>
      <li>✓ Read proposal template</li>
      <li>✓ Generate branded .docx proposals</li>
    </ul>
    <form method="POST" action="/authorize/allow">
      <input type="hidden" name="client_id" value="${client_id}">
      <input type="hidden" name="redirect_uri" value="${redirect_uri}">
      <input type="hidden" name="state" value="${state||""}">
      <input type="hidden" name="code_challenge" value="${code_challenge||""}">
      <input type="hidden" name="code_challenge_method" value="${code_challenge_method||""}">
      <button type="submit" class="allow">Allow Access</button>
    </form>
    <form method="POST" action="/authorize/deny">
      <input type="hidden" name="redirect_uri" value="${redirect_uri}">
      <input type="hidden" name="state" value="${state||""}">
      <button type="submit" class="deny">Deny</button>
    </form>
  </div>
</body>
</html>`)
})

// User clicked Allow — generate code and redirect back
app.post("/authorize/allow", (req, res) => {
  const { redirect_uri, state, code_challenge, code_challenge_method } = req.body
  const code = randomBytes(32).toString("hex")
  oauthCodes.set(code, { redirect_uri, code_challenge, code_challenge_method, expires: Date.now() + 600_000 })
  const url = new URL(redirect_uri)
  url.searchParams.set("code", code)
  if (state) url.searchParams.set("state", state)
  res.redirect(url.toString())
})

// User clicked Deny
app.post("/authorize/deny", (req, res) => {
  const { redirect_uri, state } = req.body
  const url = new URL(redirect_uri)
  url.searchParams.set("error", "access_denied")
  if (state) url.searchParams.set("state", state)
  res.redirect(url.toString())
})

// Token endpoint — exchange code for access token
app.post("/token", express.json(), (req, res) => {
  const body = req.body || {}
  const code = body.code || new URLSearchParams(req.body).get?.("code")
  const entry = oauthCodes.get(code)
  if (!entry || Date.now() > entry.expires) {
    return res.status(400).json({ error: "invalid_grant" })
  }
  oauthCodes.delete(code)
  res.json({ access_token: API_KEY, token_type: "Bearer", expires_in: 86400 })
})

// ── MCP endpoint ──────────────────────────────────────────────────────────────

app.all("/mcp", async (req, res) => {
  if (!checkApiKey(req, res)) return

  try {
    const server    = createMcpServer()
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    await server.connect(transport)
    await transport.handleRequest(req, res)
  } catch (err) {
    console.error("MCP error:", err)
    if (!res.headersSent) res.status(500).json({ error: err.message })
  }
})

// ── Upload: samples ───────────────────────────────────────────────────────────

app.post("/upload/sample", upload.single("file"), (req, res) => {
  if (!checkApiKey(req, res)) return
  if (!req.file) return res.status(400).json({ error: "No file provided" })

  const dest = join(SAMPLES_DIR, req.file.originalname)
  writeFileSync(dest, req.file.buffer)
  console.log(`Sample uploaded: ${req.file.originalname}`)
  res.json({ uploaded: req.file.originalname, size: req.file.size })
})

// ── Upload: template ──────────────────────────────────────────────────────────

app.post("/upload/template", upload.single("file"), (req, res) => {
  if (!checkApiKey(req, res)) return
  if (!req.file) return res.status(400).json({ error: "No file provided" })

  const dest = join(TEMPLATES_DIR, req.file.originalname)
  writeFileSync(dest, req.file.buffer)
  console.log(`Template uploaded: ${req.file.originalname}`)
  res.json({ uploaded: req.file.originalname, size: req.file.size })
})

// ── Download: generated proposals ─────────────────────────────────────────────

app.get("/download/:filename", (req, res) => {
  const safeName = basename(req.params.filename)
  const filePath = join(OUTPUT_DIR, safeName)

  if (!existsSync(filePath)) {
    return res.status(404).json({ error: "File not found" })
  }
  res.download(filePath, safeName)
})

// ── Health check ──────────────────────────────────────────────────────────────

app.get("/health", (req, res) => {
  const samples   = readdirSync(SAMPLES_DIR).filter(f => [".docx",".pdf",".txt"].includes(extname(f))).length
  const templates = readdirSync(TEMPLATES_DIR).filter(f => extname(f) === ".docx").length

  let pandocVersion = "not installed"
  try { pandocVersion = execSync("pandoc --version", { stdio: "pipe" }).toString().split("\n")[0] } catch {}

  res.json({ status: "ok", samples, templates, pandoc: pandocVersion })
})

app.get("/", (req, res) => {
  res.json({ name: "RFP Docs MCP Server", version: "1.0.0", mcp: `${PUBLIC_URL}/mcp` })
})

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, "0.0.0.0", () => {
  console.log(`RFP Docs MCP server running on port ${PORT}`)
  console.log(`MCP endpoint: ${PUBLIC_URL}/mcp`)
  console.log(`Health check: ${PUBLIC_URL}/health`)
})
