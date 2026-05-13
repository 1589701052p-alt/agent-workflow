import { SHARED_PACKAGE_VERSION } from '@agent-workflow/shared'

export function App() {
  return (
    <div style={{ fontFamily: 'system-ui', padding: 24 }}>
      <h1>Agent Workflow</h1>
      <p>M0 scaffold — real UI begins in M1 (P-1-16).</p>
      <p>shared package version: {SHARED_PACKAGE_VERSION}</p>
    </div>
  )
}
