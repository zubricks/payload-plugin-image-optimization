import type { CollectionSlug, ImageUploadFormatOptions, PayloadRequest } from 'payload'

export type ImageCompressionFormat = Extract<
  ImageUploadFormatOptions['format'],
  'avif' | 'jpeg' | 'png' | 'webp'
>

export type ImageCompressionOptions = {
  /** Queue a serializable task after the original has been stored instead of processing inline. */
  background?: ImageCompressionBackgroundAdapter
  /** Upload collections whose originals and generated sizes should be optimized. */
  collections: CollectionSlug[]
  /** Keep the schema fields while disabling image processing and metrics updates. */
  disabled?: boolean
  /** Output format for optimizable raster images. */
  format?: ImageCompressionFormat
  /** Sharp encoder options passed to Payload's native image pipeline. */
  formatOptions?: ImageUploadFormatOptions['options']
  /** Add a read-only group containing the result of the latest upload. */
  metadata?: boolean
  /** Name of the group used to store compression metrics. */
  metadataFieldName?: string
  /** Maximum height for the stored original, without enlargement. */
  maxHeight?: number
  /** Largest file the plugin will attempt to compress. Larger files are stored unchanged. */
  maxFileSize?: number
  /** Maximum decoded pixel count accepted by Sharp. */
  maxInputPixels?: number
  /** Maximum width for the stored original, without enlargement. */
  maxWidth?: number
  /** Smallest file the plugin will attempt to compress. Smaller files are stored unchanged. */
  minFileSize?: number
  /** Failure behavior for inline processing. */
  onError?: 'keep-original' | 'throw'
  /** Preserve image metadata. Defaults to false for smaller, privacy-safe output. */
  preserveMetadata?: boolean
  /** Keep the source when the encoded candidate is not smaller. */
  skipIfLarger?: boolean
}

export type ImageCompressionPreset = 'balanced' | 'quality' | 'savings'

export type ImageCompressionAdminSettings = {
  enabled: boolean
  maxDimension: number
  minFileSizeKB: number
  preset: ImageCompressionPreset
  preserveMetadata: boolean
}

export type ImageCompressionProcessingOptions = Pick<
  SanitizedImageCompressionOptions,
  | 'format'
  | 'formatOptions'
  | 'maxHeight'
  | 'maxFileSize'
  | 'maxInputPixels'
  | 'maxWidth'
  | 'minFileSize'
  | 'preserveMetadata'
  | 'skipIfLarger'
>

export type ImageCompressionBackgroundTask = {
  collection: CollectionSlug
  documentId: number | string
  filename: string
  mimeType: string
  originalSize: number
  /** Resolved at upload time so queued work remains deterministic. */
  settings: ImageCompressionProcessingOptions
  url?: string
}

export type ImageCompressionBackgroundAdapter = {
  enqueue: (task: ImageCompressionBackgroundTask) => Promise<void> | void
}

export type SanitizedImageCompressionOptions = Required<
  Pick<
    ImageCompressionOptions,
    | 'disabled'
    | 'format'
    | 'formatOptions'
    | 'metadata'
    | 'metadataFieldName'
    | 'maxHeight'
    | 'maxFileSize'
    | 'maxInputPixels'
    | 'maxWidth'
    | 'minFileSize'
    | 'onError'
    | 'preserveMetadata'
    | 'skipIfLarger'
  >
> &
  Pick<ImageCompressionOptions, 'background' | 'collections'>

export type CompressionStatus =
  'complete' | 'failed' | 'kept-original' | 'larger-than-source' | 'pending' | 'skipped'

export type CompressionContext = {
  error?: string
  optimizable: boolean
  originalMimeType: string
  originalSize: number
  settings?: ImageCompressionProcessingOptions
  status: CompressionStatus
}

export type ImageCompressionSettingsResolver = (
  req: PayloadRequest,
) => Promise<{ enabled: boolean; options: SanitizedImageCompressionOptions }>
