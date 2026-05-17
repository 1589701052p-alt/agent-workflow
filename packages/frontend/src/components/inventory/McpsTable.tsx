import { useTranslation } from 'react-i18next'
import type { InventoryMcp } from '@agent-workflow/shared'
import { StatusBadge } from './StatusBadge'

export function McpsTable({ mcps }: { mcps: readonly InventoryMcp[] }) {
  const { t } = useTranslation()
  if (mcps.length === 0) {
    return <div className="muted inventory-section__empty">{t('nodeDrawer.inventory.empty')}</div>
  }
  return (
    <table className="inventory-table inventory-table--mcps">
      <colgroup>
        <col className="col-name" />
        <col className="col-status" />
        <col className="col-type" />
        <col className="col-hint" />
      </colgroup>
      <thead>
        <tr>
          <th>{t('nodeDrawer.inventory.col.name')}</th>
          <th>{t('nodeDrawer.inventory.col.status')}</th>
          <th>{t('nodeDrawer.inventory.col.type')}</th>
          <th>{t('nodeDrawer.inventory.col.hint')}</th>
        </tr>
      </thead>
      <tbody>
        {mcps.map((m) => (
          <tr key={m.name}>
            <td>{m.name}</td>
            <td>
              <StatusBadge status={m.status} />
            </td>
            <td>{m.type}</td>
            <td>
              <span title={m.hint ?? ''}>{m.hint !== null ? m.hint : '—'}</span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
