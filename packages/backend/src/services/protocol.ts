// Backwards-compatible re-export. The renderUserPrompt + buildProtocolBlock
// implementation moved to @agent-workflow/shared in P-2-06 so the frontend
// preview pane (NodeInspector) can reuse the exact same algorithm.

export {
  buildProtocolBlock,
  renderUserPrompt,
  type RenderPromptInput,
} from '@agent-workflow/shared'
