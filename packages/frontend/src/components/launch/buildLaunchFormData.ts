// RFC-020: pure helper that turns a launch-form snapshot into a FormData
// body suitable for `POST /api/tasks` multipart. Kept separate from the
// route component so unit tests can assert the exact field shape.
//
// Contract (mirrors backend/routes/tasks.ts handleMultipartTaskStart):
//   - `payload` field: JSON-encoded StartTask body (inputs[uploadKey] is the
//     empty string; the backend overwrites it with the packed paths after
//     landing files in the worktree).
//   - `files[<inputKey>][]` fields: one Blob entry per File, preserving
//     order so the backend's packed-paths list matches the user's selection.

export interface LaunchPayload {
  workflowId: string
  repoPath: string
  baseBranch: string
  inputs: Record<string, string>
}

export function buildLaunchFormData(
  payload: LaunchPayload,
  uploads: Record<string, File[]>,
): FormData {
  // Make sure every declared upload key shows up in inputs[] (as ''), so the
  // backend can detect 'this is an upload-kind input' without leaking File
  // objects through the JSON payload.
  const inputsOut: Record<string, string> = { ...payload.inputs }
  for (const key of Object.keys(uploads)) {
    if (!(key in inputsOut)) inputsOut[key] = ''
  }
  const fd = new FormData()
  fd.set(
    'payload',
    new Blob([JSON.stringify({ ...payload, inputs: inputsOut })], {
      type: 'application/json',
    }),
  )
  for (const [key, list] of Object.entries(uploads)) {
    for (const f of list) {
      fd.append(`files[${key}][]`, f, f.name)
    }
  }
  return fd
}
