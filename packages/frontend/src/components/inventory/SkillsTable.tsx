import { useTranslation } from 'react-i18next'
import type { InventorySkill } from '@agent-workflow/shared'
import { sourceLabel } from './sourceLabel'

export function SkillsTable({ skills }: { skills: readonly InventorySkill[] }) {
  const { t } = useTranslation()
  if (skills.length === 0) {
    return <div className="muted inventory-section__empty">{t('nodeDrawer.inventory.empty')}</div>
  }
  return (
    <table className="inventory-table inventory-table--skills">
      <colgroup>
        <col className="col-name" />
        <col className="col-source" />
        <col className="col-path" />
        <col className="col-desc" />
      </colgroup>
      <thead>
        <tr>
          <th>{t('nodeDrawer.inventory.col.name')}</th>
          <th>{t('nodeDrawer.inventory.col.source')}</th>
          <th>{t('nodeDrawer.inventory.col.path')}</th>
          <th>{t('nodeDrawer.inventory.col.desc')}</th>
        </tr>
      </thead>
      <tbody>
        {skills.map((s) => (
          <tr key={s.name}>
            <td>{s.name}</td>
            <td>{sourceLabel(s.source, t)}</td>
            {/* Long paths / descriptions wrap inside the cell via CSS
                `overflow-wrap: anywhere` instead of being JS-truncated —
                the full text stays visible without a hover tooltip. */}
            <td>{s.path !== null ? s.path : '—'}</td>
            <td>{s.description !== null ? s.description : '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
