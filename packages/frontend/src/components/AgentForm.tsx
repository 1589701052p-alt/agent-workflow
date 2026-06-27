// Shared frontmatter + body form for /agents/new and /agents/$name.
// Lifts the entire CreateAgent payload to local state; submission is the
// parent's concern.

import { useTranslation } from 'react-i18next'
import { useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import type { Config, CreateAgent } from '@agent-workflow/shared'
import { AGENT_NAME_RE } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { AgentDependsPicker } from './AgentDependsPicker'
import { DependencyAutodetectButton } from './agents/DependencyAutodetectButton'
import { DependencyTreePreview } from './agents/DependencyTreePreview'
import { mergeAgentDeps } from '@/lib/agent-dep-detect'
import { Field, NumberInput, Switch, TextArea, TextInput } from './Form'
import { JsonField } from './JsonField'
import { MarkdownEditor } from './MarkdownEditor'
import { McpsPicker } from './McpsPicker'
import { PluginsPicker } from './PluginsPicker'
import { ModelSelect } from './ModelSelect'
import { OutputsEditor } from './OutputsEditor'
import { Select } from './Select'
import { SkillsPicker } from './SkillsPicker'

export interface AgentFormProps {
  value: CreateAgent
  onChange: (next: CreateAgent) => void
  /** When true the name input is read-only (editing an existing agent). */
  nameLocked?: boolean
}

const DEFAULT: CreateAgent = {
  name: '',
  description: '',
  outputs: [],
  readonly: false,
  syncOutputsOnIterate: true,
  permission: {},
  skills: [],
  dependsOn: [],
  mcp: [],
  plugins: [],
  frontmatterExtra: {},
  bodyMd: '',
}

export function emptyAgent(): CreateAgent {
  return structuredClone(DEFAULT)
}

export function AgentForm({ value, onChange, nameLocked }: AgentFormProps) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  // RFC-111: the runtime selector + claude model namespace are gated on the
  // runtime config. Shares the ['config'] cache the agent routes already
  // populate (ModelSelect already requires a QueryClientProvider here).
  const config = useQuery<Config>({
    queryKey: ['config'],
    queryFn: ({ signal }) => api.get('/api/config', undefined, signal),
    staleTime: 30_000,
    retry: false,
  })
  function patch<K extends keyof CreateAgent>(key: K, next: CreateAgent[K]) {
    onChange({ ...value, [key]: next })
  }

  // RFC-111 D17: surface the runtime selector unless claude is explicitly
  // disabled (undefined ⇒ enabled now parity shipped). Keep showing it when
  // the agent already pins a runtime so an existing value is never hidden.
  const claudeEnabled = config.data?.claudeCodeEnabled !== false
  // RFC-112: registered runtimes (GET /api/runtimes — open to all users, unlike
  // admin-only /api/config) drive the picker options + the selected runtime's
  // protocol, so a custom claude-protocol fork uses the claude model namespace.
  const runtimesQuery = useQuery<{ runtimes: Array<{ name: string; protocol: string }> }>({
    queryKey: ['runtimes'],
    queryFn: ({ signal }) => api.get('/api/runtimes', undefined, signal),
    staleTime: 30_000,
  })
  const registeredRuntimes = runtimesQuery.data?.runtimes ?? []
  const showRuntime = claudeEnabled || value.runtime != null
  // Effective runtime = agent override → global default → opencode. Drives the
  // model namespace + whether variant/temperature apply (claude has neither).
  const effectiveRuntime = value.runtime ?? config.data?.defaultRuntime ?? 'opencode'
  const effectiveProtocol =
    registeredRuntimes.find((r) => r.name === effectiveRuntime)?.protocol ??
    (effectiveRuntime === 'claude-code' ? 'claude-code' : 'opencode')
  const isClaude = effectiveProtocol === 'claude-code'

  return (
    <div className="agent-form">
      <div className="form-grid">
        <Field label={t('agentForm.fieldName')} required hint={t('agentForm.fieldNameHint')}>
          <TextInput
            value={value.name}
            onChange={(v) => patch('name', v)}
            disabled={nameLocked === true}
            required
            pattern={AGENT_NAME_RE.source}
            placeholder={t('agentForm.fieldNamePlaceholder')}
          />
        </Field>

        <Field label={t('agentForm.fieldDescription')}>
          <TextInput
            value={value.description ?? ''}
            onChange={(v) => patch('description', v)}
            placeholder={t('agentForm.fieldDescriptionPlaceholder')}
          />
        </Field>

        <Field label={t('agentForm.fieldOutputs')} hint={t('agentForm.fieldOutputsHint')}>
          <OutputsEditor
            outputs={value.outputs ?? []}
            outputKinds={value.outputKinds}
            onChange={(outputs, outputKinds) => onChange({ ...value, outputs, outputKinds })}
            placeholder={t('agentForm.fieldOutputsPlaceholder')}
          />
        </Field>

        <Field label={t('agentForm.fieldSkills')} hint={t('agentForm.fieldSkillsHint')}>
          <SkillsPicker
            value={value.skills ?? []}
            onChange={(v) => patch('skills', v)}
            placeholder={t('agentForm.fieldSkillsPlaceholder')}
          />
        </Field>

        <Field label={t('agentForm.fieldMcps')} hint={t('agentForm.fieldMcpsHint')}>
          <McpsPicker
            value={value.mcp ?? []}
            onChange={(v) => patch('mcp', v)}
            placeholder={t('agentForm.fieldMcpsPlaceholder')}
          />
        </Field>

        <Field label={t('agentForm.fieldPlugins')} hint={t('agentForm.fieldPluginsHint')}>
          <PluginsPicker
            value={value.plugins ?? []}
            onChange={(v) => patch('plugins', v)}
            placeholder={t('agentForm.fieldPluginsPlaceholder')}
          />
        </Field>

        <Field label={t('agentForm.fieldDependsOn')} hint={t('agentForm.fieldDependsOnHint')}>
          <AgentDependsPicker
            value={value.dependsOn ?? []}
            onChange={(v) => patch('dependsOn', v)}
            selfName={value.name}
            placeholder={t('agentForm.fieldDependsOnPlaceholder')}
          />
        </Field>

        <DependencyAutodetectButton
          bodyMd={value.bodyMd ?? ''}
          value={value}
          selfName={value.name}
          onApply={(selection) => onChange(mergeAgentDeps(value, selection))}
        />

        <Field label={t('agentForm.fieldDependencyTree')}>
          <DependencyTreePreview
            name={value.name}
            dependsOn={value.dependsOn ?? []}
            onNodeClick={(n) => navigate({ to: '/agents/$name', params: { name: n } })}
          />
        </Field>

        <Switch
          checked={value.readonly === true}
          onChange={(v) => patch('readonly', v)}
          label={t('agentForm.fieldReadonly')}
          hint={t('agentForm.fieldReadonlyHint')}
        />

        <Switch
          checked={value.syncOutputsOnIterate !== false}
          onChange={(v) => patch('syncOutputsOnIterate', v)}
          label={t('agentForm.fieldSyncOutputsOnIterate')}
          hint={t('agentForm.fieldSyncOutputsOnIterateHint')}
        />

        {/* RFC-060 PR-B — agent role + outputWrapperPortNames. The map editor
            is JSON-shaped for now; PR-F upgrades OutputsEditor with per-port
            rename inputs. */}
        <Field label={t('agentForm.fieldRole')} hint={t('agentForm.fieldRoleHint')}>
          <Select<'normal' | 'aggregator'>
            value={value.role ?? 'normal'}
            onChange={(v) => patch('role', v === 'normal' ? undefined : v)}
            options={[
              { value: 'normal', label: t('agentForm.roleNormal') },
              { value: 'aggregator', label: t('agentForm.roleAggregator') },
            ]}
            ariaLabel={t('agentForm.fieldRole')}
          />
        </Field>

        {value.role === 'aggregator' ? (
          <Field
            label={t('agentForm.fieldOutputWrapperPortNames')}
            hint={t('agentForm.fieldOutputWrapperPortNamesHint')}
          >
            <JsonField
              value={value.outputWrapperPortNames ?? {}}
              onChange={(v) => {
                if (typeof v !== 'object' || v === null || Array.isArray(v)) return
                patch('outputWrapperPortNames', v as Record<string, string>)
              }}
              placeholder={'{"report":"final"}'}
              rows={3}
            />
          </Field>
        ) : null}

        {/* RFC-111: per-agent runtime override. Empty = inherit the global
            default. Hidden only when claude is explicitly disabled in config
            (and the agent doesn't already pin a runtime). */}
        {showRuntime && (
          <Field label={t('agentForm.fieldRuntime')} hint={t('agentForm.fieldRuntimeHint')}>
            {/* RFC-112: options are the registered runtimes (built-ins + custom
                forks) by name, plus the inherit-default sentinel. */}
            <Select<string>
              value={value.runtime ?? ''}
              ariaLabel={t('agentForm.fieldRuntime')}
              onChange={(v) => patch('runtime', v === '' ? undefined : v)}
              options={[
                { value: '', label: t('agentForm.runtimeInherit') },
                ...(registeredRuntimes.length > 0
                  ? registeredRuntimes.map((r) => ({ value: r.name, label: r.name }))
                  : [
                      { value: 'opencode', label: t('agentForm.runtimeOpencode') },
                      { value: 'claude-code', label: t('agentForm.runtimeClaudeCode') },
                    ]),
              ]}
            />
          </Field>
        )}

        <div className="form-grid form-grid--cols-3">
          <Field label={t('agentForm.fieldModel')}>
            <ModelSelect
              value={value.model}
              onChange={(v) => patch('model', v)}
              runtime={isClaude ? 'claude' : 'opencode'}
            />
          </Field>
          {/* RFC-111: variant + temperature are opencode-only — Claude Code's
              CLI has no equivalent. Disable + explain when claude is active. */}
          <Field
            label={t('agentForm.fieldVariant')}
            hint={isClaude ? t('agentForm.claudeOptionsHint') : undefined}
          >
            <TextInput
              value={value.variant ?? ''}
              onChange={(v) => patch('variant', v === '' ? undefined : v)}
              placeholder={t('common.optionalPlaceholder')}
              disabled={isClaude}
            />
          </Field>
          <Field
            label={t('agentForm.fieldTemperature')}
            hint={isClaude ? t('agentForm.claudeOptionsHint') : undefined}
          >
            <NumberInput
              value={value.temperature}
              onChange={(v) => patch('temperature', v)}
              min={0}
              max={2}
              step={0.1}
              placeholder={t('agentForm.temperaturePlaceholder')}
              disabled={isClaude}
            />
          </Field>
          <Field label={t('agentForm.fieldSteps')}>
            <NumberInput
              value={value.steps}
              onChange={(v) => patch('steps', v)}
              min={1}
              placeholder={t('common.optionalPlaceholder')}
            />
          </Field>
          <Field label={t('agentForm.fieldMaxSteps')}>
            <NumberInput
              value={value.maxSteps}
              onChange={(v) => patch('maxSteps', v)}
              min={1}
              placeholder={t('common.optionalPlaceholder')}
            />
          </Field>
        </div>

        <Field label={t('agentForm.fieldPermission')} hint={t('agentForm.fieldPermissionHint')}>
          <JsonField
            value={value.permission ?? {}}
            onChange={(v) => patch('permission', v)}
            placeholder={t('agentForm.permissionPlaceholder')}
            rows={5}
          />
        </Field>

        <Field
          label={t('agentForm.fieldFrontmatterExtra')}
          hint={t('agentForm.fieldFrontmatterExtraHint')}
        >
          <JsonField
            value={value.frontmatterExtra ?? {}}
            onChange={(v) => patch('frontmatterExtra', v)}
            placeholder={t('common.optionalPlaceholder')}
            rows={4}
          />
        </Field>

        <Field label={t('agentForm.fieldBody')}>
          <MarkdownEditor
            value={value.bodyMd ?? ''}
            onChange={(v) => patch('bodyMd', v)}
            placeholder={t('agentForm.bodyPlaceholder')}
          />
        </Field>

        {/* Quick raw-body fallback for users who don't want preview. */}
        <details className="form-details">
          <summary>{t('agentForm.rawBodySummary')}</summary>
          <TextArea
            value={value.bodyMd ?? ''}
            onChange={(v) => patch('bodyMd', v)}
            rows={6}
            monospace
          />
        </details>
      </div>
    </div>
  )
}
