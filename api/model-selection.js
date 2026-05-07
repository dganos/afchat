// Default model selection based on available RAM
function selectDefaultModel(totalRAM) {
  const GB = 1024 ** 3
  if (totalRAM >= 14 * GB) return 'gemma4:e4b'
  if (totalRAM >= 6 * GB) return 'gemma4:e2b'
  return 'gemma4:e2b'
}

module.exports = { selectDefaultModel }
