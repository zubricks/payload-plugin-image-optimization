import type { CollectionConfig, Config, ImageSize, Plugin, UploadConfig } from 'payload'

import { sanitizeImageCompressionOptions } from './defaults.js'
import { createExistingMediaEndpoint } from './existingMedia.js'
import { compressionMetadataFields } from './fields/compressionMetadata.js'
import { captureOriginalFile } from './hooks/captureOriginalFile.js'
import { enqueueBackgroundCompression } from './hooks/enqueueBackgroundCompression.js'
import { recordCompressionResult } from './hooks/recordCompressionResult.js'
import { processUploadedImage } from './processImage.js'
import {
  createImageCompressionSettingsResolver,
  imageCompressionSettingsGlobal,
  imageCompressionSettingsSlug,
  skipImageOptimizationFieldName,
} from './settings.js'
import type {
  ImageCompressionBackgroundTask,
  ImageCompressionOptions,
  SanitizedImageCompressionOptions,
} from './types.js'

const configureUpload = (
  upload: UploadConfig,
  options: SanitizedImageCompressionOptions,
): UploadConfig => {
  if (options.background) {
    return upload
  }

  const formatOptions = {
    format: options.format,
    options: options.formatOptions,
  }

  const {
    formatOptions: _formatOptions,
    resizeOptions: _resizeOptions,
    ...uploadWithoutOriginalEdits
  } = upload

  return {
    ...uploadWithoutOriginalEdits,
    imageSizes: upload.imageSizes?.map((imageSize): ImageSize => ({
      ...imageSize,
      formatOptions,
    })),
    withMetadata: options.preserveMetadata,
  }
}

const configureCollection = (
  collection: CollectionConfig,
  sharp: Config['sharp'],
  options: SanitizedImageCompressionOptions,
): CollectionConfig => {
  const upload = collection.upload === true ? {} : collection.upload

  if (!upload) {
    throw new Error(`imageCompressionPlugin collection "${collection.slug}" is not upload-enabled`)
  }

  if (
    options.metadata &&
    collection.fields.some((field) => 'name' in field && field.name === options.metadataFieldName)
  ) {
    throw new Error(
      `imageCompressionPlugin field "${options.metadataFieldName}" already exists on collection "${collection.slug}"`,
    )
  }

  if (
    options.metadata &&
    collection.fields.some(
      (field) => 'name' in field && field.name === `${options.metadataFieldName}Summary`,
    )
  ) {
    throw new Error(
      `imageCompressionPlugin field "${options.metadataFieldName}Summary" already exists on collection "${collection.slug}"`,
    )
  }

  if (
    collection.fields.some(
      (field) => 'name' in field && field.name === skipImageOptimizationFieldName,
    )
  ) {
    throw new Error(
      `imageCompressionPlugin field "${skipImageOptimizationFieldName}" already exists on collection "${collection.slug}"`,
    )
  }

  const fields = [
    ...collection.fields,
    {
      name: skipImageOptimizationFieldName,
      type: 'checkbox' as const,
      admin: {
        description:
          'Keep this uploaded original unchanged. Payload image sizes are still generated normally.',
        position: 'sidebar' as const,
      },
      defaultValue: false,
      label: 'Skip image optimization',
    },
    ...(options.metadata
      ? compressionMetadataFields(options.metadataFieldName, Boolean(options.existingMedia))
      : []),
  ]

  if (options.disabled) {
    return {
      ...collection,
      fields,
    }
  }

  const resolveSettings = createImageCompressionSettingsResolver(options)
  const pluginBeforeOperation = options.background
    ? captureOriginalFile(resolveSettings)
    : processUploadedImage(resolveSettings, sharp!, upload)
  const backgroundAfterChange = options.background
    ? [
        enqueueBackgroundCompression(
          collection.slug as ImageCompressionBackgroundTask['collection'],
          options.background,
          options.onError,
        ),
      ]
    : []

  return {
    ...collection,
    fields,
    hooks: {
      ...collection.hooks,
      afterChange: [...(collection.hooks?.afterChange ?? []), ...backgroundAfterChange],
      beforeChange: [
        ...(collection.hooks?.beforeChange ?? []),
        ...(options.metadata ? [recordCompressionResult(options.metadataFieldName)] : []),
      ],
      beforeOperation: [pluginBeforeOperation, ...(collection.hooks?.beforeOperation ?? [])],
    },
    upload: configureUpload(upload, options),
  }
}

export const imageCompressionPlugin = (pluginOptions: ImageCompressionOptions): Plugin => {
  return (config) => {
    const options = sanitizeImageCompressionOptions(pluginOptions)

    if (!options.disabled && !options.background && !config.sharp) {
      throw new Error('imageCompressionPlugin requires sharp in the Payload config')
    }

    const targetCollections = new Set<string>(options.collections)
    const foundCollections = new Set<string>()

    const collections = (config.collections ?? []).map((collection) => {
      if (!targetCollections.has(collection.slug)) {
        return collection
      }

      foundCollections.add(collection.slug)
      return configureCollection(collection, config.sharp, options)
    })

    const missingCollections = options.collections.filter(
      (collection) => !foundCollections.has(collection),
    )

    if (missingCollections.length) {
      throw new Error(
        `imageCompressionPlugin could not find collection(s): ${missingCollections.join(', ')}`,
      )
    }

    if ((config.globals ?? []).some((global) => global.slug === imageCompressionSettingsSlug)) {
      throw new Error(
        `imageCompressionPlugin global "${imageCompressionSettingsSlug}" already exists`,
      )
    }

    return {
      ...config,
      collections,
      endpoints: [
        ...(config.endpoints ?? []),
        ...(!options.disabled && options.existingMedia
          ? [createExistingMediaEndpoint(options)]
          : []),
      ],
      globals: [...(config.globals ?? []), imageCompressionSettingsGlobal(options)],
    }
  }
}
