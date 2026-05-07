// Pick the largest installed model that fits in roughly half of total RAM —
// leaves headroom for the OS, Electron, and other apps. If nothing fits, fall
// back to the smallest installed model so the app at least starts and the user
// can pick something else from the UI.
//
// availableModels: array of { name, size } from Ollama's /api/tags
// Returns the chosen model name, or null if no models are installed.
function selectDefaultModel(totalRAM, availableModels = []) {
  if (!availableModels || availableModels.length === 0) return null

  const sizeBudget = totalRAM * 0.5

  const fitting = availableModels
    .filter(m => typeof m.size === 'number' && m.size < sizeBudget)
    .sort((a, b) => b.size - a.size)

  if (fitting.length > 0) return fitting[0].name

  const sorted = [...availableModels]
    .filter(m => typeof m.size === 'number')
    .sort((a, b) => a.size - b.size)
  return sorted[0]?.name || null
}

module.exports = { selectDefaultModel }
