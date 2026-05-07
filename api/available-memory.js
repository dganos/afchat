// Cross-platform "available memory" — what an app can realistically allocate
// right now, including reclaimable file cache.
//
// Node's os.freemem() is unreliable for this:
//   - macOS: only counts truly idle pages, missing ~GBs of reclaimable cache
//   - Linux: reports MemFree, not MemAvailable
//   - Windows: already returns AvailPhys (close to Task Manager's "Available")
const os = require('os')
const fs = require('fs')
const { execSync } = require('child_process')

function availableMemoryDarwin() {
  try {
    const out = execSync('vm_stat', { encoding: 'utf8', timeout: 1000 })
    const pageMatch = out.match(/page size of (\d+) bytes/)
    const pageSize = pageMatch ? parseInt(pageMatch[1], 10) : 4096
    const keys = ['Pages free', 'Pages inactive', 'Pages speculative', 'Pages purgeable']
    let pages = 0
    for (const key of keys) {
      const m = out.match(new RegExp(`${key}:\\s+(\\d+)`))
      if (m) pages += parseInt(m[1], 10)
    }
    return pages > 0 ? pages * pageSize : os.freemem()
  } catch {
    return os.freemem()
  }
}

function availableMemoryLinux() {
  try {
    const text = fs.readFileSync('/proc/meminfo', 'utf8')
    const m = text.match(/MemAvailable:\s+(\d+)\s+kB/)
    if (m) return parseInt(m[1], 10) * 1024
  } catch {}
  return os.freemem()
}

function availableMemory() {
  if (process.platform === 'darwin') return availableMemoryDarwin()
  if (process.platform === 'linux') return availableMemoryLinux()
  return os.freemem()
}

module.exports = { availableMemory }
