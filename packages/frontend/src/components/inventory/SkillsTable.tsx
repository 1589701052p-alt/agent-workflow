import { useTranslation } from 'react-i18next'
import type { InventorySkill } from '@agent-workflow/shared'
import { sourceLabel } from './sourceLabel'

export function SkillsTable({ skills }: { skills: readonly InventorySkill[] }) {
  const { t } = useTranslation()
  if (skills.length === 0) {
    return <div className="muted inventory-section__empty">{t('nodeDrawer.inventory.empty')}</div>
  }
  return (
    <table className="inventory-table">
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
            <td>
              <span title={s.path ?? ''}>{s.path !== null ? truncate(s.path, 40) : '—'}</span>
            </td>
            <td>
              <span title={s.description ?? ''}>
                {s.description !== null ? truncate(s.description, 60) : '—'}
              </span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 1) + '…'
}
