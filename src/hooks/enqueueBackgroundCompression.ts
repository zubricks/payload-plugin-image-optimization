import type { CollectionAfterChangeHook } from 'payload'

import { compressionContextKey } from './captureOriginalFile.js'
import type {
  CompressionContext,
  ImageCompressionBackgroundAdapter,
  ImageCompressionBackgroundTask,
} from '../types.js'

export const enqueueBackgroundCompression = (
  collection: ImageCompressionBackgroundTask['collection'],
  background: ImageCompressionBackgroundAdapter,
  onError: 'keep-original' | 'throw',
): CollectionAfterChangeHook => {
  return async ({ doc, operation, req }) => {
    const compression = req.context[compressionContextKey] as CompressionContext | undefined

    if (
      (operation !== 'create' && operation !== 'update') ||
      !compression ||
      compression.status !== 'pending'
    ) {
      return doc
    }

    const task: ImageCompressionBackgroundTask = {
      collection,
      documentId: doc.id,
      filename: doc.filename,
      mimeType: doc.mimeType,
      originalSize: compression.originalSize,
      settings: compression.settings!,
      ...(typeof doc.url === 'string' ? { url: doc.url } : {}),
    }

    try {
      await background.enqueue(task)
    } catch (error) {
      if (onError === 'throw') {
        throw error
      }

      req.payload.logger.error({
        err: error,
        msg: `Unable to enqueue image compression for ${collection}:${String(doc.id)}`,
      })
    }

    return doc
  }
}
