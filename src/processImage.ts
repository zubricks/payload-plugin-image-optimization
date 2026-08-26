import fs from 'node:fs/promises'
import path from 'node:path'

import type { Config, PayloadRequest, UploadConfig } from 'payload'

import { compressionContextKey, optimizableMimeTypes } from './hooks/captureOriginalFile.js'
import { sanitizeImageCompressionOptions } from './defaults.js'
import { getProcessingOptions, skipImageOptimizationFieldName } from './settings.js'
import type {
  CompressionContext,
  ImageCompressionOptions,
  ImageCompressionProcessingOptions,
  ImageCompressionSettingsResolver,
} from './types.js'

type SharpFactory = NonNullable<Config['sharp']>

export type ImageCompressionFile = {
  data: Buffer
  mimetype: string
  name: string
  size: number
  tempFilePath?: string
}

export type ProcessImageInput = {
  constructorOptions?: UploadConfig['constructorOptions']
  file: ImageCompressionFile
  options: ImageCompressionProcessingOptions
  resizeOptions?: UploadConfig['resizeOptions']
  sharp: SharpFactory
}

export type ProcessImageResult = {
  file: ImageCompressionFile
  originalSize: number
  status: CompressionContext['status']
}

export type ImageCompressionProcessor = (
  input: Omit<ProcessImageInput, 'options' | 'sharp'>,
) => Promise<ProcessImageResult>

const outputMimeTypes = {
  avif: 'image/avif',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
} as const

const outputExtensions = {
  avif: 'avif',
  jpeg: 'jpg',
  png: 'png',
  webp: 'webp',
} as const

const multiPageMimeTypes = new Set(['image/avif', 'image/gif', 'image/tiff', 'image/webp'])

const replaceExtension = (filename: string, extension: string): string => {
  const parsed = path.parse(filename)
  return `${parsed.name || filename}.${extension}`
}

const readFileBuffer = async (file: ImageCompressionFile): Promise<Buffer> => {
  if (file.data.length > 0) {
    return file.data
  }
  if (file.tempFilePath) {
    return fs.readFile(file.tempFilePath)
  }
  return file.data
}

export const processImage = async ({
  constructorOptions,
  file,
  options,
  resizeOptions,
  sharp,
}: ProcessImageInput): Promise<ProcessImageResult> => {
  const originalSize = file.size
  const withinFileSizeLimits =
    originalSize >= options.minFileSize && originalSize <= options.maxFileSize

  if (!optimizableMimeTypes.has(file.mimetype) || !withinFileSizeLimits) {
    return { file, originalSize, status: 'skipped' }
  }

  const originalBuffer = await readFileBuffer(file)
  const sharpOptions = {
    ...constructorOptions,
    animated: multiPageMimeTypes.has(file.mimetype),
    limitInputPixels: options.maxInputPixels,
  }

  let pipeline = sharp(originalBuffer, sharpOptions).rotate()
  pipeline = pipeline.resize({
    fit: 'inside',
    height: options.maxHeight,
    width: options.maxWidth,
    withoutEnlargement: true,
    ...resizeOptions,
  })
  pipeline = pipeline.toFormat(options.format, options.formatOptions)

  if (options.preserveMetadata) {
    pipeline = pipeline.withMetadata()
  }

  const optimizedBuffer = await pipeline.toBuffer()

  if (options.skipIfLarger && optimizedBuffer.length >= originalSize) {
    return { file, originalSize, status: 'kept-original' }
  }

  if (file.tempFilePath) {
    await fs.writeFile(file.tempFilePath, optimizedBuffer)
  }

  return {
    file: {
      ...file,
      data: optimizedBuffer,
      mimetype: outputMimeTypes[options.format],
      name: replaceExtension(file.name, outputExtensions[options.format]),
      size: optimizedBuffer.length,
    },
    originalSize,
    status: optimizedBuffer.length > originalSize ? 'larger-than-source' : 'complete',
  }
}

export const createImageCompressionProcessor = (
  options: ImageCompressionOptions,
  sharp: SharpFactory,
): ImageCompressionProcessor => {
  const sanitizedOptions = sanitizeImageCompressionOptions(options)

  return (input) => processImage({ ...input, options: sanitizedOptions, sharp })
}

export const processUploadedImage = (
  resolveSettings: ImageCompressionSettingsResolver,
  sharp: SharpFactory,
  upload: UploadConfig,
) => {
  return async ({ operation, req }: { operation: string; req: PayloadRequest }) => {
    if ((operation !== 'create' && operation !== 'update') || !req.file) {
      return
    }

    const originalFile = req.file
    const { enabled, options } = await resolveSettings(req)

    if (!enabled || req.data?.[skipImageOptimizationFieldName] === true) {
      req.context[compressionContextKey] = {
        optimizable: false,
        originalMimeType: originalFile.mimetype,
        originalSize: originalFile.size,
        settings: getProcessingOptions(options),
        status: 'skipped',
      } satisfies CompressionContext
      return
    }

    try {
      const result = await processImage({
        constructorOptions: upload.constructorOptions,
        file: originalFile,
        options,
        resizeOptions: upload.resizeOptions,
        sharp,
      })

      req.file = result.file
      req.context[compressionContextKey] = {
        optimizable: result.status !== 'skipped',
        originalMimeType: originalFile.mimetype,
        originalSize: result.originalSize,
        settings: getProcessingOptions(options),
        status: result.status,
      } satisfies CompressionContext
    } catch (error) {
      if (options.onError === 'throw') {
        throw error
      }

      req.file = originalFile
      req.context[compressionContextKey] = {
        error: error instanceof Error ? error.message : 'Unknown image compression error',
        optimizable: true,
        originalMimeType: originalFile.mimetype,
        originalSize: originalFile.size,
        settings: getProcessingOptions(options),
        status: 'failed',
      } satisfies CompressionContext
    }
  }
}
