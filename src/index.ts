export { imageCompressionPlugin } from './plugin.js'
export { createImageCompressionProcessor, processImage } from './processImage.js'
export { imageCompressionSettingsSlug, skipImageOptimizationFieldName } from './settings.js'
export type {
  ImageCompressionFile,
  ImageCompressionProcessor,
  ProcessImageInput,
  ProcessImageResult,
} from './processImage.js'
export type {
  CompressionStatus,
  ExistingMediaDocument,
  ExistingMediaFile,
  ExistingMediaOptions,
  ExistingMediaReadFileArgs,
  ImageCompressionAdminSettings,
  ImageCompressionBackgroundAdapter,
  ImageCompressionBackgroundTask,
  ImageCompressionFormat,
  ImageCompressionOptions,
  ImageCompressionPreset,
  ImageCompressionProcessingOptions,
} from './types.js'
