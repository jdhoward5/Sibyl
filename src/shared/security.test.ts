import { describe, expect, it } from 'vitest'
import {
  developmentRendererPolicy,
  isAllowedRendererUrl,
  isExternalWebUrl,
  isTrustedRendererFrame,
  type RendererUrlPolicy
} from './security'

describe('renderer URL policy', () => {
  it('permits only the exact packaged renderer file', () => {
    const policy: RendererUrlPolicy = {
      kind: 'file',
      exactUrl: 'file:///C:/Program%20Files/Sibyl/resources/app.asar/out/renderer/index.html'
    }
    expect(isAllowedRendererUrl(policy.exactUrl, policy)).toBe(true)
    expect(
      isAllowedRendererUrl(
        'file:///C:/Program%20Files/Sibyl/resources/app.asar/out/renderer/other.html',
        policy
      )
    ).toBe(false)
    expect(isAllowedRendererUrl(`${policy.exactUrl}?unexpected=1`, policy)).toBe(false)
    expect(isAllowedRendererUrl('file:///C:/Users/user/dropped.html', policy)).toBe(false)
  })

  it('permits only the parsed configured development origin', () => {
    const policy = developmentRendererPolicy('http://localhost:5173/app/')
    expect(isAllowedRendererUrl('http://localhost:5173/', policy)).toBe(true)
    expect(isAllowedRendererUrl('http://localhost:5173/src/main.tsx', policy)).toBe(true)
    expect(isAllowedRendererUrl('http://localhost:5174/', policy)).toBe(false)
    expect(isAllowedRendererUrl('http://127.0.0.1:5173/', policy)).toBe(false)
    expect(isAllowedRendererUrl('file:///C:/tmp/other.html', policy)).toBe(false)
  })

  it('recognizes only HTTP(S) as external-browser links', () => {
    expect(isExternalWebUrl('https://example.com')).toBe(true)
    expect(isExternalWebUrl('http://example.com')).toBe(true)
    expect(isExternalWebUrl('file:///C:/secret.txt')).toBe(false)
    expect(isExternalWebUrl('javascript:alert(1)')).toBe(false)
  })

  it('rejects IPC senders from subframes and unexpected documents', () => {
    const policy: RendererUrlPolicy = { kind: 'file', exactUrl: 'file:///app/index.html' }
    expect(
      isTrustedRendererFrame(
        { senderDestroyed: false, isMainFrame: true, isTopFrame: true, url: policy.exactUrl },
        policy
      )
    ).toBe(true)
    expect(
      isTrustedRendererFrame(
        { senderDestroyed: false, isMainFrame: false, isTopFrame: false, url: policy.exactUrl },
        policy
      )
    ).toBe(false)
    expect(
      isTrustedRendererFrame(
        { senderDestroyed: false, isMainFrame: true, isTopFrame: true, url: 'file:///tmp/other.html' },
        policy
      )
    ).toBe(false)
  })
})
