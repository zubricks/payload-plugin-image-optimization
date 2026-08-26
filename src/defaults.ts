import type {
  ImageCompressionFormat,
  ImageCompressionOptions,
  SanitizedImageCompressionOptions,
} from './types.js'

const formatDefaults: Record<
  ImageCompressionFormat,
  SanitizedImageCompressionOptions['formatOptions']
> = {
  avif: {
    effort: 4,
    quality: 50,
  },
  jpeg: {
    mozjpeg: true,
    quality: 82,
  },
  png: {
    compressionLevel: 9,
  },
  webp: {
    effort: 4,
    quality: 82,
  },
}

export const sanitizeImageCompressionOptions = (
  options: ImageCompressionOptions,
): SanitizedImageCompressionOptions => {
  if (!options.collections.length) {
    throw new Error('imageCompressionPlugin requires at least one collection')
  }

  const format = options.format ?? 'webp'
  const maxHeight = options.maxHeight ?? 2560
  const maxFileSize = options.maxFileSize ?? Number.MAX_SAFE_INTEGER
  const maxInputPixels = options.maxInputPixels ?? 100_000_000
  const maxWidth = options.maxWidth ?? 2560
  const minFileSize = options.minFileSize ?? 0

  if (maxHeight < 1 || maxWidth < 1 || maxFileSize < 1 || maxInputPixels < 1 || minFileSize < 0) {
    throw new Error('imageCompressionPlugin size and pixel limits must be positive numbers')
  }

  if (minFileSize > maxFileSize) {
    throw new Error('imageCompressionPlugin minFileSize cannot exceed maxFileSize')
  }

  return {
    background: options.background,
    collections: options.collections,
    disabled: options.disabled ?? false,
    format,
    formatOptions: options.formatOptions ?? formatDefaults[format],
    metadata: options.metadata ?? true,
    metadataFieldName: options.metadataFieldName ?? 'imageCompression',
    maxHeight,
    maxFileSize,
    maxInputPixels,
    maxWidth,
    minFileSize,
    onError: options.onError ?? 'keep-original',
    preserveMetadata: options.preserveMetadata ?? false,
    skipIfLarger: options.skipIfLarger ?? true,
  }
}
