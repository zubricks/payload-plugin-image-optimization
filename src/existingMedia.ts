import type { CollectionSlug, Endpoint, PayloadRequest, Where } from 'payload'

import { optimizableMimeTypes } from './hooks/captureOriginalFile.js'
import {
  createImageCompressionSettingsResolver,
  skipImageOptimizationFieldName,
} from './settings.js'
import type {
  CompressionStatus,
  ExistingMediaDocument,
  ExistingMediaFile,
  ExistingMediaReadFileArgs,
  SanitizedImageCompressionOptions,
} from './types.js'

export const existingMediaEndpointPath = '/image-optimization/existing'

type ExistingMediaRequestBody = {
  collection?: unknown
  dryRun?: unknown
  force?: unknown
  id?: unknown
}

type ExistingMediaResult = {
  collection: CollectionSlug
  documentId: number | string
  error?: string
  optimizedSize?: number
  originalSize?: number
  savedBytes?: number
  status: CompressionStatus | 'already-processed'
}

type ExistingMediaPayloadAPI = {
  collections?: Record<
    string,
    {
      config?: {
        upload?:
          | boolean
          | {
              handlers?: Array<
                (
                  req: PayloadRequest,
                  args: {
                    doc: ExistingMediaDocument
                    params: {
                      collection: string
                      filename: string
                      prefix?: string
                    }
                  },
                ) => Promise<Response | void> | Response | void
              >
            }
      }
    }
  >
  count: (args: Record<string, unknown>) => Promise<{ totalDocs: number }>
  find: (args: Record<string, unknown>) => Promise<{
    docs: ExistingMediaDocument[]
    totalDocs: number
  }>
  findByID: (args: Record<string, unknown>) => Promise<ExistingMediaDocument>
  update: (args: Record<string, unknown>) => Promise<ExistingMediaDocument>
}

const readResponse = async ({
  maxFileSize,
  response,
}: {
  maxFileSize: number
  response: Response
}): Promise<Buffer> => {
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get('location')

    if (!location) {
      throw new Error('Existing-media storage handler returned a redirect without a location')
    }

    response = await fetch(location, {
      redirect: 'follow',
      signal: AbortSignal.timeout(30_000),
    })
  }

  if (!response.ok) {
    throw new Error(`Unable to read existing media (${response.status} ${response.statusText})`)
  }

  const contentLength = Number(response.headers.get('content-length'))

  if (Number.isFinite(contentLength) && contentLength > maxFileSize) {
    throw new Error('Existing media exceeds the configured maximum file size')
  }

  const data = Buffer.from(await response.arrayBuffer())

  if (data.length > maxFileSize) {
    throw new Error('Existing media exceeds the configured maximum file size')
  }

  return data
}

const readFromStorageHandler = async ({
  collection,
  document,
  maxFileSize,
  req,
}: ExistingMediaReadFileArgs): Promise<Buffer | undefined> => {
  const payload = req.payload as unknown as ExistingMediaPayloadAPI
  const upload = payload.collections?.[collection]?.config?.upload
  const handlers = upload && typeof upload === 'object' ? upload.handlers : undefined

  if (!handlers?.length || !document.filename) {
    return
  }

  for (const handler of handlers) {
    const response = await handler(req, {
      doc: document,
      params: {
        collection,
        filename: document.filename,
        ...(typeof document.prefix === 'string' ? { prefix: document.prefix } : {}),
      },
    })

    if (response) {
      return readResponse({ maxFileSize, response })
    }
  }
}

const isDocumentID = (value: unknown): value is number | string =>
  (typeof value === 'string' && value.length > 0) ||
  (typeof value === 'number' && Number.isFinite(value))

const getStoredStatus = (
  document: ExistingMediaDocument,
  metadataFieldName: string,
): CompressionStatus | undefined => {
  const metadata = document[metadataFieldName]

  if (!metadata || typeof metadata !== 'object') {
    return
  }

  const status = (metadata as Record<string, unknown>).status
  return typeof status === 'string' ? (status as CompressionStatus) : undefined
}

const getMetrics = (
  document: ExistingMediaDocument,
  metadataFieldName: string,
): Pick<ExistingMediaResult, 'optimizedSize' | 'originalSize' | 'savedBytes' | 'status'> => {
  const metadata = document[metadataFieldName]

  if (!metadata || typeof metadata !== 'object') {
    return { status: 'pending' }
  }

  const values = metadata as Record<string, unknown>
  const status =
    typeof values.status === 'string' ? (values.status as CompressionStatus) : 'pending'

  return {
    ...(typeof values.optimizedSize === 'number' ? { optimizedSize: values.optimizedSize } : {}),
    ...(typeof values.originalSize === 'number' ? { originalSize: values.originalSize } : {}),
    ...(typeof values.savedBytes === 'number' ? { savedBytes: values.savedBytes } : {}),
    status,
  }
}

const defaultReadFile = async (args: ExistingMediaReadFileArgs) => {
  const { document, maxFileSize, req } = args

  if (!document.filename || !document.mimeType) {
    throw new Error('The media document is missing filename or mimeType')
  }

  const storageData = await readFromStorageHandler(args)

  if (storageData) {
    return {
      data: storageData,
      mimetype: document.mimeType,
      name: document.filename,
      size: storageData.length,
    } satisfies ExistingMediaFile
  }

  if (!document.url) {
    throw new Error('The media document is missing a url and no storage handler returned the file')
  }

  const baseURL = req.payload.config.serverURL || req.url
  const url = new URL(document.url, baseURL)
  const headers = new Headers()
  const authorization = req.headers.get('authorization')
  const cookie = req.headers.get('cookie')
  const trustedOrigins = new Set<string>()
  const serverURL = req.payload.config.serverURL

  if (req.url) {
    trustedOrigins.add(new URL(req.url).origin)
  }

  if (serverURL) {
    trustedOrigins.add(new URL(serverURL).origin)
  }

  if (trustedOrigins.has(url.origin)) {
    if (authorization) {
      headers.set('authorization', authorization)
    }
    if (cookie) {
      headers.set('cookie', cookie)
    }
  }

  const response = await fetch(url, {
    headers,
    redirect: 'follow',
    signal: AbortSignal.timeout(30_000),
  })

  const data = await readResponse({ maxFileSize, response })

  return {
    data,
    mimetype: document.mimeType,
    name: document.filename,
    size: data.length,
  } satisfies ExistingMediaFile
}

