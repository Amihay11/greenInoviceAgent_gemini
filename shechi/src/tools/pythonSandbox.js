// MCP tool stub — Python (Numpy/Scipy) sandbox.
// Wire this to your sandbox provider (e.g. e2b, modal, local docker) in Phase 2.

export async function runPython({ code }) {
  return {
    ok: false,
    stub: true,
    note: 'pythonSandbox not configured. Set SANDBOX_PROVIDER and implement runPython.',
    echo: code,
  };
}
