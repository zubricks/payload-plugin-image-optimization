import { s3Storage } from '@payloadcms/storage-s3'
import { vercelBlobStorage } from '@payloadcms/storage-vercel-blob'
import type { CollectionConfig, Config } from 'payload'
import sharp from 'sharp'
import { describe, expect, it, vi } from 'vitest'

import { type ImageCompressionOptions, imageCompressionPlugin, processImage } from '../src/index.js'
import { formatBytes } from '../src/components/formatBytes.js'
import { sanitizeImageCompressionOptions } from '../src/defaults.js'

const uploadCollection = (overrides: Partial<CollectionConfig> = {}): CollectionConfig => ({
  slug: 'media',
  fields: [{ name: 'alt', type: 'text' }],
  upload: {
    imageSizes: [{ name: 'thumbnail', width: 300 }],
  },
  ...overrides,
})

const applyPlugin = (
  collection: CollectionConfig = uploadCollection(),
  options: Partial<ImageCompressionOptions> = {},
  includeSharp = true,
): Config => {
  const plugin = imageCompressionPlugin({
    collections: ['media'],
    ...options,
  })

  return plugin({
    collections: [collection],
    ...(includeSharp ? { sharp } : {}),
  } as unknown as Config) as Config
}

const makeStillImage = async (width = 1200, height = 800): Promise<Buffer> =>
  sharp({
    create: {
      background: '#b84a35',
      channels: 4,
      height,
      width,
    },
  })
    .jpeg({ quality: 100 })
    .toBuffer()

const makeMultiPageImage = async (format: 'gif' | 'tiff'): Promise<Buffer> => {
  const input = [
    {
      create: {
        background: { alpha: 1, b: 0, g: 0, r: 255 },
        channels: 4 as const,
        height: 24,
        width: 24,
      },
    },
    {
      create: {
        background: { alpha: 1, b: 255, g: 0, r: 0 },
        channels: 4 as const,
        height: 24,
        width: 24,
      },
    },
  ]
  // Sharp supports create descriptors in joined input arrays at runtime, but its public overload
  // currently narrows array items to byte/string inputs.
  const pipeline = sharp(input as never, { join: { animated: true } })

  return format === 'gif'
    ? pipeline.gif({ delay: [80, 120], loop: 0 }).toBuffer()
    : pipeline.tiff({ compression: 'deflate' }).toBuffer()
}

