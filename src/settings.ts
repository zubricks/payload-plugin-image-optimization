import type { GlobalConfig, PayloadRequest } from 'payload'

import type {
  ImageCompressionAdminSettings,
  ImageCompressionPreset,
  ImageCompressionSettingsResolver,
  SanitizedImageCompressionOptions,
} from './types.js'

export const imageCompressionSettingsSlug = 'image-compression-settings'
export const skipImageOptimizationFieldName = 'skipImageOptimization'

const authenticated = ({ req }: { req: PayloadRequest }): boolean => Boolean(req.user)

const presetOptions = (
  preset: ImageCompressionPreset,
  options: SanitizedImageCompressionOptions,
): SanitizedImageCompressionOptions['formatOptions'] => {
  if (preset === 'balanced') {
    return options.formatOptions
  }

  const presets = {
    avif: {
      quality: { effort: 4, quality: 65 },
      savings: { effort: 7, quality: 40 },
    },
    jpeg: {
      quality: { mozjpeg: true, quality: 90 },
      savings: { mozjpeg: true, quality: 70 },
    },
    png: {
      quality: { compressionLevel: 6 },
      savings: { compressionLevel: 9 },
    },
    webp: {
      quality: { effort: 4, quality: 90 },
      savings: { effort: 6, quality: 70 },
    },
  } as const

  return presets[options.format][preset]
}

export const imageCompressionSettingsGlobal = (
  options: SanitizedImageCompressionOptions,
): GlobalConfig => ({
  slug: imageCompressionSettingsSlug,
  access: {
    read: authenticated,
    update: authenticated,
  },
  admin: {
    group: 'Settings',
  },
  fields: [
    {
      name: 'enabled',
      type: 'checkbox',
      admin: {
        description: 'Optimize newly uploaded and replaced image originals.',
      },
      defaultValue: true,
      label: 'Enable image optimization',
    },
    {
      name: 'preset',
      type: 'select',
      admin: {
        description: 'Balanced uses the encoder options configured by the developer.',
      },
      defaultValue: 'balanced',
      options: [
        { label: 'Balanced', value: 'balanced' },
        { label: 'Higher quality', value: 'quality' },
        { label: 'Maximum savings', value: 'savings' },
      ],
      required: true,
    },
    {
      name: 'maxDimension',
      type: 'number',
      admin: {
        description: `Maximum width or height in pixels, up to the developer limit of ${Math.min(options.maxWidth, options.maxHeight)}. Images are never enlarged.`,
        step: 1,
      },
      defaultValue: Math.min(options.maxWidth, options.maxHeight),
      label: 'Maximum image dimension',
      max: Math.min(options.maxWidth, options.maxHeight),
      min: 1,
      required: true,
    },
    {
      name: 'minFileSizeKB',
      type: 'number',
      admin: {
        description: 'Smaller files are stored unchanged. Developer safety limits still apply.',
        step: 1,
      },
      defaultValue: Math.round(options.minFileSize / 1024),
      label: 'Minimum file size (KB)',
      min: 0,
      required: true,
    },
    {
      name: 'preserveMetadata',
      type: 'checkbox',
      admin: {
        description:
          'Retains EXIF and other metadata, which can increase size and reveal device or location details.',
      },
      defaultValue: options.preserveMetadata,
      label: 'Preserve image metadata',
    },
    ...(options.existingMedia && !options.disabled
      ? [
          {
            name: 'existingMediaOptimizer',
            type: 'ui' as const,
            admin: {
              components: {
                Field: {
                  clientProps: {
                    collections: options.collections,
                  },
                  path: '@zubricks/payload-plugin-image-optimization/client#ExistingMediaOptimizer',
                },
              },
            },
          },
        ]
      : []),
  ],
  label: 'Image Optimization',
})

const toFiniteNumber = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback

export const createImageCompressionSettingsResolver = (
  baseOptions: SanitizedImageCompressionOptions,
): ImageCompressionSettingsResolver => {
  return async (req) => {
    if (typeof req.payload?.findGlobal !== 'function') {
      return { enabled: true, options: baseOptions }
    }

    const settings = (await req.payload.findGlobal({
      depth: 0,
      req,
      slug: imageCompressionSettingsSlug as never,
    })) as unknown as Partial<ImageCompressionAdminSettings>
    const configuredMaxDimension = Math.min(baseOptions.maxWidth, baseOptions.maxHeight)
    const maxDimension = Math.min(
      configuredMaxDimension,
      Math.max(1, Math.round(toFiniteNumber(settings.maxDimension, configuredMaxDimension))),
    )
    const minFileSize = Math.min(
      baseOptions.maxFileSize,
      Math.max(
        baseOptions.minFileSize,
        Math.round(toFiniteNumber(settings.minFileSizeKB, baseOptions.minFileSize / 1024) * 1024),
      ),
    )
    const preset: ImageCompressionPreset =
      settings.preset === 'quality' || settings.preset === 'savings' ? settings.preset : 'balanced'
    const options: SanitizedImageCompressionOptions = {
      ...baseOptions,
      formatOptions: presetOptions(preset, baseOptions),
      maxHeight: maxDimension,
      maxWidth: maxDimension,
      minFileSize,
      preserveMetadata:
        typeof settings.preserveMetadata === 'boolean'
          ? settings.preserveMetadata
          : baseOptions.preserveMetadata,
    }

    return {
      enabled: settings.enabled !== false,
      options,
    }
  }
}

export const getProcessingOptions = (options: SanitizedImageCompressionOptions) => ({
  format: options.format,
  formatOptions: options.formatOptions,
  maxFileSize: options.maxFileSize,
  maxHeight: options.maxHeight,
  maxInputPixels: options.maxInputPixels,
  maxWidth: options.maxWidth,
  minFileSize: options.minFileSize,
  preserveMetadata: options.preserveMetadata,
  skipIfLarger: options.skipIfLarger,
})
