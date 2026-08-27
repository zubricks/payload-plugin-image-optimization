'use client'

import { Button, useConfig } from '@payloadcms/ui'
import { formatAdminURL } from 'payload/shared'
import { useMemo, useState } from 'react'

import { formatBytes } from './formatBytes.js'
import './styles.scss'

type ExistingMediaOptimizerProps = {
  collections: string[]
}

type BatchResponse = {
  collection: string
  failed: number
  processed: number
  remaining: number
  savedBytes: number
}

type PreviewResponse = {
  collection: string
  eligible: number
}

type Phase = 'complete' | 'error' | 'idle' | 'running' | 'scanning'

export const ExistingMediaOptimizer = ({ collections }: ExistingMediaOptimizerProps) => {
  const { config } = useConfig()
  const [eligible, setEligible] = useState<Record<string, number>>({})
  const [error, setError] = useState<string>()
  const [failed, setFailed] = useState(0)
  const [phase, setPhase] = useState<Phase>('idle')
  const [processed, setProcessed] = useState(0)
  const [savedBytes, setSavedBytes] = useState(0)
  const endpoint = formatAdminURL({
    apiRoute: config.routes.api,
    path: '/image-optimization/existing',
  })
  const eligibleTotal = useMemo(
    () => Object.values(eligible).reduce((total, value) => total + value, 0),
    [eligible],
  )

  const post = async <T,>(body: Record<string, unknown>): Promise<T> => {
    const response = await fetch(endpoint, {
      body: JSON.stringify(body),
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    })
    const result = (await response.json()) as T & { error?: string }

    if (!response.ok) {
      throw new Error(result.error || `Image optimization request failed (${response.status})`)
    }

    return result
  }

  const scan = async () => {
    setError(undefined)
    setFailed(0)
    setPhase('scanning')
    setProcessed(0)
    setSavedBytes(0)

    try {
      const previews = await Promise.all(
        collections.map((collection) => post<PreviewResponse>({ collection, dryRun: true })),
      )
      setEligible(
        Object.fromEntries(previews.map((preview) => [preview.collection, preview.eligible])),
      )
      setPhase('idle')
    } catch (scanError) {
      setError(scanError instanceof Error ? scanError.message : 'Unable to scan existing media')
      setPhase('error')
    }
  }

  const optimize = async () => {
    setError(undefined)
    setFailed(0)
    setPhase('running')
    setProcessed(0)
    setSavedBytes(0)

    let nextFailed = 0
    let nextProcessed = 0
    let nextSavedBytes = 0

    try {
      for (const collection of collections) {
        let remaining = eligible[collection] ?? 0

        while (remaining > 0) {
          const batch = await post<BatchResponse>({ collection })
          nextFailed += batch.failed
          nextProcessed += batch.processed
          nextSavedBytes += batch.savedBytes
          setFailed(nextFailed)
          setProcessed(nextProcessed)
          setSavedBytes(nextSavedBytes)
          remaining = batch.remaining

          if (batch.failed > 0 || batch.processed === 0) {
            throw new Error(
              `Stopped after ${batch.failed || 1} file failed. Fix the storage or file error, then scan again to retry.`,
            )
          }
        }
      }

      setEligible({})
      setPhase('complete')
    } catch (optimizationError) {
      setError(
        optimizationError instanceof Error
          ? optimizationError.message
          : 'Unable to optimize existing media',
      )
      setPhase('error')
    }
  }

  const busy = phase === 'running' || phase === 'scanning'

  return (
    <section className="existing-media-optimizer" aria-live="polite">
      <div className="existing-media-optimizer__content">
        <div>
          <h3>Existing media</h3>
          <p>
            Find images uploaded before this plugin was enabled. Already processed images and files
            outside the configured limits are not changed.
          </p>
        </div>
        <div className="existing-media-optimizer__actions">
          <Button
            buttonStyle="secondary"
            disabled={busy}
            margin={false}
            onClick={scan}
            size="small"
          >
            {phase === 'scanning' ? 'Scanning…' : 'Scan existing media'}
          </Button>
          {eligibleTotal > 0 ? (
            <Button disabled={busy} margin={false} onClick={optimize} size="small">
              {phase === 'running'
                ? `Optimizing ${processed + failed} of ${eligibleTotal}…`
                : `Optimize ${eligibleTotal} ${eligibleTotal === 1 ? 'image' : 'images'}`}
            </Button>
          ) : null}
        </div>
      </div>

      {phase === 'complete' ? (
        <p className="existing-media-optimizer__notice existing-media-optimizer__notice--success">
          Optimized {processed} {processed === 1 ? 'image' : 'images'} and saved{' '}
          {formatBytes(savedBytes)}.
        </p>
      ) : null}
      {phase === 'idle' && Object.keys(eligible).length > 0 ? (
        <p className="existing-media-optimizer__notice">
          {eligibleTotal === 0
            ? 'No unprocessed images match the current limits.'
            : `${eligibleTotal} unprocessed ${eligibleTotal === 1 ? 'image matches' : 'images match'} the current limits.`}
        </p>
      ) : null}
      {error ? (
        <p className="existing-media-optimizer__notice existing-media-optimizer__notice--error">
          {error}
        </p>
      ) : null}
    </section>
  )
}
