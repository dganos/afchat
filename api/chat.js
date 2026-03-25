const http = require('http')
const path = require('path')
const fs = require('fs')
const { createOllama } = require('ollama-ai-provider')
const { streamText } = require('ai')
const { z } = require('zod')

const MODEL = 'deepseek-r1:1.5b'
const DOCS_PATH = process.env.DOCS_PATH || path.join(__dirname, '../resources/documents')
const ollama = createOllama({ baseURL: 'http://localhost:11434/api' })

// ── System Prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a helpful assistant with access to a document library.
When answering questions, ALWAYS search the documents first. Never answer from your
training knowledge alone when the answer could be in the documents. Use listFiles to
understand what documents exist, searchText to find relevant sections, and readFile to
read full content. Always cite which document and section your answer comes from.
If you cannot find the answer in the documents, say so clearly.`

// ── Tools ────────────────────────────────────────────────────────────────────

// Helper: recursive directory walk, returns relative file paths
function walkDir(dir, base = '') {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  return entries.flatMap(e => {
    const rel = base ? `${base}/${e.name}` : e.name
    return e.isDirectory()
      ? walkDir(path.join(dir, e.name), rel)
      : [rel]
  })
}

// Helper: validate path stays within DOCS_PATH (security)
function safePath(filepath) {
  const resolved = path.resolve(DOCS_PATH, filepath)
  if (!resolved.startsWith(path.resolve(DOCS_PATH))) {
    throw new Error('Access denied: path outside documents directory')
  }
  return resolved
}

const tools = {
  listFiles: {
    description: 'List all documents available in the document library. Use this first to understand what documents exist before searching or reading.',
    parameters: z.object({
      directory: z.string().describe('Directory to list. Use "." for the root documents folder.')
    }),
    execute: async ({ directory }) => {
      try {
        const targetDir = directory === '.' ? DOCS_PATH : safePath(directory)
        const files = walkDir(targetDir)
        return { files, count: files.length }
      } catch (err) {
        return { error: err.message }
      }
    }
  },

  readFile: {
    description: 'Read the full content of a specific document file. Use when you need to find detailed information in a file.',
    parameters: z.object({
      filepath: z.string().describe('Path to the file relative to the documents folder, e.g. "manual.md" or "subdir/specs.md"')
    }),
    execute: async ({ filepath }) => {
      try {
        const fullPath = safePath(filepath)
        if (!fs.existsSync(fullPath)) {
          return { error: `File not found: ${filepath}` }
        }
        const content = fs.readFileSync(fullPath, 'utf-8')
        const MAX_CHARS = 8000
        return {
          filepath,
          content: content.slice(0, MAX_CHARS),
          truncated: content.length > MAX_CHARS,
          totalLength: content.length
        }
      } catch (err) {
        return { error: err.message }
      }
    }
  },

  searchText: {
    description: 'Search for a keyword or phrase across all documents. Returns matching lines with their source file and line number.',
    parameters: z.object({
      query: z.string().describe('Text to search for. Case-insensitive.')
    }),
    execute: async ({ query }) => {
      try {
        const results = []
        const files = walkDir(DOCS_PATH)
        for (const file of files) {
          const fullPath = path.join(DOCS_PATH, file)
          const content = fs.readFileSync(fullPath, 'utf-8')
          const lines = content.split('\n')
          lines.forEach((line, i) => {
            if (line.toLowerCase().includes(query.toLowerCase())) {
              results.push({ file, line: i + 1, text: line.trim() })
            }
          })
        }
        return {
          query,
          matches: results.slice(0, 30),
          total: results.length
        }
      } catch (err) {
        return { error: err.message }
      }
    }
  }
}

// ── HTTP Server ───────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  // CORS headers — required for Electron renderer to call this
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  if (req.method === 'OPTIONS') {
    res.writeHead(200)
    res.end()
    return
  }

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200)
    res.end('ok')
    return
  }

  if (req.method === 'POST' && req.url === '/chat') {
    // Parse request body
    const body = await new Promise((resolve, reject) => {
      let data = ''
      req.on('data', chunk => { data += chunk })
      req.on('end', () => {
        try { resolve(JSON.parse(data)) }
        catch (e) { reject(e) }
      })
    })

    try {
      const result = streamText({
        model: ollama(MODEL),
        system: SYSTEM_PROMPT,
        messages: body.messages,
        tools,
        maxSteps: 10  // Allow up to 10 tool call rounds per response
      })

      // pipeDataStreamToResponse sends the full AI SDK stream protocol
      // useChat on the frontend understands this natively — no extra config needed
      result.pipeDataStreamToResponse(res)

    } catch (err) {
      console.error('[api] error:', err)
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: err.message }))
    }
    return
  }

  res.writeHead(404)
  res.end()
})

server.listen(3001, () => {
  console.log('[api] listening on http://localhost:3001')
})
