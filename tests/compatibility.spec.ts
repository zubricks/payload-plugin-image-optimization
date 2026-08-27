import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const readProjectFile = (path: string): string =>
  readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

describe('Payload version compatibility', () => {
  it('does not depend on Payload 3 private Sass APIs', () => {
    const css = readProjectFile('src/components/styles.css')

    expect(css).not.toContain('@payloadcms/ui/scss')
    expect(css).not.toContain('@include')
    expect(css).not.toMatch(/\bbase\(/)
  })

  it('accepts Payload 3 and Payload 4 as peer dependencies', () => {
    const manifest = JSON.parse(readProjectFile('package.json')) as {
      peerDependencies: Record<string, string>
    }

    expect(manifest.peerDependencies.payload).toBe('^3.88.0 || >=4.0.0-0 <5.0.0')
    expect(manifest.peerDependencies['@payloadcms/ui']).toBe(
      '^3.88.0 || >=4.0.0-0 <5.0.0',
    )
  })
})