const getEligibleWhere = (options: SanitizedImageCompressionOptions): Where => ({
  and: [
    {
      mimeType: {
        in: [...optimizableMimeTypes],
      },
    },
    {
      filesize: {
        greater_than_equal: options.minFileSize,
      },
    },
    {
      filesize: {
        less_than_equal: options.maxFileSize,
      },
    },
    {
      [skipImageOptimizationFieldName]: {
        not_equals: true,
      },
    },
    {
      [`${options.metadataFieldName}.status`]: {
        exists: false,
      },
    },
  ],
})

const optimizeDocument = async ({
  collection,
  document,
  force,
  options,
  req,
}: {
  collection: CollectionSlug
  document: ExistingMediaDocument
  force: boolean
  options: SanitizedImageCompressionOptions
  req: PayloadRequest
}): Promise<ExistingMediaResult> => {
  const existingStatus = getStoredStatus(document, options.metadataFieldName)

  if (existingStatus && !force) {
    return {
      collection,
      documentId: document.id,
      status: 'already-processed',
    }
  }

  if (document[skipImageOptimizationFieldName] === true) {
    return { collection, documentId: document.id, status: 'skipped' }
  }

  if (!document.mimeType || !optimizableMimeTypes.has(document.mimeType)) {
    return { collection, documentId: document.id, status: 'skipped' }
  }

  const readFile =
    options.existingMedia && options.existingMedia.readFile
      ? options.existingMedia.readFile
      : defaultReadFile

  try {
    const file = await readFile({
      collection,
      document,
      maxFileSize: options.maxFileSize,
      req,
    })

    if (file.size !== file.data.length) {
      throw new Error('Existing-media reader returned a size that does not match its buffer')
    }

    if (file.size < options.minFileSize || file.size > options.maxFileSize) {
      return { collection, documentId: document.id, status: 'skipped' }
    }

    const payload = req.payload as unknown as ExistingMediaPayloadAPI
    const updated = await payload.update({
      collection,
      context: { imageCompressionExistingMedia: true },
      data: {},
      file,
      id: document.id,
      overwriteExistingFiles: true,
      overrideAccess: false,
      req,
    })

    return {
      collection,
      documentId: document.id,
      ...getMetrics(updated, options.metadataFieldName),
    }
  } catch (error) {
    return {
      collection,
      documentId: document.id,
      error: error instanceof Error ? error.message : 'Unknown existing-media optimization error',
      status: 'failed',
    }
  }
}

export const createExistingMediaEndpoint = (
  options: SanitizedImageCompressionOptions,
): Endpoint => ({
  handler: async (req) => {
    if (!req.user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = (await req.json?.()) as ExistingMediaRequestBody | undefined
    const collection = body?.collection

    if (
      typeof collection !== 'string' ||
      !options.collections.some((candidate) => candidate === collection)
    ) {
      return Response.json({ error: 'Invalid image optimization collection' }, { status: 400 })
    }

    const settings = await createImageCompressionSettingsResolver(options)(req)

    if (!settings.enabled) {
      return Response.json(
        { error: 'Image optimization is disabled in the admin settings' },
        { status: 409 },
      )
    }

    const resolvedOptions = settings.options

    const payload = req.payload as unknown as ExistingMediaPayloadAPI
    const collectionSlug = collection as CollectionSlug

    if (isDocumentID(body?.id)) {
      const document = await payload.findByID({
        collection: collectionSlug,
        depth: 0,
        id: body.id,
        overrideAccess: false,
        req,
      })
      const result = await optimizeDocument({
        collection: collectionSlug,
        document,
        force: body?.force === true,
        options: resolvedOptions,
        req,
      })

      return Response.json({ result })
    }

    const where = getEligibleWhere(resolvedOptions)

    if (body?.dryRun === true) {
      const { totalDocs } = await payload.count({
        collection: collectionSlug,
        overrideAccess: false,
        req,
        where,
      })

      return Response.json({ collection: collectionSlug, eligible: totalDocs })
    }

    const batch = await payload.find({
      collection: collectionSlug,
      depth: 0,
      limit: resolvedOptions.existingMedia ? resolvedOptions.existingMedia.batchSize : 5,
      overrideAccess: false,
      page: 1,
      req,
      sort: 'id',
      where,
    })
    const results: ExistingMediaResult[] = []

    // Reuse the authenticated request sequentially so hooks never share mutable request context.
    for (const document of batch.docs) {
      results.push(
        await optimizeDocument({
          collection: collectionSlug,
          document,
          force: false,
          options: resolvedOptions,
          req,
        }),
      )
    }

    const failed = results.filter((result) => result.status === 'failed').length
    const processed = results.length - failed
    const savedBytes = results.reduce((total, result) => total + (result.savedBytes ?? 0), 0)

    return Response.json({
      collection: collectionSlug,
      failed,
      processed,
      remaining: Math.max(0, batch.totalDocs - processed),
      results,
      savedBytes,
    })
  },
  method: 'post',
  path: existingMediaEndpointPath,
})
