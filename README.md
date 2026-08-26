# Image Optimization for Payload

Dependency-light image optimization for Payload. The plugin uses the project's existing `sharp`
dependency, owns the stored-original encode so it can make reliable fallback decisions, and leaves
file persistence to Payload and its storage adapters.

## Installation

```sh
pnpm add payload-plugin-image-optimization sharp
```

Payload, React, `@payloadcms/ui`, and Sharp are peer dependencies. This package targets Payload
3.88 or newer and Node.js 20.9 or newer.

## Current behavior

- Optimizes new and replaced raster-image originals
- Applies the selected output format to every configured Payload `imageSize`
- Supports WebP, AVIF, JPEG, and PNG output
- Preserves animated GIF, WebP, AVIF, and multi-page TIFF inputs when the output codec supports it
- Limits dimensions without enlargement
- Skips files outside configurable byte thresholds
- Rejects decoded images above a configurable pixel limit
- Keeps the source when the encoded candidate is not smaller by default
- Keeps the source on Sharp errors by default, with strict failure available
- Strips metadata by default
- Records status and size metrics in a read-only admin summary
- Adds authenticated admin settings for stored-original optimization
- Supports a per-upload `Skip image optimization` override
- Leaves SVG, PDF, video, and document uploads untouched

## Inline usage

```ts
import { imageCompressionPlugin } from 'payload-plugin-image-optimization'

imageCompressionPlugin({
  collections: ['media'],
  format: 'webp',
  formatOptions: {
    effort: 4,
    quality: 82,
  },
  maxFileSize: 25 * 1024 * 1024,
  maxHeight: 2560,
  maxInputPixels: 100_000_000,
  maxWidth: 2560,
  minFileSize: 32 * 1024,
  onError: 'keep-original',
  preserveMetadata: false,
  skipIfLarger: true,
})
```

Defaults are WebP quality 82, effort 4, maximum dimensions of 2560 by 2560 pixels, a 100 megapixel
decoded-input limit, no minimum byte threshold, no plugin-level maximum byte threshold, metadata
stripping, `skipIfLarger: true`, and `onError: 'keep-original'`.

`minFileSize` and `maxFileSize` define the range the plugin will attempt to compress. Files outside
that range are stored unchanged with a `skipped` status. Payload's root `upload.limits.fileSize`
should still be configured when uploads above a certain size must be rejected entirely.

`maxInputPixels` is passed to Sharp's constructor. If it is exceeded, `onError` determines whether
the upload fails or the original is stored.

Collection-level `resizeOptions` are consumed by the plugin and applied after its default `inside`
resize settings, preserving intentional project overrides. Payload still owns derivative
`imageSize` generation and storage.

## Admin settings

The plugin adds an **Image Optimization** Global under **Settings**. Authenticated admin users can
control stored-original processing without a redeploy:

- Enable or disable optimization
- Select Balanced, Higher quality, or Maximum savings
- Lower the maximum image dimension within the developer-configured ceiling
- Raise the minimum file size within the developer-configured limits
- Preserve or strip metadata

Each configured upload collection also receives a sidebar **Skip image optimization** checkbox.
This keeps that document's uploaded original unchanged while Payload continues to generate its
configured image sizes normally.

Infrastructure and safety controls remain code-only: collections, background adapters,
`maxFileSize`, `maxInputPixels`, `onError`, `skipIfLarger`, metadata field names, and raw Sharp
options. The Global cannot increase the configured dimension ceiling or lower the configured
minimum file size.

Admin values are resolved once per upload. In background mode, the resolved processing settings
are copied into the serialized task so queued work is deterministic even if the Global changes
before a worker runs. Payload image-size encoder options are startup configuration, so the admin
preset and metadata toggle apply to the stored original; generated sizes continue to use the
code-configured encoder settings.

## Background-processing interface

Supplying `background` stores the original without inline image manipulation and calls `enqueue`
after the document has been saved. The task is JSON-serializable and contains storage-neutral
identifiers and a snapshot of the resolved processing settings.

