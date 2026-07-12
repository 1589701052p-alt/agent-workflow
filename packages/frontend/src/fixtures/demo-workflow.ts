// P-5-10: demo workflow imported by the first-run onboarding card.
//
// Shape mirrors the YAML format that workflows.tsx's "Import YAML" picker
// accepts (top-level name / description / definition fields, see
// design/docs/workflow-yaml.md). The agent name `coder` is also what the
// onboarding step list tells the user to create — pair them by convention,
// not by binding. If the user creates a different agent the workflow will
// fail validation with `agent-not-found` and they can rename the node.

// 2026-07-10 naming unification: workflow names are slug-only now and the
// demo goes through the real import endpoint, so the name must comply.
export const DEMO_WORKFLOW_NAME = 'demo-single-agent-code'

export const DEMO_WORKFLOW_YAML = `name: ${DEMO_WORKFLOW_NAME}
description: |
  Three-node workflow that hands a task description to a "coder" agent and
  exposes its first declared port as the task output. Create an agent named
  "coder" with outputs: [code] to make this runnable.
definition:
  $schema_version: 1
  inputs:
    - kind: text
      key: task
      label: Task description
      required: true
      description: One paragraph describing what to do in the repo.
  nodes:
    - id: in_task
      kind: input
      inputKey: task
      position: { x: 80, y: 80 }
    - id: coder
      kind: agent-single
      agentName: coder
      promptTemplate: |
        Task: {{task}}

        Implement the change in the working repo. Keep edits scoped.
      position: { x: 320, y: 80 }
    - id: out
      kind: output
      ports:
        - name: result
          bind: { nodeId: coder, portName: code }
      position: { x: 600, y: 80 }
  edges:
    - id: e_in_coder
      source: { nodeId: in_task, portName: task }
      target: { nodeId: coder, portName: task }
`
