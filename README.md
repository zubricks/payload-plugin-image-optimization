<img width="1200" height="375" alt="github-header" src="https://github.com/user-attachments/assets/291ef5cd-e462-48d1-8145-a19222e037f6" />

# Image Optimization for Payload

Dependency-light image optimization for Payload. The plugin uses Payload's existing `sharp`
dependency, owns the stored-original encode so it can make reliable fallback decisions, and leaves
file persistence to Payload and its storage adapters.

## Installation

```sh
pnpm add @zubricks/payload-plugin-image-optimization sharp
```

Payload, React, `@payloadcms/ui`, and Sharp are peer dependencies. This package supports Payload
3.88 and newer, including Payload 4. The plugin itself supports Node.js 20.9 and newer; your chosen
Payload release may require a newer Node.js version (Payload 4 currently requires Node.js 24.15+).

Import the plugin and add it to the `plugins` array in `payload.config.ts` (or in the module where
your Payload plugins are assembled). Every collection listed in `collections` must be
upload-enabled.

```ts
import { imageCompressionPlugin } from '@zubricks/payload-plugin-image-optimization'
import { buildConfig } from 'payload'
import sharp from 'sharp'

export default buildConfig({
  // ...your existing Payload config
  plugins: [
    imageCompressionPlugin({
      collections: ['media'],
    }),
  ],
  sharp,
})
```

After changing the plugin configuration, regenerate Payload's import map and types, then restart
the development server:

```sh
pnpm payload generate:importmap
pnpm payload generate:types
pnpm dev
```

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
- Scans and optimizes media uploaded before the plugin was installed
- Supports a per-upload `Skip image optimization` override
- Leaves SVG, PDF, video, and document uploads untouched

## Inline usage

```ts
import { imageCompressionPlugin } from '@zubricks/payload-plugin-image-optimization'

imageCompressionPlugin({
  collections: ['media'],
  existingMedia: {
    batchSize: 5,
  },
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
stripping, `skipIfLarger: true`, `onError: 'keep-original'`, and existing-media admin actions in
batches of five.

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
- Scan and optimize existing, unprocessed media

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

## Existing media

The **Existing media** panel in the Image Optimization Global provides a two-step bulk workflow:

1. **Scan existing media** counts eligible images without changing them.
2. **Optimize images** processes bounded batches until the scan is complete.

An **Optimize Image** action also appears on individual media documents that do not have
compression metrics yet. Both actions require an authenticated Payload user and execute collection
read and update access control. Existing documents with compression metrics are excluded by default
to prevent repeated lossy encoding. The per-document API supports an explicit `force` request for
application-specific tooling, but the bundled admin UI does not force reprocessing.

Each existing file is submitted through `payload.update` as a normal replacement upload. That means
the plugin's current settings, Sharp limits, error behavior, generated `imageSize` derivatives,
storage adapters, hooks, and metrics remain authoritative. A format conversion can change the media
filename and URL; Payload relationships continue to reference the same document ID, but consumers
that persisted a raw URL may need updating.

Set `existingMedia: false` to remove the endpoint and admin controls, or configure the maximum work
performed by one request:

```ts
imageCompressionPlugin({
  collections: ['media'],
  existingMedia: {
    batchSize: 5, // 1–25; smaller batches are safer on serverless platforms
  },
})
```

Existing-media processing requires `metadata` because the stored status is the idempotency marker.
The bulk action is unavailable while optimization is disabled in the Image Optimization Global.
When `background` is configured, replacement uploads enter that same background interface and are
recorded as pending rather than being encoded inline.

### Private and custom storage

By default, the plugin first asks the upload collection's configured storage handlers for the file.
This avoids a serverless function making a request back through its own public media route and works
with storage adapters that return either file bytes or a signed redirect. If no storage handler
responds, the plugin reads the document's `url`. Cookies and authorization headers are forwarded
only for same-origin URLs; credentials are never sent to a cross-origin CDN. Public S3, Vercel Blob,
and other public object URLs work without additional configuration.

Provide `readFile` when originals require an SDK, signed request, private bucket credentials, or
custom retrieval logic. The callback runs on the server and keeps provider SDKs out of this package:

```ts
imageCompressionPlugin({
  collections: ['media'],
  existingMedia: {
    batchSize: 5,
    readFile: async ({ document, maxFileSize }) => {
      const data = await privateStorage.download(document.filename!)

      if (data.length > maxFileSize) {
        throw new Error('Stored image exceeds the configured maximum')
      }

      return {
        data,
        mimetype: document.mimeType!,
        name: document.filename!,
        size: data.length,
      }
    },
  },
})
```

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
import { createImageCompressionProcessor } from '@zubricks/payload-plugin-image-optimization'

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
uploads for larger inputs. Supported client-upload adapters rehydrate uploads into `req.file`,
allowing inline processing to run, but the decoded image must still fit within the function's memory
and duration limits. Background mode is recommended for large or CPU-expensive images.

Existing-media batches use short authenticated requests instead of a long-running in-process loop.
The admin client sends the next batch only after the previous batch completes, making the workflow
compatible with serverless execution limits and resumable after a browser or function interruption.

## Production deployment guidance

Sharp is a native peer dependency. The Payload application—not this plugin—must install Sharp
directly and package binaries that match its production operating system, CPU architecture, and C
standard library. A build created on macOS contains macOS binaries by default and cannot run on an
AWS Lambda Linux runtime unless the corresponding Linux binaries are also installed and copied into
the deployment artifact.

For a project built on macOS and deployed to an AWS Lambda ARM64 runtime, add this project-level
`pnpm-workspace.yaml`:

```yaml
supportedArchitectures:
  os:
    - darwin
    - linux
  cpu:
    - arm64
  libc:
    - glibc
