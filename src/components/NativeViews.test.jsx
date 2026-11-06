import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it } from 'vitest'
import NativeViews from './NativeViews'

it('renders custom status names that match Object prototype keys', async () => {
  const client = { get: async (_, query) => query.definitions ? { rows: [] } : {
    rows: ['__proto__', 'constructor', 'toString'].map(status => ({ id: status, metadata: { title: status, status } })), total: 3, offset: 0,
  } }
  render(<NativeViews client={client} session={{ version: 1, vaultId: 'custom-status' }} onSelect={() => {}} />)
  await screen.findByRole('button', { name: '__proto__', exact: true })
  expect(screen.getByRole('table')).toHaveTextContent('__proto__')
  await userEvent.selectOptions(screen.getByLabelText('View layout'), 'board')
  expect(screen.getByRole('heading', { name: 'constructor' })).toBeVisible()
  expect(screen.getByRole('heading', { name: 'toString' })).toBeVisible()
})

it('keeps filter input made during a slow initial query and renders unknown legacy properties safely', async () => {
  let resolve
  const pending = new Promise(done => { resolve = done })
  const client = { get: async (_, query) => query.definitions ? { rows: [] } : pending }
  render(<NativeViews client={client} session={{ version: 1, vaultId: 'slow-synthetic' }} onSelect={() => {}} />)
  await userEvent.type(screen.getByLabelText('Filter tag'), '프로젝트')
  await act(async () => resolve({ rows: [{ id: 'legacy', metadata: { title: 'Legacy note', project: { unknown: true }, status: { unknown: true }, tags: ['valid', {}] } }], total: 1, offset: 0 }))
  expect(screen.getByLabelText('Filter tag')).toHaveValue('프로젝트')
  expect(screen.getByRole('table')).toHaveTextContent('Legacy note')
  expect(screen.getByRole('table')).toHaveTextContent('No status')
})
