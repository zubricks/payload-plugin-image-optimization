import type { CollectionBeforeOperationHook } from 'payload'

import { getProcessingOptions, skipImageOptimizationFieldName } from '../settings.js'
import type { CompressionContext, ImageCompressionSettingsResolver } from '../types.js'

export const compressionContextKey = 'imageCompressionPlugin'

export const optimizableMimeTypes = new Set([
  'image/avif',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/tiff',
  'image/webp',
])

export const captureOriginalFile = (
  resolveSettings: ImageCompressionSettingsResolver,
): CollectionBeforeOperationHook => {
  return async ({ operation, req }) => {
    if ((operation !== 'create' && operation !== 'update') || !req.file) {
      return
    }

    const { enabled, options } = await resolveSettings(req)
    const skippedByDocument = req.data?.[skipImageOptimizationFieldName] === true
    const optimizable = enabled && !skippedByDocument && optimizableMimeTypes.has(req.file.mimetype)
    const withinFileSizeLimits =
      req.file.size >= options.minFileSize && req.file.size <= options.maxFileSize

    req.context[compressionContextKey] = {
      optimizable: optimizable && withinFileSizeLimits,
      originalMimeType: req.file.mimetype,
      originalSize: req.file.size,
      settings: getProcessingOptions(options),
      status: optimizable && withinFileSizeLimits ? 'pending' : 'skipped',
    } satisfies CompressionContext
  }
}
