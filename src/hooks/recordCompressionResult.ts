import type { CollectionBeforeChangeHook } from 'payload'

import { compressionContextKey } from './captureOriginalFile.js'
import type { CompressionContext } from '../types.js'

export const recordCompressionResult = (metadataFieldName: string): CollectionBeforeChangeHook => {
  return ({ data, req }) => {
    const compression = req.context[compressionContextKey] as CompressionContext | undefined
    const optimizedSize = data.filesize

    if (!compression || typeof optimizedSize !== 'number') {
      return data
    }

    if (compression.status !== 'complete' && compression.status !== 'larger-than-source') {
      return {
        ...data,
        [metadataFieldName]: {
          error: compression.error ?? null,
          optimizedSize,
          originalMimeType: compression.originalMimeType,
          originalSize: compression.originalSize,
          outputMimeType: typeof data.mimeType === 'string' ? data.mimeType : null,
          savedBytes: 0,
          savedPercent: 0,
          status: compression.status,
        },
      }
    }

    const savedBytes = compression.originalSize - optimizedSize
    const savedPercent =
      compression.originalSize === 0
        ? 0
        : Number(((savedBytes / compression.originalSize) * 100).toFixed(2))

    return {
      ...data,
      [metadataFieldName]: {
        error: null,
        optimizedSize,
        originalMimeType: compression.originalMimeType,
        originalSize: compression.originalSize,
        outputMimeType: typeof data.mimeType === 'string' ? data.mimeType : null,
        savedBytes,
        savedPercent,
        status: compression.status,
      },
    }
  }
}
