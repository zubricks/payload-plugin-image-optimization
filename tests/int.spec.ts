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
            clientProps: { existingMediaEnabled: true, metricsPath: 'imageCompression' },
            path: '@zubricks/payload-plugin-image-optimization/client#CompressionSummary',
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
    expect(config.endpoints).toContainEqual(
      expect.objectContaining({
        method: 'post',
        path: '/image-optimization/existing',
      }),
    )
    expect(config.globals?.[0]?.fields).toContainEqual(
      expect.objectContaining({
        name: 'existingMediaOptimizer',
        type: 'ui',
      }),
    )
  })

  it('optimizes an existing document through Payload update and records metrics', async () => {
    const source = await makeStillImage()
    const readFile = vi.fn().mockResolvedValue({
      data: source,
      mimetype: 'image/jpeg',
      name: 'legacy.jpg',
      size: source.length,
    })
    const config = applyPlugin(uploadCollection(), { existingMedia: { readFile } })
    const media = config.collections?.[0]
    const endpoint = config.endpoints?.find(
      (candidate) => candidate.path === '/image-optimization/existing',
    )
    const document = {
      filename: 'legacy.jpg',
      filesize: source.length,
      id: 'legacy-id',
      mimeType: 'image/jpeg',
      url: 'https://cdn.example.com/legacy.jpg',
    }
    const req = {
      context: {},
      data: {},
      headers: new Headers(),
      json: vi.fn().mockResolvedValue({ collection: 'media', id: document.id }),
      payload: {
        config: { serverURL: 'https://cms.example.com' },
        findByID: vi.fn().mockResolvedValue(document),
        findGlobal: vi.fn().mockResolvedValue({ enabled: true }),
        update: vi.fn(),
      },
      url: 'https://cms.example.com/api/image-optimization/existing',
      user: { id: 'admin-id' },
    }

    req.payload.update.mockImplementation(
      async ({
        file,
      }: {
        file: { data: Buffer; mimetype: string; name: string; size: number }
      }) => {
        const hookReq = { ...req, context: {}, data: {}, file }
        await media?.hooks?.beforeOperation?.[0]?.({ operation: 'update', req: hookReq } as never)
        const data = await media?.hooks?.beforeChange?.at(-1)?.({
          data: { filesize: hookReq.file.size, mimeType: hookReq.file.mimetype },
          operation: 'update',
          req: hookReq,
        } as never)

        return { ...document, ...data }
      },
    )

    if (!endpoint) {
      throw new Error('Expected existing-media endpoint')
    }
    const response = await endpoint.handler(req as never)
    const body = (await response.json()) as {
      result: { optimizedSize: number; savedBytes: number; status: string }
    }

    expect(response.status).toBe(200)
    expect(readFile).toHaveBeenCalledWith({
      collection: 'media',
      document,
      maxFileSize: Number.MAX_SAFE_INTEGER,
      req,
    })
    expect(req.payload.update).toHaveBeenCalledWith(
      expect.objectContaining({
        collection: 'media',
        id: 'legacy-id',
        overwriteExistingFiles: true,
        overrideAccess: false,
        req,
      }),
    )
    expect(body.result.status).toBe('complete')
    expect(body.result.optimizedSize).toBeLessThan(source.length)
    expect(body.result.savedBytes).toBeGreaterThan(0)
  })

  it('previews and batches only unprocessed existing media', async () => {
    const source = await makeStillImage(80, 80)
    const documents = ['one', 'two'].map((id) => ({
      filename: `${id}.jpg`,
      filesize: source.length,
      id,
      mimeType: 'image/jpeg',
      url: `https://cdn.example.com/${id}.jpg`,
    }))
    const config = applyPlugin(uploadCollection(), {
      existingMedia: {
        batchSize: 2,
        readFile: ({ document }) =>
          Promise.resolve({
            data: source,
            mimetype: 'image/jpeg',
            name: document.filename!,
            size: source.length,
          }),
      },
    })
    const endpoint = config.endpoints?.find(
      (candidate) => candidate.path === '/image-optimization/existing',
    )
    const payload = {
      config: { serverURL: 'https://cms.example.com' },
      count: vi.fn().mockResolvedValue({ totalDocs: 2 }),
      find: vi.fn().mockResolvedValue({ docs: documents, totalDocs: 2 }),
      findGlobal: vi.fn().mockResolvedValue({ enabled: true }),
      update: vi.fn().mockImplementation(({ file, id }) => ({
        id,
        imageCompression: {
          optimizedSize: file.size,
          originalSize: file.size + 100,
          savedBytes: 100,
          status: 'complete',
        },
      })),
    }
    const makeReq = (body: Record<string, unknown>) => ({
      context: {},
      headers: new Headers(),
      json: vi.fn().mockResolvedValue(body),
      payload,
      url: 'https://cms.example.com/api/image-optimization/existing',
      user: { id: 'admin-id' },
    })

    if (!endpoint) {
      throw new Error('Expected existing-media endpoint')
    }
    const previewResponse = await endpoint.handler(
      makeReq({ collection: 'media', dryRun: true }) as never,
    )
    const preview = (await previewResponse.json()) as { eligible: number }
    const batchResponse = await endpoint.handler(makeReq({ collection: 'media' }) as never)
    const batch = (await batchResponse.json()) as {
      failed: number
      processed: number
      remaining: number
      savedBytes: number
    }

    expect(preview.eligible).toBe(2)
    expect(payload.count).toHaveBeenCalledWith(
      expect.objectContaining({
        collection: 'media',
        overrideAccess: false,
        where: expect.objectContaining({ and: expect.any(Array) }),
      }),
    )
    expect(payload.find).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 2, page: 1, sort: 'id' }),
    )
    expect(batch).toMatchObject({ failed: 0, processed: 2, remaining: 0, savedBytes: 200 })
    expect(payload.update).toHaveBeenCalledTimes(2)
  })

  it('does not re-optimize processed media unless an individual request forces it', async () => {
    const source = await makeStillImage(40, 40)
    const readFile = vi.fn().mockResolvedValue({
      data: source,
      mimetype: 'image/jpeg',
      name: 'processed.jpg',
      size: source.length,
    })
    const config = applyPlugin(uploadCollection(), { existingMedia: { readFile } })
    const endpoint = config.endpoints?.find(
      (candidate) => candidate.path === '/image-optimization/existing',
    )
    const document = {
      filename: 'processed.jpg',
      filesize: source.length,
      id: 'processed-id',
      imageCompression: { status: 'complete' },
      mimeType: 'image/jpeg',
      url: 'https://cdn.example.com/processed.jpg',
    }
    const payload = {
      config: { serverURL: 'https://cms.example.com' },
      findByID: vi.fn().mockResolvedValue(document),
      update: vi.fn().mockResolvedValue({
        ...document,
        imageCompression: { status: 'kept-original' },
      }),
    }
    const makeReq = (force = false) => ({
      context: {},
      headers: new Headers(),
      json: vi.fn().mockResolvedValue({
        collection: 'media',
        force,
        id: document.id,
      }),
      payload,
      url: 'https://cms.example.com/api/image-optimization/existing',
      user: { id: 'admin-id' },
    })

    if (!endpoint) {
      throw new Error('Expected existing-media endpoint')
    }
    const skippedResponse = await endpoint.handler(makeReq() as never)
    const skipped = (await skippedResponse.json()) as { result: { status: string } }
    expect(skipped.result.status).toBe('already-processed')
    expect(readFile).not.toHaveBeenCalled()

    const forcedResponse = await endpoint.handler(makeReq(true) as never)
    const forced = (await forcedResponse.json()) as { result: { status: string } }
    expect(forced.result.status).toBe('kept-original')
    expect(readFile).toHaveBeenCalledOnce()
    expect(payload.update).toHaveBeenCalledOnce()
  })

  it('reads public cloud URLs by default and forwards admin authentication', async () => {
    const source = await makeStillImage(40, 40)
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(source, {
        headers: { 'content-type': 'image/jpeg' },
        status: 200,
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const config = applyPlugin()
    const endpoint = config.endpoints?.find(
      (candidate) => candidate.path === '/image-optimization/existing',
    )
    const document = {
      filename: 'cloud.jpg',
      filesize: source.length,
      id: 'cloud-id',
      mimeType: 'image/jpeg',
      url: 'https://blob.example.com/cloud.jpg',
    }
    const req = {
      context: {},
      headers: new Headers({ authorization: 'Bearer token', cookie: 'payload-token=secret' }),
      json: vi.fn().mockResolvedValue({ collection: 'media', id: document.id }),
      payload: {
        config: { serverURL: 'https://cms.example.com' },
        findByID: vi.fn().mockResolvedValue(document),
        update: vi.fn().mockResolvedValue({
          ...document,
          imageCompression: { status: 'complete' },
        }),
      },
      url: 'https://cms.example.com/api/image-optimization/existing',
      user: { id: 'admin-id' },
    }

    if (!endpoint) {
      throw new Error('Expected existing-media endpoint')
    }
    await endpoint.handler(req as never)

    expect(fetchMock).toHaveBeenCalledWith(
      new URL(document.url),
      expect.objectContaining({
        headers: expect.objectContaining({}),
        redirect: 'follow',
      }),
    )
    const requestHeaders = fetchMock.mock.calls[0]?.[1]?.headers as Headers
    expect(requestHeaders.get('authorization')).toBeNull()
    expect(requestHeaders.get('cookie')).toBeNull()
    vi.unstubAllGlobals()
  })

  it('reads through the configured storage handler before falling back to the document URL', async () => {
    const source = await makeStillImage(40, 40)
    const signedURL = 'https://storage.example.com/signed-cloud.jpg'
    const storageHandler = vi.fn().mockResolvedValue(Response.redirect(signedURL, 302))
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(source, {
        headers: { 'content-type': 'image/jpeg' },
        status: 200,
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const config = applyPlugin()
    const endpoint = config.endpoints?.find(
      (candidate) => candidate.path === '/image-optimization/existing',
    )
    const document = {
      filename: 'cloud.jpg',
      filesize: source.length,
      id: 'cloud-id',
      mimeType: 'image/jpeg',
      prefix: 'originals',
      url: '/api/media/file/cloud.jpg',
    }
    const req = {
      context: {},
      headers: new Headers({ cookie: 'payload-token=secret' }),
      json: vi.fn().mockResolvedValue({ collection: 'media', id: document.id }),
      payload: {
        collections: {
          media: {
            config: {
              upload: { handlers: [storageHandler] },
            },
          },
        },
        config: { serverURL: '' },
        findByID: vi.fn().mockResolvedValue(document),
        update: vi.fn().mockResolvedValue({
          ...document,
          imageCompression: { status: 'complete' },
        }),
      },
      url: 'http://localhost:3000/api/image-optimization/existing',
      user: { id: 'admin-id' },
    }

    if (!endpoint) {
      throw new Error('Expected existing-media endpoint')
    }
    const response = await endpoint.handler(req as never)
    const body = (await response.json()) as { result: { status: string } }

    expect(body.result.status).toBe('complete')
    expect(storageHandler).toHaveBeenCalledWith(
      req,
      expect.objectContaining({
        doc: document,
        params: {
          collection: 'media',
          filename: 'cloud.jpg',
          prefix: 'originals',
        },
      }),
    )
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock).toHaveBeenCalledWith(
      signedURL,
      expect.objectContaining({ redirect: 'follow' }),
    )
    vi.unstubAllGlobals()
  })

  it('rejects unauthenticated existing-media requests and reports reader failures', async () => {
    const config = applyPlugin(uploadCollection(), {
      existingMedia: {
        readFile: () => Promise.reject(new Error('Private object is unavailable')),
      },
    })
    const endpoint = config.endpoints?.find(
      (candidate) => candidate.path === '/image-optimization/existing',
    )
    const payload = {
      config: { serverURL: 'https://cms.example.com' },
      findByID: vi.fn().mockResolvedValue({
        filename: 'private.jpg',
        filesize: 1024,
        id: 'private-id',
        mimeType: 'image/jpeg',
        url: 'https://private.example.com/private.jpg',
      }),
      update: vi.fn(),
    }
    const makeReq = (authenticated: boolean) => ({
      context: {},
      headers: new Headers(),
      json: vi.fn().mockResolvedValue({ collection: 'media', id: 'private-id' }),
      payload,
      url: 'https://cms.example.com/api/image-optimization/existing',
      user: authenticated ? { id: 'admin-id' } : null,
    })

    if (!endpoint) {
      throw new Error('Expected existing-media endpoint')
    }
    const unauthorized = await endpoint.handler(makeReq(false) as never)
    expect(unauthorized.status).toBe(401)
    expect(payload.findByID).not.toHaveBeenCalled()

    const failedResponse = await endpoint.handler(makeReq(true) as never)
    const failed = (await failedResponse.json()) as {
      result: { error: string; status: string }
    }
    expect(failed.result).toMatchObject({
      error: 'Private object is unavailable',
      status: 'failed',
    })
    expect(payload.update).not.toHaveBeenCalled()
  })

  it('respects the admin enabled setting for existing-media actions', async () => {
    const config = applyPlugin()
    const endpoint = config.endpoints?.find(
      (candidate) => candidate.path === '/image-optimization/existing',
    )
    const req = {
      context: {},
      headers: new Headers(),
      json: vi.fn().mockResolvedValue({ collection: 'media', dryRun: true }),
      payload: {
        config: { serverURL: 'https://cms.example.com' },
        count: vi.fn(),
        findGlobal: vi.fn().mockResolvedValue({ enabled: false }),
      },
      url: 'https://cms.example.com/api/image-optimization/existing',
      user: { id: 'admin-id' },
    }

    if (!endpoint) {
      throw new Error('Expected existing-media endpoint')
    }
    const response = await endpoint.handler(req as never)
    expect(response.status).toBe(409)
    expect(req.payload.count).not.toHaveBeenCalled()
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
    expect(() =>
      sanitizeImageCompressionOptions({
        collections: ['media'],
        existingMedia: true,
        metadata: false,
      }),
    ).toThrow('existingMedia requires metadata')
    expect(() =>
      sanitizeImageCompressionOptions({
        collections: ['media'],
        existingMedia: { batchSize: 26 },
      }),
    ).toThrow('existingMedia.batchSize must be between 1 and 25')
    expect(() => applyPlugin(uploadCollection({ upload: undefined }))).toThrow(
      'collection "media" is not upload-enabled',
    )
  })
})
