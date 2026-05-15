// Side-by-side markdown editor for agent body / SKILL.md.
//
// RFC-008 T3: the preview pane now uses the same <Prose> renderer that
// review docs use, so the editor preview supports the full GFM + GitHub
// callout + KaTeX + shiki feature surface. The body is fed through
// useDeferredValue so heavy renders don't gate keystrokes.

import { useDeferredValue } from 'react'
import { Prose } from './prose/Prose'
import { TextArea } from './Form'

interface MarkdownEditorProps {
  value: string
  onChange: (v: string) => void
  rows?: number
  placeholder?: string
}

export function MarkdownEditor({ value, onChange, rows = 18, placeholder }: MarkdownEditorProps) {
  const deferred = useDeferredValue(value)
  return (
    <div className="md-editor">
      <div className="md-editor__pane md-editor__pane--edit">
        <div className="md-editor__label">Edit</div>
        <TextArea
          value={value}
          onChange={onChange}
          rows={rows}
          placeholder={placeholder}
          monospace
        />
      </div>
      <div className="md-editor__pane md-editor__pane--preview">
        <div className="md-editor__label">Preview</div>
        {deferred.trim() === '' ? (
          <div className="md-editor__preview md-preview__empty">Nothing to preview yet.</div>
        ) : (
          <Prose body={deferred} className="md-editor__preview" />
        )}
      </div>
    </div>
  )
}
