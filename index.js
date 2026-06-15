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