describe('imageCompressionPlugin', () => {
  it('formats stored byte counts for humans', () => {
    expect(formatBytes(45_752)).toBe('44.7 KB')
    expect(formatBytes(1_851_762)).toBe('1.8 MB')
    expect(formatBytes(1_806_010)).toBe('1.7 MB')
    expect(formatBytes(-2048)).toBe('-2 KB')
  })

  it('owns original processing and leaves generated sizes on Payload native Sharp', () => {
    const config = applyPlugin()
    const media = config.collections?.[0]
    const upload = media?.upload && media.upload !== true ? media.upload : undefined
    const summaryField = media?.fields.find(
      (field) => 'name' in field && field.name === 'imageCompressionSummary',
    )

    expect(upload?.formatOptions).toBeUndefined()
    expect(upload?.resizeOptions).toBeUndefined()
    expect(upload?.imageSizes?.[0]?.formatOptions).toEqual({
      format: 'webp',
      options: { effort: 4, quality: 82 },
    })
    expect(upload?.withMetadata).toBe(false)
    expect(summaryField).toMatchObject({
      admin: {
        components: {
          Field: {
            clientProps: { metricsPath: 'imageCompression' },
            path: 'payload-plugin-image-optimization/client#CompressionSummary',
          },
        },
      },
      type: 'ui',
    })
    expect(media?.fields).toContainEqual(
      expect.objectContaining({
        name: 'skipImageOptimization',
        type: 'checkbox',
      }),
    )
    expect(config.globals).toContainEqual(
      expect.objectContaining({
        label: 'Image Optimization',
        slug: 'image-compression-settings',
      }),
    )
  })

  it('applies safe admin settings to the stored original', async () => {
    const config = applyPlugin(uploadCollection(), { maxHeight: 1000, maxWidth: 1000 })
    const media = config.collections?.[0]
    const source = await makeStillImage(1200, 800)
    const findGlobal = vi.fn().mockResolvedValue({
      enabled: true,
      maxDimension: 400,
      minFileSizeKB: 0,
      preset: 'savings',
      preserveMetadata: true,
    })
    const req = {
      context: {},
      file: {
        data: source,
        mimetype: 'image/jpeg',
        name: 'admin-settings.jpg',
        size: source.length,
      },
      payload: { findGlobal },
    }

    await media?.hooks?.beforeOperation?.[0]?.({ operation: 'create', req } as never)

    expect(findGlobal).toHaveBeenCalledWith({
      depth: 0,
      req,
      slug: 'image-compression-settings',
    })
    expect(await sharp(req.file.data).metadata()).toMatchObject({
      format: 'webp',
      width: 400,
    })
  })

  it('allows global and per-image optimization overrides', async () => {
    const config = applyPlugin()
    const media = config.collections?.[0]
    const source = await makeStillImage()
    const originalFile = {
      data: source,
      mimetype: 'image/jpeg',
      name: 'untouched.jpg',
      size: source.length,
    }

    for (const req of [
      {
        context: {},
        data: {},
        file: originalFile,
        payload: { findGlobal: vi.fn().mockResolvedValue({ enabled: false }) },
      },
      {
        context: {},
        data: { skipImageOptimization: true },
        file: originalFile,
        payload: { findGlobal: vi.fn().mockResolvedValue({ enabled: true }) },
      },
    ]) {
      await media?.hooks?.beforeOperation?.[0]?.({ operation: 'create', req } as never)
      expect(req.file).toBe(originalFile)
      expect(req.context).toMatchObject({
        imageCompressionPlugin: { status: 'skipped' },
      })
    }
  })

  it('preserves existing collection hooks and applies collection resize overrides', async () => {
    const existingBeforeOperation = vi.fn()
    const existingAfterChange = vi.fn()
    const config = applyPlugin(
      uploadCollection({
        hooks: {
          afterChange: [existingAfterChange],
          beforeOperation: [existingBeforeOperation],
        },
        upload: {
          resizeOptions: { width: 320 },
        },
      }),
    )
    const media = config.collections?.[0]
    const source = await makeStillImage(1200, 800)
    const req = {
      context: {},
      file: {
        data: source,
        mimetype: 'image/jpeg',
        name: 'resized.jpg',
        size: source.length,
      },
    }

    expect(media?.hooks?.beforeOperation?.[1]).toBe(existingBeforeOperation)
    expect(media?.hooks?.afterChange?.[0]).toBe(existingAfterChange)
    await media?.hooks?.beforeOperation?.[0]?.({ operation: 'create', req } as never)

    const metadata = await sharp(req.file.data).metadata()
    expect(metadata.width).toBe(320)
    expect(metadata.height).toBeLessThanOrEqual(320)
  })

  it('compresses a real upload and records its final Payload metrics', async () => {
    const config = applyPlugin()
    const media = config.collections?.[0]
    const source = await makeStillImage()
    const req = {
      context: {},
      file: {
        data: source,
        mimetype: 'image/jpeg',
        name: 'photo.jpg',
        size: source.length,
      },
    }

    await media?.hooks?.beforeOperation?.[0]?.({ operation: 'create', req } as never)
    expect(req.file.mimetype).toBe('image/webp')
    expect(req.file.size).toBeLessThan(source.length)

    const result = await media?.hooks?.beforeChange?.at(-1)?.({
      data: { filesize: req.file.size, mimeType: req.file.mimetype },
      operation: 'create',
      req,
    } as never)

    expect(result).toMatchObject({
      imageCompression: {
        optimizedSize: req.file.size,
        originalMimeType: 'image/jpeg',
        originalSize: source.length,
        outputMimeType: 'image/webp',
        status: 'complete',
      },
    })
  })

  it('keeps the original when the candidate is not smaller', async () => {
    const source = await sharp({
      create: { background: '#fff', channels: 3, height: 1, width: 1 },
    })
      .jpeg({ quality: 1 })
      .toBuffer()
    const options = sanitizeImageCompressionOptions({
      collections: ['media'],
      format: 'jpeg',
      formatOptions: { quality: 100 },
    })
    const result = await processImage({
      file: {
        data: source,
        mimetype: 'image/jpeg',
        name: 'pixel.jpg',
        size: source.length,
      },
      options,
      sharp,
    })

    expect(result.status).toBe('kept-original')
    expect(result.file.data).toBe(source)
    expect(result.file.mimetype).toBe('image/jpeg')
  })

  it('applies minimum, maximum, and decoded-pixel limits', async () => {
    const source = await makeStillImage(40, 40)
    const file = {
      data: source,
      mimetype: 'image/jpeg',
      name: 'limited.jpg',
      size: source.length,
    }

    const belowMinimum = await processImage({
      file,
      options: sanitizeImageCompressionOptions({
        collections: ['media'],
        minFileSize: source.length + 1,
      }),
      sharp,
    })
    const aboveMaximum = await processImage({
      file,
      options: sanitizeImageCompressionOptions({
        collections: ['media'],
        maxFileSize: source.length - 1,
      }),
      sharp,
    })

    expect(belowMinimum.status).toBe('skipped')
    expect(aboveMaximum.status).toBe('skipped')
    await expect(
      processImage({
        file,
        options: sanitizeImageCompressionOptions({
          collections: ['media'],
          maxInputPixels: 100,
        }),
        sharp,
      }),
    ).rejects.toThrow()
  })

  it('keeps the source or throws when Sharp processing fails', async () => {
    const invalidFile = {
      data: Buffer.from('not an image'),
      mimetype: 'image/jpeg',
      name: 'broken.jpg',
      size: 12,
    }
    const keepConfig = applyPlugin(uploadCollection(), { onError: 'keep-original' })
    const keepReq = { context: {}, file: invalidFile }

    await keepConfig.collections?.[0]?.hooks?.beforeOperation?.[0]?.({
      operation: 'create',
      req: keepReq,
    } as never)
    expect(keepReq.file).toBe(invalidFile)
    expect(keepReq.context).toMatchObject({
      imageCompressionPlugin: { status: 'failed' },
    })
    const failedData = await keepConfig.collections?.[0]?.hooks?.beforeChange?.at(-1)?.({
      data: { filesize: invalidFile.size, mimeType: invalidFile.mimetype },
      operation: 'create',
      req: keepReq,
    } as never)
    expect(failedData).toMatchObject({
      imageCompression: {
        optimizedSize: invalidFile.size,
        originalSize: invalidFile.size,
        savedBytes: 0,
        status: 'failed',
      },
    })

    const throwConfig = applyPlugin(uploadCollection(), { onError: 'throw' })
    await expect(
      throwConfig.collections?.[0]?.hooks?.beforeOperation?.[0]?.({
        operation: 'create',
        req: { context: {}, file: invalidFile },
      } as never),
    ).rejects.toThrow()
  })

  it.each(['gif', 'tiff'] as const)(
    'preserves all pages from a multi-page %s fixture',
    async (format) => {
      const source = await makeMultiPageImage(format)
      const result = await processImage({
        file: {
          data: source,
          mimetype: `image/${format}`,
          name: `animation.${format}`,
          size: source.length,
        },
        options: sanitizeImageCompressionOptions({
          collections: ['media'],
          skipIfLarger: false,
        }),
        sharp,
      })
      const metadata = await sharp(result.file.data, { animated: true }).metadata()

      expect(result.file.mimetype).toBe('image/webp')
      expect(metadata.pages).toBe(2)
    },
  )

  it('queues a serializable background task after the original is stored', async () => {
    const enqueue = vi.fn()
    const config = applyPlugin(uploadCollection(), { background: { enqueue } }, false)
    const media = config.collections?.[0]
    const req = {
      context: {},
      file: {
        data: Buffer.alloc(10),
        mimetype: 'image/jpeg',
        name: 'queued.jpg',
        size: 10,
      },
      payload: {
        findGlobal: vi.fn().mockResolvedValue({
          enabled: true,
          maxDimension: 1024,
          minFileSizeKB: 0,
          preset: 'quality',
          preserveMetadata: true,
        }),
        logger: { error: vi.fn() },
      },
    }

    await media?.hooks?.beforeOperation?.[0]?.({ operation: 'create', req } as never)
    const data = await media?.hooks?.beforeChange?.at(-1)?.({
      data: { filesize: 10, mimeType: 'image/jpeg' },
      operation: 'create',
      req,
    } as never)
    await media?.hooks?.afterChange?.at(-1)?.({
      doc: {
        filename: 'queued.jpg',
        id: 'media-id',
        mimeType: 'image/jpeg',
        url: 'https://cdn.example.com/queued.jpg',
      },
      operation: 'create',
      req,
    } as never)

    expect(data).toMatchObject({ imageCompression: { status: 'pending' } })
    expect(enqueue).toHaveBeenCalledWith({
      collection: 'media',
      documentId: 'media-id',
      filename: 'queued.jpg',
      mimeType: 'image/jpeg',
      originalSize: 10,
      settings: {
        format: 'webp',
        formatOptions: { effort: 4, quality: 90 },
        maxFileSize: Number.MAX_SAFE_INTEGER,
        maxHeight: 1024,
        maxInputPixels: 100_000_000,
        maxWidth: 1024,
        minFileSize: 0,
        preserveMetadata: true,
        skipIfLarger: true,
      },
      url: 'https://cdn.example.com/queued.jpg',
    })
  })

  it.each([
    {
      name: 'Vercel Blob',
      storage: vercelBlobStorage({
        clientUploads: true,
        collections: { media: true },
        token: 'vercel_blob_rw_store_random',
      }),
    },
    {
      name: 'S3',
      storage: s3Storage({
        bucket: 'test-bucket',
        clientUploads: true,
        collections: { media: true },
        config: {
          credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
          region: 'us-east-1',
        },
      }),
    },
  ])('composes with $name client uploads', ({ storage }) => {
    const compressedConfig = applyPlugin()
    const config = storage(compressedConfig) as Config
    const media = config.collections?.find((collection) => collection.slug === 'media')
    const upload = media?.upload && media.upload !== true ? media.upload : undefined

    expect(upload?.disableLocalStorage).toBe(true)
    expect(upload?.handlers?.length).toBeGreaterThan(0)
    expect(upload?.imageSizes?.[0]?.formatOptions).toMatchObject({ format: 'webp' })
    expect(media?.hooks?.beforeOperation?.length).toBeGreaterThan(0)
  })

  it('protects metadata, supports disabled mode, and validates configuration', async () => {
    const config = applyPlugin()
    const media = config.collections?.[0]
    const metadataField = media?.fields.find(
      (field) => 'name' in field && field.name === 'imageCompression',
    )
    if (!metadataField || metadataField.type !== 'group' || !('name' in metadataField)) {
      throw new Error('Expected imageCompression group field')
    }

    const existingMetrics = { originalSize: 1000, savedPercent: 40, status: 'complete' }
    const protectedValue = await metadataField.hooks?.beforeChange?.[0]?.({
      originalDoc: { imageCompression: existingMetrics },
      req: { context: {} },
      value: { savedPercent: 99 },
    } as never)
    expect(protectedValue).toEqual(existingMetrics)

    const disabled = applyPlugin(uploadCollection(), { disabled: true }, false)
    expect(disabled.collections?.[0]?.hooks?.beforeOperation).toBeUndefined()
    expect(() =>
      sanitizeImageCompressionOptions({
        collections: ['media'],
        maxFileSize: 100,
        minFileSize: 101,
      }),
    ).toThrow('minFileSize cannot exceed maxFileSize')
    expect(() => applyPlugin(uploadCollection({ upload: undefined }))).toThrow(
      'collection "media" is not upload-enabled',
    )
  })
})