```ts
imageCompressionPlugin({
  collections: ['media'],
  background: {
    enqueue: async (task) => {
      await queue.publish('compress-payload-image', task)
    },
  },
})
```

Workers can reuse the same codec behavior without depending on plugin internals:

```ts
import sharp from 'sharp'
import { createImageCompressionProcessor } from 'payload-plugin-image-optimization'

const processImage = createImageCompressionProcessor(
  {
    collections: ['media'],
    format: 'webp',
    skipIfLarger: true,
  },
  sharp,
)

const result = await processImage({
  file: {
    data: sourceBuffer,
    mimetype: sourceMimeType,
    name: sourceFilename,
    size: sourceBuffer.length,
  },
})
```

For a queued task, call the lower-level exported `processImage` with `task.settings`; those are the
exact options resolved when the upload was accepted.

The host worker is responsible for retrieving the referenced source, persisting `result.file`, and
updating the Payload document and metrics. This boundary deliberately avoids bundling Vercel, AWS,
or other cloud SDKs into the core plugin.

## Storage and serverless compatibility

The test suite composes the plugin with `clientUploads: true` configurations for the official
`@payloadcms/storage-vercel-blob` and `@payloadcms/storage-s3` adapters. These tests verify that
client-upload handlers, cloud-only storage, compression hooks, and image-size options survive
plugin composition. Live provider credentials and network behavior still require deployment smoke
tests before release.

Vercel server uploads have a 4.5 MB request-body limit. Use an official storage adapter with client
uploads for larger inputs. Payload 3.88 rehydrates supported client uploads into `req.file`, allowing
inline processing to run, but the decoded image must still fit within the function's memory and
duration limits. Background mode is recommended for large or CPU-expensive images.

## Node-runtime compatibility matrix

| Runtime                                 | Support            | Notes                                                             |
| --------------------------------------- | ------------------ | ----------------------------------------------------------------- |
| Node.js 20.9+                           | Supported          | Minimum runtime supported by Sharp 0.34                           |
| Node.js 22                              | Tested             | Integration suite currently runs on Node 22                       |
| Node.js 24                              | Expected           | Supported by Sharp; add CI before claiming tested support         |
| Node.js 18                              | Unsupported        | Below Sharp 0.34's Node-API runtime requirement                   |
| Vercel Node.js Functions                | Supported          | Requires persistent storage; use client uploads above 4.5 MB      |
| AWS Lambda Node.js                      | Supported          | Deployment must include the matching Linux Sharp binary           |
| Traditional Node servers and containers | Supported          | Persistent local or cloud storage is required                     |
| Payload Cloud                           | Expected           | Node/Sharp-compatible; add a release smoke test                   |
| Cloudflare Workers / Edge runtimes      | Inline unsupported | Use background/external processing; native Sharp cannot run there |
| Bun and Deno                            | Not supported      | Outside the published compatibility target                        |

CI covers Node 20 and 22 on Linux x64. Linux arm64 should be added before claiming arm64 support.

## Remaining limits

- Conversion uses one output format per configured collection.
- Existing files are unchanged until re-uploaded or processed by a host-provided background worker.
- A built-in bulk-recompression command is not included yet.
- Background mode defines queue and processor boundaries but does not assume a specific queue or
  storage provider.
- `onError` controls stored-original processing. Errors raised later by Payload while generating a
  configured derivative `imageSize` still follow Payload's normal upload failure behavior.
- Exact cloud-provider behavior still needs credentialed deployment smoke tests.

## Development

```sh
pnpm install
```

The standalone Vitest suite covers image processing, plugin composition, background jobs, animated
and multi-page images, and Vercel Blob/S3 client-upload configuration. Use a consuming Payload app
for manual admin and end-to-end upload testing.

Useful commands:

```sh
pnpm lint
pnpm test:int
pnpm build
npm pack --dry-run
```

## Publishing

The package starts at `0.1.0`. Before publishing, update the version according to SemVer, review the
contents reported by `npm pack --dry-run`, then publish to npm:

```sh
npm login
npm publish --access public
```

The package name `payload-plugin-image-optimization` was available when this project was scaffolded,
but npm ownership is not reserved until the first successful publish.