```

Then reinstall dependencies, delete any previous Next.js build output, and rebuild the deployment
artifact:

```sh
pnpm install --force
rm -rf .next
pnpm build
```

Before deployment, confirm that a Next.js standalone build contains both of these directories:

```text
.next/standalone/node_modules/@img/sharp-linux-arm64/
.next/standalone/node_modules/@img/sharp-libvips-linux-arm64/
```

This example supports an Apple Silicon macOS builder and an ARM64 AWS Lambda target. Adjust or add
values to match both your build machine and deployment target: use `x64` for an Intel/x64 target.
Standard AWS Lambda runtimes use `glibc`; Alpine container images use `musl`. Building the artifact
in a Linux environment matching production is the most deterministic option.

If the packages are installed but omitted from a Next.js standalone artifact, include the runtime
files explicitly in `next.config`:

```ts
const nextConfig = {
  output: 'standalone',
  outputFileTracingIncludes: {
    '/*': [
      'node_modules/sharp/**/*',
      'node_modules/@img/sharp-linux-arm64/**/*',
      'node_modules/@img/sharp-libvips-linux-arm64/**/*',
    ],
  },
}
```

Do not add these platform settings to the plugin package itself. A reusable plugin cannot know
whether its host deploys to Lambda ARM64, Lambda x64, Alpine, Vercel, or a traditional Node server.

## Node-runtime compatibility matrix

Payload 3.88 and Payload 4 use different Admin UI styling APIs. Version 1.1.1 and newer ships
standalone CSS and does not depend on Payload's private Sass entrypoint. The release is built and
tested against Payload 3.88, and type-checked against Payload 4.0.0-canary.28. Payload 4 is still a
moving pre-release target, so newer canaries should be verified before production deployment.

| Runtime                                 | Support            | Notes                                                             |
| --------------------------------------- | ------------------ | ----------------------------------------------------------------- |
| Node.js 20.9+                           | Supported          | Minimum runtime supported by Sharp 0.34                           |
| Node.js 22                              | Tested             | Integration suite currently runs on Node 22                       |
| Node.js 24.15+                          | Required by v4      | Payload 4 runtime minimum; add runtime CI before claiming tested   |
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
- Existing-media reads require an accessible URL or a host-provided `readFile` implementation.
- Force-reprocessing existing compressed images is API-only to reduce accidental generation loss.
- Background mode defines queue and processor boundaries but does not assume a specific queue or
  storage provider.
- `onError` controls stored-original processing. Errors raised later by Payload while generating a
  configured derivative `imageSize` still follow Payload's normal upload failure behavior.
- Exact cloud-provider behavior still needs credentialed deployment smoke tests.
