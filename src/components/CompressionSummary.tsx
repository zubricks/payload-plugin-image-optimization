'use client'

import { useField } from '@payloadcms/ui'

import { formatBytes } from './formatBytes.js'
import './styles.scss'

type CompressionStatus =
  'complete' | 'failed' | 'kept-original' | 'larger-than-source' | 'pending' | 'skipped'

type CompressionSummaryProps = {
  metricsPath: string
}

const statusDetails: Record<
  CompressionStatus,
  { label: (percent: string) => string; tone: 'error' | 'neutral' | 'success' }
> = {
  complete: {
    label: (percent) => `Saved ${percent}%`,
    tone: 'success',
  },
  failed: {
    label: () => 'Original kept',
    tone: 'error',
  },
  'kept-original': {
    label: () => 'Original kept',
    tone: 'neutral',
  },
  'larger-than-source': {
    label: (percent) => `Increased ${percent}%`,
    tone: 'error',
  },
  pending: {
    label: () => 'Pending',
    tone: 'neutral',
  },
  skipped: {
    label: () => 'Skipped',
    tone: 'neutral',
  },
}

export const CompressionSummary = ({ metricsPath }: CompressionSummaryProps) => {
  const { value: statusValue } = useField<CompressionStatus>({ path: `${metricsPath}.status` })
  const { value: originalSize } = useField<number>({ path: `${metricsPath}.originalSize` })
  const { value: optimizedSize } = useField<number>({ path: `${metricsPath}.optimizedSize` })
  const { value: savedPercent } = useField<number>({ path: `${metricsPath}.savedPercent` })

  const hasMetrics = typeof statusValue === 'string' && statusValue in statusDetails
  const status = hasMetrics ? statusDetails[statusValue] : null
  const normalizedPercent =
    typeof savedPercent === 'number' && Number.isFinite(savedPercent) ? Math.abs(savedPercent) : 0
  const formattedPercent = new Intl.NumberFormat(undefined, {
    maximumFractionDigits: 1,
  }).format(normalizedPercent)

  return (
    <section
      className={`compression-summary${status ? ` compression-summary--${status.tone}` : ''}`}
      aria-labelledby={`${metricsPath}-summary-title`}
    >
      <header className="compression-summary__header">
        <div>
          <h3 className="compression-summary__title" id={`${metricsPath}-summary-title`}>
            Image Compression
          </h3>
          <p className="compression-summary__description">
            Recorded automatically when an image is uploaded or replaced.
          </p>
        </div>
      </header>

      {hasMetrics && status ? (
        <div className="compression-summary__metrics" role="table">
          <div className="compression-summary__labels" role="row">
            <span role="columnheader">Before</span>
            <span role="columnheader">Status</span>
            <span role="columnheader">After</span>
          </div>
          <div className="compression-summary__values" role="row">
            <span className="compression-summary__before" role="cell">
              {formatBytes(originalSize)}
            </span>
            <span role="cell">
              <span
                className={`compression-summary__status compression-summary__status--${status.tone}`}
              >
                {status.label(formattedPercent)}
              </span>
            </span>
            <span role="cell">{formatBytes(optimizedSize)}</span>
          </div>
        </div>
      ) : (
        <div className="compression-summary__empty">
          Upload an image to see its optimization results.
        </div>
      )}
    </section>
  )
}
