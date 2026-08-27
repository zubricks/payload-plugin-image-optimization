import type { Field } from 'payload'

import { compressionContextKey } from '../hooks/captureOriginalFile.js'

export const compressionMetadataFields = (name: string, existingMediaEnabled = false): Field[] => [
  {
    name,
    type: 'group',
    admin: {
      hidden: true,
    },
    hooks: {
      beforeChange: [
        ({ originalDoc, req, value }) => {
          if (req.context[compressionContextKey]) {
            return value
          }

          const existingValue = originalDoc?.[name]
          return typeof existingValue === 'object' ? existingValue : null
        },
      ],
    },
    fields: [
      {
        name: 'status',
        type: 'select',
        options: [
          { label: 'Complete', value: 'complete' },
          { label: 'Failed', value: 'failed' },
          { label: 'Original kept', value: 'kept-original' },
          { label: 'Larger than source', value: 'larger-than-source' },
          { label: 'Pending', value: 'pending' },
          { label: 'Skipped', value: 'skipped' },
        ],
      },
      {
        name: 'originalSize',
        type: 'number',
      },
      {
        name: 'optimizedSize',
        type: 'number',
      },
      {
        name: 'savedBytes',
        type: 'number',
      },
      {
        name: 'savedPercent',
        type: 'number',
      },
      {
        name: 'originalMimeType',
        type: 'text',
      },
      {
        name: 'outputMimeType',
        type: 'text',
      },
      {
        name: 'error',
        type: 'text',
      },
    ],
  },
  {
    name: `${name}Summary`,
    type: 'ui',
    admin: {
      components: {
        Field: {
          clientProps: {
            existingMediaEnabled,
            metricsPath: name,
          },
          path: '@zubricks/payload-plugin-image-optimization/client#CompressionSummary',
        },
      },
    },
  },
]
