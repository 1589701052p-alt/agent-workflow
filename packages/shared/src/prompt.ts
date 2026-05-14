// Prompt assembly logic shared between the backend runner and the frontend
// preview pane (NodeInspector). Pure functions — no Bun / Node / DB
// imports. Mirrors design.md §7.2.

export interface RenderPromptInput {
  /** Node-level prompt template. May be undefined or empty. */
  promptTemplate?: string
  /** Resolved input ports — { portName -> concatenated content }. */
  inputs: Record<string, string>
  /** Built-in template variables. */
  meta: {
    repoPath: string
    baseBranch: string
    taskId: string
  }
  /** Declared outputs for the protocol block instructions. */
  agentOutputs: string[]
}

const TEMPLATE_RE = /\{\{(\w+)\}\}/g

const BUILTIN_VARS = new Set(['__repo_path__', '__base_branch__', '__task_id__'])

/**
 * Compose the user-prompt string sent to opencode for one node invocation:
 *
 *   1. Node-level template with `{{port_name}}` + built-in substitutions.
 *   2. Per-port sections for any input not referenced by the template.
 *   3. English protocol block at the end instructing the agent how to format
 *      its `<workflow-output>` reply.
 */
export function renderUserPrompt(input: RenderPromptInput): string {
  const tpl = input.promptTemplate ?? ''
  const referenced = new Set<string>()

  const body = tpl.replace(TEMPLATE_RE, (_match, name: string) => {
    referenced.add(name)
    if (BUILTIN_VARS.has(name)) {
      switch (name) {
        case '__repo_path__':
          return input.meta.repoPath
        case '__base_branch__':
          return input.meta.baseBranch
        case '__task_id__':
          return input.meta.taskId
      }
    }
    const v = input.inputs[name]
    return v ?? ''
  })

  let sections = ''
  for (const [name, content] of Object.entries(input.inputs)) {
    if (referenced.has(name)) continue
    sections += `\n\n## ${name}\n${content}`
  }

  return body + sections + buildProtocolBlock(input.agentOutputs)
}

/**
 * The English protocol block. Always appended to user prompt, never to the
 * agent's system prompt (agent.md body is passed through verbatim).
 */
export function buildProtocolBlock(agentOutputs: string[]): string {
  let s = '\n\n---\nYou MUST end your reply with a `<workflow-output>` block listing these ports:\n'
  for (const port of agentOutputs) {
    s += `  - ${port}\n`
  }
  s += '\nFormat:\n<workflow-output>\n'
  for (const port of agentOutputs) {
    s += `  <port name="${port}">...</port>\n`
  }
  s += '</workflow-output>'
  return s
}
