import { useTranslation } from 'react-i18next'
import type { InventoryPlugin } from '@agent-workflow/shared'
import { sourceLabel } from './sourceLabel'

export function PluginsTable({ plugins }: { plugins: readonly InventoryPlugin[] }) {
  const { t } = useTranslation()
  if (plugins.length === 0) {
    return <div className="muted inventory-section__empty">{t('nodeDrawer.inventory.empty')}</div>
  }
  return (
    <table className="inventory-table">
      <thead>
        <tr>
          <th>{t('nodeDrawer.inventory.col.specifier')}</th>
          <th>{t('nodeDrawer.inventory.col.source')}</th>
        </tr>
      </thead>
      <tbody>
        {plugins.map((p) => (
          <tr key={p.specifier}>
            <td>
              <span title={p.specifier}>{p.specifier}</span>
            </td>
            <td>{sourceLabel(p.source, t)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
