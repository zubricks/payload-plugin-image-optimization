export const formatBytes = (value: number | null | undefined): string => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return '—'
  }

  const sign = value < 0 ? '-' : ''
  const bytes = Math.abs(value)

  if (bytes < 1024) {
    return `${sign}${Math.round(bytes)} B`
  }

  const units = ['KB', 'MB', 'GB']
  let amount = bytes / 1024
  let unitIndex = 0

  while (amount >= 1024 && unitIndex < units.length - 1) {
    amount /= 1024
    unitIndex += 1
  }

  return `${sign}${new Intl.NumberFormat('en-US', {
    maximumFractionDigits: amount >= 100 ? 0 : 1,
  }).format(amount)} ${units[unitIndex]}`
}
